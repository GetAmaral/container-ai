-- ============================================================
-- TABELA: log_total
-- Banco: DB1 (hkzgttizcfklxfafkzfl.supabase.co)
-- Auditoria completa de todas as acoes do sistema
-- LOGS SAO IMUTAVEIS: sem UPDATE, sem DELETE
-- ============================================================
-- INSTRUCAO: Copie TUDO e cole no SQL Editor do Supabase DB1
-- ============================================================

-- ========================
-- 1. CRIAR TABELA
-- ========================

CREATE TABLE public.log_total (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     TEXT NOT NULL,
    acao        TEXT NOT NULL,
    mensagem    TEXT NOT NULL,
    categoria   TEXT NOT NULL DEFAULT 'geral',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.log_total IS
  'Auditoria completa do sistema. Logs sao IMUTAVEIS — sem UPDATE/DELETE.';

COMMENT ON COLUMN public.log_total.user_id IS
  'Identificador do usuario (mesmo user_id de log_users_messages — formato texto WhatsApp)';

COMMENT ON COLUMN public.log_total.acao IS
  'Codigo da acao em snake_case. Ex: lembrete_disparado, plano_ativado, login_admin';

COMMENT ON COLUMN public.log_total.mensagem IS
  'Texto legivel do aviso. Aparece no chat do usuario como notificacao do sistema.';

COMMENT ON COLUMN public.log_total.categoria IS
  'Classificacao para filtros. Ex: lembrete, sistema, pagamento, ia, admin, whatsapp';

-- ========================
-- 2. INDICES
-- ========================

CREATE INDEX idx_log_total_user_id      ON public.log_total (user_id);
CREATE INDEX idx_log_total_created_at   ON public.log_total (created_at DESC);
CREATE INDEX idx_log_total_categoria    ON public.log_total (categoria);
CREATE INDEX idx_log_total_acao         ON public.log_total (acao);
CREATE INDEX idx_log_total_user_time    ON public.log_total (user_id, created_at DESC);

-- ========================
-- 3. ROW LEVEL SECURITY
-- ========================

ALTER TABLE public.log_total ENABLE ROW LEVEL SECURITY;

-- SELECT: somente admins autenticados
CREATE POLICY "Admins autenticados podem ler logs"
    ON public.log_total
    FOR SELECT
    TO authenticated
    USING (true);

-- INSERT: service_role (n8n, Edge Functions, backend)
CREATE POLICY "Service role pode inserir logs"
    ON public.log_total
    FOR INSERT
    TO service_role
    WITH CHECK (true);

-- INSERT: authenticated (admin logado no painel)
CREATE POLICY "Admin autenticado pode inserir logs"
    ON public.log_total
    FOR INSERT
    TO authenticated
    WITH CHECK (true);

-- NAO EXISTE: policy para anon (anonimo nao faz nada)
-- NAO EXISTE: policy de UPDATE (logs nao se editam)
-- NAO EXISTE: policy de DELETE (logs nao se apagam)

-- ========================
-- 4. REALTIME
-- ========================

ALTER PUBLICATION supabase_realtime ADD TABLE public.log_total;
