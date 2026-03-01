// =============================================================================
// google-calendar/index.ts — CORRIGIDO
//
// Mudancas vs original:
//   - performInitialSync: REMOVIDO singleEvents/orderBy, ADICIONADO recurrence handling
//   - performIncrementalSync: REMOVIDO singleEvents, ADICIONADO paginacao, fallback corrigido
//   - processEventChange: ADICIONADO recurrence handling + _syncing_from_google
//   - NOVO: handlePushToGoogle (chamado pelo trigger SQL)
//   - NOVO: parseGoogleRecurrence, calculateNextOccurrence helpers
//   - Tudo mais IDENTICO ao original
// =============================================================================

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

// URLs do frontend para redirecionamento apos OAuth
const PRODUCTION_URL = 'https://totalassistente.com.br';
const DEVELOPMENT_URL = 'https://ignorethissiteavtotal.lovable.app';

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// Helper para extrair userId e origin do state
function parseState(state: string): { userId: string; origin: string } {
  try {
    const parsed = JSON.parse(atob(state));
    return {
      userId: parsed.userId || state,
      origin: parsed.origin || PRODUCTION_URL
    };
  } catch {
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

  // A) Inicio do fluxo: sem code e sem error -> redireciona pro OAuth do Google
  if (req.method === 'GET' && !code && !error) {
    const redirectUri = `${supabaseUrl}/functions/v1/google-calendar`;
    const scope = 'https://www.googleapis.com/auth/calendar';
    const userIdParam = url.searchParams.get('userId') || '';
    const referer = req.headers.get('referer');
    const originUrl = getOriginUrl(referer);

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

  // B) Callback: se houver erro do Google
  if (req.method === 'GET' && error) {
    console.error('OAuth error:', error);
    const { origin } = state ? parseState(state) : { origin: PRODUCTION_URL };
    const errorRedirectUrl = `${origin}/auth/google-calendar?error=${encodeURIComponent(error)}`;
    return Response.redirect(errorRedirectUrl, 302);
  }

  // C) Callback: se houver code -> troca por tokens, salva e redireciona
  if (req.method === 'GET' && code && state) {
    const { userId, origin } = parseState(state);
    const result = await handleCallback(userId, code);
    const success = result.status === 200;

    if (success) {
      const successRedirectUrl = `${origin}/auth/google-calendar?success=true`;
      return Response.redirect(successRedirectUrl, 302);
    } else {
      const errorRedirectUrl = `${origin}/auth/google-calendar?error=${encodeURIComponent('Falha ao conectar')}`;
      return Response.redirect(errorRedirectUrl, 302);
    }
  }

  // JSON API para as outras acoes
  try {
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized - Missing authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const token = authHeader.replace('Bearer ', '');
    const body = await req.json();
    const { action, eventId, event, userId, renewWebhook, calendarRowId } = body;
    console.log('Received request:', { action, eventId, userId });

    let finalUserId: string;

    if (token === supabaseServiceRoleKey) {
      if (!userId) {
        return new Response(
          JSON.stringify({ error: 'Missing userId for service role request' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      finalUserId = userId;
    } else {
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        console.error('Authentication error:', authError);
        return new Response(
          JSON.stringify({ error: 'Unauthorized - Invalid token' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (userId && userId !== user.id) {
        console.error(`Security breach attempt: User ${user.id} tried to act as ${userId}`);
        return new Response(
          JSON.stringify({ error: 'Unauthorized - User ID mismatch' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      finalUserId = user.id;
    }

    // Cron sync (chamado pelo webhook e pelo cron)
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
      // NOVO: chamado pelo trigger SQL para sincronizar evento local -> Google
      case 'push-to-google':
        return handlePushToGoogle(finalUserId, calendarRowId);
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

// =============================================================================
// AUTH (sem mudanca)
// =============================================================================

async function handleAuth(userId: string) {
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

    // Background: sync inicial + webhook
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

// =============================================================================
// TOKENS (sem mudanca)
// =============================================================================

async function getValidAccessToken(userId: string): Promise<string | null> {
  try {
    const { data: tokens, error } = await supabase
      .rpc('secure_get_google_tokens', { p_user_id: userId })
      .single();

    if (error) {
      console.error('Error getting tokens:', error);
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
        await supabase.rpc('reset_failed_token_access', { p_user_id: userId });
      }
      return refreshedToken;
    }

    await supabase.rpc('reset_failed_token_access', { p_user_id: userId });
    return (tokens as any).access_token || '';
  } catch (error) {
    console.error('Error getting access token:', error);
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

// =============================================================================
// CRUD EVENTS (sem mudanca)
// =============================================================================

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

// =============================================================================
// DISCONNECT (sem mudanca)
// =============================================================================

async function handleDisconnect(userId: string) {
  try {
    console.log(`Disconnecting Google Calendar for user: ${userId}`);

    try {
      await cancelGoogleWebhook(userId);
    } catch (error) {
      console.error('Error canceling webhook:', error);
    }

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

    const { data: deletedCount } = await supabase
      .rpc('remove_google_calendar_events', { p_user_id: userId })
      .single();

    console.log(`Removed ${deletedCount || 0} Google Calendar events`);

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

// =============================================================================
// MANUAL SYNC (sem mudanca)
// =============================================================================

async function handleSyncFromGoogle(userId: string) {
  try {
    console.log(`Manual sync requested for user: ${userId}`);

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

// =============================================================================
// HELPERS PARA RECORRENCIA (NOVO)
// =============================================================================

/**
 * Extrai hora/minuto/segundo do datetime string (hora LOCAL do evento).
 * Ex: "2026-03-02T19:00:00-03:00" -> { hours: 19, minutes: 0, seconds: 0 }
 */
function extractLocalTime(dateTimeStr: string): { hours: number; minutes: number; seconds: number } {
  const match = dateTimeStr.match(/T(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return { hours: 0, minutes: 0, seconds: 0 };
  return {
    hours: parseInt(match[1]),
    minutes: parseInt(match[2]),
    seconds: parseInt(match[3]),
  };
}

/**
 * Converte recurrence do Google para rrule da tabela calendar.
 * Google: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE"]
 * Resultado: "FREQ=WEEKLY;BYDAY=MO,TU,WE;BYHOUR=19;BYMINUTE=0;BYSECOND=0"
 */
function parseGoogleRecurrence(recurrence: string[], startDateTime: string): string | null {
  if (!recurrence || recurrence.length === 0) return null;

  // Encontrar a linha RRULE
  const rruleLine = recurrence.find(r => r.startsWith('RRULE:'));
  if (!rruleLine) return null;

  // Strip "RRULE:" prefix
  let rrule = rruleLine.replace('RRULE:', '');

  // Adicionar BYHOUR/BYMINUTE/BYSECOND do start time (se nao presentes)
  const { hours, minutes, seconds } = extractLocalTime(startDateTime);

  if (!rrule.includes('BYHOUR')) {
    rrule += `;BYHOUR=${hours}`;
  }
  if (!rrule.includes('BYMINUTE')) {
    rrule += `;BYMINUTE=${minutes}`;
  }
  if (!rrule.includes('BYSECOND')) {
    rrule += `;BYSECOND=${seconds}`;
  }

  return rrule;
}

/**
 * Calcula proxima ocorrencia baseado no rrule.
 * Implementacao simples para DAILY/WEEKLY/MONTHLY/YEARLY.
 * Para BYDAY complexo, retorna a proxima data aproximada.
 */
function calculateNextOccurrence(rrule: string, startDateTime: string): string | null {
  try {
    const now = new Date();
    const start = new Date(startDateTime);

    // Se o start e futuro, ele E a proxima ocorrencia
    if (start > now) return start.toISOString();

    // Parse RRULE
    const parts: Record<string, string> = {};
    rrule.split(';').forEach(part => {
      const eqIdx = part.indexOf('=');
      if (eqIdx > 0) {
        parts[part.substring(0, eqIdx)] = part.substring(eqIdx + 1);
      }
    });

    const freq = parts['FREQ'];
    const interval = parseInt(parts['INTERVAL'] || '1');
    const count = parts['COUNT'] ? parseInt(parts['COUNT']) : null;
    const until = parts['UNTIL'] ? new Date(parts['UNTIL']) : null;

    let next = new Date(start);
    let iterations = 0;
    const maxIterations = 1000;

    while (next <= now && iterations < maxIterations) {
      switch (freq) {
        case 'DAILY':
          next.setDate(next.getDate() + interval);
          break;
        case 'WEEKLY':
          next.setDate(next.getDate() + (7 * interval));
          break;
        case 'MONTHLY':
          next.setMonth(next.getMonth() + interval);
          break;
        case 'YEARLY':
          next.setFullYear(next.getFullYear() + interval);
          break;
        default:
          return null;
      }
      iterations++;

      // Checar COUNT
      if (count && iterations >= count) return null;
      // Checar UNTIL
      if (until && next > until) return null;
    }

    return iterations < maxIterations ? next.toISOString() : null;
  } catch {
    return null;
  }
}

// =============================================================================
// INITIAL SYNC (MODIFICADO)
// - REMOVIDO: singleEvents: true, orderBy: startTime
// - ADICIONADO: recurrence handling (is_recurring, rrule, next_fire_at)
// - ADICIONADO: _syncing_from_google: true em todos os inserts
// =============================================================================

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

    // Buscar eventos dos ultimos 1 mes e proximos 6 meses
    const timeMin = new Date();
    timeMin.setMonth(timeMin.getMonth() - 1);

    const timeMax = new Date();
    timeMax.setMonth(timeMax.getMonth() + 6);

    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    url.searchParams.set('timeMin', timeMin.toISOString());
    url.searchParams.set('timeMax', timeMax.toISOString());
    url.searchParams.set('maxResults', '500');
    // >>> REMOVIDO: singleEvents e orderBy <<<
    // Sem singleEvents, eventos recorrentes vem como master com campo recurrence

    console.log('Fetching events from Google Calendar (sem singleEvents)...');
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
    const nextSyncToken = data.nextSyncToken;
    console.log(`Found ${googleEvents.length} events in Google Calendar`);

    // Buscar eventos existentes do usuario
    const { data: existingEvents, error: fetchError } = await supabase
      .from('calendar')
      .select('session_event_id_google, event_name, start_event')
      .eq('user_id', userId)
      .not('session_event_id_google', 'is', null);

    if (fetchError) {
      console.error('Error fetching existing events:', fetchError);
      throw fetchError;
    }

    const existingGoogleIds = new Set(
      (existingEvents || []).map(e => e.session_event_id_google)
    );

    console.log(`Found ${existingGoogleIds.size} existing synced events in database`);

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];
    const eventsToInsert: any[] = [];

    for (const gEvent of googleEvents) {
      try {
        // Pular se ja existe
        if (existingGoogleIds.has(gEvent.id)) {
          skipped++;
          continue;
        }

        // Validar campos obrigatorios (pular eventos de dia inteiro)
        if (!gEvent.start?.dateTime || !gEvent.end?.dateTime) {
          skipped++;
          continue;
        }

        // Base do evento
        const eventRecord: any = {
          user_id: userId,
          event_name: (gEvent.summary || 'Sem titulo').substring(0, 255),
          desc_event: (gEvent.description || '').substring(0, 5000),
          start_event: gEvent.start.dateTime,
          end_event: gEvent.end.dateTime,
          session_event_id_google: gEvent.id,
          reminder: false,
          remembered: false,
          timezone: gEvent.start.timeZone || 'America/Sao_Paulo',
          calendar_email_created: gEvent.creator?.email || null,
          active: true,
          _syncing_from_google: true, // <<< NOVO: previne trigger loop
        };

        // >>> NOVO: handling de eventos recorrentes <<<
        if (gEvent.recurrence && Array.isArray(gEvent.recurrence)) {
          // Evento master recorrente
          const rrule = parseGoogleRecurrence(gEvent.recurrence, gEvent.start.dateTime);
          eventRecord.is_recurring = true;
          eventRecord.rrule = rrule;
          eventRecord.next_fire_at = calculateNextOccurrence(
            rrule || '', gEvent.start.dateTime
          );
        } else if (gEvent.recurringEventId) {
          // Instancia modificada de evento recorrente: armazenar como individual
          eventRecord.is_recurring = false;
          // Manter o ID original (com sufixo) para rastreamento
        } else {
          // Evento normal
          eventRecord.is_recurring = false;
        }

        eventsToInsert.push(eventRecord);

      } catch (err) {
        console.error(`Error processing event ${gEvent.id}:`, err);
        errors.push(`Event ${gEvent.summary}: ${(err as Error).message}`);
      }
    }

    // Inserir em batch (maximo 100 por vez)
    if (eventsToInsert.length > 0) {
      console.log(`Inserting ${eventsToInsert.length} new events...`);

      for (let i = 0; i < eventsToInsert.length; i += 100) {
        const batch = eventsToInsert.slice(i, i + 100);

        const { error: insertError } = await supabase
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

    // Atualizar timestamp e sync_token
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

// =============================================================================
// WEBHOOK (sem mudanca)
// =============================================================================

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

// =============================================================================
// CRON SYNC (sem mudanca)
// =============================================================================

async function handleCronSync(userId: string, renewWebhook: boolean = false) {
  try {
    console.log(`Cron sync for user: ${userId}`);

    if (renewWebhook) {
      await cancelGoogleWebhook(userId);
      await setupGoogleWebhook(userId);
    }

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

// =============================================================================
// INCREMENTAL SYNC (MODIFICADO)
// - REMOVIDO: singleEvents: true
// - ADICIONADO: paginacao com nextPageToken
// - Sem syncToken: fallback para performInitialSync
// =============================================================================

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

    // Sem syncToken: fazer full sync como fallback
    if (!syncToken) {
      console.log('No sync token, falling back to initial sync');
      await performInitialSync(userId);
      return;
    }

    // Com syncToken: buscar apenas mudancas
    let nextPageToken: string | undefined = undefined;
    let newSyncToken: string | undefined = undefined;

    do {
      const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
      if (nextPageToken) {
        url.searchParams.set('pageToken', nextPageToken);
      } else {
        url.searchParams.set('syncToken', syncToken);
      }
      url.searchParams.set('maxResults', '250');
      // >>> REMOVIDO: singleEvents: true <<<
      // Sem singleEvents, recebe master events com recurrence

      console.log('Fetching changes from Google Calendar...', nextPageToken ? '(next page)' : '');
      const response = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        // Sync token expirado/invalido -> full sync
        if (response.status === 410) {
          console.log('Sync token expired, clearing and doing full sync...');
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
      nextPageToken = data.nextPageToken;
      newSyncToken = data.nextSyncToken;
      const events = data.items || [];

      console.log(`Processing ${events.length} changed events`);

      // Processar mudancas
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
    throw error;
  }
}

// =============================================================================
// PROCESS EVENT CHANGE (MODIFICADO)
// - ADICIONADO: recurrence handling (is_recurring, rrule, next_fire_at)
// - ADICIONADO: _syncing_from_google: true em todos os inserts/updates
// =============================================================================

async function processEventChange(userId: string, gEvent: any): Promise<void> {
  try {
    const googleEventId = gEvent.id;

    // Evento deletado ou cancelado
    if (gEvent.status === 'cancelled') {
      console.log(`Deleting event ${googleEventId} (cancelled in Google)`);
      await supabase
        .from('calendar')
        .delete()
        .eq('user_id', userId)
        .eq('session_event_id_google', googleEventId);
      return;
    }

    // Pular eventos de dia inteiro
    if (!gEvent.start?.dateTime || !gEvent.end?.dateTime) {
      return;
    }

    // Verificar se evento ja existe
    const { data: existing } = await supabase
      .from('calendar')
      .select('id, event_name, start_event, end_event, desc_event, is_recurring, rrule')
      .eq('user_id', userId)
      .eq('session_event_id_google', googleEventId)
      .maybeSingle();

    // Dados base do evento
    const eventData: any = {
      event_name: (gEvent.summary || 'Sem titulo').substring(0, 255),
      desc_event: (gEvent.description || '').substring(0, 5000),
      start_event: gEvent.start.dateTime,
      end_event: gEvent.end.dateTime,
      timezone: gEvent.start.timeZone || 'America/Sao_Paulo',
      calendar_email_created: gEvent.creator?.email || null,
      _syncing_from_google: true, // <<< NOVO: previne trigger loop
    };

    // >>> NOVO: handling de recorrencia <<<
    if (gEvent.recurrence && Array.isArray(gEvent.recurrence)) {
      // Evento master recorrente
      const rrule = parseGoogleRecurrence(gEvent.recurrence, gEvent.start.dateTime);
      eventData.is_recurring = true;
      eventData.rrule = rrule;
      eventData.next_fire_at = calculateNextOccurrence(rrule || '', gEvent.start.dateTime);
    } else if (gEvent.recurringEventId) {
      // Instancia modificada: armazenar como evento individual
      eventData.is_recurring = false;
    } else {
      // Evento normal
      eventData.is_recurring = false;
    }

    if (existing) {
      // Atualizar apenas se mudou
      const hasChanged =
        existing.event_name !== eventData.event_name ||
        existing.start_event !== eventData.start_event ||
        existing.end_event !== eventData.end_event ||
        (existing.desc_event || '') !== eventData.desc_event ||
        existing.is_recurring !== eventData.is_recurring ||
        existing.rrule !== eventData.rrule;

      if (hasChanged) {
        console.log(`Updating event ${googleEventId}`);
        await supabase
          .from('calendar')
          .update(eventData)
          .eq('id', existing.id);
      }
    } else {
      // Criar novo evento
      console.log(`Creating new event ${googleEventId}`);
      await supabase
        .from('calendar')
        .insert({
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

// =============================================================================
// PUSH TO GOOGLE (NOVO)
// Chamado pelo trigger SQL quando user cria evento no app
// =============================================================================

async function handlePushToGoogle(userId: string, calendarRowId: string) {
  try {
    console.log(`Push to Google: user=${userId}, row=${calendarRowId}`);

    if (!calendarRowId) {
      return new Response(JSON.stringify({ error: 'Missing calendarRowId' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Ler evento da tabela calendar
    const { data: calEvent, error: readError } = await supabase
      .from('calendar')
      .select('*')
      .eq('id', calendarRowId)
      .eq('user_id', userId)
      .single();

    if (readError || !calEvent) {
      console.log('Event not found for push-to-google:', calendarRowId);
      return new Response(JSON.stringify({ error: 'Event not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Pular se ja tem Google ID (ja foi sincronizado)
    if (calEvent.session_event_id_google) {
      console.log('Event already synced to Google:', calEvent.session_event_id_google);
      return new Response(JSON.stringify({ skipped: true, reason: 'already synced' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Obter access token
    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) {
      console.error('No valid access token for push-to-google');
      return new Response(JSON.stringify({ error: 'No valid access token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Construir evento do Google Calendar
    const googleEvent: any = {
      summary: calEvent.event_name,
      description: calEvent.desc_event || '',
      start: {
        dateTime: calEvent.start_event,
        timeZone: calEvent.timezone || 'America/Sao_Paulo',
      },
      end: {
        dateTime: calEvent.end_event,
        timeZone: calEvent.timezone || 'America/Sao_Paulo',
      },
    };

    // Criar no Google Calendar
    const response = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(googleEvent),
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error('Google API error in push-to-google:', result.error);
      throw new Error(`Google API error: ${result.error?.message || response.status}`);
    }

    console.log('Event pushed to Google, ID:', result.id);

    // Atualizar row com o Google event ID
    // Usa _syncing_from_google=true para que o UPDATE nao dispare o trigger novamente
    await supabase
      .from('calendar')
      .update({
        session_event_id_google: result.id,
        _syncing_from_google: true,
      })
      .eq('id', calendarRowId);

    return new Response(JSON.stringify({ success: true, googleEventId: result.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Push to Google error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
