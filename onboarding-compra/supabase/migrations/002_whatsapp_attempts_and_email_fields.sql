-- ============================================================
-- Story 1.3 + 1.4: Tabela de tentativas WPP + campos email no payments
-- ============================================================

-- Tabela de tentativas de envio WhatsApp (Story 1.3)
CREATE TABLE IF NOT EXISTS whatsapp_attempts (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID REFERENCES profiles(id),
  phone       TEXT NOT NULL,
  attempt_num INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL,  -- success | failed
  error       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Campos extras no payments pra controle de email (Story 1.4)
-- (se já existirem, o ALTER TABLE ignora)
DO $$ BEGIN
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS email_enviado BOOLEAN DEFAULT false;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS email_tipo TEXT;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS email_enviado_at TIMESTAMPTZ;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Índices
CREATE INDEX IF NOT EXISTS idx_whatsapp_attempts_user ON whatsapp_attempts(user_id);

-- RLS
ALTER TABLE whatsapp_attempts ENABLE ROW LEVEL SECURITY;
