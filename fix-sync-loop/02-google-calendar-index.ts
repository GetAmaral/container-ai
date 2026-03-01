import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const googleClientId = Deno.env.get('GOOGLE_CLIENT_ID')!;
const googleClientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')!;

// URLs do frontend para redirecionamento após OAuth
const PRODUCTION_URL = 'https://totalassistente.com.br';
const DEVELOPMENT_URL = 'https://ignorethissiteavtotal.lovable.app';

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// Helper para extrair userId e origin do state
function parseState(state: string): { userId: string; origin: string } {
  try {
    // Tenta parsear como JSON (novo formato: {userId, origin})
    const parsed = JSON.parse(atob(state));
    return {
      userId: parsed.userId || state,
      origin: parsed.origin || PRODUCTION_URL
    };
  } catch {
    // Fallback para formato antigo (apenas userId)
    return { userId: state, origin: PRODUCTION_URL };
  }
}

// Helper para criar state com userId e origin
function createState(userId: string, origin: string): string {
  return btoa(JSON.stringify({ userId, origin }));
}

// Helper para determinar a URL de origem
function getOriginUrl(referer: string | null): string {
  if (referer) {
    if (referer.includes('ignorethissiteavtotal.lovable.app')) {
      return DEVELOPMENT_URL;
    }
  }
  return PRODUCTION_URL;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  // A) Início do fluxo: sem code e sem error -> redireciona pro OAuth do Google
  if (req.method === 'GET' && !code && !error) {
    const redirectUri = `${supabaseUrl}/functions/v1/google-calendar`;
    const scope = 'https://www.googleapis.com/auth/calendar';
    const userIdParam = url.searchParams.get('userId') || '';
    const referer = req.headers.get('referer');
    const originUrl = getOriginUrl(referer);

    // Cria state com userId e origin para usar no callback
    const stateValue = createState(userIdParam || crypto.randomUUID(), originUrl);

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', googleClientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scope);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('include_granted_scopes', 'true');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', stateValue);

    return Response.redirect(authUrl.toString(), 302);
  }

  // B) Callback: se houver erro do Google - redireciona para página do frontend
  if (req.method === 'GET' && error) {
    console.error('OAuth error:', error);
    const { origin } = state ? parseState(state) : { origin: PRODUCTION_URL };
    const errorRedirectUrl = `${origin}/auth/google-calendar?error=${encodeURIComponent(error)}`;
    return Response.redirect(errorRedirectUrl, 302);
  }

  // C) Callback: se houver code -> troca por tokens, salva e redireciona para página do frontend
  if (req.method === 'GET' && code && state) {
    const { userId, origin } = parseState(state);
    const result = await handleCallback(userId, code);
    const success = result.status === 200;

    // Redireciona para página do frontend com resultado
    if (success) {
      const successRedirectUrl = `${origin}/auth/google-calendar?success=true`;
      return Response.redirect(successRedirectUrl, 302);
    } else {
      const errorRedirectUrl = `${origin}/auth/google-calendar?error=${encodeURIComponent('Falha ao conectar')}`;
      return Response.redirect(errorRedirectUrl, 302);
    }
  }

  // JSON API para as outras ações - Requires authentication
  try {
    // Extract and validate JWT token
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized - Missing authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const token = authHeader.replace('Bearer ', '');
    const body = await req.json();
    const { action, eventId, event, userId, renewWebhook } = body;
    console.log('Received request:', { action, eventId, userId });

    let finalUserId: string;

    // Se o token for a service role key, confiamos no userId do corpo
    if (token === supabaseServiceRoleKey) {
      if (!userId) {
        return new Response(
          JSON.stringify({ error: 'Missing userId for service role request' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      finalUserId = userId;
    } else {
      // Caso contrário, validamos o JWT do usuário
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        console.error('Authentication error:', authError);
        return new Response(
          JSON.stringify({ error: 'Unauthorized - Invalid token' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      // Se for um usuário autenticado, ele SÓ pode agir sobre seu próprio ID
      // Se um userId foi passado no body, ele DEVE ser igual ao do token
      if (userId && userId !== user.id) {
        console.error(`Security breach attempt: User ${user.id} tried to act as ${userId}`);
        return new Response(
          JSON.stringify({ error: 'Unauthorized - User ID mismatch' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      finalUserId = user.id;
    }

    // Para cron-sync, já temos o finalUserId validado
    if (action === 'cron-sync') {
      return handleCronSync(finalUserId, renewWebhook);
    }

    switch (action) {
      case 'auth':
        return handleAuth(finalUserId);
      case 'sync':
        return handleSyncFromGoogle(finalUserId);
      case 'create':
        return handleCreateEvent(finalUserId, event);
      case 'update':
        return handleUpdateEvent(finalUserId, eventId, event);
      case 'delete':
        return handleDeleteEvent(finalUserId, eventId);
      case 'disconnect':
        return handleDisconnect(finalUserId);
      default:
        return new Response(JSON.stringify({ error: 'Invalid action' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

async function handleAuth(userId: string) {
  // Retorna a URL da função (que inicia o redirecionamento para o Google)
  const authUrl = `${supabaseUrl}/functions/v1/google-calendar?userId=${encodeURIComponent(userId)}`;
  return new Response(JSON.stringify({ authUrl }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

async function handleCallback(userId: string, code: string) {
  try {
    const redirectUri = `${supabaseUrl}/functions/v1/google-calendar`;

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: googleClientId,
        client_secret: googleClientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = await tokenResponse.json();
    console.log('Token response:', tokenResponse.ok);

    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed: ${tokenData.error}`);
    }

    // Armazena/atualiza a conexão do usuário com criptografia
    const { error } = await supabase
      .rpc('store_google_connection', {
        p_user_id: userId,
        p_access_token: tokenData.access_token,
        p_refresh_token: tokenData.refresh_token,
        p_expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
        p_connected_email: tokenData.email || null,
        p_scope: tokenData.scope || 'https://www.googleapis.com/auth/calendar'
      });

    if (error) {
      console.error('Connection storage error:', error);
      throw new Error('Failed to store connection status');
    }

    console.info('Google Calendar connected successfully');

    // Dispara sincronização inicial + registro de webhook em background
    EdgeRuntime.waitUntil(
      (async () => {
        try {
          console.log('Starting background sync and webhook setup');
          await performInitialSync(userId);
          await setupGoogleWebhook(userId);
          console.log('Background sync and webhook completed');
        } catch (error) {
          console.error('Background setup failed:', error);
        }
      })()
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Callback error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function getValidAccessToken(userId: string): Promise<string | null> {
  try {
    const { data: tokens, error } = await supabase
      .rpc('secure_get_google_tokens', { p_user_id: userId })
      .single();

    if (error) {
      console.error('Error getting tokens:', error);
      // Log failed access attempt
      await supabase.rpc('log_failed_token_access', {
        p_user_id: userId,
        p_ip_hash: null
      });
      return null;
    }

    if (!tokens || !(tokens as any).is_connected) {
      console.error('No connection found for user:', userId);
      return null;
    }

    if ((tokens as any).expires_at && new Date() >= new Date((tokens as any).expires_at)) {
      console.log('Token expired, attempting refresh...');
      const refreshedToken = await refreshAccessToken(userId, (tokens as any).refresh_token || '');
      if (refreshedToken) {
        // Reset failed attempts on successful refresh
        await supabase.rpc('reset_failed_token_access', { p_user_id: userId });
      }
      return refreshedToken;
    }

    // Reset failed attempts on successful access
    await supabase.rpc('reset_failed_token_access', { p_user_id: userId });
    return (tokens as any).access_token || '';
  } catch (error) {
    console.error('Error getting access token:', error);
    // Log failed access attempt
    await supabase.rpc('log_failed_token_access', {
      p_user_id: userId,
      p_ip_hash: null
    });
    return null;
  }
}

async function refreshAccessToken(userId: string, refreshToken: string): Promise<string | null> {
  try {
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
      throw new Error(`Token refresh failed: ${tokenData.error}`);
    }

    // Use encrypted function to store the new access token
    const { error } = await supabase
      .rpc('store_access_token', {
        p_user_id: userId,
        p_token: tokenData.access_token,
        p_expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      });

    if (error) {
      console.error('Failed to update tokens:', error);
      return null;
    }

    return tokenData.access_token;
  } catch (error) {
    console.error('Error refreshing token:', error);
    return null;
  }
}

async function handleCreateEvent(userId: string, eventData: any) {
  try {
    console.log('Creating Google Calendar event');

    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) {
      console.error('No valid access token found');
      throw new Error('No valid access token found');
    }

    const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(eventData),
    });

    const result = await response.json();
    console.log('Google Calendar API response:', response.status);

    if (!response.ok) {
      console.error('Google Calendar API error:', result.error);
      throw new Error(`Google Calendar API error: ${result.error?.message || response.status}`);
    }

    console.log('Event created successfully, ID:', result.id);
    return new Response(JSON.stringify({ eventId: result.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Create event error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleUpdateEvent(userId: string, eventId: string, eventData: any) {
  try {
    console.log('Updating Google Calendar event:', eventId);

    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) {
      console.error('No valid access token found');
      throw new Error('No valid access token found');
    }

    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(eventData),
    });

    const result = await response.json();
    console.log('Google Calendar API response:', response.status);

    if (!response.ok) {
      console.error('Google Calendar API error:', result.error);
      throw new Error(`Google Calendar API error: ${result.error?.message || response.status}`);
    }

    console.log('Event updated successfully');
    return new Response(JSON.stringify({ eventId: result.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Update event error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleDeleteEvent(userId: string, eventId: string) {
  try {
    console.log('Deleting Google Calendar event:', eventId);

    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) {
      console.error('No valid access token found');
      throw new Error('No valid access token found');
    }

    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    console.log('Google Calendar API response:', response.status);

    // CORRIGIDO: Tratar 404/410 como sucesso (evento já deletado no Google)
    if (response.status === 404 || response.status === 410) {
      console.log('Event already deleted in Google (404/410), treating as success');
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!response.ok) {
      const result = await response.json().catch(() => ({} as any));
      console.error('Google Calendar API error:', result.error);
      throw new Error(`Google Calendar API error: ${result.error?.message || response.status}`);
    }

    console.log('Event deleted successfully');
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Delete event error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleDisconnect(userId: string) {
  try {
    console.log(`Disconnecting Google Calendar for user: ${userId}`);

    // 1. Cancelar webhook (best effort)
    try {
      await cancelGoogleWebhook(userId);
    } catch (error) {
      console.error('Error canceling webhook:', error);
    }

    // 2. Revogar token do Google (best effort)
    try {
      const { data: tokens } = await supabase
        .rpc('secure_get_google_tokens', { p_user_id: userId })
        .single();

      if (tokens && (tokens as any).refresh_token) {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${(tokens as any).refresh_token}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        console.log('Google token revoked successfully');
      }
    } catch (error) {
      console.error('Error revoking token:', error);
    }

    // 3. Remover eventos do Google Calendar (preserva eventos locais)
    const { data: deletedCount } = await supabase
      .rpc('remove_google_calendar_events', { p_user_id: userId })
      .single();

    console.log(`Removed ${deletedCount || 0} Google Calendar events`);

    // 4. Limpar conexão
    const { error } = await supabase
      .from('google_calendar_connections')
      .update({
        is_connected: false,
        encrypted_access_token: null,
        encrypted_refresh_token: null,
        expires_at: null,
        connected_email: null,
        sync_token: null,
        webhook_id: null,
        webhook_resource_id: null,
        webhook_expiration: null,
        last_sync_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    if (error) {
      console.error('Disconnect error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log('Google Calendar disconnected successfully');
    return new Response(JSON.stringify({ success: true, deleted: deletedCount || 0 }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Disconnect error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleSyncFromGoogle(userId: string) {
  try {
    console.log(`Manual sync requested for user: ${userId}`);

    // Rate limiting: verificar última sincronização
    const { data: connection } = await supabase
      .from('google_calendar_connections')
      .select('last_sync_at')
      .eq('user_id', userId)
      .single();

    if (connection?.last_sync_at) {
      const lastSync = new Date(connection.last_sync_at);
      const now = new Date();
      const diffMinutes = (now.getTime() - lastSync.getTime()) / 1000 / 60;

      if (diffMinutes < 5) {
        return new Response(
          JSON.stringify({
            error: 'Please wait before syncing again',
            retryAfter: Math.ceil(5 - diffMinutes)
          }),
          {
            status: 429,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          }
        );
      }
    }

    // Executa sincronização
    const result = await performInitialSync(userId);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Sync error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function performInitialSync(userId: string): Promise<{
  success: boolean;
  imported: number;
  skipped: number;
  errors?: string[];
}> {
  try {
    console.log(`Starting initial sync for user: ${userId}`);

    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) {
      throw new Error('No valid access token');
    }

    // Buscar eventos dos últimos 1 mês e próximos 6 meses
    const timeMin = new Date();
    timeMin.setMonth(timeMin.getMonth() - 1);

    const timeMax = new Date();
    timeMax.setMonth(timeMax.getMonth() + 6);

    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    url.searchParams.set('timeMin', timeMin.toISOString());
    url.searchParams.set('timeMax', timeMax.toISOString());
    url.searchParams.set('maxResults', '500'); // Limitar para performance
    url.searchParams.set('singleEvents', 'true'); // Expandir eventos recorrentes
    url.searchParams.set('orderBy', 'startTime');

    console.log('Fetching events from Google Calendar...');
    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Google API error: ${errorData.error?.message || response.status}`);
    }

    const data = await response.json();
    const googleEvents = data.items || [];
    const nextSyncToken = data.nextSyncToken; // Capture the sync token
    console.log(`Found ${googleEvents.length} events in Google Calendar`);

    // Buscar eventos existentes do usuário (otimizado)
    const { data: existingEvents, error: fetchError } = await supabase
      .from('calendar')
      .select('session_event_id_google, event_name, start_event')
      .eq('user_id', userId)
      .not('session_event_id_google', 'is', null);

    if (fetchError) {
      console.error('Error fetching existing events:', fetchError);
      throw fetchError;
    }

    // Criar Set para busca O(1)
    const existingGoogleIds = new Set(
      (existingEvents || []).map(e => e.session_event_id_google)
    );

    console.log(`Found ${existingGoogleIds.size} existing synced events in database`);

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];
    const eventsToInsert: any[] = [];

    // Processar eventos em batch
    for (const gEvent of googleEvents) {
      try {
        // Pular se já existe
        if (existingGoogleIds.has(gEvent.id)) {
          skipped++;
          continue;
        }

        // Validar campos obrigatórios
        if (!gEvent.start?.dateTime || !gEvent.end?.dateTime) {
          skipped++;
          continue; // Pular eventos de dia inteiro
        }

        // Preparar evento para inserção
        eventsToInsert.push({
          user_id: userId,
          event_name: (gEvent.summary || 'Sem título').substring(0, 255),
          desc_event: (gEvent.description || '').substring(0, 5000),
          start_event: gEvent.start.dateTime,
          end_event: gEvent.end.dateTime,
          session_event_id_google: gEvent.id,
          reminder: false,
          remembered: false,
          timezone: gEvent.start.timeZone || 'America/Sao_Paulo',
          calendar_email_created: gEvent.creator?.email || null,
          active: true,
          _syncing_from_google: true,
        });

      } catch (err) {
        console.error(`Error processing event ${gEvent.id}:`, err);
        errors.push(`Event ${gEvent.summary}: ${(err as Error).message}`);
      }
    }

    // Inserir em batch (máximo 100 por vez para segurança)
    if (eventsToInsert.length > 0) {
      console.log(`Inserting ${eventsToInsert.length} new events...`);

      for (let i = 0; i < eventsToInsert.length; i += 100) {
        const batch = eventsToInsert.slice(i, i + 100);

        const { error: insertError, count } = await supabase
          .from('calendar')
          .insert(batch);

        if (insertError) {
          console.error('Batch insert error:', insertError);
          errors.push(`Batch ${i / 100 + 1}: ${insertError.message}`);
        } else {
          imported += batch.length;
          console.log(`Inserted batch ${i / 100 + 1}: ${batch.length} events`);
        }
      }
    }

    // Atualizar timestamp de última sincronização e o sync_token
    const updateData: any = { last_sync_at: new Date().toISOString() };
    if (nextSyncToken) {
      updateData.sync_token = nextSyncToken;
    }

    await supabase
      .from('google_calendar_connections')
      .update(updateData)
      .eq('user_id', userId);

    console.log(`Sync completed: ${imported} imported, ${skipped} skipped. Sync token stored: ${!!nextSyncToken}`);

    return {
      success: true,
      imported,
      skipped,
      errors: errors.length > 0 ? errors : undefined
    };

  } catch (error) {
    console.error('performInitialSync error:', error);
    throw error;
  }
}

// =============================================
// FUNÇÕES DE WEBHOOK E SINCRONIZAÇÃO BIDIRECIONAL
// =============================================

async function setupGoogleWebhook(userId: string): Promise<void> {
  try {
    console.log(`Setting up webhook for user: ${userId}`);

    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) {
      throw new Error('No valid access token');
    }

    const webhookUrl = `${supabaseUrl}/functions/v1/google-calendar-webhook`;
    const channelId = `calendar-${userId}-${Date.now()}`;
    const expiration = Date.now() + (7 * 24 * 60 * 60 * 1000); // 7 dias

    console.log('Registering webhook with Google...');
    const response = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/watch',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: channelId,
          type: 'web_hook',
          address: webhookUrl,
          expiration: expiration.toString(),
        }),
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Failed to setup webhook: ${error.error?.message || response.status}`);
    }

    const data = await response.json();
    console.log('Webhook registered:', data);

    // Salvar informações do webhook
    await supabase
      .from('google_calendar_connections')
      .update({
        webhook_id: channelId,
        webhook_resource_id: data.resourceId,
        webhook_expiration: new Date(parseInt(data.expiration)).toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    console.log('Webhook setup completed');
  } catch (error) {
    console.error('Webhook setup error:', error);
    // Não falhar a conexão se webhook falhar
  }
}

async function cancelGoogleWebhook(userId: string): Promise<void> {
  try {
    console.log(`Canceling webhook for user: ${userId}`);

    const { data: connection } = await supabase
      .from('google_calendar_connections')
      .select('webhook_id, webhook_resource_id')
      .eq('user_id', userId)
      .single();

    if (!connection?.webhook_id || !connection?.webhook_resource_id) {
      console.log('No webhook to cancel');
      return;
    }

    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) {
      console.log('No access token to cancel webhook');
      return;
    }

    const response = await fetch(
      'https://www.googleapis.com/calendar/v3/channels/stop',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: connection.webhook_id,
          resourceId: connection.webhook_resource_id,
        }),
      }
    );

    if (response.ok) {
      console.log('Webhook canceled successfully');
    } else {
      console.log('Webhook cancel failed (may already be expired)');
    }
  } catch (error) {
    console.error('Webhook cancel error:', error);
  }
}

async function handleCronSync(userId: string, renewWebhook: boolean = false) {
  try {
    console.log(`Cron sync for user: ${userId}`);

    // Renovar webhook se necessário
    if (renewWebhook) {
      await cancelGoogleWebhook(userId);
      await setupGoogleWebhook(userId);
    }

    // Executar sincronização incremental
    await performIncrementalSync(userId);

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Cron sync error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function performIncrementalSync(userId: string): Promise<void> {
  console.log(`Starting incremental sync for user: ${userId}`);

  try {
    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) {
      throw new Error('No valid access token');
    }

    const { data: connection } = await supabase
      .from('google_calendar_connections')
      .select('sync_token')
      .eq('user_id', userId)
      .single();

    const syncToken = connection?.sync_token;

    // CORRIGIDO: Sem sync token → usar performInitialSync como fallback seguro
    // ANTES: fallback usava singleEvents: true que expandia eventos recorrentes
    // em centenas/milhares de instâncias individuais (bug dos eventos em 2030+)
    if (!syncToken) {
      console.log('No sync token available, performing initial sync as fallback...');
      await performInitialSync(userId);
      return;
    }

    // Sync incremental com syncToken
    // IMPORTANTE: NÃO usar singleEvents aqui!
    // singleEvents: true expande eventos recorrentes em instâncias individuais,
    // o que causava centenas de eventos junk com datas em 2030+
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    url.searchParams.set('syncToken', syncToken);
    url.searchParams.set('maxResults', '250');
    url.searchParams.set('showDeleted', 'true');

    console.log('Fetching changes from Google Calendar...');
    const response = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      // Se sync token inválido/expirado, limpar e fazer sync inicial
      if (response.status === 410) {
        console.log('Sync token expired (410), clearing and doing initial sync...');
        await supabase
          .from('google_calendar_connections')
          .update({ sync_token: null })
          .eq('user_id', userId);
        await performInitialSync(userId);
        return;
      }
      throw new Error(`Google API error: ${response.status}`);
    }

    const data = await response.json();
    const newSyncToken = data.nextSyncToken;
    const events = data.items || [];

    console.log(`Processing ${events.length} changed events`);

    // Processar mudanças
    for (const gEvent of events) {
      await processEventChange(userId, gEvent);
    }

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
    throw error;
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
