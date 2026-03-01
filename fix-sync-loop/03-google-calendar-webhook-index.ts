import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-goog-channel-id, x-goog-resource-id, x-goog-resource-state',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const googleClientId = Deno.env.get('GOOGLE_CLIENT_ID')!;
const googleClientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')!;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Headers do webhook do Google
    const channelId = req.headers.get('x-goog-channel-id');
    const resourceId = req.headers.get('x-goog-resource-id');
    const resourceState = req.headers.get('x-goog-resource-state');

    console.log('Webhook received:', { channelId, resourceId, resourceState });

    // Validar que é um webhook do Google
    if (!channelId || !resourceId) {
      console.error('Invalid webhook: missing headers');
      return new Response('Invalid webhook', { status: 400, headers: corsHeaders });
    }

    // sync = mudanças disponíveis
    if (resourceState === 'sync') {
      console.log('Webhook setup confirmed');
      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    // exists = há mudanças para sincronizar
    if (resourceState === 'exists') {
      console.log('Changes detected, triggering sync...');

      // Buscar usuário pelo webhook_id
      const { data: connection, error } = await supabase
        .from('google_calendar_connections')
        .select('user_id, last_sync_at')
        .eq('webhook_id', channelId)
        .eq('webhook_resource_id', resourceId)
        .eq('is_connected', true)
        .single();

      if (error || !connection) {
        console.error('Connection not found for webhook:', error);
        return new Response('Connection not found', { status: 404, headers: corsHeaders });
      }

      // CORRIGIDO: Dedup - pular se sincronizou há menos de 30 segundos
      if (connection.last_sync_at) {
        const lastSync = new Date(connection.last_sync_at);
        const now = new Date();
        const diffSeconds = (now.getTime() - lastSync.getTime()) / 1000;

        if (diffSeconds < 30) {
          console.log(`Dedup: last sync was ${diffSeconds.toFixed(0)}s ago, skipping`);
          return new Response('OK', { status: 200, headers: corsHeaders });
        }
      }

      // Dispara sincronização em background
      EdgeRuntime.waitUntil(
        performIncrementalSync(connection.user_id).catch(err => {
          console.error('Background sync error:', err);
        })
      );

      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    return new Response('OK', { status: 200, headers: corsHeaders });

  } catch (error) {
    console.error('Webhook error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

async function getValidAccessToken(userId: string): Promise<string | null> {
  try {
    const { data: tokens, error } = await supabase
      .rpc('secure_get_google_tokens', { p_user_id: userId })
      .single();

    if (error || !tokens) {
      console.error('Failed to get tokens:', error);
      return null;
    }

    const accessToken = (tokens as any).access_token;
    const expiresAt = (tokens as any).expires_at;

    // Se token expirou, tentar refresh
    if (expiresAt && new Date() >= new Date(expiresAt)) {
      console.log('Token expired, attempting refresh...');
      const refreshToken = (tokens as any).refresh_token;
      if (!refreshToken) return null;

      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: googleClientId,
          client_secret: googleClientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      });

      const tokenData = await response.json();
      if (!response.ok) {
        console.error('Token refresh failed:', tokenData.error);
        return null;
      }

      // Salvar novo token
      await supabase.rpc('store_access_token', {
        p_user_id: userId,
        p_token: tokenData.access_token,
        p_expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      });

      return tokenData.access_token;
    }

    return accessToken || null;
  } catch (error) {
    console.error('Error getting access token:', error);
    return null;
  }
}

async function performIncrementalSync(userId: string): Promise<void> {
  console.log(`Starting incremental sync for user: ${userId}`);

  try {
    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) {
      console.error('No valid access token for user:', userId);
      return;
    }

    const { data: connection } = await supabase
      .from('google_calendar_connections')
      .select('sync_token')
      .eq('user_id', userId)
      .single();

    let syncToken = connection?.sync_token;
    let nextPageToken: string | undefined = undefined;
    let newSyncToken: string | undefined = undefined;

    do {
      // Construir URL para sincronização incremental
      const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
      if (nextPageToken) {
        url.searchParams.set('pageToken', nextPageToken);
      } else if (syncToken) {
        url.searchParams.set('syncToken', syncToken);
      } else {
        // Primeira vez (fallback): buscar últimos 30 dias e próximos 90 dias
        const timeMin = new Date();
        timeMin.setDate(timeMin.getDate() - 30);
        const timeMax = new Date();
        timeMax.setDate(timeMax.getDate() + 90);
        url.searchParams.set('timeMin', timeMin.toISOString());
        url.searchParams.set('timeMax', timeMax.toISOString());
      }
      url.searchParams.set('maxResults', '250');
      url.searchParams.set('singleEvents', 'true');
      // CORRIGIDO: Capturar eventos deletados no Google
      url.searchParams.set('showDeleted', 'true');

      console.log('Fetching changes from Google Calendar...', nextPageToken ? '(next page)' : '');
      const response = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        // Se sync token inválido, fazer full sync
        if (response.status === 410) {
          console.log('Sync token expired, performing full sync...');
          await supabase
            .from('google_calendar_connections')
            .update({ sync_token: null })
            .eq('user_id', userId);
          return performIncrementalSync(userId);
        }
        throw new Error(`Google API error: ${response.status}`);
      }

      const data = await response.json();
      nextPageToken = data.nextPageToken;
      newSyncToken = data.nextSyncToken;
      const events = data.items || [];

      console.log(`Processing ${events.length} changed events`);

      // Processar mudanças
      for (const gEvent of events) {
        await processEventChange(userId, gEvent);
      }
    } while (nextPageToken);

    // Salvar novo sync token
    if (newSyncToken) {
      await supabase
        .from('google_calendar_connections')
        .update({
          sync_token: newSyncToken,
          last_sync_at: new Date().toISOString()
        })
        .eq('user_id', userId);
    }

    console.log(`Incremental sync completed for user ${userId}`);

  } catch (error) {
    console.error('Incremental sync error:', error);
  }
}

