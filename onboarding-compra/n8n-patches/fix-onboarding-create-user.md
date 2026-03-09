# Fix: Onboarding — Criar User + Anti-Loop

## Problema Diagnosticado (Execução #154826 — 09/03/2026 00:04 UTC)

### Erro 1: HTTP Request4 — Loop Infinito
O node `HTTP Request4` (criar user via Admin API) conectava de volta ao
`HTTP Request1` (enviar OTP). Se o OTP falhasse, tentava criar user de novo,
criando um **loop infinito**.

### Erro 2: Headers incompletos no HTTP Request4
O node não enviava `Content-Type: application/json` nem `apikey` —
a Admin API rejeitava a requisição.

### Erro 3: service_role_key exposto no n8n
A key estava nos headers do workflow JSON, acessível a qualquer editor.

### Erro 4: Referência a node inexistente no Create a row3
`$('trigger-whatsappsdadsa')` → node não existe. Correto: `$('trigger-whatsapp')`

---

## Solução: Edge Function `create-onboarding-user`

Uma única Edge Function que faz tudo em uma chamada:
1. Verifica se user já existe
2. Se não existe → cria via Admin API (service_role fica dentro do Supabase)
3. Envia OTP para o email
4. Retorna resultado completo

### Benefícios
- **Anti-loop:** Uma chamada = um resultado. Sem re-tentativas circulares.
- **Segurança:** service_role_key nunca sai do Supabase.
- **Simplicidade:** n8n só precisa de 1 node HTTP Request com anon key.

---

## Como aplicar no n8n

### Substituir: HTTP Request1 + HTTP Request4 → 1 único node

**Remover:**
- Node `HTTP Request1` (OTP direto)
- Node `HTTP Request4` (criar user)
- A conexão circular entre eles

**Adicionar:** Um único node HTTP Request:

```
Name: "Create User + Send OTP"
Method: POST
URL: https://ldbdtakddxznfridsarn.supabase.co/functions/v1/create-onboarding-user

Headers:
  apikey: <SUPABASE_ANON_KEY>
  Content-Type: application/json

Body (JSON):
{
  "email": "{{ $('Get a row3').item.json.email }}",
  "phone": "{{ $('trigger-whatsapp').item.json.contacts[0].wa_id }}",
  "name": "{{ $('Get a row3').item.json.name || '' }}"
}

On Error: continueErrorOutput
```

**Conexões:**
- `Update a row4` (stg→4) → **Create User + Send OTP**
  - Sucesso (`$json.otpSent === true`) → `Send message6` (pede código)
  - Erro → mensagem de erro para o usuário (sem loop!)

### Corrigir: Create a row3

Trocar nos campos `ai_message` e `user_message`:
```
DE:  {{ $('trigger-whatsappsdadsa').item.json.body[0].messages[0].text.body }}
PARA: {{ $('trigger-whatsapp').item.json.messages[0].text.body }}
```

---

## Fluxo Corrigido (Completo)

```
trigger-whatsapp
  → Get a row3 (busca phone)
    → Switch (verifica stg)
      → stg=2 → Template confirmação email → Update a row1 (stg→3) → Create a row3 (log)
      → stg=3 → Switch1 (Sim/Não)
        → Sim → Update a row4 (stg→4) → [Create User + Send OTP]
          → sucesso → Send message6 ("digite o código") → Create a row6 (log)
          → erro   → Send message erro → FIM (sem loop!)
        → Não → Send message7 ("digite email correto") → Update a row3 (stg→2) → Create a row7 (log)
```

---

## Deploy da Edge Function

```bash
cd /home/totalAssistente/site
supabase functions deploy create-onboarding-user --project-ref ldbdtakddxznfridsarn
```

Variáveis de ambiente necessárias (já configuradas no Supabase):
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
