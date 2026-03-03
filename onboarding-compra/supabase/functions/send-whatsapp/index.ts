// ============================================================
// Story 1.3: Enviar WhatsApp de Boas-Vindas (Path A)
// Supabase Edge Function (Deno)
//
// Chamada pelo hotmart-webhook via fetch fire-and-forget.
// Retry 3x com backoff progressivo.
// Após 3 falhas → chama send-email como fallback.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// --- Config ---

const RETRY_DELAYS = [0, 30_000, 120_000]; // imediato, 30s, 2min
const WHATSAPP_API_URL = "https://graph.facebook.com/v23.0";

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

// --- WhatsApp API ---

async function sendWhatsAppTemplate(
  phone: string,
  userName: string,
): Promise<{ ok: boolean; error?: string }> {
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  const token = Deno.env.get("WHATSAPP_TOKEN");
  const templateName = Deno.env.get("WHATSAPP_TEMPLATE_BOAS_VINDAS") ?? "boas_vindas_compra";

  if (!phoneNumberId || !token) {
    return { ok: false, error: "WhatsApp credentials not configured" };
  }

  try {
    const res = await fetch(
      `${WHATSAPP_API_URL}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phone,
          type: "template",
          template: {
            name: templateName,
            language: { code: "pt_BR" },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: userName },
                ],
              },
            ],
          },
        }),
      },
    );

    if (!res.ok) {
      const err = await res.text();
      return { ok: false, error: `WhatsApp API ${res.status}: ${err}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown" };
  }
}

// --- Log de tentativas ---

async function logAttempt(
  db: ReturnType<typeof supabase>,
  profileId: string,
  phone: string,
  attemptNum: number,
  status: "success" | "failed",
  error?: string,
) {
  await db.from("whatsapp_attempts").insert({
    user_id: profileId,
    phone,
    attempt_num: attemptNum,
    status,
    error: error ?? null,
  }).catch((e: Error) => console.error("[wpp] Failed to log attempt:", e.message));
}

// --- Fallback: chamar send-email ---

async function triggerEmailFallback(
  profileId: string,
  email: string,
  userName: string,
  productName: string,
  orderId: string,
) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  await fetch(`${supabaseUrl}/functions/v1/send-email`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      profileId,
      email,
      userName,
      productName,
      orderId,
      emailType: "fallback_whatsapp",
    }),
  }).catch((e: Error) => console.error("[wpp] Failed to trigger email fallback:", e.message));
}

// --- Main Handler ---

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: {
    profileId: string;
    email: string;
    phone: string;
    userName: string;
    productName: string;
    orderId: string;
  };

  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { profileId, email, phone, userName, productName, orderId } = body;

  if (!profileId || !phone) {
    return json({ error: "Missing profileId or phone" }, 400);
  }

  const db = supabase();

  // Checar se user já está ativado (evitar duplicata)
  const { data: profile } = await db
    .from("profiles")
    .select("plan_status, phone")
    .eq("id", profileId)
    .single();

  if (profile?.phone && profile?.plan_status) {
    console.log(`[wpp] User ${email} already activated. Skipping.`);
    return json({ status: "already_activated" });
  }

  // Retry loop: 3 tentativas com backoff
  for (let attempt = 1; attempt <= 3; attempt++) {
    const delay = RETRY_DELAYS[attempt - 1];
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }

    console.log(`[wpp] Attempt ${attempt}/3 | phone: ${phone} | order: ${orderId}`);
    const result = await sendWhatsAppTemplate(phone, userName);

    if (result.ok) {
      await logAttempt(db, profileId, phone, attempt, "success");

      // Marcar user como ativado
      await db
        .from("profiles")
        .update({ phone, plan_status: true })
        .eq("id", profileId);

      console.log(`[wpp] Sent OK | attempt: ${attempt} | phone: ${phone}`);
      return json({ status: "sent", attempt });
    }

    // Falhou
    console.warn(`[wpp] Attempt ${attempt} failed: ${result.error}`);
    await logAttempt(db, profileId, phone, attempt, "failed", result.error);
  }

  // 3 falhas → fallback email
  console.warn(`[wpp] All 3 attempts failed for ${phone}. Triggering email fallback.`);
  await triggerEmailFallback(profileId, email, userName, productName, orderId);

  return json({ status: "failed_all_attempts", fallback: "email" });
});
