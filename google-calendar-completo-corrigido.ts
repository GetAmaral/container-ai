// ============================================================
// EDGE FUNCTION: google-calendar (VERSÃO CORRIGIDA)
// ============================================================
// Correções aplicadas:
// 1. performIncrementalSync: NÃO usa singleEvents + syncToken juntos
// 2. processEventChange: suporta eventos de dia inteiro e recorrentes
// 3. Novo: performSyncWithToken + performFullTimeRangeSync + syncRecurringEventInstances
// 4. handleCronSync: melhor tratamento de erro
// ============================================================

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const googleClientId = Deno.env.get('GOOGLE_CLIENT_ID')!;
const googleClientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')!;

const PRODUCTION_URL = 'https://totalassistente.com.br';
const DEVELOPMENT_URL = 'https://ignorethissiteavtotal.lovable.app';

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// =============================================
// HELPERS
// =============================================

function parseState(state: string) {
  try {
    const parsed = JSON.parse(atob(state));
    return {
      userId: parsed.userId || state,
      origin: parsed.origin || PRODUCTION_URL
    };
  } catch {
    return {
      userId: state,
      origin: PRODUCTION_URL
    };
  }
}

function createState(userId: string, origin: string) {
  return btoa(JSON.stringify({ userId, origin }));
}

function getOriginUrl(referer: string | null) {
  if (referer) {
    if (referer.includes('ignorethissiteavtotal.lovable.app')) {
      return DEVELOPMENT_URL;
    }
  }
  return PRODUCTION_URL;
}

