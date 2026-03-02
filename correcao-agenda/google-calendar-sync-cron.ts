// ============================================================
// EDGE FUNCTION: google-calendar-sync-cron (CORRIGIDA)
// ============================================================
// Correções aplicadas:
//   1. Usa fetch direto com service_role no Authorization
//      (antes, supabase.functions.invoke mandava auth que a
//       google-calendar não aceitava)
//   2. Action "cron-sync" agora existe na google-calendar corrigida
//   3. Renova webhook quando não existe (não só quando expira)
//   4. Wrapped cleanup_expired_google_webhooks em try-catch
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response(null, { headers: corsHeaders });

  try {
    console.log("[cron] Starting scheduled sync...");

    // Buscar conexões ativas
    const { data: connections, error } = await admin
      .from("google_calendar_connections")
      .select("user_id, last_sync_at, webhook_expiration, webhook_id")
      .eq("is_connected", true);

    if (error)
      throw new Error(`Failed to fetch connections: ${error.message}`);

    if (!connections?.length) {
      console.log("[cron] No active connections");
      return new Response(
        JSON.stringify({ message: "No active connections" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    console.log(`[cron] Found ${connections.length} active connections`);

    // Limpar webhooks expirados (best effort)
    try {
      await admin.rpc("cleanup_expired_google_webhooks");
    } catch {
      // RPC pode não existir, não é crítico
    }

    let synced = 0;
    let skipped = 0;
    let errors = 0;

    const batchSize = 5;
    for (let i = 0; i < connections.length; i += batchSize) {
      const batch = connections.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (conn) => {
          try {
            // Pular se sincronizou há menos de 10 minutos
            if (conn.last_sync_at) {
              const diff =
                (Date.now() - new Date(conn.last_sync_at).getTime()) / 60000;
              if (diff < 10) {
                skipped++;
                return;
              }
            }

            // Verificar se webhook precisa ser renovado
            let renewWebhook = !conn.webhook_id; // sem webhook = precisa criar
            if (!renewWebhook && conn.webhook_expiration) {
              const hours =
                (new Date(conn.webhook_expiration).getTime() - Date.now()) /
                3600000;
              renewWebhook = hours < 24;
            }

            // Chamar google-calendar com service_role auth
            const res = await fetch(
              `${SUPABASE_URL}/functions/v1/google-calendar`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${SERVICE_ROLE}`,
                  apikey: SERVICE_ROLE,
                },
                body: JSON.stringify({
                  action: "cron-sync",
                  userId: conn.user_id,
                  renewWebhook,
                }),
              },
            );

            if (!res.ok) {
              const errData = await res.json().catch(() => ({}));
              console.error(
                `[cron] Sync error for ${conn.user_id}:`,
                errData?.error || res.status,
              );
              errors++;
            } else {
              synced++;
            }
          } catch (err) {
            console.error(`[cron] Error syncing ${conn.user_id}:`, err);
            errors++;
          }
        }),
      );

      // Delay entre batches para não sobrecarregar
      if (i + batchSize < connections.length) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    console.log(
      `[cron] Done: ${synced} synced, ${skipped} skipped, ${errors} errors`,
    );

    return new Response(
      JSON.stringify({
        success: true,
        synced,
        skipped,
        errors,
        total: connections.length,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("[cron] Error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
