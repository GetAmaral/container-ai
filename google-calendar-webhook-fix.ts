// ============================================================
// EDGE FUNCTION: google-calendar-webhook
// ============================================================
// Esta function PRECISA ser criada no Supabase.
// Ela recebe push notifications do Google Calendar quando
// eventos são criados/editados/deletados pelo usuário no Google.
//
// Deploy: supabase functions deploy google-calendar-webhook
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

serve(async (req) => {
  // Google envia POST com headers especiais
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const channelId = req.headers.get('x-goog-channel-id');
    const resourceId = req.headers.get('x-goog-resource-id');
    const resourceState = req.headers.get('x-goog-resource-state');

    console.log(`🔔 Webhook received: channel=${channelId}, resource=${resourceId}, state=${resourceState}`);

    // "sync" é enviado quando o webhook é registrado pela primeira vez — ignorar
    if (resourceState === 'sync') {
      console.log('ℹ️ Sync notification (webhook registered), ignoring');
      return new Response('OK', { status: 200 });
    }

    if (!channelId) {
      console.error('❌ Missing x-goog-channel-id header');
      return new Response('OK', { status: 200 }); // 200 para Google não retentar
    }

    // Buscar o user_id associado a esse webhook
    const { data: connection, error: connError } = await supabase
      .from('google_calendar_connections')
      .select('user_id')
      .eq('webhook_id', channelId)
      .eq('is_connected', true)
      .single();

    if (connError || !connection) {
      console.error(`❌ No active connection found for channel: ${channelId}`, connError);
      // Retornar 200 para o Google não ficar retentando para um webhook órfão
      return new Response('OK', { status: 200 });
    }

    console.log(`✅ Found user ${connection.user_id} for channel ${channelId}`);

    // Verificar rate limit: não sincronizar se fez sync há menos de 2 minutos
    // (Google pode enviar múltiplas notificações em sequência para uma mesma mudança)
    const { data: connDetails } = await supabase
      .from('google_calendar_connections')
      .select('last_sync_at')
      .eq('user_id', connection.user_id)
      .single();

    if (connDetails?.last_sync_at) {
      const lastSync = new Date(connDetails.last_sync_at);
      const now = new Date();
      const diffMinutes = (now.getTime() - lastSync.getTime()) / 1000 / 60;

      if (diffMinutes < 2) {
        console.log(`⏳ Rate limited: last sync was ${diffMinutes.toFixed(1)} min ago, skipping`);
        return new Response('OK', { status: 200 });
      }
    }

    // Disparar sincronização incremental via a edge function principal
    console.log(`🔄 Triggering incremental sync for user ${connection.user_id}...`);

    const { error: syncError } = await supabase.functions.invoke('google-calendar', {
      body: {
        action: 'cron-sync',
        userId: connection.user_id,
        renewWebhook: false
      },
      headers: {
        'Authorization': `Bearer ${supabaseServiceRoleKey}`
      }
    });

    if (syncError) {
      console.error(`❌ Sync invocation error for user ${connection.user_id}:`, syncError);
    } else {
      console.log(`✅ Sync triggered successfully for user ${connection.user_id}`);
    }

    // Sempre retornar 200 para o Google (caso contrário ele desativa o webhook)
    return new Response('OK', { status: 200 });

  } catch (error) {
    console.error('❌ Webhook handler error:', error);
    // Retornar 200 mesmo em erro para não desativar o webhook
    return new Response('OK', { status: 200 });
  }
});