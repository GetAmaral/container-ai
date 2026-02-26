-- ============================================
-- DASHBOARD VIEWS & FUNCTIONS
-- Executar no Supabase DB2 (ldbdtakddxznfridsarn)
-- SQL Editor > New Query > Cole e execute
-- Nenhuma tabela criada ou alterada - apenas LEITURA do log_total
-- ============================================

-- VIEW 1: Resumo geral por categoria (KPI cards)
CREATE OR REPLACE VIEW public.v_dashboard_categorias AS
SELECT
    categoria,
    COUNT(*) as total,
    COUNT(DISTINCT user_id) as usuarios_unicos,
    MAX(created_at) as ultima_atividade
FROM public.log_total
GROUP BY categoria
ORDER BY total DESC;

-- VIEW 2: Subcategorias (acoes) mais usadas por categoria
CREATE OR REPLACE VIEW public.v_dashboard_acoes AS
SELECT
    categoria,
    acao,
    COUNT(*) as total,
    COUNT(DISTINCT user_id) as usuarios_unicos
FROM public.log_total
GROUP BY categoria, acao
ORDER BY total DESC;

-- VIEW 3: Atividade diaria (line chart)
CREATE OR REPLACE VIEW public.v_dashboard_atividade_diaria AS
SELECT
    DATE(created_at) as dia,
    COUNT(*) as total,
    COUNT(DISTINCT user_id) as usuarios_unicos,
    COUNT(DISTINCT categoria) as categorias_ativas
FROM public.log_total
GROUP BY DATE(created_at)
ORDER BY dia DESC
LIMIT 90;

-- VIEW 4: Atividade por hora (heatmap)
CREATE OR REPLACE VIEW public.v_dashboard_atividade_hora AS
SELECT
    EXTRACT(DOW FROM created_at)::int as dia_semana,
    EXTRACT(HOUR FROM created_at)::int as hora,
    COUNT(*) as total
FROM public.log_total
GROUP BY dia_semana, hora
ORDER BY dia_semana, hora;

-- VIEW 5: Top usuarios
CREATE OR REPLACE VIEW public.v_dashboard_top_users AS
SELECT
    lt.user_id,
    p.phone,
    COUNT(*) as total_acoes,
    COUNT(DISTINCT lt.categoria) as categorias_usadas,
    MAX(lt.created_at) as ultimo_uso
FROM public.log_total lt
LEFT JOIN public.profiles p ON p.id::text = lt.user_id
GROUP BY lt.user_id, p.phone
ORDER BY total_acoes DESC
LIMIT 50;

-- VIEW 6: Tendencia por categoria ao longo do tempo
CREATE OR REPLACE VIEW public.v_dashboard_tendencia_categoria AS
SELECT
    DATE(created_at) as dia,
    categoria,
    COUNT(*) as total
FROM public.log_total
GROUP BY DATE(created_at), categoria
ORDER BY dia DESC;

-- ============================================
-- FUNCTIONS (com filtro de periodo)
-- ============================================

-- FUNCTION: Resumo com filtro de periodo (para o date picker)
CREATE OR REPLACE FUNCTION public.fn_dashboard_resumo(
    p_start_date timestamptz DEFAULT NOW() - INTERVAL '30 days',
    p_end_date timestamptz DEFAULT NOW()
)
RETURNS TABLE(
    total_acoes bigint,
    usuarios_ativos bigint,
    categorias_ativas bigint,
    acoes_distintas bigint,
    media_diaria numeric
) LANGUAGE sql STABLE AS $$
    SELECT
        COUNT(*)::bigint as total_acoes,
        COUNT(DISTINCT user_id)::bigint as usuarios_ativos,
        COUNT(DISTINCT categoria)::bigint as categorias_ativas,
        COUNT(DISTINCT acao)::bigint as acoes_distintas,
        ROUND(COUNT(*)::numeric / GREATEST(EXTRACT(DAY FROM p_end_date - p_start_date), 1), 1) as media_diaria
    FROM public.log_total
    WHERE created_at >= p_start_date AND created_at <= p_end_date;
$$;

-- FUNCTION: Acoes filtradas por periodo
CREATE OR REPLACE FUNCTION public.fn_dashboard_acoes_periodo(
    p_start_date timestamptz DEFAULT NOW() - INTERVAL '30 days',
    p_end_date timestamptz DEFAULT NOW()
)
RETURNS TABLE(
    categoria text,
    acao text,
    total bigint,
    usuarios_unicos bigint
) LANGUAGE sql STABLE AS $$
    SELECT
        categoria,
        acao,
        COUNT(*)::bigint as total,
        COUNT(DISTINCT user_id)::bigint as usuarios_unicos
    FROM public.log_total
    WHERE created_at >= p_start_date AND created_at <= p_end_date
    GROUP BY categoria, acao
    ORDER BY total DESC;
$$;

-- FUNCTION: Atividade diaria filtrada
CREATE OR REPLACE FUNCTION public.fn_dashboard_diario_periodo(
    p_start_date timestamptz DEFAULT NOW() - INTERVAL '30 days',
    p_end_date timestamptz DEFAULT NOW()
)
RETURNS TABLE(
    dia date,
    total bigint,
    usuarios_unicos bigint
) LANGUAGE sql STABLE AS $$
    SELECT
        DATE(created_at) as dia,
        COUNT(*)::bigint as total,
        COUNT(DISTINCT user_id)::bigint as usuarios_unicos
    FROM public.log_total
    WHERE created_at >= p_start_date AND created_at <= p_end_date
    GROUP BY DATE(created_at)
    ORDER BY dia;
$$;
