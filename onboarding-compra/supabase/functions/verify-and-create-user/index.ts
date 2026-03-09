import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * verify-and-create-user
 *
 * Chamada pelo n8n DEPOIS que o user digita o código OTP no WhatsApp.
 * 1. Verifica o código OTP contra o Supabase Auth
 * 2. SÓ se o código for válido:
 *    - Atualiza user_metadata com phone + name
 *    - Upsert no profile vinculando phone
 *    - Vincula subscriptions existentes
 * 3. Se código inválido → rejeita, NÃO vincula nada
 *
 * Isso garante que ninguém vincula um email ao WhatsApp sem provar
 * que é dono daquele email.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const { email, otp_code, phone, name } = await req.json();

    if (!email || !otp_code) {
      return json({ error: "Email e código são obrigatórios" }, 400);
    }

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedCode = otp_code.trim();

    if (!/^\d{6}$/.test(trimmedCode)) {
      return json({
        success: false,
        verified: false,
        error: "Código deve ter 6 dígitos",
      }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const authClient = createClient(supabaseUrl, anonKey);

    // ── Step 1: Verificar OTP ──
    const { data: verifyData, error: verifyError } =
      await authClient.auth.verifyOtp({
        email: trimmedEmail,
        token: trimmedCode,
        type: "email",
      });

    if (verifyError || !verifyData.user) {
      console.warn("[verify-and-create-user] Código inválido para:", trimmedEmail);
      return json({
        success: false,
        verified: false,
        error: "Código inválido ou expirado",
      }, 401);
    }

    // ── Step 2: Código válido! Agora sim vincular tudo ──
    const userId = verifyData.user.id;
    console.log("[verify-and-create-user] Código válido. User:", userId);

    // Atualizar metadata do user com phone e name
    const { error: updateError } =
      await supabaseAdmin.auth.admin.updateUserById(userId, {
        user_metadata: {
          name: name || null,
          phone: phone || null,
          onboarding_source: "whatsapp",
          onboarding_status: "verified",
          verified_at: new Date().toISOString(),
        },
      });

    if (updateError) {
      console.error("[verify-and-create-user] Erro ao atualizar metadata:", updateError);
    }

    // ── Step 3: Upsert profile ──
    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .upsert({
        id: userId,
        email: trimmedEmail,
        name: name || null,
        phone: phone || null,
      });

    if (profileError) {
      console.error("[verify-and-create-user] Erro no profile:", profileError);
    }

    // ── Step 4: Vincular subscriptions existentes ──
    const { error: subError } = await supabaseAdmin
      .from("subscriptions")
      .update({ user_id: userId })
      .ilike("email", trimmedEmail);

    if (subError) {
      console.error("[verify-and-create-user] Erro ao vincular subscription:", subError);
    }

    return json({
      success: true,
      verified: true,
      userId,
      email: trimmedEmail,
      phone: phone || null,
    });
  } catch (error: any) {
    console.error("[verify-and-create-user] Erro:", error);
    return json({ error: error.message || "Erro interno" }, 500);
  }
});
