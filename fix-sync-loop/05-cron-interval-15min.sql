-- =============================================
-- ATUALIZAR INTERVALO DO CRON PARA 15 MINUTOS
-- =============================================
-- Com o webhook funcionando corretamente, o cron é apenas um fallback
-- para pegar notificações perdidas. 15 min é mais que suficiente.
--
-- IMPORTANTE: Rodar este SQL no Supabase SQL Editor
-- =============================================

-- 1. Remover agendamento antigo (30 min)
SELECT cron.unschedule('google-calendar-sync-every-30m');

-- 2. Criar novo agendamento a cada 15 minutos
SELECT cron.schedule(
  'google-calendar-sync-every-15m',
  '*/15 * * * *',
  $$
  SELECT
    extensions.http_post(
      url := 'https://ldbdtakddxznfridsarn.supabase.co/functions/v1/google-calendar-sync-cron',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxkYmR0YWtkZHh6bmZyaWRzYXJuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTM4MTE1NzgsImV4cCI6MjA2OTM4NzU3OH0.EA3vHa296JSuneN_yAK1V95QkcwtAPoEwFbplksisGw"}'::jsonb,
      body := '{}'::jsonb
    )
  $$
);
