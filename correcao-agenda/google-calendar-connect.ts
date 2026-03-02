// ============================================================
// EDGE FUNCTION: google-calendar-connect (CORRIGIDA)
// ============================================================
// Correção aplicada:
//   APÓS salvar os tokens, dispara initialSync + ensureWebhook
//   em background via EdgeRuntime.waitUntil().
//   Antes, só salvava tokens e redirecionava — nenhum evento
//   era importado e nenhum webhook era criado.
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
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const APP_URL = Deno.env.get("APP_URL")!;
const STATE_SECRET = Deno.env.get("GC_STATE_SECRET")!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

// ==================== helpers (iguais ao google-calendar) ====================

function b64urlDecodeToString(s: string) {
  s = s.replaceAll("-", "+").replaceAll("_", "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  return new TextDecoder().decode(
    new Uint8Array([...bin].map((c) => c.charCodeAt(0))),
  );
}

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

async function verifyAndParseState(
  state: string,
): Promise<{ userId: string; origin: string }> {
  const parts = state.split(".");
  if (parts.length !== 2) throw new Error("Invalid state");

  const payloadJson = b64urlDecodeToString(parts[0]);
  const sig = parts[1];
  const expected = await hmacSign(payloadJson);
  if (sig !== expected) throw new Error("State signature mismatch");

  const parsed = JSON.parse(payloadJson);
  return {
    userId: String(parsed.userId),
    origin: String(parsed.origin || APP_URL),
  };
}

async function exchangeCodeForTokens(code: string) {
  const redirectUri = `${SUPABASE_URL}/functions/v1/google-calendar-connect`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  const data = await res.json();
  if (!res.ok)
    throw new Error(
      data?.error_description || data?.error || "Token exchange failed",
    );
  return data;
}

async function fetchUserEmail(accessToken: string): Promise<string | null> {
  const res = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const data = await res.json().catch(() => ({}));
  return res.ok ? data?.email || null : null;
}

// ==================== event mapping ====================

function mapGoogleEventToRow(userId: string, g: any) {
  if (!g.start?.dateTime || !g.end?.dateTime) return null;

  const recurrenceArr: string[] | null = Array.isArray(g.recurrence)
    ? g.recurrence
    : null;
  const rruleLine =
    recurrenceArr?.find((x: string) => x.startsWith("RRULE:")) || null;

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

// ==================== NOVO: sync + webhook em background ====================

async function backgroundSyncAndWebhook(userId: string, accessToken: string) {
  try {
    console.log(`[connect] Background sync starting for user: ${userId}`);

    // ---------- 1. Initial sync ----------
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
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const data = await res.json();
      if (!res.ok) {
        console.error(
          `[connect] Google API error: ${res.status}`,
          data?.error?.message,
        );
        break;
      }

      const items: any[] = data.items || [];
      const rows = items
        .filter((g: any) => g?.id && g.status !== "cancelled")
        .map((g: any) => mapGoogleEventToRow(userId, g))
        .filter(Boolean);

      if (rows.length) {
        const { error } = await admin
          .from("calendar")
          .upsert(rows as any[], {
            onConflict: "user_id,session_event_id_google",
          });
        if (error) {
          console.error("[connect] Upsert error:", error.message);
        } else {
          imported += rows.length;
        }
      }

      pageToken = data.nextPageToken;
      if (!pageToken) {
        // Salvar syncToken para uso futuro pelo webhook
        if (data.nextSyncToken) {
          await admin
            .from("google_calendar_connections")
            .update({
              sync_token: data.nextSyncToken,
              last_sync_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId);
        }
        break;
      }
    }

    console.log(`[connect] Imported ${imported} events`);

    // ---------- 2. Setup webhook para mudanças futuras ----------
    const webhookUrl = `${SUPABASE_URL}/functions/v1/google-calendar-webhook`;
    const channelId = `gc-${userId}-${Date.now()}`;

    const watchRes = await fetch(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/watch",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: channelId,
          type: "web_hook",
          address: webhookUrl,
        }),
      },
    );

    if (watchRes.ok) {
      const watchData = await watchRes.json();
      await admin
        .from("google_calendar_connections")
        .update({
          webhook_id: channelId,
          webhook_resource_id: watchData.resourceId,
          webhook_expiration: watchData.expiration
            ? new Date(Number(watchData.expiration)).toISOString()
            : null,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
      console.log(`[connect] Webhook created: ${channelId}`);
    } else {
      const errData = await watchRes.json().catch(() => ({}));
      console.error(
        `[connect] Webhook setup failed: ${watchRes.status}`,
        errData?.error?.message,
      );
    }

    console.log(`[connect] Background setup completed for user: ${userId}`);
  } catch (err) {
    console.error("[connect] Background sync/webhook error:", err);
  }
}

// ==================== server ====================

serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response(null, { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    // Erro do Google
    if (error) {
      return Response.redirect(
        `${APP_URL}/auth/google-calendar?error=${encodeURIComponent(error)}`,
        302,
      );
    }

    // Faltam parâmetros
    if (!code || !state) {
      return new Response("Missing code/state", {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Verificar state assinado
    const { userId, origin } = await verifyAndParseState(state);

    // Trocar code por tokens
    const tokenData = await exchangeCodeForTokens(code);
    const accessToken = tokenData.access_token as string;
    const refreshToken = tokenData.refresh_token as string | undefined;
    const expiresAt = new Date(
      Date.now() + tokenData.expires_in * 1000,
    ).toISOString();
    const scope = tokenData.scope as string | null;

    // Buscar email
    const email = await fetchUserEmail(accessToken);

    // Preservar refresh_token existente se Google não retornar um novo
    const { data: existing } = await admin
      .from("google_calendar_connections")
      .select("encrypted_refresh_token")
      .eq("user_id", userId)
      .maybeSingle();
    const finalRefresh =
      refreshToken || (existing?.encrypted_refresh_token as string | null);

    // Salvar conexão
    await admin.from("google_calendar_connections").upsert(
      {
        user_id: userId,
        is_connected: true,
        connected_email: email,
        scope,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: expiresAt,
        encrypted_access_token: accessToken,
        encrypted_refresh_token: finalRefresh,
      },
      { onConflict: "user_id" },
    );

    // ===================================================================
    // CORREÇÃO PRINCIPAL: dispara sync + webhook em background
    // Antes essa linha NÃO existia — por isso nenhum evento era importado
    // ===================================================================
    // @ts-ignore - EdgeRuntime.waitUntil é API do Supabase Edge Runtime
    EdgeRuntime.waitUntil(backgroundSyncAndWebhook(userId, accessToken));

    // Redireciona imediatamente (sync roda em background)
    return Response.redirect(
      `${origin}/auth/google-calendar?success=true`,
      302,
    );
  } catch (e) {
    console.error("[connect] Error:", e);
    return Response.redirect(
      `${APP_URL}/auth/google-calendar?error=${encodeURIComponent(String((e as Error).message || e))}`,
      302,
    );
  }
});