// =============================================
// MAIN SERVE
// =============================================

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  // A) Início do fluxo OAuth
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

  // B) Callback com erro
  if (req.method === 'GET' && error) {
    console.error('OAuth error:', error);
    const { origin } = state ? parseState(state) : { origin: PRODUCTION_URL };
    return Response.redirect(`${origin}/auth/google-calendar?error=${encodeURIComponent(error)}`, 302);
  }

  // C) Callback com code
  if (req.method === 'GET' && code && state) {
    const { userId, origin } = parseState(state);
    const result = await handleCallback(userId, code);
    const success = result.status === 200;

    if (success) {
      return Response.redirect(`${origin}/auth/google-calendar?success=true`, 302);
    } else {
      return Response.redirect(`${origin}/auth/google-calendar?error=${encodeURIComponent('Falha ao conectar')}`, 302);
    }
  }

  // D) JSON API
  try {
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized - Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const token = authHeader.replace('Bearer ', '');
    const body = await req.json();
    const { action, eventId, event, userId, renewWebhook } = body;

    console.log('Received request:', { action, eventId, userId });

    let finalUserId: string;

    if (token === supabaseServiceRoleKey) {
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Missing userId for service role request' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      finalUserId = userId;
    } else {
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized - Invalid token' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      if (userId && userId !== user.id) {
        console.error(`Security breach attempt: User ${user.id} tried to act as ${userId}`);
        return new Response(JSON.stringify({ error: 'Unauthorized - User ID mismatch' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      finalUserId = user.id;
    }

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
  } catch (error: any) {
    console.error('Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// =============================================
// AUTH
// =============================================

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
        redirect_uri: redirectUri
      })
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed: ${tokenData.error}`);
    }

    const { error } = await supabase.rpc('store_google_connection', {
      p_user_id: userId,
      p_access_token: tokenData.access_token,
      p_refresh_token: tokenData.refresh_token,
      p_expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
      p_connected_email: tokenData.email || null,
      p_scope: tokenData.scope || 'https://www.googleapis.com/auth/calendar'
    });

    if (error) {
      throw new Error('Failed to store connection status');
    }

    // Background: sync inicial + webhook
    EdgeRuntime.waitUntil((async () => {
      try {
        console.log('Starting background sync and webhook setup');
        await performInitialSync(userId);
        await setupGoogleWebhook(userId);
        console.log('Background sync and webhook completed');
      } catch (error) {
        console.error('Background setup failed:', error);
      }
    })());

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('Callback error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// =============================================
// TOKEN MANAGEMENT
// =============================================

async function getValidAccessToken(userId: string) {
  try {
    const { data: tokens, error } = await supabase
      .rpc('secure_get_google_tokens', { p_user_id: userId })
      .single();

    if (error) {
      console.error('Error getting tokens:', error);
      await supabase.rpc('log_failed_token_access', { p_user_id: userId, p_ip_hash: null });
      return null;
    }

    if (!tokens || !tokens.is_connected) {
      console.error('No connection found for user:', userId);
      return null;
    }

    if (tokens.expires_at && new Date() >= new Date(tokens.expires_at)) {
      console.log('Token expired, attempting refresh...');
      const refreshedToken = await refreshAccessToken(userId, tokens.refresh_token || '');
      if (refreshedToken) {
        await supabase.rpc('reset_failed_token_access', { p_user_id: userId });
      }
      return refreshedToken;
    }

    await supabase.rpc('reset_failed_token_access', { p_user_id: userId });
    return tokens.access_token || '';
  } catch (error) {
    console.error('Error getting access token:', error);
    await supabase.rpc('log_failed_token_access', { p_user_id: userId, p_ip_hash: null });
    return null;
  }
}

async function refreshAccessToken(userId: string, refreshToken: string) {
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: googleClientId,
        client_secret: googleClientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      })
    });

    const tokenData = await response.json();
    if (!response.ok) {
      throw new Error(`Token refresh failed: ${tokenData.error}`);
    }

    const { error } = await supabase.rpc('store_access_token', {
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

// =============================================
// CRUD DE EVENTOS
// =============================================

async function handleCreateEvent(userId: string, eventData: any) {
  try {
    console.log('Creating Google Calendar event');
    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) throw new Error('No valid access token found');

    const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(eventData)
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(`Google Calendar API error: ${result.error?.message || response.status}`);
    }

    console.log('Event created successfully, ID:', result.id);
    return new Response(JSON.stringify({ eventId: result.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('Create event error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleUpdateEvent(userId: string, eventId: string, eventData: any) {
  try {
    console.log('Updating Google Calendar event:', eventId);
    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) throw new Error('No valid access token found');

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(eventData)
      }
    );

    const result = await response.json();
    if (!response.ok) {
      throw new Error(`Google Calendar API error: ${result.error?.message || response.status}`);
    }

    return new Response(JSON.stringify({ eventId: result.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('Update event error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleDeleteEvent(userId: string, eventId: string) {
  try {
    console.log('Deleting Google Calendar event:', eventId);
    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) throw new Error('No valid access token found');

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${accessToken}` }
      }
    );

    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(`Google Calendar API error: ${result.error?.message || response.status}`);
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('Delete event error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// =============================================
// DISCONNECT
// =============================================

async function handleDisconnect(userId: string) {
  try {
    console.log(`Disconnecting Google Calendar for user: ${userId}`);

    // 1. Cancelar webhook
    try { await cancelGoogleWebhook(userId); } catch (e) { console.error('Webhook cancel error:', e); }

    // 2. Revogar token
    try {
      const { data: tokens } = await supabase
        .rpc('secure_get_google_tokens', { p_user_id: userId })
        .single();
      if (tokens?.refresh_token) {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${tokens.refresh_token}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
      }
    } catch (e) { console.error('Token revoke error:', e); }

    // 3. Remover eventos do Google
    const { data: deletedCount } = await supabase
      .rpc('remove_google_calendar_events', { p_user_id: userId })
      .single();

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
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ success: true, deleted: deletedCount || 0 }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('Disconnect error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// =============================================
// MANUAL SYNC
// =============================================

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
        return new Response(JSON.stringify({
          error: 'Please wait before syncing again',
          retryAfter: Math.ceil(5 - diffMinutes)
        }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    const result = await performInitialSync(userId);
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('Sync error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// =============================================
// INITIAL SYNC (primeiro sync após conectar)
// =============================================

async function performInitialSync(userId: string) {
  try {
    console.log(`🔄 Starting initial sync for user: ${userId}`);

    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) throw new Error('No valid access token');

    const timeMin = new Date();
    timeMin.setMonth(timeMin.getMonth() - 1);
    const timeMax = new Date();
    timeMax.setMonth(timeMax.getMonth() + 6);

    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    url.searchParams.set('timeMin', timeMin.toISOString());
    url.searchParams.set('timeMax', timeMax.toISOString());
    url.searchParams.set('maxResults', '500');
    url.searchParams.set('singleEvents', 'true');  // ✅ OK: sem syncToken
    url.searchParams.set('orderBy', 'startTime');

    console.log('📡 Fetching events from Google Calendar...');

    const response = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Google API error: ${errorData.error?.message || response.status}`);
    }

    const data = await response.json();
    const googleEvents = data.items || [];
    const nextSyncToken = data.nextSyncToken;

    console.log(`📥 Found ${googleEvents.length} events in Google Calendar`);

    // Buscar eventos existentes
    const { data: existingEvents, error: fetchError } = await supabase
      .from('calendar')
      .select('session_event_id_google, event_name, start_event')
      .eq('user_id', userId)
      .not('session_event_id_google', 'is', null);

    if (fetchError) throw fetchError;

    const existingGoogleIds = new Set((existingEvents || []).map(e => e.session_event_id_google));

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];
    const eventsToInsert: any[] = [];

    for (const gEvent of googleEvents) {
      try {
        if (existingGoogleIds.has(gEvent.id)) { skipped++; continue; }
        if (!gEvent.start?.dateTime || !gEvent.end?.dateTime) { skipped++; continue; }

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
          connect_google: true,
          active: true
        });
      } catch (err: any) {
        errors.push(`Event ${gEvent.summary}: ${err.message}`);
      }
    }

    // Inserir em batch
    if (eventsToInsert.length > 0) {
      console.log(`📤 Inserting ${eventsToInsert.length} new events...`);
      for (let i = 0; i < eventsToInsert.length; i += 100) {
        const batch = eventsToInsert.slice(i, i + 100);
        const { error: insertError } = await supabase.from('calendar').insert(batch);
        if (insertError) {
          errors.push(`Batch ${i / 100 + 1}: ${insertError.message}`);
        } else {
          imported += batch.length;
        }
      }
    }

    // Salvar sync token
    const updateData: any = { last_sync_at: new Date().toISOString() };
    if (nextSyncToken) updateData.sync_token = nextSyncToken;

    await supabase
      .from('google_calendar_connections')
      .update(updateData)
      .eq('user_id', userId);

    console.log(`✅ Initial sync completed: ${imported} imported, ${skipped} skipped. Token: ${!!nextSyncToken}`);

    return { success: true, imported, skipped, errors: errors.length > 0 ? errors : undefined };
  } catch (error) {
    console.error('performInitialSync error:', error);
    throw error;
  }
}

// =============================================
// INCREMENTAL SYNC (CORRIGIDO — BUG PRINCIPAL)
// =============================================

async function performIncrementalSync(userId: string) {
  console.log(`🔄 Starting incremental sync for user: ${userId}`);

  try {
    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) throw new Error('No valid access token');

    const { data: connection } = await supabase
      .from('google_calendar_connections')
      .select('sync_token')
      .eq('user_id', userId)
      .single();

    const syncToken = connection?.sync_token;

    // =============================================
    // CAMINHO 1: Com syncToken (incremental real)
    // =============================================
    if (syncToken) {
      try {
        await performSyncWithToken(userId, accessToken, syncToken);
        return;
      } catch (error: any) {
        const errMsg = error?.message || '';

        // 410 = sync token expirado
        // 400 = token inválido / parâmetros incompatíveis
        if (errMsg.includes('410') || errMsg.includes('400')) {
          console.log(`⚠️ Sync token invalid (${errMsg}), clearing and doing full sync...`);
          await supabase
            .from('google_calendar_connections')
            .update({ sync_token: null })
            .eq('user_id', userId);
          // Fall through para o caminho 2
        } else {
          throw error;
        }
      }
    }

    // =============================================
    // CAMINHO 2: Sem syncToken — full sync com singleEvents
    // =============================================
    await performFullTimeRangeSync(userId, accessToken);

  } catch (error) {
    console.error('❌ Incremental sync error:', error);
    throw error;
  }
}

// -----------------------------------------------
// SYNC COM TOKEN (NÃO usa singleEvents — regra do Google)
// -----------------------------------------------
async function performSyncWithToken(userId: string, accessToken: string, syncToken: string) {
  let nextPageToken: string | undefined = undefined;
  let newSyncToken: string | undefined = undefined;

  do {
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');

    if (nextPageToken) {
      url.searchParams.set('pageToken', nextPageToken);
    } else {
      url.searchParams.set('syncToken', syncToken);
    }

    // ⚠️ CORREÇÃO PRINCIPAL: NÃO setar singleEvents com syncToken
    // A API do Google retorna 400 se ambos forem enviados juntos.
    url.searchParams.set('maxResults', '250');

    console.log('📡 Fetching changes with syncToken...', nextPageToken ? '(next page)' : '');

    const response = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const status = response.status;
      console.error(`❌ Google API error ${status}:`, errorData);
      throw new Error(`Google API error: ${status} - ${errorData?.error?.message || 'Unknown'}`);
    }

    const data = await response.json();
    nextPageToken = data.nextPageToken;
    newSyncToken = data.nextSyncToken;

    const events = data.items || [];
    console.log(`📥 Processing ${events.length} changed events`);

    for (const gEvent of events) {
      // Detectar master event recorrente (tem recurrence[] mas não é instância)
      if (gEvent.recurrence && !gEvent.recurringEventId) {
        console.log(`🔁 Recurring master event: ${gEvent.summary} (${gEvent.id})`);
        await syncRecurringEventInstances(userId, accessToken, gEvent);
        continue;
      }

      await processEventChange(userId, gEvent);
    }
  } while (nextPageToken);

  // Salvar novo sync token
  const updateData: any = { last_sync_at: new Date().toISOString() };
  if (newSyncToken) updateData.sync_token = newSyncToken;

  await supabase
    .from('google_calendar_connections')
    .update(updateData)
    .eq('user_id', userId);

  console.log(`✅ Sync with token completed for user ${userId}`);
}

// -----------------------------------------------
// SYNC DE INSTÂNCIAS DE EVENTO RECORRENTE
// -----------------------------------------------
async function syncRecurringEventInstances(userId: string, accessToken: string, masterEvent: any) {
  try {
    const timeMin = new Date();
    timeMin.setMonth(timeMin.getMonth() - 1);
    const timeMax = new Date();
    timeMax.setMonth(timeMax.getMonth() + 6);

    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${masterEvent.id}/instances`
    );
    url.searchParams.set('timeMin', timeMin.toISOString());
    url.searchParams.set('timeMax', timeMax.toISOString());
    url.searchParams.set('maxResults', '100');

    const response = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!response.ok) {
      console.error(`Failed to fetch instances for ${masterEvent.id}: ${response.status}`);
      return;
    }

    const data = await response.json();
    const instances = data.items || [];
    console.log(`  → ${instances.length} instances for "${masterEvent.summary}"`);

    for (const instance of instances) {
      await processEventChange(userId, instance);
    }
  } catch (error) {
    console.error(`Error syncing instances for ${masterEvent.id}:`, error);
  }
}

// -----------------------------------------------
// FULL SYNC COM TIME RANGE (com singleEvents=true)
// -----------------------------------------------
async function performFullTimeRangeSync(userId: string, accessToken: string) {
  console.log(`🔄 Full time-range sync for user: ${userId}`);

  const timeMin = new Date();
  timeMin.setMonth(timeMin.getMonth() - 1);
  const timeMax = new Date();
  timeMax.setMonth(timeMax.getMonth() + 6);

  let nextPageToken: string | undefined = undefined;
  let newSyncToken: string | undefined = undefined;
  let totalProcessed = 0;

  do {
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');

    if (nextPageToken) {
      url.searchParams.set('pageToken', nextPageToken);
    } else {
      url.searchParams.set('timeMin', timeMin.toISOString());
      url.searchParams.set('timeMax', timeMax.toISOString());
    }

    url.searchParams.set('maxResults', '250');
    url.searchParams.set('singleEvents', 'true');  // ✅ OK aqui: sem syncToken
    url.searchParams.set('orderBy', 'startTime');

    const response = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Google API error: ${response.status} - ${errorData?.error?.message || 'Unknown'}`);
    }

    const data = await response.json();
    nextPageToken = data.nextPageToken;
    newSyncToken = data.nextSyncToken;

    const events = data.items || [];
    console.log(`📥 Processing ${events.length} events (full sync)`);

    for (const gEvent of events) {
      await processEventChange(userId, gEvent);
      totalProcessed++;
    }
  } while (nextPageToken);

  const updateData: any = { last_sync_at: new Date().toISOString() };
  if (newSyncToken) updateData.sync_token = newSyncToken;

  await supabase
    .from('google_calendar_connections')
    .update(updateData)
    .eq('user_id', userId);

  console.log(`✅ Full sync completed: ${totalProcessed} events. Token: ${!!newSyncToken}`);
}

// =============================================
// PROCESS EVENT CHANGE (CORRIGIDO)
// =============================================

async function processEventChange(userId: string, gEvent: any) {
  try {
    const googleEventId = gEvent.id;

    // Evento deletado/cancelado no Google
    if (gEvent.status === 'cancelled') {
      console.log(`🗑️ Removing: ${googleEventId}`);
      await supabase
        .from('calendar')
        .delete()
        .eq('user_id', userId)
        .eq('session_event_id_google', googleEventId);
      return;
    }

    // Determinar start/end (suportar dateTime E date)
    let startEvent: string | null = null;
    let endEvent: string | null = null;

    if (gEvent.start?.dateTime) {
      startEvent = gEvent.start.dateTime;
    } else if (gEvent.start?.date) {
      startEvent = `${gEvent.start.date}T00:00:00-03:00`;
    }

    if (gEvent.end?.dateTime) {
      endEvent = gEvent.end.dateTime;
    } else if (gEvent.end?.date) {
      endEvent = `${gEvent.end.date}T23:59:59-03:00`;
    }

    if (!startEvent || !endEvent) {
      console.log(`⏭️ Skipping (no dates): ${gEvent.summary || googleEventId}`);
      return;
    }

    // Checar se já existe
    const { data: existing } = await supabase
      .from('calendar')
      .select('id, event_name, start_event, end_event, desc_event')
      .eq('user_id', userId)
      .eq('session_event_id_google', googleEventId)
      .maybeSingle();

    const eventData = {
      event_name: (gEvent.summary || 'Sem título').substring(0, 255),
      desc_event: (gEvent.description || '').substring(0, 5000),
      start_event: startEvent,
      end_event: endEvent,
      timezone: gEvent.start?.timeZone || 'America/Sao_Paulo',
      calendar_email_created: gEvent.creator?.email || null
    };

    if (existing) {
      const hasChanged =
        existing.event_name !== eventData.event_name ||
        existing.start_event !== eventData.start_event ||
        existing.end_event !== eventData.end_event ||
        (existing.desc_event || '') !== eventData.desc_event;

      if (hasChanged) {
        console.log(`📝 Updating: "${eventData.event_name}" (${googleEventId})`);
        await supabase.from('calendar').update(eventData).eq('id', existing.id);
      }
    } else {
      console.log(`➕ Creating: "${eventData.event_name}" (${googleEventId})`);
      await supabase.from('calendar').insert({
        user_id: userId,
        session_event_id_google: googleEventId,
        reminder: false,
        remembered: false,
        active: true,
        connect_google: true,
        ...eventData
      });
    }
  } catch (error) {
    console.error(`Error processing event ${gEvent.id}:`, error);
  }
}

// =============================================
// CRON SYNC (CORRIGIDO)
// =============================================

async function handleCronSync(userId: string, renewWebhook = false) {
  try {
    console.log(`⏰ Cron sync for user: ${userId}`);

    if (renewWebhook) {
      try { await cancelGoogleWebhook(userId); } catch (e) { console.error('Cancel webhook err:', e); }
      try { await setupGoogleWebhook(userId); } catch (e) { console.error('Setup webhook err:', e); }
    }

    await performIncrementalSync(userId);

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('Cron sync error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// =============================================
// WEBHOOK SETUP / CANCEL
// =============================================

async function setupGoogleWebhook(userId: string) {
  try {
    console.log(`🔔 Setting up webhook for user: ${userId}`);

    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) throw new Error('No valid access token');

    const webhookUrl = `${supabaseUrl}/functions/v1/google-calendar-webhook`;
    const channelId = `calendar-${userId}-${Date.now()}`;
    const expiration = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 dias

    const response = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/watch',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          id: channelId,
          type: 'web_hook',
          address: webhookUrl,
          expiration: expiration.toString()
        })
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Webhook setup failed: ${error.error?.message || response.status}`);
    }

    const data = await response.json();
    console.log('✅ Webhook registered:', data);

    await supabase
      .from('google_calendar_connections')
      .update({
        webhook_id: channelId,
        webhook_resource_id: data.resourceId,
        webhook_expiration: new Date(parseInt(data.expiration)).toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    console.log('✅ Webhook setup completed');
  } catch (error) {
    console.error('Webhook setup error:', error);
  }
}

async function cancelGoogleWebhook(userId: string) {
  try {
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

    const response = await fetch('https://www.googleapis.com/calendar/v3/channels/stop', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        id: connection.webhook_id,
        resourceId: connection.webhook_resource_id
      })
    });

    if (response.ok) {
      console.log('✅ Webhook canceled');
    } else {
      console.log('⚠️ Webhook cancel failed (may already be expired)');
    }
  } catch (error) {
    console.error('Webhook cancel error:', error);
  }
}