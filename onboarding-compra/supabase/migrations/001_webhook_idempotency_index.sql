-- ============================================================
-- Story 1.1: Índice de idempotência na webhook_events_log
-- A tabela webhook_events_log JÁ EXISTE no Supabase.
-- Este migration adiciona apenas o que falta.
-- ============================================================

-- Índice único para idempotência: mesmo order_id + event_type processado = skip
-- Nota: NÃO é UNIQUE constraint porque podemos ter received + processed para o mesmo par.
-- A idempotência é checada via query (processing_status = 'processed').
CREATE INDEX IF NOT EXISTS idx_webhook_events_log_order_event
  ON webhook_events_log(order_id, event_type);

CREATE INDEX IF NOT EXISTS idx_webhook_events_log_status
  ON webhook_events_log(processing_status);
