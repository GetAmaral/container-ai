// ============================================================
// Story 1.1: Receber e Validar Webhook da Hotmart
// Supabase Edge Function (Deno)
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// --- Types ---

interface HotmartBuyer {
  email: string;
  name: string;
  first_name: string;
  last_name: string;
  checkout_phone: string;
  checkout_phone_code: string;
  document: string;
  document_type: string;
}

interface HotmartPurchase {
  order_id: string;
  status: string;
}

interface HotmartProduct {
  id: number;
  name: string;
}

interface HotmartPayload {
  event: string;
  version: string;
  hottok: string;
  data: {
    buyer: HotmartBuyer;
    purchase: HotmartPurchase;
    product: HotmartProduct;
  };
}

type WebhookStatus = "received" | "processed" | "ignored" | "error";

// Eventos que processamos
const ACTIONABLE_EVENTS = [
  "PURCHASE_APPROVED",
  "PURCHASE_REFUNDED",
  "CHARGEBACK",
] as const;

type ActionableEvent = typeof ACTIONABLE_EVENTS[number];

// --- Helpers ---

function supabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isActionable(event: string): event is ActionableEvent {
  return ACTIONABLE_EVENTS.includes(event as ActionableEvent);
}

// --- Normalização de Telefone ---
// Regra: DDI "55" + número. Se 13 dígitos e o 5º é "9", remove (9º dígito extra).
// Resultado: 12 dígitos (padrão WhatsApp BR). Ex: 554391936205
function normalizePhone(
  phoneCode: string | null | undefined,
  phone: string | null | undefined,
): string | null {
  if (!phone) return null;

  // Limpa tudo que não é dígito
  const cleanPhone = phone.replace(/\D/g, "");
  if (!cleanPhone) return null;

  // Monta: DDI + número
  const ddi = phoneCode?.replace(/\D/g, "") || "55";
  let full = `${ddi}${cleanPhone}`;

  // Se BR (55) e ficou 13 dígitos, e o 5º dígito é "9" → remove o 9 extra
  if (ddi === "55" && full.length === 13 && full[4] === "9") {
    full = full.slice(0, 4) + full.slice(5);
  }

  return full;
}

// --- Validações ---

function validateHottok(payload: HotmartPayload): boolean {
  const expected = Deno.env.get("HOTMART_HOTTOK");
  if (!expected) {
    console.error("[webhook] HOTMART_HOTTOK env var not set");
    return false;
  }
  return payload.hottok === expected;
}

function validatePayload(body: unknown): { ok: true; payload: HotmartPayload } | { ok: false; error: string } {
  const p = body as Record<string, unknown>;

  if (!p || typeof p !== "object") {
    return { ok: false, error: "Body is not an object" };
  }
  if (!p.event || typeof p.event !== "string") {
    return { ok: false, error: "Missing or invalid: event" };
  }
  const data = p.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Missing: data" };
  }
  const purchase = data.purchase as Record<string, unknown> | undefined;
  if (!purchase?.order_id) {
    return { ok: false, error: "Missing: data.purchase.order_id" };
  }
  const buyer = data.buyer as Record<string, unknown> | undefined;
  if (!buyer?.email) {
    return { ok: false, error: "Missing: data.buyer.email" };
  }

  return { ok: true, payload: body as HotmartPayload };
}

// --- Logging (usa tabela existente: webhook_events_log) ---

async function logWebhook(
  db: ReturnType<typeof supabase>,
  payload: HotmartPayload,
  status: WebhookStatus,
  errorMessage?: string,
) {
  const { event, data } = payload;
  const { error } = await db.from("webhook_events_log").insert({
    event_type: event,
    order_id: data.purchase.order_id,
    product_name: data.product?.name ?? null,
    customer_phone: normalizePhone(data.buyer?.checkout_phone_code, data.buyer?.checkout_phone),
    customer_email: data.buyer.email,
    signature_valid: true,
    processing_status: status,
    error_message: errorMessage ?? null,
    payload: payload as unknown as Record<string, unknown>,
  });

  if (error) {
    console.error("[webhook] Failed to log:", error.message);
  }
}

