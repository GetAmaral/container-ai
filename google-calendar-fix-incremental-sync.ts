// ============================================================
// CORREÇÃO: performIncrementalSync + processEventChange
// ============================================================
// Substituir APENAS essas duas funções no google-calendar/index.ts
// O resto do arquivo permanece igual.
// ============================================================

// SUBSTITUIR a função performIncrementalSync por esta:
async function performIncrementalSync(userId: string) {
  console.log(`🔄 Starting incremental sync for user: ${userId}`);

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

    // =============================================
    // CAMINHO 1: Com syncToken (incremental real)
    // =============================================
    if (syncToken) {
      try {
        await performSyncWithToken(userId, accessToken, syncToken);
        return;
      } catch (error: any) {
        const errMsg = error?.message || '';

        // 410 = sync token expirado (Google pede full sync)
        // 400 = token inválido ou parâmetros incompatíveis
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
    // CAMINHO 2: Sem syncToken (full sync com singleEvents)
    // =============================================
    await performFullTimeRangeSync(userId, accessToken);

  } catch (error) {
    console.error('❌ Incremental sync error:', error);
    throw error;
  }
}

// -----------------------------------------------
// SYNC COM TOKEN (sem singleEvents — regra do Google)
// -----------------------------------------------
async function performSyncWithToken(userId: string, accessToken: string, syncToken: string) {
  let nextPageToken: string | undefined = undefined;
  let newSyncToken: string | undefined = undefined;
  let hasRecurringMasterEvents = false;

  do {
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');

    if (nextPageToken) {
      url.searchParams.set('pageToken', nextPageToken);
    } else {
      url.searchParams.set('syncToken', syncToken);
    }

    // ⚠️ NÃO setar singleEvents aqui!
    // A API do Google proíbe syncToken + singleEvents juntos (retorna 400).
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
      // Detectar se é um master event recorrente
      if (gEvent.recurrence && !gEvent.recurringEventId) {
        hasRecurringMasterEvents = true;
        console.log(`🔁 Recurring master event detected: ${gEvent.summary} (${gEvent.id})`);

        // Para master events, buscar as instâncias expandidas
        await syncRecurringEventInstances(userId, accessToken, gEvent);
        continue;
      }

      await processEventChange(userId, gEvent);
    }
  } while (nextPageToken);

  // Salvar novo sync token
  const updateData: any = {
    last_sync_at: new Date().toISOString()
  };
  if (newSyncToken) {
    updateData.sync_token = newSyncToken;
  }

  await supabase
    .from('google_calendar_connections')
    .update(updateData)
    .eq('user_id', userId);

  console.log(`✅ Sync with token completed for user ${userId}. New token stored: ${!!newSyncToken}`);
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

    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${masterEvent.id}/instances`);
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
    console.log(`  → ${instances.length} instances found for "${masterEvent.summary}"`);

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
  console.log(`🔄 Performing full time-range sync for user: ${userId}`);

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

  // Salvar sync token para próximas syncs incrementais
  const updateData: any = {
    last_sync_at: new Date().toISOString()
  };
  if (newSyncToken) {
    updateData.sync_token = newSyncToken;
  }

  await supabase
    .from('google_calendar_connections')
    .update(updateData)
    .eq('user_id', userId);

  console.log(`✅ Full sync completed: ${totalProcessed} events processed. Token stored: ${!!newSyncToken}`);
}

// -----------------------------------------------
// SUBSTITUIR a função processEventChange por esta:
// -----------------------------------------------
async function processEventChange(userId: string, gEvent: any) {
  try {
    // Usar o ID mais específico possível
    // Instâncias de recurring usam o ID da instância (ex: "abc_20260301T150000Z")
    const googleEventId = gEvent.id;

    // Se evento foi deletado ou cancelado no Google
    if (gEvent.status === 'cancelled') {
      console.log(`🗑️ Removing cancelled event: ${googleEventId}`);
      const { error: deleteError } = await supabase
        .from('calendar')
        .delete()
        .eq('user_id', userId)
        .eq('session_event_id_google', googleEventId);

      if (deleteError) {
        console.error(`Error deleting event ${googleEventId}:`, deleteError);
      }
      return;
    }

    // Determinar start/end (suportar tanto dateTime quanto date)
    let startEvent: string | null = null;
    let endEvent: string | null = null;

    if (gEvent.start?.dateTime) {
      startEvent = gEvent.start.dateTime;
    } else if (gEvent.start?.date) {
      // Evento de dia inteiro: converter para dateTime
      startEvent = `${gEvent.start.date}T00:00:00-03:00`;
    }

    if (gEvent.end?.dateTime) {
      endEvent = gEvent.end.dateTime;
    } else if (gEvent.end?.date) {
      endEvent = `${gEvent.end.date}T23:59:59-03:00`;
    }

    // Se não tem start ou end válido, pular
    if (!startEvent || !endEvent) {
      console.log(`⏭️ Skipping event without valid dates: ${gEvent.summary || googleEventId}`);
      return;
    }

    // Verificar se evento já existe no Supabase
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
      // Atualizar apenas se algo mudou
      const hasChanged =
        existing.event_name !== eventData.event_name ||
        existing.start_event !== eventData.start_event ||
        existing.end_event !== eventData.end_event ||
        (existing.desc_event || '') !== eventData.desc_event;

      if (hasChanged) {
        console.log(`📝 Updating event: "${eventData.event_name}" (${googleEventId})`);
        await supabase
          .from('calendar')
          .update(eventData)
          .eq('id', existing.id);
      }
    } else {
      // Criar novo evento
      console.log(`➕ Creating event: "${eventData.event_name}" (${googleEventId})`);
      await supabase
        .from('calendar')
        .insert({
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

// ============================================================
// TAMBÉM CORRIGIR handleCronSync para usar a nova lógica:
// ============================================================
async function handleCronSync(userId: string, renewWebhook = false) {
  try {
    console.log(`⏰ Cron sync for user: ${userId}`);

    // Renovar webhook se necessário
    if (renewWebhook) {
      try {
        await cancelGoogleWebhook(userId);
      } catch (e) {
        console.error('Error canceling old webhook:', e);
      }
      try {
        await setupGoogleWebhook(userId);
      } catch (e) {
        console.error('Error setting up new webhook:', e);
      }
    }

    // Executar sincronização incremental (agora corrigida)
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