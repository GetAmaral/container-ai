// =============================================================================
// google-calendar-webhook/index.ts — SIMPLIFICADO
// Recebe webhook do Google, identifica user, delega para google-calendar
// ~50 linhas (era 200+)
// =============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200 });
  }

  try {
    const channelId = req.headers.get('x-goog-channel-id');
    const resourceId = req.headers.get('x-goog-resource-id');
    const resourceState = req.headers.get('x-goog-resource-state');

    console.log('Webhook received:', { channelId, resourceId, resourceState });

    if (!channelId || !resourceId) {
      return new Response('Invalid webhook', { status: 400 });
    }

    // Ping de confirmacao do Google
    if (resourceState === 'sync') {
      console.log('Webhook setup confirmed');
      return new Response('OK', { status: 200 });
    }

    // Somente processar quando ha mudancas
    if (resourceState !== 'exists') {
      return new Response('OK', { status: 200 });
    }

    // Identificar user pelo channel_id + resource_id
    const { data: connection, error } = await supabase
      .from('google_calendar_connections')
      .select('user_id, last_sync_at')
      .eq('webhook_id', channelId)
      .eq('webhook_resource_id', resourceId)
      .eq('is_connected', true)
      .single();

    if (error || !connection) {
      console.error('Connection not found for webhook:', error);
      return new Response('Not found', { status: 404 });
    }

    // Dedup: ignorar se sincronizou ha menos de 30 segundos
    if (connection.last_sync_at) {
      const elapsed = Date.now() - new Date(connection.last_sync_at).getTime();
      if (elapsed < 30000) {
        console.log(`Dedup: skipping, last sync ${Math.round(elapsed / 1000)}s ago`);
        return new Response('OK', { status: 200 });
      }
    }

    console.log(`Delegating sync for user: ${connection.user_id}`);

    // Delegar para a funcao principal (google-calendar com action cron-sync)
    EdgeRuntime.waitUntil(
      supabase.functions.invoke('google-calendar', {
        body: { action: 'cron-sync', userId: connection.user_id }
      }).then(({ error: invokeError }) => {
        if (invokeError) console.error('Sync invoke error:', invokeError);
        else console.log('Sync completed for user:', connection.user_id);
      }).catch(err => {
        console.error('Sync invoke failed:', err);
      })
    );

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('Webhook error:', error);
    return new Response('Error', { status: 500 });
  }
});
