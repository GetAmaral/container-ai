import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * send-onboarding-otp (antigo create-onboarding-user)
 *
 * APENAS envia OTP para o email. NÃO cria conta.
 * Se o user já existir no auth → envia OTP normalmente.
 * Se o user NÃO existir → cria um user TEMPORÁRIO só pra poder enviar OTP,
 *   mas NÃO vincula phone nem ativa nada.
 *
 * A conta só é vinculada/ativada na verify-and-create-user,
 * DEPOIS que o código for validado.
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
    const { email } = await req.json();

    if (!email) {
      return json({ error: "Email é obrigatório" }, 400);
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const trimmedEmail = email.trim().toLowerCase();

    if (!emailRegex.test(trimmedEmail)) {
      return json({ error: "Email inválido" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const authClient = createClient(supabaseUrl, anonKey);

    // ── Verificar se user já existe ──
    const { data: existingUserId } = await supabaseAdmin
      .rpc("get_user_id_by_email", { p_email: trimmedEmail });

    let userExists = !!existingUserId;

    if (!userExists) {
      // Criar user TEMPORÁRIO só pra viabilizar o envio do OTP
      // Sem phone, sem profile, sem subscription — isso vem DEPOIS da verificação
      const tempPassword = crypto.randomUUID().slice(0, 16) + "A1!";

      const { error: createError } =
        await supabaseAdmin.auth.admin.createUser({
          email: trimmedEmail,
          password: tempPassword,
          email_confirm: true,
          user_metadata: {
            onboarding_status: "pending_verification",
          },
        });

      if (createError) {
        // Se "already registered" (race condition), tudo bem — segue pro OTP
        if (!createError.message?.includes("already been registered")) {
          console.error("[send-onboarding-otp] Erro ao criar temp user:", createError);
          return json({ error: createError.message }, 400);
        }
      }

      userExists = true;
    }

    // ── Enviar OTP ──
    const { error: otpError } = await authClient.auth.signInWithOtp({
      email: trimmedEmail,
      options: { shouldCreateUser: false },
    });

    if (otpError) {
      console.error("[send-onboarding-otp] Erro OTP:", otpError);
      return json({ error: "Falha ao enviar código: " + otpError.message }, 500);
    }

    return json({
      success: true,
      otpSent: true,
      email: trimmedEmail,
    });
  } catch (error: any) {
    console.error("[send-onboarding-otp] Erro:", error);
    return json({ error: error.message || "Erro interno" }, 500);
  }
});
