// ============================================================
// EDGE FUNCTION: google-calendar (CORRIGIDA)
// ============================================================
// Correções aplicadas:
//   1. Suporte a GET para OAuth redirect (compatibilidade com frontend)
//   2. Aceita "sync" como alias de "sync_now"
//   3. Token refresh automático (copiado do webhook)
//   4. Handler "cron-sync" com auth por service_role
//   5. Handlers "create", "update", "delete" (frontend + trigger SQL)
//   6. Auth dual: JWT (frontend) + service_role (cron/trigger)
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const APP_URL = Deno.env.get("APP_URL")!;
const STATE_SECRET = Deno.env.get("GC_STATE_SECRET")!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

// ==================== helpers ====================

function b64urlEncode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function hmacSign(payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(STATE_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return b64urlEncode(new Uint8Array(sig));
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function buildGoogleAuthUrl(state: string) {
  const redirectUri = `${SUPABASE_URL}/functions/v1/google-calendar-connect`;
  const scope = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/calendar",
  ].join(" ");

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scope);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

// ==================== token refresh ====================

async function refreshAccessTokenIfNeeded(userId: string): Promise<string> {
  const { data: conn, error } = await admin
    .from("google_calendar_connections")
    .select(
      "encrypted_access_token, encrypted_refresh_token, expires_at, is_connected",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !conn?.is_connected) throw new Error("Google not connected");

  const access = conn.encrypted_access_token as string | null;
  const refresh = conn.encrypted_refresh_token as string | null;
  if (!access) throw new Error("Missing Google access token");

  const expired = conn.expires_at
    ? new Date() >= new Date(conn.expires_at)
    : false;
  if (!expired) return access;

  // ---------- REFRESH (antes jogava erro, agora faz refresh) ----------
  if (!refresh)
    throw new Error("Token expired. Please reconnect Google Calendar.");

  console.log(`[gc] Refreshing token for user ${userId}`);
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
      data?.error_description || data?.error || "Token refresh failed",
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

// ==================== sync ====================

async function initialSync(userId: string) {
  const access = await refreshAccessTokenIfNeeded(userId);

  const timeMin = new Date();
  timeMin.setDate(timeMin.getDate() - 30);
  const timeMax = new Date();
  timeMax.setDate(timeMax.getDate() + 180);

  let pageToken: string | undefined;
  let imported = 0;

  while (true) {
    const url = new URL(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
    url.searchParams.set("timeMin", timeMin.toISOString());
    url.searchParams.set("timeMax", timeMax.toISOString());
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("singleEvents", "false");
    url.searchParams.set("showDeleted", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${access}` },
    });
    const data = await res.json();
    if (!res.ok)
      throw new Error(data?.error?.message || `Google error ${res.status}`);

    const items: any[] = data.items || [];
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
      imported += rows.length;
    }

    pageToken = data.nextPageToken;
    if (!pageToken) {
      await admin
        .from("google_calendar_connections")
        .update({
          sync_token: data.nextSyncToken || null,
          last_sync_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
      break;
    }
  }

  return { imported };
}

async function incrementalSync(userId: string) {
  const access = await refreshAccessTokenIfNeeded(userId);

  const { data: conn } = await admin
    .from("google_calendar_connections")
    .select("sync_token")
    .eq("user_id", userId)
    .maybeSingle();

  const syncToken = conn?.sync_token as string | null;
  if (!syncToken) return initialSync(userId);

  let pageToken: string | undefined;
  let newSyncToken: string | undefined;
  let processed = 0;

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

    if (res.status === 410) {
      console.log("[gc] syncToken expired, falling back to full sync");
      await admin
        .from("google_calendar_connections")
        .update({ sync_token: null, updated_at: new Date().toISOString() })
        .eq("user_id", userId);
      return initialSync(userId);
    }

    const data = await res.json();
    if (!res.ok)
      throw new Error(data?.error?.message || `Google error ${res.status}`);

    const items: any[] = data.items || [];

    // Deletados
    for (const g of items) {
      if (g?.id && g.status === "cancelled") {
        await admin
          .from("calendar")
          .delete()
          .eq("user_id", userId)
          .eq("session_event_id_google", g.id);
        processed++;
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
      processed += rows.length;
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

  return { imported: processed };
}

// ==================== webhook ====================

async function ensureWebhook(userId: string) {
  const access = await refreshAccessTokenIfNeeded(userId);
  const webhookUrl = `${SUPABASE_URL}/functions/v1/google-calendar-webhook`;
  const channelId = `gc-${userId}-${Date.now()}`;

  // Cancelar webhook anterior (best effort)
  const { data: existing } = await admin
    .from("google_calendar_connections")
    .select("webhook_id, webhook_resource_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing?.webhook_id && existing?.webhook_resource_id) {
    await fetch("https://www.googleapis.com/calendar/v3/channels/stop", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: existing.webhook_id,
        resourceId: existing.webhook_resource_id,
      }),
    }).catch(() => {});
  }

  const res = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events/watch",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: channelId,
        type: "web_hook",
        address: webhookUrl,
      }),
    },
  );

  const data = await res.json();
  if (!res.ok)
    throw new Error(data?.error?.message || `watch failed ${res.status}`);

  await admin
    .from("google_calendar_connections")
    .update({
      webhook_id: channelId,
      webhook_resource_id: data.resourceId,
      webhook_expiration: data.expiration
        ? new Date(Number(data.expiration)).toISOString()
        : null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  return { webhook_id: channelId };
}

// ==================== server ====================

serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response(null, { headers: corsHeaders });

  try {
    const url = new URL(req.url);

    // ===== GET: OAuth redirect (compatibilidade com frontend) =====
    if (req.method === "GET") {
      const userIdParam = url.searchParams.get("userId");
      if (!userIdParam) return jsonResponse({ error: "Missing userId" }, 400);

      const origin = APP_URL;
      const payload = JSON.stringify({
        userId: userIdParam,
        origin,
        ts: Date.now(),
      });
      const sig = await hmacSign(payload);
      const state =
        b64urlEncode(new TextEncoder().encode(payload)) + "." + sig;
      return Response.redirect(buildGoogleAuthUrl(state), 302);
    }

    // ===== POST: API actions =====
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

    const body = await req.json();
    const action = String(body?.action || "");

    // ---------- Determinar userId ----------
    let userId: string;
    const isServiceRole = token === SERVICE_ROLE;

    if (isServiceRole) {
      // Service role: cron, trigger SQL
      if (!body?.userId) throw new Error("Missing userId for service call");
      userId = String(body.userId);
    } else {
      // JWT do usuário
      if (!token) throw new Error("Missing Authorization");
      const { data, error } = await admin.auth.getUser(token);
      if (error || !data?.user) throw new Error("Invalid token");
      userId = data.user.id;
    }

    // ---------- Actions ----------
    switch (action) {
      // --- Auth URL (POST) ---
      case "get_auth_url": {
        const origin = String(body?.origin || APP_URL);
        const payload = JSON.stringify({ userId, origin, ts: Date.now() });
        const sig = await hmacSign(payload);
        const state =
          b64urlEncode(new TextEncoder().encode(payload)) + "." + sig;
        return jsonResponse({ authUrl: buildGoogleAuthUrl(state) });
      }

      // --- Sync manual (frontend) ---
      case "sync_now":
      case "sync": {
        const result = await initialSync(userId);
        const hook = await ensureWebhook(userId).catch(() => ({}));
        return jsonResponse({ success: true, ...result, ...hook });
      }

      // --- Sync periódico (cron) ---
      case "cron-sync": {
        if (!isServiceRole) throw new Error("Unauthorized");
        const renewWebhook = !!body?.renewWebhook;
        const result = await incrementalSync(userId);
        if (renewWebhook) await ensureWebhook(userId).catch(() => {});
        return jsonResponse({ success: true, ...result });
      }

      // --- CRUD de eventos (frontend + trigger SQL) ---
      case "create": {
        const eventData = body?.event;
        if (!eventData) throw new Error("Missing event data");
        const access = await refreshAccessTokenIfNeeded(userId);

        const res = await fetch(
          "https://www.googleapis.com/calendar/v3/calendars/primary/events",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${access}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(eventData),
          },
        );
        const result = await res.json();
        if (!res.ok)
          throw new Error(
            result?.error?.message || `Google error ${res.status}`,
          );

        return jsonResponse({ eventId: result.id, success: true });
      }

      case "update": {
        const eventId = body?.eventId;
        const eventData = body?.event;
        if (!eventId || !eventData)
          throw new Error("Missing eventId or event data");
        const access = await refreshAccessTokenIfNeeded(userId);

        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${access}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(eventData),
          },
        );
        const result = await res.json();
        if (!res.ok)
          throw new Error(
            result?.error?.message || `Google error ${res.status}`,
          );

        return jsonResponse({ eventId: result.id, success: true });
      }

      case "delete": {
        const eventId = body?.eventId;
        if (!eventId) throw new Error("Missing eventId");
        const access = await refreshAccessTokenIfNeeded(userId);

        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${access}` },
          },
        );
        // 404/410 = já deletado, tudo OK
        if (!res.ok && res.status !== 404 && res.status !== 410) {
          const result = await res.json().catch(() => ({}));
          throw new Error(
            result?.error?.message || `Google error ${res.status}`,
          );
        }

        return jsonResponse({ success: true });
      }

      case "disconnect": {
        // Cancelar webhook (best effort)
        try {
          const { data: conn } = await admin
            .from("google_calendar_connections")
            .select("webhook_id, webhook_resource_id")
            .eq("user_id", userId)
            .maybeSingle();

          if (conn?.webhook_id && conn?.webhook_resource_id) {
            const access = await refreshAccessTokenIfNeeded(userId).catch(
              () => null,
            );
            if (access) {
              await fetch(
                "https://www.googleapis.com/calendar/v3/channels/stop",
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${access}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    id: conn.webhook_id,
                    resourceId: conn.webhook_resource_id,
                  }),
                },
              ).catch(() => {});
            }
          }
        } catch {
          // best effort
        }

        await admin
          .from("google_calendar_connections")
          .update({
            is_connected: false,
            encrypted_access_token: null,
            encrypted_refresh_token: null,
            expires_at: null,
            connected_email: null,
            scope: null,
            sync_token: null,
            webhook_id: null,
            webhook_resource_id: null,
            webhook_expiration: null,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId);

        return jsonResponse({ success: true });
      }

      default:
        return jsonResponse({ error: "Invalid action" }, 400);
    }
  } catch (e) {
    console.error("[gc] Error:", e);
    return jsonResponse({ error: String((e as Error).message || e) }, 500);
  }
});
