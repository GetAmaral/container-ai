// ============================================================
// Story 1.4: Enviar Email de Ativação (Path B)
// Supabase Edge Function (Deno)
//
// Dois gatilhos:
//   1. sem_telefone: user sem phone no webhook → email direto
//   2. fallback_whatsapp: WhatsApp falhou 3x → email como plano B
//
// Email contém link wa.me com mensagem pré-preenchida.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// --- Config ---

const WHATSAPP_NUMBER = Deno.env.get("WHATSAPP_BUSINESS_NUMBER") ?? "5543999999999";

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

// --- Link wa.me ---

function buildWaMeLink(productName: string): string {
  const msg = encodeURIComponent(`Olá, comprei ${productName} e quero ativar minha conta`);
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${msg}`;
}

// --- Envio de Email via Resend ---

async function sendEmail(
  to: string,
  userName: string,
  productName: string,
): Promise<{ ok: boolean; error?: string }> {
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("EMAIL_FROM") ?? "Total <noreply@total.com>";

  if (!resendKey) {
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }

  const waMeLink = buildWaMeLink(productName);

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2>Olá ${userName}! 👋</h2>
      <p>Sua compra de <strong>"${productName}"</strong> foi confirmada com sucesso!</p>
      <p>Para ativar sua conta, entre em contato conosco via WhatsApp:</p>
      <p style="text-align: center; margin: 30px 0;">
        <a href="${waMeLink}"
           style="background: #25D366; color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-size: 16px; font-weight: bold;">
          ATIVAR MINHA CONTA VIA WHATSAPP
        </a>
      </p>
      <p>Ou adicione nosso número e envie uma mensagem:<br>
         <strong>+${WHATSAPP_NUMBER.replace(/(\d{2})(\d{2})(\d{5})(\d{4})/, "$1 ($2) $3-$4")}</strong>
      </p>
      <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;">
      <p style="color: #888; font-size: 13px;">Equipe Total</p>
    </div>
  `;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [to],
        subject: `Sua compra foi confirmada! Ative sua conta no Total`,
        html,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return { ok: false, error: `Resend ${res.status}: ${err}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown" };
  }
}

// --- Main Handler ---

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: {
    profileId: string;
    email: string;
    userName: string;
    productName: string;
    orderId: string;
    emailType: "sem_telefone" | "fallback_whatsapp";
  };

  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { profileId, email, userName, productName, orderId, emailType } = body;

  if (!profileId || !email) {
    return json({ error: "Missing profileId or email" }, 400);
  }

  const db = supabase();

  // Controle de duplicata: já enviou email pra esse order_id + tipo?
  const { data: existing } = await db
    .from("payments")
    .select("id, email_enviado, email_tipo")
    .eq("transaction_id", orderId)
    .maybeSingle();

  if (existing?.email_enviado && existing?.email_tipo === emailType) {
    console.log(`[email] Already sent ${emailType} for order ${orderId}. Skipping.`);
    return json({ status: "already_sent" });
  }

  // Enviar email
  console.log(`[email] Sending ${emailType} to ${email} | order: ${orderId}`);
  const result = await sendEmail(email, userName, productName);

  if (result.ok) {
    // Registrar no banco
    await db
      .from("payments")
      .update({
        email_enviado: true,
        email_tipo: emailType,
        email_enviado_at: new Date().toISOString(),
      })
      .eq("transaction_id", orderId);

    console.log(`[email] Sent OK: ${emailType} to ${email}`);
    return json({ status: "sent", emailType });
  }

  // Falha no envio
  console.error(`[email] Failed: ${result.error}`);
  return json({ status: "error", error: result.error }, 500);
});
