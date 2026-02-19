import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-goog-channel-id, x-goog-resource-id, x-goog-resource-state'
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const googleClientId = Deno.env.get('GOOGLE_CLIENT_ID')!;
const googleClientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')!;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// ═══════════════════════════════════════════════════
// NOVO: getValidAccessToken (extraído da function principal)
// Garante que o token está válido antes de chamar a Google API
// ═══════════════════════════════════════════════════
async function getValidAccessToken(userId: string): Promise<string> {
  const { data: tokens, error: tokenError } = await supabase
    .rpc('secure_get_google_tokens', { p_user_id: userId })
    .single();

  if (tokenError || !tokens) {
    throw new Error(`Failed to get tokens for user ${userId}: ${tokenError?.message}`);
  }

  if (!tokens.is_connected) {
    throw new Error(`User ${userId} is not connected to Google Calendar`);
  }

  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;
  const expiresAt = tokens.expires_at;

  // Checar se o token expirou (com margem de 5 minutos)
  const now = new Date();
  const expiresDate = new Date(expiresAt);
  const fiveMinutes = 5 * 60 * 1000;

  if (expiresDate.getTime() - now.getTime() > fiveMinutes) {
    // Token ainda válido
    return accessToken;
  }

  // Token expirado ou prestes a expirar — renovar
  console.log(`🔄 Refreshing access token for user ${userId}`);

  const refreshResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: googleClientId,
      client_secret: googleClientSecret,
    }).toString(),
  });

  if (!refreshResponse.ok) {
    const errBody = await refreshResponse.text();
    console.error(`Token refresh failed for user ${userId}:`, errBody);

    // Logar falha
    await supabase.rpc('log_failed_token_access', { p_user_id: userId, p_ip_hash: null });

    throw new Error(`Token refresh failed: ${refreshResponse.status}`);
  }

  const refreshData = await refreshResponse.json();
  const newAccessToken = refreshData.access_token;
  const newExpiresAt = new Date(Date.now() + (refreshData.expires_in || 3600) * 1000).toISOString();

  // Gravar novo token via RPC (criptografado)
  await supabase.rpc('store_access_token', {
    p_user_id: userId,
    p_token: newAccessToken,
    p_expires_at: newExpiresAt,
  });

  // Resetar contador de falhas
  await supabase.rpc('reset_failed_token_access', { p_user_id: userId });

  console.log(`✅ Token refreshed for user ${userId}`);
  return newAccessToken;
}

// ═══════════════════════════════════════════════════
// Handler principal do webhook
// ═══════════════════════════════════════════════════
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const channelId = req.headers.get('x-goog-channel-id');
    const resourceId = req.headers.get('x-goog-resource-id');
    const resourceState = req.headers.get('x-goog-resource-state');

    console.log('📥 Webhook received:', { channelId, resourceId, resourceState });

    if (!channelId || !resourceId) {
      console.error('Invalid webhook: missing headers');
      return new Response('Invalid webhook', { status: 400, headers: corsHeaders });
    }

    // sync = confirmação inicial do webhook
    if (resourceState === 'sync') {
      console.log('✅ Webhook setup confirmed');
      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    // exists = há mudanças para sincronizar
    if (resourceState === 'exists') {
      console.log('🔄 Changes detected, triggering sync...');

      // Buscar usuário pelo webhook_id (isolamento por user)
      const { data: connection, error } = await supabase
        .from('google_calendar_connections')
        .select('user_id')
        .eq('webhook_id', channelId)
        .eq('webhook_resource_id', resourceId)
        .eq('is_connected', true)
        .single();

      if (error || !connection) {
        console.error('Connection not found for webhook:', error);
        return new Response('Connection not found', { status: 404, headers: corsHeaders });
      }

      // Dispara sincronização em background
      EdgeRuntime.waitUntil(
        performIncrementalSync(connection.user_id).catch((err) => {
          console.error('Background sync error:', err);
        })
      );

      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    return new Response('OK', { status: 200, headers: corsHeaders });
  } catch (error) {
    console.error('Webhook error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ═══════════════════════════════════════════════════
// Sync incremental (CORRIGIDO: usa getValidAccessToken)
// ═══════════════════════════════════════════════════
async function performIncrementalSync(userId: string) {
  console.log(`🔄 Starting incremental sync for user: ${userId}`);

  try {
    // CORREÇÃO: obter token válido (renova se expirado)
    const accessToken = await getValidAccessToken(userId);

    const { data: connection } = await supabase
      .from('google_calendar_connections')
      .select('sync_token')
      .eq('user_id', userId)
      .single();

    let syncToken = connection?.sync_token;
    let nextPageToken: string | undefined = undefined;
    let newSyncToken: string | undefined = undefined;

    do {
      const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');

      if (nextPageToken) {
        url.searchParams.set('pageToken', nextPageToken);
      } else if (syncToken) {
        url.searchParams.set('syncToken', syncToken);
      } else {
        // Fallback: últimos 30 dias e próximos 90 dias
        const timeMin = new Date();
        timeMin.setDate(timeMin.getDate() - 30);
        const timeMax = new Date();
        timeMax.setDate(timeMax.getDate() + 90);
        url.searchParams.set('timeMin', timeMin.toISOString());
        url.searchParams.set('timeMax', timeMax.toISOString());
      }

      url.searchParams.set('maxResults', '250');
      url.searchParams.set('singleEvents', 'true');

      console.log('📡 Fetching changes from Google Calendar...', nextPageToken ? '(next page)' : '');

      const response = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        if (response.status === 410) {
          // Sync token expirado, limpar e recomeçar
          console.log('⚠️ Sync token expired, performing full sync...');
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
      console.log(`📥 Processing ${events.length} changed events`);

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
          last_sync_at: new Date().toISOString(),
        })
        .eq('user_id', userId);
    }

    console.log(`✅ Incremental sync completed for user ${userId}`);
  } catch (error) {
    console.error('Incremental sync error:', error);
  }
}

// ═══════════════════════════════════════════════════
// Processar mudança de evento individual
// (sem alteração — lógica original preservada)
// ═══════════════════════════════════════════════════
async function processEventChange(userId: string, gEvent: any) {
  try {
    const googleEventId = gEvent.id;

    // Evento deletado/cancelado
    if (gEvent.status === 'cancelled') {
      console.log(`🗑️ Deleting event ${googleEventId} (cancelled in Google)`);
      await supabase
        .from('calendar')
        .delete()
        .eq('user_id', userId)
        .eq('session_event_id_google', googleEventId);
      return;
    }

    // Validar campos obrigatórios
    if (!gEvent.start?.dateTime || !gEvent.end?.dateTime) {
      return; // Pular eventos de dia inteiro (será corrigido na Fase 5)
    }

    // Verificar se evento já existe (filtrado por user_id)
    const { data: existing } = await supabase
      .from('calendar')
      .select('id, event_name, start_event, end_event, desc_event')
      .eq('user_id', userId)
      .eq('session_event_id_google', googleEventId)
      .maybeSingle();

    const eventData = {
      event_name: (gEvent.summary || 'Sem título').substring(0, 255),
      desc_event: (gEvent.description || '').substring(0, 5000),
      start_event: gEvent.start.dateTime || gEvent.start.date,
      end_event: gEvent.end.dateTime || gEvent.end.date,
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
        console.log(`📝 Updating event ${googleEventId}`);
        await supabase.from('calendar').update(eventData).eq('id', existing.id);
      }
    } else {
      // Criar novo evento
      console.log(`➕ Creating new event ${googleEventId}`);
      await supabase.from('calendar').insert({
        user_id: userId,
        session_event_id_google: googleEventId,
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
