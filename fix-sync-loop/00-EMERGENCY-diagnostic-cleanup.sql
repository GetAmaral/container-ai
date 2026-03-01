-- =============================================
-- EMERGÊNCIA: DIAGNÓSTICO E LIMPEZA DE TODOS OS USUÁRIOS
-- =============================================
-- Problema: singleEvents: true expandiu eventos recorrentes
-- (que já tinham is_recurring=true e rrule) em centenas de
-- instâncias individuais sem rrule.
--
-- IMPORTANTE: Rodar cada passo SEPARADAMENTE no SQL Editor.
-- Rodar ANTES de fazer deploy das Edge Functions corrigidas.
-- =============================================


-- =============================================
-- PASSO 1: DIAGNÓSTICO (APENAS SELECT - seguro)
-- Rode cada query separadamente para entender o problema
-- =============================================

-- 1A: Encontrar instâncias expandidas de eventos recorrentes
-- Eventos recorrentes TÊM is_recurring=true e rrule.
-- As cópias expandidas TÊM o mesmo nome + user_id mas SEM rrule,
-- e o Google ID segue o padrão baseId_YYYYMMDDTHHMMSSZ
SELECT
  master.user_id,
  master.event_name as evento_recorrente,
  master.rrule,
  COUNT(expanded.id) as copias_expandidas
FROM calendar AS master
JOIN calendar AS expanded
  ON expanded.user_id = master.user_id
  AND expanded.session_event_id_google LIKE master.session_event_id_google || '_%'
  AND expanded.id != master.id
WHERE master.is_recurring = true
  AND master.session_event_id_google IS NOT NULL
GROUP BY master.user_id, master.event_name, master.rrule
ORDER BY copias_expandidas DESC;

-- 1B: Usuários com eventos em datas absurdas (após 2027)
SELECT
  user_id,
  COUNT(*) as eventos_junk,
  MIN(start_event::date) as data_mais_antiga,
  MAX(start_event::date) as data_mais_distante
FROM calendar
WHERE start_event > '2027-01-01'::timestamptz
GROUP BY user_id
ORDER BY eventos_junk DESC;

-- 1C: Eventos duplicados (mesmo Google ID para o mesmo user)
SELECT
  user_id,
  session_event_id_google,
  COUNT(*) as duplicatas
FROM calendar
WHERE session_event_id_google IS NOT NULL
GROUP BY user_id, session_event_id_google
HAVING COUNT(*) > 1
ORDER BY duplicatas DESC
LIMIT 50;

-- 1D: Total de eventos por usuário (baseline)
SELECT
  user_id,
  COUNT(*) as total_eventos,
  COUNT(CASE WHEN is_recurring = true THEN 1 END) as recorrentes,
  COUNT(CASE WHEN session_event_id_google IS NOT NULL THEN 1 END) as eventos_google,
  COUNT(CASE WHEN session_event_id_google IS NULL THEN 1 END) as eventos_locais,
  COUNT(CASE WHEN start_event > '2027-01-01'::timestamptz THEN 1 END) as eventos_pos_2027
FROM calendar
GROUP BY user_id
ORDER BY total_eventos DESC;

-- 1E: Resumo geral do problema
SELECT 'Instâncias expandidas de recorrentes' as tipo, COUNT(*) as quantidade
FROM calendar AS expanded
JOIN calendar AS master
  ON expanded.user_id = master.user_id
  AND master.is_recurring = true
  AND master.session_event_id_google IS NOT NULL
  AND expanded.session_event_id_google LIKE master.session_event_id_google || '_%'
  AND expanded.id != master.id
UNION ALL
SELECT 'Eventos após 2027' as tipo, COUNT(*) as quantidade
FROM calendar WHERE start_event > '2027-01-01'::timestamptz
UNION ALL
SELECT 'Eventos duplicados (Google ID)' as tipo, SUM(cnt - 1) as quantidade
FROM (
  SELECT COUNT(*) as cnt
  FROM calendar
  WHERE session_event_id_google IS NOT NULL
  GROUP BY user_id, session_event_id_google
  HAVING COUNT(*) > 1
) sub;


