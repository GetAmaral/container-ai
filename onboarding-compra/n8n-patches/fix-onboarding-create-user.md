# Fix: Onboarding — Segurança + Anti-Loop

## Problemas Diagnosticados (Execução #154826 — 09/03/2026 00:04 UTC)

### CRÍTICO: Conta vinculada SEM verificar código
O fluxo original criava a conta e vinculava email→phone ANTES de verificar
o código OTP. Qualquer pessoa podia digitar qualquer email, dizer "Sim",
e ter aquele email vinculado ao seu WhatsApp sem provar ser dona do email.

### Erro 2: HTTP Request4 — Loop Infinito
HTTP Request4 (criar user) conectava de volta ao HTTP Request1 (enviar OTP).
Se OTP falhasse → tentava criar user de novo → loop infinito.

### Erro 3: service_role_key exposto no n8n
A key estava nos headers do workflow JSON, acessível a qualquer editor.

### Erro 4: Referência a node inexistente no Create a row3
`$('trigger-whatsappsdadsa')` → node não existe. Correto: `$('trigger-whatsapp')`

---

## Solução: 2 Edge Functions (verificação ANTES da vinculação)

### Function 1: `create-onboarding-user` (renomear para send-onboarding-otp)
- Recebe: `{ email }`
- Verifica se user existe. Se não → cria user TEMPORÁRIO (sem phone, sem profile)
- Envia OTP para o email
- NÃO vincula nada. NÃO cria profile. NÃO toca em subscriptions.

### Function 2: `verify-and-create-user` (NOVA)
- Recebe: `{ email, otp_code, phone, name }`
- Verifica o código OTP contra Supabase Auth
- Código INVÁLIDO → rejeita, retorna `{ verified: false }`
- Código VÁLIDO → SÓ AGORA:
  - Atualiza user_metadata com phone + name
  - Upsert no profile vinculando phone
  - Vincula subscriptions existentes
  - Retorna `{ verified: true, userId }`

---

## Fluxo Corrigido no n8n (com novo stg=5)

```
trigger-whatsapp
  → Get a row3 (busca phone em phones_whatsapp)
    → Switch (verifica stg)

      → stg=2 → Template "Seu email é X. Está correto? Sim/Não"
        → Update a row1 (stg→3, salva email temporário)
        → Create a row3 (log)

      → stg=3 → Switch1 (Sim/Não)
        → Sim → [Send Onboarding OTP] (só envia código, NÃO cria conta)
          → sucesso → Update stg→4 → Send message "digite o código"
          → erro    → Send message erro → FIM
        → Não → Send message "digite email correto"
          → Update stg→2

      → stg=4 → [Verify and Create User] (verifica código + vincula)
        → verified: true  → Update stg→5 → Send message "Conta ativada!"
        → verified: false → Send message "Código inválido, tente novamente"
          (mantém stg=4, user pode tentar de novo)
```

---

## Nodes no n8n

### Node: "Send Onboarding OTP" (substitui HTTP Request1 + HTTP Request4)

```
Method: POST
URL: https://ldbdtakddxznfridsarn.supabase.co/functions/v1/create-onboarding-user
Headers:
  apikey: <SUPABASE_ANON_KEY>
  Content-Type: application/json
Body:
{
  "email": "{{ $('Get a row3').item.json.email }}"
}
On Error: continueErrorOutput
```

Conexão: Switch (stg=3) → Switch1 "Sim" → **Send Onboarding OTP**
  - Sucesso → Update stg→4 → Send message6 ("digite o código")
  - Erro → Send message erro

### Node: "Verify and Create User" (NOVO)

```
Method: POST
URL: https://ldbdtakddxznfridsarn.supabase.co/functions/v1/verify-and-create-user
Headers:
  apikey: <SUPABASE_ANON_KEY>
  Content-Type: application/json
Body:
{
  "email": "{{ $('Get a row3').item.json.email }}",
  "otp_code": "{{ $('Edit Fields').item.json.messageSet }}",
  "phone": "{{ $('trigger-whatsapp').item.json.contacts[0].wa_id }}",
  "name": "{{ $('Get a row3').item.json.name || '' }}"
}
On Error: continueErrorOutput
```

Conexão: Switch (stg=4) → **Verify and Create User**
  - `$json.verified === true` → Update stg→5 → Send message "Conta ativada!"
  - `$json.verified === false` → Send message "Código inválido ou expirado"

### Corrigir: Create a row3

```
DE:  {{ $('trigger-whatsappsdadsa').item.json.body[0].messages[0].text.body }}
PARA: {{ $('trigger-whatsapp').item.json.messages[0].text.body }}
```

---

## Deploy

```bash
# 1. Rodar migration (criar RPC get_user_id_by_email)
# Via Supabase Dashboard > SQL Editor, rodar o conteúdo de:
# migrations/003_get_user_id_by_email.sql

# 2. Deploy das edge functions
supabase functions deploy create-onboarding-user --project-ref ldbdtakddxznfridsarn
supabase functions deploy verify-and-create-user --project-ref ldbdtakddxznfridsarn
```

Variáveis de ambiente necessárias (já configuradas no Supabase):
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`

---

## Segurança Garantida

| Antes | Depois |
|-------|--------|
| Conta criada quando user diz "Sim" | Conta vinculada SÓ após código válido |
| service_role_key no n8n | service_role_key só dentro do Supabase |
| Loop infinito entre nodes | Uma chamada = um resultado |
| Phone vinculado sem prova de email | Phone vinculado só com OTP verificado |
