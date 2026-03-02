# Correção Google Calendar - Passo a Passo

## Problemas Identificados

| # | Problema | Impacto |
|---|---------|---------|
| 1 | `google-calendar-connect` não dispara sync após salvar tokens | User conecta mas 0 eventos aparecem |
| 2 | `google-calendar` não aceita action "sync" (só "sync_now") | Sync manual do frontend falha |
| 3 | `google-calendar` não faz refresh de token | Sync falha após 1h |
| 4 | `google-calendar` não tem handlers create/update/delete | Frontend não consegue criar/editar/deletar eventos no Google |
| 5 | `google-calendar` não aceita service_role auth | Cron e trigger SQL falham |
| 6 | Cron chama action "cron-sync" que não existia | Sync periódico nunca funciona |
| 7 | Vault sem service_role_key | Trigger bidirecional (local→Google) falha |
| 8 | Webhook: syncToken e pageToken setados juntos | Possível erro na paginação |

---

## Passo 1: Correções no Banco (SQL)

Abra o **SQL Editor** no Supabase Dashboard.

### 1.1 Adicionar service_role_key ao Vault

Vá em **Settings → API** e copie a `service_role` key (a secreta, não a anon).

Execute:
```sql
SELECT vault.create_secret(
  'COLE_SUA_SERVICE_ROLE_KEY_AQUI',
  'service_role_key'
);
```

Verifique:
```sql
SELECT name FROM vault.decrypted_secrets WHERE name = 'service_role_key';
```
Deve retornar 1 linha.

### 1.2 Verificar unique constraint

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.calendar'::regclass AND contype = 'u';
```

Se NÃO tiver constraint em `(user_id, session_event_id_google)`:
```sql
ALTER TABLE public.calendar
  ADD CONSTRAINT calendar_user_google_event_unique
  UNIQUE (user_id, session_event_id_google);
```

### 1.3 Verificar coluna _syncing_from_google

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'calendar' AND column_name = '_syncing_from_google';
```

Se não existir:
```sql
ALTER TABLE public.calendar
  ADD COLUMN IF NOT EXISTS _syncing_from_google BOOLEAN DEFAULT false;
```

### 1.4 Verificar pg_net extension

```sql
SELECT extname FROM pg_extension WHERE extname = 'pg_net';
```

Se não existir:
```sql
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
```

---

## Passo 2: Deploy das Edge Functions

### Pré-requisitos

Certifique-se de ter o Supabase CLI instalado e logado:
```bash
npx supabase login
npx supabase link --project-ref ldbdtakddxznfridsarn
```

### 2.1 Deploy google-calendar (função principal)

Copie o conteúdo de `google-calendar.ts` para:
```
site/supabase/functions/google-calendar/index.ts
```

Deploy:
```bash
cd site
npx supabase functions deploy google-calendar --no-verify-jwt
```

> `--no-verify-jwt` é necessário porque a função aceita tanto GET (sem JWT)
> quanto POST com JWT ou service_role.

### 2.2 Deploy google-calendar-connect (callback OAuth)

Copie o conteúdo de `google-calendar-connect.ts` para:
```
site/supabase/functions/google-calendar-connect/index.ts
```

Deploy:
```bash
npx supabase functions deploy google-calendar-connect --no-verify-jwt
```

> `--no-verify-jwt` necessário porque recebe redirect do Google (GET sem JWT).

### 2.3 Deploy google-calendar-webhook

Copie o conteúdo de `google-calendar-webhook.ts` para:
```
site/supabase/functions/google-calendar-webhook/index.ts
```

Deploy:
```bash
npx supabase functions deploy google-calendar-webhook --no-verify-jwt
```

> `--no-verify-jwt` necessário porque recebe POST do Google (sem JWT).

### 2.4 Deploy google-calendar-sync-cron

Copie o conteúdo de `google-calendar-sync-cron.ts` para:
```
site/supabase/functions/google-calendar-sync-cron/index.ts
```

Deploy:
```bash
npx supabase functions deploy google-calendar-sync-cron --no-verify-jwt
```

### 2.5 Verificar variáveis de ambiente

Todas as edge functions precisam das seguintes env vars (configuradas via `supabase secrets set`):

```bash
npx supabase secrets set GOOGLE_CLIENT_ID="seu_client_id"
npx supabase secrets set GOOGLE_CLIENT_SECRET="seu_client_secret"
npx supabase secrets set APP_URL="https://totalassistente.com.br"
npx supabase secrets set GC_STATE_SECRET="um_segredo_aleatorio_forte"
```

> `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já são automáticos.

---

## Passo 3: Testar

### 3.1 Testar conexão
1. Abra o site → Dashboard → Clique em "Conectar Google Agenda"
2. Autorize no Google
3. Deve redirecionar para a página de sucesso
4. Após 5-10 segundos, os eventos do Google devem aparecer no dashboard

### 3.2 Testar sync manual
1. No dashboard, clique em "Sincronizar" (se houver botão)
2. Deve importar eventos novos

### 3.3 Testar webhook (Google → Supabase)
1. Crie um evento no Google Calendar
2. Aguarde ~30 segundos
3. O evento deve aparecer automaticamente no dashboard

### 3.4 Testar CRUD (Supabase → Google)
1. Crie um evento pelo dashboard
2. Verifique se aparece no Google Calendar
3. Edite o evento → deve atualizar no Google
4. Delete o evento → deve sumir do Google

### 3.5 Verificar logs
Se algo não funcionar, verifique os logs:

**Supabase Dashboard → Edge Functions → [nome-da-função] → Logs**

Cada função tem prefixo nos logs:
- `[gc]` → google-calendar
- `[connect]` → google-calendar-connect
- `[webhook]` → google-calendar-webhook
- `[cron]` → google-calendar-sync-cron

---

## Resumo das Mudanças

### google-calendar.ts
- **NOVO**: Suporte GET para OAuth redirect (compatibilidade frontend)
- **NOVO**: Token refresh automático (antes jogava erro)
- **NOVO**: Aceita "sync" como alias de "sync_now"
- **NOVO**: Handlers create/update/delete para frontend e trigger
- **NOVO**: Handler cron-sync com auth por service_role
- **NOVO**: Auth dual (JWT para user, service_role para cron/trigger)

### google-calendar-connect.ts
- **NOVO**: `EdgeRuntime.waitUntil(backgroundSyncAndWebhook(...))` após salvar tokens
- Importa eventos e cria webhook automaticamente ao conectar

### google-calendar-webhook.ts
- **FIX**: syncToken/pageToken nunca são setados juntos
- Resto mantido (refresh já funcionava)

### google-calendar-sync-cron.ts
- **FIX**: Usa fetch direto com service_role auth
- **FIX**: Renova webhook quando não existe (não só quando expira)
- **FIX**: Wrapped cleanup_expired_google_webhooks em try-catch

### SQL
- **NOVO**: service_role_key no Vault (para trigger bidirecional)
