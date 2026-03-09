import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * create-onboarding-user
 *
 * Chamada pelo n8n durante o onboarding via WhatsApp.
 * 1. Cria o auth user (se não existir) com email_confirm: true
 * 2. Envia OTP para o email do user
 * 3. Retorna o resultado em uma única chamada (anti-loop)
 *
 * Segurança: service_role_key fica APENAS dentro do Supabase,
 * n8n chama via anon key + apikey header (sem expor service_role).
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
    const { email, phone, name } = await req.json();

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

    // ── Step 1: Verificar se user já existe (query direta em auth.users) ──
    let userId: string | null = null;
    let userCreated = false;

    const { data: existingUser } = await supabaseAdmin
      .rpc("get_user_id_by_email", { p_email: trimmedEmail });

    if (existingUser) {
      // User já existe — apenas prosseguir para OTP
      userId = existingUser;
      console.log("[create-onboarding-user] User já existe:", userId);
    } else {
      // ── Step 2: Criar user via Admin API ──
      const tempPassword =
        crypto.randomUUID().slice(0, 16) + "A1!"; // Senha temporária segura

      const { data: userData, error: createError } =
        await supabaseAdmin.auth.admin.createUser({
          email: trimmedEmail,
          password: tempPassword,
          email_confirm: true,
          user_metadata: {
            name: name || null,
            phone: phone || null,
            onboarding_source: "whatsapp",
          },
        });

      if (createError) {
        console.error("[create-onboarding-user] Erro ao criar:", createError);
        return json({ error: createError.message }, 400);
      }

      userId = userData.user?.id ?? null;
      userCreated = true;
      console.log("[create-onboarding-user] User criado:", userId);

      // ── Step 3: Upsert profile ──
      if (userId) {
        const { error: profileError } = await supabaseAdmin
          .from("profiles")
          .upsert({
            id: userId,
            email: trimmedEmail,
            name: name || null,
            phone: phone || null,
          });

        if (profileError) {
          console.error(
            "[create-onboarding-user] Erro no profile:",
            profileError
          );
        }

        // Vincular subscriptions existentes
        await supabaseAdmin
          .from("subscriptions")
          .update({ user_id: userId })
          .ilike("email", trimmedEmail);
      }
    }

    // ── Step 4: Enviar OTP ──
    const { error: otpError } = await authClient.auth.signInWithOtp({
      email: trimmedEmail,
      options: {
        shouldCreateUser: false,
      },
    });

    if (otpError) {
      console.error("[create-onboarding-user] Erro OTP:", otpError);
      return json(
        {
          success: false,
          userCreated,
          userId,
          otpSent: false,
          error: "Usuário criado mas falha ao enviar OTP: " + otpError.message,
        },
        500
      );
    }

    // ── Sucesso completo ──
    return json({
      success: true,
      userCreated,
      userId,
      otpSent: true,
      email: trimmedEmail,
    });
  } catch (error: any) {
    console.error("[create-onboarding-user] Erro:", error);
    return json({ error: error.message || "Erro interno" }, 500);
  }
});
