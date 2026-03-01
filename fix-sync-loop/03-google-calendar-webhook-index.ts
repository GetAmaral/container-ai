import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-goog-channel-id, x-goog-resource-id, x-goog-resource-state',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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

    // sync = confirmação de setup do webhook
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
        console.error('Connection not found for webhook:', { channelId, resourceId, error });
        return new Response('Connection not found', { status: 404, headers: corsHeaders });
      }

      console.log('User found:', connection.user_id);

      // Dedup - pular se sincronizou há menos de 30 segundos
      if (connection.last_sync_at) {
        const lastSync = new Date(connection.last_sync_at);
        const now = new Date();
        const diffSeconds = (now.getTime() - lastSync.getTime()) / 1000;

        if (diffSeconds < 30) {
          console.log(`Dedup: last sync was ${diffSeconds.toFixed(0)}s ago, skipping`);
          return new Response('OK', { status: 200, headers: corsHeaders });
        }
      }

      // Chamar a Edge Function principal (mesmo caminho que o cron usa)
      // Isso é PROVADO funcionar - o cron faz exatamente isso
      console.log('Invoking google-calendar sync for user:', connection.user_id);
      EdgeRuntime.waitUntil(
        supabase.functions.invoke('google-calendar', {
          body: {
            action: 'cron-sync',
            userId: connection.user_id,
          }
        }).then(({ error: invokeError }) => {
          if (invokeError) {
            console.error('Sync invocation error:', invokeError);
          } else {
            console.log('Sync completed successfully for user:', connection.user_id);
          }
        }).catch(err => {
          console.error('Sync invocation failed:', err);
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
