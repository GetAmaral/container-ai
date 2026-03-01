-- ============================================================================
-- SYNC BIDIRECIONAL GOOGLE CALENDAR — SQL
-- Rodar TUDO no SQL Editor do Supabase (de uma vez)
-- ============================================================================

-- ============================================================================
-- 1. FIX: secure_get_google_tokens
--    Bug: a funcao original checa auth.users, que falha via service_role
--    Fix: checar google_calendar_connections em vez de auth.users
-- ============================================================================

CREATE OR REPLACE FUNCTION public.secure_get_google_tokens(p_user_id uuid)
RETURNS TABLE(
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  is_connected boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Validar que user tem conexao (NAO usa auth.users)
  IF NOT EXISTS (
    SELECT 1 FROM google_calendar_connections WHERE user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'No Google Calendar connection found for user';
  END IF;

  RETURN QUERY
  SELECT
    pgp_sym_decrypt(gcc.encrypted_access_token::bytea, current_setting('app.encryption_key'))::text AS access_token,
    pgp_sym_decrypt(gcc.encrypted_refresh_token::bytea, current_setting('app.encryption_key'))::text AS refresh_token,
    gcc.expires_at AS expires_at,
    gcc.is_connected AS is_connected
  FROM google_calendar_connections gcc
  WHERE gcc.user_id = p_user_id;
END;
$$;

-- ============================================================================
-- 2. RESET: failed_access_attempts de todos os users
-- ============================================================================

UPDATE google_calendar_connections
SET failed_access_attempts = 0
WHERE failed_access_attempts > 0;

-- ============================================================================
-- 3. COLUNAS: garantir que existem na tabela calendar
-- ============================================================================

-- Flag para prevenir sync loop
ALTER TABLE calendar ADD COLUMN IF NOT EXISTS _syncing_from_google boolean DEFAULT false;

-- Campos para eventos recorrentes
ALTER TABLE calendar ADD COLUMN IF NOT EXISTS is_recurring boolean DEFAULT false;
ALTER TABLE calendar ADD COLUMN IF NOT EXISTS rrule text;
ALTER TABLE calendar ADD COLUMN IF NOT EXISTS next_fire_at timestamptz;

-- ============================================================================
-- 4. CONFIGURACAO: URL e service role key para o trigger
--    IMPORTANTE: substituir os valores abaixo antes de rodar!
-- ============================================================================

-- Salvar URL do Supabase como config (usado pelo trigger)
-- SUBSTITUIR 'YOUR_SUPABASE_URL' pela URL real do projeto
ALTER DATABASE postgres SET app.supabase_url = 'YOUR_SUPABASE_URL';

-- Salvar service role key como config (usado pelo trigger)
-- SUBSTITUIR 'YOUR_SERVICE_ROLE_KEY' pela key real
ALTER DATABASE postgres SET app.service_role_key = 'YOUR_SERVICE_ROLE_KEY';

-- Recarregar configs
SELECT pg_reload_conf();

-- ============================================================================
-- 5. TRIGGER FUNCTION: sync calendar -> Google
-- ============================================================================

CREATE OR REPLACE FUNCTION trigger_sync_calendar_to_google()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _supabase_url text;
  _service_role_key text;
BEGIN
  -- Se veio do Google sync, NAO sincronizar de volta (previne loop)
  IF NEW._syncing_from_google = true THEN
    RETURN NEW;
  END IF;

  -- Se ja tem Google ID, nao precisa criar (ja existe no Google)
  IF NEW.session_event_id_google IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Verificar se user tem Google Calendar conectado
  IF NOT EXISTS (
    SELECT 1 FROM google_calendar_connections
    WHERE user_id = NEW.user_id AND is_connected = true
  ) THEN
    RETURN NEW;
  END IF;

  -- Buscar configs
  _supabase_url := current_setting('app.supabase_url', true);
  _service_role_key := current_setting('app.service_role_key', true);

  -- Se configs nao existem, nao fazer nada
  IF _supabase_url IS NULL OR _service_role_key IS NULL THEN
    RAISE WARNING 'app.supabase_url or app.service_role_key not configured';
    RETURN NEW;
  END IF;

  -- Chamar edge function async via pg_net
  PERFORM net.http_post(
    url := _supabase_url || '/functions/v1/google-calendar',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || _service_role_key
    ),
    body := jsonb_build_object(
      'action', 'push-to-google',
      'userId', NEW.user_id::text,
      'calendarRowId', NEW.id::text
    )
  );

  RETURN NEW;
END;
$$;

-- ============================================================================
-- 6. TRIGGER: recriar como BEFORE INSERT
-- ============================================================================

-- Remover trigger antigo (se existir, qualquer nome)
DROP TRIGGER IF EXISTS sync_calendar_to_google ON calendar;
DROP TRIGGER IF EXISTS trigger_sync_to_google ON calendar;
DROP TRIGGER IF EXISTS on_calendar_insert_sync_google ON calendar;

-- Criar trigger BEFORE INSERT
CREATE TRIGGER sync_calendar_to_google
  BEFORE INSERT ON calendar
  FOR EACH ROW
  EXECUTE FUNCTION trigger_sync_calendar_to_google();

-- ============================================================================
-- 7. VERIFICACAO
-- ============================================================================

-- Verificar que a funcao foi criada
SELECT routine_name FROM information_schema.routines
WHERE routine_name IN ('secure_get_google_tokens', 'trigger_sync_calendar_to_google');

-- Verificar que o trigger existe
SELECT trigger_name, event_manipulation, action_timing
FROM information_schema.triggers
WHERE event_object_table = 'calendar'
AND trigger_name = 'sync_calendar_to_google';

-- Verificar que as colunas existem
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'calendar'
AND column_name IN ('_syncing_from_google', 'is_recurring', 'rrule', 'next_fire_at');
