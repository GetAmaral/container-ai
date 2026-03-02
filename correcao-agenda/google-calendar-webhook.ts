// ============================================================
// EDGE FUNCTION: google-calendar-webhook (CORRIGIDA)
// ============================================================
// Correção aplicada:
//   Fix no syncToken/pageToken — antes setava ambos ao mesmo
//   tempo nas páginas subsequentes. Agora usa OU um OU outro.
//   Resto do código mantido igual (já tinha refresh correto).
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "content-type, x-goog-channel-id, x-goog-resource-id, x-goog-resource-state",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

// ==================== token refresh ====================

async function refreshAccessTokenIfNeeded(userId: string): Promise<string> {
  const { data: conn, error } = await admin
    .from("google_calendar_connections")
    .select(
      "encrypted_access_token, encrypted_refresh_token, expires_at, is_connected",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !conn?.is_connected) throw new Error("Not connected");

  const access = conn.encrypted_access_token as string | null;
  const refresh = conn.encrypted_refresh_token as string | null;
  if (!access) throw new Error("Missing access token");

  const expired = conn.expires_at
    ? new Date() >= new Date(conn.expires_at)
    : false;
  if (!expired) return access;

  if (!refresh) throw new Error("Expired and missing refresh token");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });

  const data = await res.json();
  if (!res.ok)
    throw new Error(
      data?.error_description || data?.error || "Refresh failed",
    );

  const newAccess = data.access_token as string;
  const expiresAt = new Date(
    Date.now() + data.expires_in * 1000,
  ).toISOString();

  await admin
    .from("google_calendar_connections")
    .update({
      encrypted_access_token: newAccess,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  return newAccess;
}

// ==================== event mapping ====================

function mapGoogleEventToRow(userId: string, g: any) {
  if (!g.start?.dateTime || !g.end?.dateTime) return null;

  const recurrenceArr: string[] | null = Array.isArray(g.recurrence)
    ? g.recurrence
    : null;
  const rruleLine =
    recurrenceArr?.find((x) => String(x).startsWith("RRULE:")) || null;

  return {
    user_id: userId,
    session_event_id_google: g.id,
    event_name: (g.summary || "Sem título").slice(0, 255),
    desc_event: (g.description || "").slice(0, 5000),
    start_event: g.start.dateTime,
    end_event: g.end.dateTime,
    timezone: g.start.timeZone || "America/Sao_Paulo",
    calendar_email_created: g.creator?.email || null,
    active: true,
    reminder: false,
    remembered: false,
    is_recurring: !!rruleLine,
    rrule: rruleLine,
    payload: g,
    _syncing_from_google: true,
  };
}

// ==================== incremental sync ====================

async function incrementalSync(userId: string) {
  const access = await refreshAccessTokenIfNeeded(userId);

  const { data: conn } = await admin
    .from("google_calendar_connections")
    .select("sync_token")
    .eq("user_id", userId)
    .maybeSingle();

  const syncToken = conn?.sync_token as string | null;
  if (!syncToken) {
    console.log("[webhook] No syncToken, skipping (user needs sync_now)");
    return;
  }

  let pageToken: string | undefined;
  let newSyncToken: string | undefined;

  do {
    const url = new URL(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );

    // FIX: usar OU syncToken OU pageToken, nunca ambos
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    } else {
      url.searchParams.set("syncToken", syncToken);
    }
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("showDeleted", "true");
    url.searchParams.set("singleEvents", "false");

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${access}` },
    });

    // syncToken expirado -> limpa e o user faz sync_now de novo
    if (res.status === 410) {
      console.log("[webhook] syncToken expired, clearing");
      await admin
        .from("google_calendar_connections")
        .update({ sync_token: null, updated_at: new Date().toISOString() })
        .eq("user_id", userId);
      return;
    }

    const data = await res.json();
    if (!res.ok)
      throw new Error(data?.error?.message || `Google error ${res.status}`);

    const items: any[] = data.items || [];

    // Deletados/cancelados
    for (const g of items) {
      if (!g?.id) continue;
      if (g.status === "cancelled") {
        await admin
          .from("calendar")
          .delete()
          .eq("user_id", userId)
          .eq("session_event_id_google", g.id);
      }
    }

    // Upsert dos ativos
    const rows = items
      .filter((g) => g?.id && g.status !== "cancelled")
      .map((g) => mapGoogleEventToRow(userId, g))
      .filter(Boolean);

    if (rows.length) {
      const { error } = await admin
        .from("calendar")
        .upsert(rows as any[], {
          onConflict: "user_id,session_event_id_google",
        });
      if (error) throw error;
    }

    pageToken = data.nextPageToken;
    newSyncToken = data.nextSyncToken || newSyncToken;
  } while (pageToken);

  if (newSyncToken) {
    await admin
      .from("google_calendar_connections")
      .update({
        sync_token: newSyncToken,
        last_sync_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
  }

  console.log(`[webhook] Incremental sync done for user ${userId}`);
}

// ==================== server ====================

serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response(null, { headers: corsHeaders });

  try {
    const channelId = req.headers.get("x-goog-channel-id");
    const resourceId = req.headers.get("x-goog-resource-id");
    const resourceState = req.headers.get("x-goog-resource-state");

    if (!channelId || !resourceId) {
      return new Response("OK", { status: 200, headers: corsHeaders });
    }

    // Setup handshake
    if (resourceState === "sync") {
      console.log("[webhook] Handshake OK");
      return new Response("OK", { status: 200, headers: corsHeaders });
    }

    // Mudanças detectadas
    if (resourceState === "exists") {
      const { data: conn } = await admin
        .from("google_calendar_connections")
        .select("user_id, last_sync_at")
        .eq("webhook_id", channelId)
        .eq("webhook_resource_id", resourceId)
        .eq("is_connected", true)
        .maybeSingle();

      if (!conn?.user_id) {
        return new Response("OK", { status: 200, headers: corsHeaders });
      }

      // Dedup: ignorar se sincronizou há menos de 20s
      if (conn.last_sync_at) {
        const diff =
          (Date.now() - new Date(conn.last_sync_at).getTime()) / 1000;
        if (diff < 20) {
          return new Response("OK", { status: 200, headers: corsHeaders });
        }
      }

      // Rodar em background (responder 200 imediatamente pro Google)
      // @ts-ignore
      EdgeRuntime.waitUntil(
        incrementalSync(conn.user_id).catch((err) => {
          console.error("[webhook] Background sync error:", err);
        }),
      );

      return new Response("OK", { status: 200, headers: corsHeaders });
    }

    return new Response("OK", { status: 200, headers: corsHeaders });
  } catch {
    return new Response("OK", { status: 200, headers: corsHeaders });
  }
});
