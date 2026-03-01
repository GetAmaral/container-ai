-- =============================================
-- MIGRATION: FIX GOOGLE CALENDAR SYNC LOOP
-- =============================================
-- Problema: Quando eventos chegam do Google → Supabase, o trigger
-- sync_calendar_event_to_google dispara e tenta sincronizar de volta,
-- criando um loop infinito.
--
-- Solução: Coluna _syncing_from_google como "etiqueta" que diz ao trigger
-- para não sincronizar de volta quando o evento veio do Google.
-- =============================================

-- ETAPA 1: Adicionar coluna _syncing_from_google
-- Default FALSE = comportamento existente do app e N8N não muda
ALTER TABLE public.calendar
ADD COLUMN IF NOT EXISTS _syncing_from_google BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.calendar._syncing_from_google IS 'Flag temporária para prevenir sync loop. TRUE = evento veio do Google, não sincronizar de volta.';

-- ETAPA 2: Substituir a function do trigger com proteção anti-loop
-- IMPORTANTE: Trigger muda de AFTER para BEFORE para poder modificar NEW._syncing_from_google
CREATE OR REPLACE FUNCTION public.sync_calendar_event_to_google()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_is_connected BOOLEAN;
  v_edge_function_url TEXT;
  v_service_role_key TEXT;
  v_action TEXT;
  v_event_data JSONB;
BEGIN
  -- 1. Check if user has an active Google Calendar connection
  SELECT is_connected INTO v_is_connected
  FROM public.google_calendar_connections
  WHERE user_id = COALESCE(NEW.user_id, OLD.user_id)
    AND is_connected = true;

  -- If not connected, do nothing
  IF NOT v_is_connected THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- 2. NOVO: Se veio do Google, não sincronizar de volta (previne loop)
  IF TG_OP IN ('INSERT', 'UPDATE') AND COALESCE(NEW._syncing_from_google, FALSE) THEN
    -- Reseta a flag para não ficar TRUE permanentemente
    NEW._syncing_from_google := FALSE;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' AND COALESCE(OLD._syncing_from_google, FALSE) THEN
    RETURN OLD;
  END IF;

  -- 3. Determine action and prepare data (lógica existente, sem alterações)
  IF (TG_OP = 'INSERT') THEN
    -- If event already has a Google ID, it's likely coming FROM Google, so don't sync back
    IF NEW.session_event_id_google IS NOT NULL THEN
      RETURN NEW;
    END IF;
    v_action := 'create';
    v_event_data := jsonb_build_object(
      'summary', NEW.event_name,
      'description', COALESCE(NEW.desc_event, ''),
      'start', jsonb_build_object('dateTime', NEW.start_event, 'timeZone', COALESCE(NEW.timezone, 'America/Sao_Paulo')),
      'end', jsonb_build_object('dateTime', NEW.end_event, 'timeZone', COALESCE(NEW.timezone, 'America/Sao_Paulo'))
    );
  ELSIF (TG_OP = 'UPDATE') THEN
    -- Skip if the Google ID is the only thing that changed (loop prevention)
    IF (OLD.session_event_id_google IS NULL AND NEW.session_event_id_google IS NOT NULL) OR
       (OLD.event_name = NEW.event_name AND OLD.start_event = NEW.start_event AND OLD.end_event = NEW.end_event AND COALESCE(OLD.desc_event, '') = COALESCE(NEW.desc_event, '')) THEN
      RETURN NEW;
    END IF;

    -- If no Google ID, try to create; otherwise update
    IF NEW.session_event_id_google IS NULL THEN
      v_action := 'create';
    ELSE
      v_action := 'update';
    END IF;

    v_event_data := jsonb_build_object(
      'summary', NEW.event_name,
      'description', COALESCE(NEW.desc_event, ''),
      'start', jsonb_build_object('dateTime', NEW.start_event, 'timeZone', COALESCE(NEW.timezone, 'America/Sao_Paulo')),
      'end', jsonb_build_object('dateTime', NEW.end_event, 'timeZone', COALESCE(NEW.timezone, 'America/Sao_Paulo'))
    );
  ELSIF (TG_OP = 'DELETE') THEN
    -- If no Google ID, nothing to delete in Google
    IF OLD.session_event_id_google IS NULL THEN
      RETURN OLD;
    END IF;
    v_action := 'delete';
  END IF;

  -- 4. Get Edge Function config
  v_edge_function_url := 'https://ldbdtakddxznfridsarn.supabase.co/functions/v1/google-calendar';

  SELECT decrypted_secret INTO v_service_role_key
  FROM vault.decrypted_secrets
  WHERE name = 'service_role_key'
  LIMIT 1;

  -- 5. Call Edge Function in background
  PERFORM extensions.http_post(
    url := v_edge_function_url,
    body := jsonb_build_object(
      'action', v_action,
      'userId', COALESCE(NEW.user_id, OLD.user_id),
      'eventId', COALESCE(NEW.session_event_id_google, OLD.session_event_id_google),
      'event', v_event_data
    )::text,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || COALESCE(v_service_role_key, '')
    )
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ETAPA 3: Recriar o trigger como BEFORE (era AFTER)
-- BEFORE permite modificar NEW._syncing_from_google para resetar a flag
DROP TRIGGER IF EXISTS tr_sync_calendar_to_google ON public.calendar;
CREATE TRIGGER tr_sync_calendar_to_google
  BEFORE INSERT OR UPDATE OR DELETE ON public.calendar
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_calendar_event_to_google();

COMMENT ON FUNCTION public.sync_calendar_event_to_google() IS 'Sincroniza automaticamente alterações locais da tabela calendar para o Google Calendar via Edge Function. Previne sync loop com flag _syncing_from_google.';
