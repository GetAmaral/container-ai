import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('Starting scheduled sync for all users...');

    // Buscar todas as conexões ativas
    const { data: connections, error } = await supabase
      .from('google_calendar_connections')
      .select('user_id, last_sync_at, webhook_expiration')
      .eq('is_connected', true);

    if (error) {
      throw new Error(`Failed to fetch connections: ${error.message}`);
    }

    if (!connections || connections.length === 0) {
      console.log('No active connections to sync');
      return new Response(JSON.stringify({ message: 'No active connections' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log(`Found ${connections.length} active connections`);

    // Limpar webhooks expirados
    await supabase.rpc('cleanup_expired_google_webhooks');

    let synced = 0;
    let skipped = 0;
    let errors = 0;

    // CORRIGIDO: Processar em batches de 5 (era 10) para evitar timeouts
    const batchSize = 5;
    for (let i = 0; i < connections.length; i += batchSize) {
      const batch = connections.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (conn) => {
          try {
            // CORRIGIDO: Pular se sincronizou há menos de 10 minutos (rate limit)
            if (conn.last_sync_at) {
              const lastSync = new Date(conn.last_sync_at);
              const now = new Date();
              const diffMinutes = (now.getTime() - lastSync.getTime()) / 1000 / 60;

              if (diffMinutes < 10) {
                skipped++;
                return;
              }
            }

            // Verificar se webhook está perto de expirar (menos de 24h)
            let needsWebhookRenewal = false;
            if (conn.webhook_expiration) {
              const expiration = new Date(conn.webhook_expiration);
              const now = new Date();
              const hoursUntilExpiration = (expiration.getTime() - now.getTime()) / 1000 / 60 / 60;
              needsWebhookRenewal = hoursUntilExpiration < 24;
            }

            // Invocar sincronização via edge function
            const { error: syncError } = await supabase.functions.invoke('google-calendar', {
              body: {
                action: 'cron-sync',
                userId: conn.user_id,
                renewWebhook: needsWebhookRenewal
              }
            });

            if (syncError) {
              console.error(`Sync error for user ${conn.user_id}:`, syncError);
              errors++;
            } else {
              synced++;
            }

          } catch (err) {
            console.error(`Error syncing user ${conn.user_id}:`, err);
            errors++;
          }
        })
      );

      // CORRIGIDO: Delay de 2 segundos entre batches para evitar sobrecarga
      if (i + batchSize < connections.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    console.log(`Cron sync completed: ${synced} synced, ${skipped} skipped, ${errors} errors`);

    return new Response(
      JSON.stringify({
        success: true,
        synced,
        skipped,
        errors,
        total: connections.length
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    console.error('Cron sync error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