// --- Idempotência (order_id + event_type na webhook_events_log) ---

async function alreadyProcessed(
  db: ReturnType<typeof supabase>,
  orderId: string,
  event: string,
): Promise<boolean> {
  const { data } = await db
    .from("webhook_events_log")
    .select("id")
    .eq("order_id", orderId)
    .eq("event_type", event)
    .eq("processing_status", "processed")
    .limit(1)
    .maybeSingle();

  return !!data;
}

// --- Main Handler ---

Deno.serve(async (req: Request) => {
  // Só POST
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // Parse JSON
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // Validar campos obrigatórios
  const validation = validatePayload(body);
  if (!validation.ok) {
    console.warn(`[webhook] Bad payload: ${validation.error}`);
    return json({ error: "Bad request", detail: validation.error }, 400);
  }

  const { payload } = validation;
  const orderId = payload.data.purchase.order_id;
  const event = payload.event;

  // Validar hottok
  if (!validateHottok(payload)) {
    console.warn(`[webhook] Invalid hottok | order: ${orderId}`);
    // Loga com signature_valid = false
    const db = supabase();
    await db.from("webhook_events_log").insert({
      event_type: event,
      order_id: orderId,
      customer_email: payload.data.buyer.email,
      signature_valid: false,
      processing_status: "error",
      error_message: "Invalid hottok",
      payload: payload as unknown as Record<string, unknown>,
    }).catch(() => {});
    return json({ error: "Unauthorized" }, 401);
  }

  const db = supabase();

  // Evento que não processamos → loga como ignored, retorna 200
  if (!isActionable(event)) {
    console.log(`[webhook] Ignored event: ${event} | order: ${orderId}`);
    await logWebhook(db, payload, "ignored");
    return json({ status: "ignored", event });
  }

  // Idempotência: já processou esse order_id + evento?
  const duplicate = await alreadyProcessed(db, orderId, event);
  if (duplicate) {
    console.log(`[webhook] Duplicate: ${event} | order: ${orderId}`);
    return json({ status: "already_processed" });
  }

  // Loga como received
  await logWebhook(db, payload, "received");

  // Rotear por evento
  try {
    let result: Record<string, unknown>;

    switch (event) {
      case "PURCHASE_APPROVED": {
        const phone = normalizePhone(
          payload.data.buyer.checkout_phone_code,
          payload.data.buyer.checkout_phone,
        );
        result = {
          action: "activate",
          orderId,
          email: payload.data.buyer.email,
          phone,
          hasPhone: !!phone,
        };
        // TODO (Story 1.2): salvar user no banco
        // TODO (Story 1.3/1.4): se hasPhone → WhatsApp, senão → Email
        break;
      }

      case "PURCHASE_REFUNDED":
        result = { action: "deactivate", reason: "refund", orderId };
        // TODO (Story 1.6): desativar acesso
        break;

      case "CHARGEBACK":
        result = { action: "deactivate", reason: "chargeback", orderId };
        // TODO (Story 1.6): desativar acesso
        break;

      default:
        result = { action: "ignored" };
    }

    // Atualiza log para processed
    await db
      .from("webhook_events_log")
      .update({ processing_status: "processed" })
      .eq("order_id", orderId)
      .eq("event_type", event)
      .eq("processing_status", "received");

    console.log(`[webhook] Processed: ${event} | order: ${orderId}`);
    return json({ status: "processed", ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[webhook] Error: ${msg} | ${event} | order: ${orderId}`);

    // Atualiza log com erro
    await db
      .from("webhook_events_log")
      .update({ processing_status: "error", error_message: msg })
      .eq("order_id", orderId)
      .eq("event_type", event)
      .eq("processing_status", "received")
      .catch(() => {});

    // Retorna 200 mesmo com erro → evita Hotmart reenviar 5x
    return json({ status: "error", message: msg });
  }
});
