// ============================================
// EDGE FUNCTION: google-calendar-wa-connect
//
// FASE 3: Adicionado trigger de sync inicial
// apos callback OAuth (linhas 244-256)
//
// IMPORTANTE: Esta versao retorna links curtos usando
// o dominio totalassistente.com.br/r/codigo
// ============================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
serve(async (req)=>{
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: corsHeaders
    });
  }
  const url = new URL(req.url);
  console.log('[WA-Google] Request:', {
    method: req.method,
    pathname: url.pathname,
    search: url.search
  });
  try {
    const action = url.searchParams.get('action');
    // ============================================
    // ACTION: auth - Gerar link OAuth
    // ============================================
    if (action === 'auth') {
      const userId = url.searchParams.get('userId');
      const phone = url.searchParams.get('phone');
      if (!userId) {
        return new Response(JSON.stringify({
          error: 'userId é obrigatório'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // Valida UUID
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(userId)) {
        return new Response(JSON.stringify({
          error: 'userId inválido (deve ser UUID)'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // State com encoding base64 URL-safe
      const stateData = {
        userId,
        phone: phone?.replace(/\D/g, '') || ''
      };
      const stateJson = JSON.stringify(stateData);
      const stateBase64 = btoa(stateJson).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const redirectUri = `${SUPABASE_URL}/functions/v1/google-calendar-wa-connect?action=callback`;
      // Monta URL OAuth
      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events openid email profile',
        access_type: 'offline',
        prompt: 'consent',
        state: stateBase64
      });
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
      console.log('[WA-Google] Auth URL gerada:', {
        userId,
        urlLength: authUrl.length
      });
      // ============================================
      // CRIAR LINK CURTO
      // ============================================
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      // Gera código único: gc-[8 chars userId]-[timestamp]
      const shortCode = `gc-${userId.substring(0, 8)}-${Date.now().toString(36).slice(-4)}`;
      const { error: shortError } = await supabase.from('short_links').insert({
        short_code: shortCode,
        original_url: authUrl,
        title: 'Conectar Google Calendar',
        description: `Conexão Google Calendar para usuário ${userId}`,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        metadata: {
          userId,
          phone: phone || null,
          type: 'google_calendar'
        }
      });
      if (shortError) {
        console.error('[WA-Google] Erro ao criar link curto:', shortError);
        // Se falhar, retorna URL longa
        return new Response(JSON.stringify({
          success: true,
          auth_url: authUrl,
          short_url: authUrl,
          userId,
          phone: phone?.replace(/\D/g, '') || null
        }), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // URL curta final - usando domínio próprio
      const shortUrl = `https://totalassistente.com.br/r/${shortCode}`;
      console.log('[WA-Google] Link curto criado:', {
        shortCode,
        shortUrl
      });
      return new Response(JSON.stringify({
        success: true,
        auth_url: authUrl,
        short_url: shortUrl,
        short_code: shortCode,
        userId,
        phone: phone?.replace(/\D/g, '') || null
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // ============================================
    // ACTION: callback - Callback do OAuth
    // ============================================
    if (action === 'callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      if (error) {
        console.error('[WA-Google] OAuth error:', error);
        return new Response(renderErrorPage('Erro na autorização: ' + error), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8'
          }
        });
      }
      if (!code || !state) {
        return new Response(renderErrorPage('Parâmetros inválidos'), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8'
          }
        });
      }
      // Decodifica state (base64 URL-safe)
      let stateData;
      try {
        const stateBase64 = state.replace(/-/g, '+').replace(/_/g, '/');
        const padding = '='.repeat((4 - stateBase64.length % 4) % 4);
        const decoded = atob(stateBase64 + padding);
        stateData = JSON.parse(decoded);
      } catch (e) {
        console.error('[WA-Google] Erro ao decodificar state:', e);
        return new Response(renderErrorPage('State inválido'), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8'
          }
        });
      }
      const { userId, phone } = stateData;
      console.log('[WA-Google] Callback recebido:', {
        userId,
        phone
      });
      // Troca código por tokens
      const redirectUri = `${SUPABASE_URL}/functions/v1/google-calendar-wa-connect?action=callback`;
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri
        })
      });
      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok) {
        console.error('[WA-Google] Token error:', tokenData);
        return new Response(renderErrorPage('Erro ao obter tokens'), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8'
          }
        });
      }
      console.log('[WA-Google] Tokens obtidos com sucesso');
      // Pega email do usuário
      let connectedEmail = null;
      try {
        const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`
          }
        });
        const userInfo = await userInfoResponse.json();
        connectedEmail = userInfo.email;
        console.log('[WA-Google] Email conectado:', connectedEmail);
      } catch (e) {
        console.warn('[WA-Google] Erro ao obter email:', e);
      }
      // Salva conexão
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
      const { error: dbError } = await supabase.rpc('store_google_connection', {
        p_user_id: userId,
        p_access_token: tokenData.access_token,
        p_refresh_token: tokenData.refresh_token,
        p_expires_at: expiresAt,
        p_connected_email: connectedEmail,
        p_scope: 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events openid email profile'
      });
      if (dbError) {
        console.error('[WA-Google] Erro ao salvar:', dbError);
        return new Response(renderErrorPage('Erro ao salvar conexão: ' + dbError.message), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8'
          }
        });
      }
      console.log('[WA-Google] Conexão salva com sucesso');

      // ============================================
      // FASE 3 - NOVO: Disparar sync inicial + webhook
      // Roda em background para nao atrasar o redirect
      // ============================================
      EdgeRuntime.waitUntil((async () => {
        try {
          console.log('[WA-Google] Disparando sync inicial para user:', userId);
          await supabase.functions.invoke('google-calendar', {
            body: { action: 'cron-sync', userId: userId, renewWebhook: true },
            headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
          });
          console.log('[WA-Google] Sync inicial disparado com sucesso');
        } catch (e) {
          console.error('[WA-Google] Erro ao disparar sync inicial:', e);
        }
      })());

      // Redireciona para WhatsApp
      const AI_WHATSAPP_NUMBER = '554384983452';
      const message = '✅ Google Calendar conectado com sucesso!';
      const whatsappUrl = `https://wa.me/${AI_WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
      return Response.redirect(whatsappUrl, 302);
    }
    // ============================================
    // ACTION: status - Verificar status
    // ============================================
    if (action === 'status') {
      const userId = url.searchParams.get('userId');
      if (!userId) {
        return new Response(JSON.stringify({
          error: 'userId obrigatório'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data, error } = await supabase.rpc('get_connection_status', {
        p_user_id: userId
      });
      if (error) {
        return new Response(JSON.stringify({
          error: error.message
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const connection = data?.[0];
      return new Response(JSON.stringify({
        success: true,
        is_connected: connection?.is_connected ?? false,
        connected_email: connection?.connected_email ?? null
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // ============================================
    // ACTION: disconnect - Desconectar
    // ============================================
    if (action === 'disconnect') {
      const userId = url.searchParams.get('userId');
      if (!userId) {
        return new Response(JSON.stringify({
          error: 'userId obrigatório'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { error } = await supabase.from('google_calendar_connections').update({
        is_connected: false,
        encrypted_access_token: null,
        encrypted_refresh_token: null,
        updated_at: new Date().toISOString()
      }).eq('user_id', userId);
      if (error) {
        return new Response(JSON.stringify({
          error: error.message
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        success: true
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    return new Response(JSON.stringify({
      error: 'Ação inválida'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('[WA-Google] Erro:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
function renderErrorPage(message) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Erro - Total Assistente</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 20px;
      padding: 40px;
      text-align: center;
      max-width: 400px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.2);
    }
    .icon { font-size: 60px; margin-bottom: 20px; }
    h1 { color: #ef4444; font-size: 24px; margin-bottom: 10px; }
    p { color: #666; font-size: 14px; line-height: 1.6; word-break: break-word; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">❌</div>
    <h1>Erro na Conexão</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}