-- =============================================
-- PASSO 2: LIMPEZA (DELETE - rodar com cuidado!)
-- Rode APÓS confirmar o diagnóstico do Passo 1
-- A ORDEM É IMPORTANTE: rode 2A, depois 2B, depois 2C
-- =============================================

-- 2A: Deletar instâncias expandidas de eventos recorrentes
-- Mantém o evento recorrente original (is_recurring=true, com rrule)
-- Deleta as cópias individuais que foram criadas por singleEvents: true
-- Identifica pelo padrão: Google ID da cópia = Google ID do master + '_...'
DELETE FROM calendar
WHERE id IN (
  SELECT expanded.id
  FROM calendar AS expanded
  JOIN calendar AS master
    ON expanded.user_id = master.user_id
    AND master.is_recurring = true
    AND master.session_event_id_google IS NOT NULL
    AND expanded.session_event_id_google LIKE master.session_event_id_google || '_%'
    AND expanded.id != master.id
);

-- 2B: Deletar TODOS os eventos com datas absurdas (após 2027)
-- Estes são 100% junk - nenhum usuário real tem eventos em 2027+
-- (Se 2A já pegou alguns, esta query pega o restante)
DELETE FROM calendar
WHERE start_event > '2027-01-01'::timestamptz;

-- 2C: Deletar duplicatas restantes (manter o mais antigo por user + google_id)
-- Quando o sync rodou múltiplas vezes, criou duplicatas do mesmo evento.
DELETE FROM calendar a
USING calendar b
WHERE a.user_id = b.user_id
  AND a.session_event_id_google = b.session_event_id_google
  AND a.session_event_id_google IS NOT NULL
  AND a.id > b.id;


-- =============================================
-- PASSO 3: PREVENÇÃO (CREATE INDEX - seguro)
-- Impede que duplicatas sejam criadas no futuro
-- =============================================

-- Constraint UNIQUE parcial: um evento do Google só pode existir uma vez por usuário
-- (session_event_id_google NULL é ignorado - eventos locais podem ter NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_user_google_event_unique
ON calendar (user_id, session_event_id_google)
WHERE session_event_id_google IS NOT NULL;


-- =============================================
-- PASSO 4: VERIFICAÇÃO (APENAS SELECT - seguro)
-- Rode APÓS a limpeza para confirmar que deu certo
-- =============================================

-- 4A: Confirmar que não há mais instâncias expandidas
SELECT COUNT(*) as instancias_expandidas
FROM calendar AS expanded
JOIN calendar AS master
  ON expanded.user_id = master.user_id
  AND master.is_recurring = true
  AND master.session_event_id_google IS NOT NULL
  AND expanded.session_event_id_google LIKE master.session_event_id_google || '_%'
  AND expanded.id != master.id;

-- 4B: Confirmar que não há mais eventos junk
SELECT COUNT(*) as eventos_pos_2027 FROM calendar WHERE start_event > '2027-01-01'::timestamptz;

-- 4C: Confirmar que não há mais duplicatas
SELECT COUNT(*) as total_duplicatas FROM (
  SELECT user_id, session_event_id_google
  FROM calendar
  WHERE session_event_id_google IS NOT NULL
  GROUP BY user_id, session_event_id_google
  HAVING COUNT(*) > 1
) sub;

-- 4D: Contagem final limpa por usuário
SELECT
  user_id,
  COUNT(*) as total_eventos,
  COUNT(CASE WHEN is_recurring = true THEN 1 END) as recorrentes,
  MIN(start_event::date) as evento_mais_antigo,
  MAX(start_event::date) as evento_mais_recente
FROM calendar
GROUP BY user_id
ORDER BY total_eventos DESC;
