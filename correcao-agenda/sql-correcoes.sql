-- ============================================================
-- SQL CORREÇÕES PARA GOOGLE CALENDAR
-- ============================================================
-- Execute TUDO no SQL Editor do Supabase (na ordem)
-- ============================================================


-- ============================================================
-- 1. ADICIONAR service_role_key AO VAULT
-- ============================================================
-- IMPORTANTE: Substitua 'SUA_SERVICE_ROLE_KEY_AQUI' pela sua
-- service role key real.
-- Encontre em: Supabase Dashboard → Settings → API → service_role (secret)
-- ============================================================

-- Primeiro, verificar se já existe:
-- SELECT name FROM vault.decrypted_secrets WHERE name = 'service_role_key';

-- Se retornar 0 linhas, execute:
SELECT vault.create_secret(
  'SUA_SERVICE_ROLE_KEY_AQUI',   -- ← COLE SUA KEY AQUI
  'service_role_key'
);

-- Para verificar se foi salvo:
-- SELECT name FROM vault.decrypted_secrets WHERE name = 'service_role_key';


-- ============================================================
-- 2. VERIFICAR SE A UNIQUE CONSTRAINT EXISTE
-- ============================================================
-- O upsert do sync usa onConflict: "user_id,session_event_id_google"
-- Se essa constraint não existir, o upsert falha.
-- ============================================================

-- Verificar constraints existentes:
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'public.calendar'::regclass AND contype = 'u';

-- Se NÃO existir uma constraint em (user_id, session_event_id_google), crie:
-- (Descomente a linha abaixo se necessário)
-- ALTER TABLE public.calendar
--   ADD CONSTRAINT calendar_user_google_event_unique
--   UNIQUE (user_id, session_event_id_google);


-- ============================================================
-- 3. VERIFICAR SE A COLUNA _syncing_from_google EXISTE
-- ============================================================
-- O sync insere esse campo. Se não existir, o upsert falha.
-- ============================================================

-- Verificar:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'calendar' AND column_name = '_syncing_from_google';

-- Se NÃO existir, crie:
-- (Descomente as linhas abaixo se necessário)
-- ALTER TABLE public.calendar
--   ADD COLUMN IF NOT EXISTS _syncing_from_google BOOLEAN DEFAULT false;


-- ============================================================
-- 4. VERIFICAR SE O TRIGGER BIDIRECIONAL EXISTE
-- ============================================================
-- O trigger sync_calendar_event_to_google é responsável por
-- enviar eventos criados localmente para o Google Calendar.
-- ============================================================

-- Verificar:
-- SELECT tgname FROM pg_trigger
-- WHERE tgrelid = 'public.calendar'::regclass
--   AND tgname = 'tr_sync_calendar_to_google';

-- Se NÃO existir, verifique se a migration foi aplicada:
-- A migration está em:
-- site/supabase/migrations/20260210000000_google_calendar_bidirectional_sync.sql


-- ============================================================
-- 5. VERIFICAR SE pg_net ESTÁ HABILITADO (para o trigger)
-- ============================================================

-- Verificar:
-- SELECT extname FROM pg_extension WHERE extname = 'pg_net';

-- Se não existir:
-- CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