// CORRIGIDO: processEventChange agora seta _syncing_from_google: true
// para prevenir o trigger de sincronizar de volta pro Google (loop)
async function processEventChange(userId: string, gEvent: any): Promise<void> {
  try {
    const googleEventId = gEvent.id;

    // Se evento foi deletado ou cancelado
    if (gEvent.status === 'cancelled') {
      console.log(`Deleting event ${googleEventId} (cancelled in Google)`);
      // Deletar diretamente - o trigger tentará deletar do Google mas
      // o evento já foi deletado lá, então handleDeleteEvent retorna sucesso (404/410)
      await supabase
        .from('calendar')
        .delete()
        .eq('user_id', userId)
        .eq('session_event_id_google', googleEventId);
      return;
    }

    // Validar campos obrigatórios
    if (!gEvent.start?.dateTime || !gEvent.end?.dateTime) {
      return; // Pular eventos de dia inteiro
    }

    // Verificar se evento já existe
    const { data: existing } = await supabase
      .from('calendar')
      .select('id, event_name, start_event, end_event, desc_event')
      .eq('user_id', userId)
      .eq('session_event_id_google', googleEventId)
      .maybeSingle();

    const eventData = {
      event_name: (gEvent.summary || 'Sem título').substring(0, 255),
      desc_event: (gEvent.description || '').substring(0, 5000),
      start_event: gEvent.start.dateTime,
      end_event: gEvent.end.dateTime,
      timezone: gEvent.start.timeZone || 'America/Sao_Paulo',
      calendar_email_created: gEvent.creator?.email || null,
    };

    if (existing) {
      // Atualizar apenas se mudou
      const hasChanged =
        existing.event_name !== eventData.event_name ||
        existing.start_event !== eventData.start_event ||
        existing.end_event !== eventData.end_event ||
        (existing.desc_event || '') !== eventData.desc_event;

      if (hasChanged) {
        console.log(`Updating event ${googleEventId}`);
        // CORRIGIDO: _syncing_from_google previne o trigger de fazer loop
        await supabase
          .from('calendar')
          .update({
            ...eventData,
            _syncing_from_google: true,
          })
          .eq('id', existing.id);
      }
    } else {
      // Criar novo evento
      console.log(`Creating new event ${googleEventId}`);
      // CORRIGIDO: _syncing_from_google previne o trigger de fazer loop
      await supabase
        .from('calendar')
        .insert({
          user_id: userId,
          session_event_id_google: googleEventId,
          _syncing_from_google: true,
          reminder: false,
          remembered: false,
          active: true,
          ...eventData,
        });
    }

  } catch (error) {
    console.error(`Error processing event ${gEvent.id}:`, error);
  }
}
