// ============================================
// DASHBOARD COMPONENT - Cole no final do app.js
// Antes do ReactDOM.createRoot(...)
// ============================================
// Usa: supabaseDB2 (ja declarado no app.js)
// Usa: Chart.js (adicionar no index.html)
// Padrao: React.createElement (e) sem JSX
// ============================================

function Dashboard({ onBack }) {
    const [resumo, setResumo] = useState(null);
    const [acoes, setAcoes] = useState([]);
    const [diario, setDiario] = useState([]);
    const [heatmap, setHeatmap] = useState([]);
    const [topUsers, setTopUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [periodo, setPeriodo] = useState('30');
    const chartRef = useRef(null);
    const pieRef = useRef(null);
    const chartInstance = useRef(null);
    const pieInstance = useRef(null);

    const getDateRange = () => {
        const end = new Date();
        const start = new Date();
        start.setDate(start.getDate() - parseInt(periodo));
        return { start: start.toISOString(), end: end.toISOString() };
    };

    useEffect(() => {
        fetchDashboardData();
    }, [periodo]);

    async function fetchDashboardData() {
        setLoading(true);
        const { start, end } = getDateRange();

        try {
            const [resumoRes, acoesRes, diarioRes, heatmapRes, usersRes] = await Promise.all([
                supabaseDB2.rpc('fn_dashboard_resumo', {
                    p_start_date: start, p_end_date: end
                }),
                supabaseDB2.rpc('fn_dashboard_acoes_periodo', {
                    p_start_date: start, p_end_date: end
                }),
                supabaseDB2.rpc('fn_dashboard_diario_periodo', {
                    p_start_date: start, p_end_date: end
                }),
                supabaseDB2.from('v_dashboard_atividade_hora').select('*'),
                supabaseDB2.from('v_dashboard_top_users').select('*').limit(10)
            ]);

            if (resumoRes.data && resumoRes.data[0]) setResumo(resumoRes.data[0]);
            if (acoesRes.data) setAcoes(acoesRes.data);
            if (diarioRes.data) setDiario(diarioRes.data);
            if (heatmapRes.data) setHeatmap(heatmapRes.data);
            if (usersRes.data) setTopUsers(usersRes.data);
        } catch (err) {
            console.error('Dashboard fetch error:', err);
        } finally {
            setLoading(false);
        }
    }

    // Agrupar acoes por categoria
    const categoriaMap = {};
    acoes.forEach(a => {
        if (!categoriaMap[a.categoria]) categoriaMap[a.categoria] = [];
        categoriaMap[a.categoria].push(a);
    });

    // Totais por categoria (para pie chart)
    const categoriaTotais = Object.entries(categoriaMap).map(([cat, items]) => ({
        categoria: cat,
        total: items.reduce((sum, i) => sum + parseInt(i.total), 0)
    })).sort((a, b) => b.total - a.total);

    // Cores por categoria
    const CORES = [
        'hsl(134, 88%, 46%)',
        'hsl(210, 80%, 55%)',
        'hsl(45, 100%, 50%)',
        'hsl(0, 84%, 60%)',
        'hsl(280, 70%, 55%)',
        'hsl(180, 60%, 45%)',
        'hsl(30, 90%, 55%)',
        'hsl(330, 70%, 55%)'
    ];

    const coresCategorias = {};
    categoriaTotais.forEach((c, i) => {
        coresCategorias[c.categoria] = CORES[i % CORES.length];
    });

    // Line chart
    useEffect(() => {
        if (!chartRef.current || diario.length === 0 || typeof Chart === 'undefined') return;

        if (chartInstance.current) chartInstance.current.destroy();

        const ctx = chartRef.current.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 250);
        gradient.addColorStop(0, 'hsla(134, 88%, 46%, 0.2)');
        gradient.addColorStop(1, 'hsla(134, 88%, 46%, 0)');

        chartInstance.current = new Chart(ctx, {
            type: 'line',
            data: {
                labels: diario.map(d => {
                    const date = new Date(d.dia);
                    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
                }),
                datasets: [{
                    label: 'Acoes',
                    data: diario.map(d => d.total),
                    borderColor: 'hsl(134, 88%, 46%)',
                    borderWidth: 3,
                    backgroundColor: gradient,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 6,
                    pointHoverBackgroundColor: 'hsl(134, 88%, 46%)',
                    pointHoverBorderColor: '#fff',
                    pointHoverBorderWidth: 3
                }, {
                    label: 'Usuarios unicos',
                    data: diario.map(d => d.usuarios_unicos),
                    borderColor: 'hsl(210, 80%, 55%)',
                    borderWidth: 2,
                    borderDash: [5, 5],
                    fill: false,
                    tension: 0.4,
                    pointRadius: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: {
                        grid: { display: false },
                        border: { display: false },
                        ticks: {
                            color: '#adb5bd',
                            font: { size: 11, weight: '700' },
                            maxRotation: 0,
                            maxTicksLimit: 10
                        }
                    },
                    y: {
                        grid: { color: 'hsla(var(--foreground) / 0.05)' },
                        border: { display: false },
                        ticks: {
                            color: '#adb5bd',
                            font: { size: 11, weight: '700' }
                        }
                    }
                },
                interaction: { intersect: false, mode: 'index' }
            }
        });

        return () => { if (chartInstance.current) chartInstance.current.destroy(); };
    }, [diario]);

    // Pie chart
    useEffect(() => {
        if (!pieRef.current || categoriaTotais.length === 0 || typeof Chart === 'undefined') return;

        if (pieInstance.current) pieInstance.current.destroy();

        pieInstance.current = new Chart(pieRef.current, {
            type: 'doughnut',
            data: {
                labels: categoriaTotais.map(c => c.categoria),
                datasets: [{
                    data: categoriaTotais.map(c => c.total),
                    backgroundColor: categoriaTotais.map(c => coresCategorias[c.categoria]),
                    borderWidth: 0,
                    spacing: 4,
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '65%',
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            padding: 16,
                            usePointStyle: true,
                            pointStyle: 'circle',
                            font: { size: 12, weight: '600' }
                        }
                    }
                }
            }
        });

        return () => { if (pieInstance.current) pieInstance.current.destroy(); };
    }, [categoriaTotais]);

    if (loading) {
        return e('div', {
            className: 'main-content',
            style: { display: 'flex', justifyContent: 'center', alignItems: 'center', height: '80vh' }
        }, e('div', { style: { textAlign: 'center', opacity: 0.5 } }, 'Carregando dashboard...'));
    }

    return e('div', {
        className: 'main-content',
        style: { padding: '20px', maxWidth: '1200px', margin: '0 auto', overflowY: 'auto', height: 'calc(100vh - 80px)' }
    },

        // HEADER
        e('div', {
            style: {
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                marginBottom: '24px', flexWrap: 'wrap', gap: '12px'
            }
        },
            e('div', null,
                e('h1', {
                    style: {
                        fontSize: '1.8rem', fontWeight: 900,
                        fontFamily: 'Outfit, sans-serif', letterSpacing: '-0.02em'
                    }
                }, 'Dashboard'),
                e('span', {
                    style: {
                        fontSize: '0.8rem', color: 'hsl(var(--muted-foreground))', fontWeight: 600
                    }
                }, 'Ultimos ' + periodo + ' dias')
            ),
            e('div', { style: { display: 'flex', gap: '8px' } },
                ['7', '30', '90'].map(d =>
                    e('button', {
                        key: d,
                        onClick: () => setPeriodo(d),
                        style: {
                            padding: '8px 16px',
                            borderRadius: '12px',
                            border: 'none',
                            fontWeight: 700,
                            fontSize: '0.8rem',
                            cursor: 'pointer',
                            background: periodo === d ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
                            color: periodo === d ? '#fff' : 'hsl(var(--muted-foreground))'
                        }
                    }, d + 'd')
                )
            )
        ),

        // KPI CARDS
        resumo && e('div', {
            style: {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: '16px',
                marginBottom: '24px'
            }
        },
            kpiCard('Total Acoes', resumo.total_acoes, 'hsl(134, 88%, 46%)'),
            kpiCard('Usuarios Ativos', resumo.usuarios_ativos, 'hsl(210, 80%, 55%)'),
            kpiCard('Categorias', resumo.categorias_ativas, 'hsl(280, 70%, 55%)'),
            kpiCard('Media/Dia', resumo.media_diaria, 'hsl(45, 100%, 50%)')
        ),

        // CHARTS ROW
        e('div', {
            style: {
                display: 'grid',
                gridTemplateColumns: window.innerWidth > 768 ? '2fr 1fr' : '1fr',
                gap: '16px',
                marginBottom: '24px'
            }
        },
            // Line chart
            e('div', { className: 'glass-effect', style: { borderRadius: '20px', padding: '24px' } },
                e('h3', {
                    style: {
                        fontSize: '0.9rem', fontWeight: 800,
                        marginBottom: '16px', fontFamily: 'Outfit'
                    }
                }, 'Atividade Diaria'),
                e('div', { style: { position: 'relative', height: '250px' } },
                    e('canvas', { ref: chartRef })
                ),
                e('div', {
                    style: {
                        display: 'flex', gap: '16px', marginTop: '12px', justifyContent: 'center'
                    }
                },
                    legendItem('Acoes', 'hsl(134, 88%, 46%)'),
                    legendItem('Usuarios', 'hsl(210, 80%, 55%)')
                )
            ),
            // Pie chart
            e('div', { className: 'glass-effect', style: { borderRadius: '20px', padding: '24px' } },
                e('h3', {
                    style: {
                        fontSize: '0.9rem', fontWeight: 800,
                        marginBottom: '16px', fontFamily: 'Outfit'
                    }
                }, 'Categorias'),
                e('div', { style: { position: 'relative', height: '280px' } },
                    e('canvas', { ref: pieRef })
                )
            )
        ),

        // CATEGORIA + ACAO DETAIL
        e('div', {
            className: 'glass-effect',
            style: { borderRadius: '20px', padding: '24px', marginBottom: '24px' }
        },
            e('h3', {
                style: {
                    fontSize: '0.9rem', fontWeight: 800,
                    marginBottom: '20px', fontFamily: 'Outfit'
                }
            }, 'Categoria \u2192 Acao (detalhe)'),
            Object.entries(categoriaMap).map(([categoria, items]) =>
                e('div', { key: categoria, style: { marginBottom: '20px' } },
                    // Categoria header
                    e('div', {
                        style: {
                            display: 'flex', alignItems: 'center', gap: '10px',
                            marginBottom: '10px', paddingBottom: '8px',
                            borderBottom: '2px solid ' + (coresCategorias[categoria] || '#ccc')
                        }
                    },
                        e('div', {
                            style: {
                                width: '10px', height: '10px', borderRadius: '50%',
                                background: coresCategorias[categoria] || '#ccc'
                            }
                        }),
                        e('span', {
                            style: {
                                fontWeight: 800, fontSize: '0.85rem',
                                textTransform: 'uppercase', letterSpacing: '0.05em'
                            }
                        }, categoria),
                        e('span', {
                            style: {
                                marginLeft: 'auto', fontSize: '0.75rem', fontWeight: 700,
                                background: 'hsl(var(--muted))',
                                padding: '4px 10px', borderRadius: '8px'
                            }
                        }, items.reduce((s, i) => s + parseInt(i.total), 0) + ' total')
                    ),
                    // Subcategorias (acoes)
                    items.map(item =>
                        e('div', {
                            key: item.acao,
                            style: {
                                display: 'flex', alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '8px 12px', marginBottom: '4px',
                                borderRadius: '10px',
                                background: 'hsl(var(--muted) / 0.5)'
                            }
                        },
                            e('span', {
                                style: { fontSize: '0.82rem', fontWeight: 600 }
                            }, item.acao),
                            e('div', {
                                style: { display: 'flex', gap: '12px', alignItems: 'center' }
                            },
                                e('span', {
                                    style: {
                                        fontSize: '0.75rem',
                                        color: 'hsl(var(--muted-foreground))'
                                    }
                                }, item.usuarios_unicos + ' user' + (parseInt(item.usuarios_unicos) !== 1 ? 's' : '')),
                                e('span', {
                                    style: {
                                        fontWeight: 800, fontSize: '0.82rem',
                                        background: coresCategorias[categoria] || '#ccc',
                                        color: '#fff',
                                        padding: '2px 10px', borderRadius: '8px',
                                        minWidth: '36px', textAlign: 'center'
                                    }
                                }, item.total)
                            )
                        )
                    )
                )
            )
        ),

        // TOP USERS
        topUsers.length > 0 && e('div', {
            className: 'glass-effect',
            style: { borderRadius: '20px', padding: '24px', marginBottom: '24px' }
        },
            e('h3', {
                style: {
                    fontSize: '0.9rem', fontWeight: 800,
                    marginBottom: '16px', fontFamily: 'Outfit'
                }
            }, 'Usuarios Mais Ativos'),
            topUsers.map((u, i) =>
                e('div', {
                    key: u.user_id,
                    style: {
                        display: 'flex', alignItems: 'center', gap: '12px',
                        padding: '10px 12px', marginBottom: '4px', borderRadius: '10px',
                        background: i < 3 ? 'hsl(var(--muted) / 0.7)' : 'transparent'
                    }
                },
                    e('span', {
                        style: {
                            fontWeight: 900, fontSize: '0.85rem', width: '24px',
                            color: i < 3 ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))'
                        }
                    }, '#' + (i + 1)),
                    e('span', {
                        style: { fontSize: '0.82rem', fontWeight: 600, flex: 1 }
                    }, u.phone || u.user_id.substring(0, 12) + '...'),
                    e('span', {
                        style: {
                            fontSize: '0.75rem',
                            color: 'hsl(var(--muted-foreground))'
                        }
                    }, u.categorias_usadas + ' cat.'),
                    e('span', {
                        style: { fontWeight: 800, fontSize: '0.82rem' }
                    }, u.total_acoes)
                )
            )
        )
    );
}

// Helper: KPI Card
function kpiCard(label, value, color) {
    return e('div', {
        className: 'glass-effect',
        style: { borderRadius: '20px', padding: '20px' }
    },
        e('div', {
            style: {
                width: '8px', height: '8px', borderRadius: '50%',
                background: color, marginBottom: '12px'
            }
        }),
        e('div', {
            style: {
                fontSize: '0.7rem', fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '0.05em',
                color: 'hsl(var(--muted-foreground))', marginBottom: '4px'
            }
        }, label),
        e('div', {
            style: {
                fontSize: '1.6rem', fontWeight: 900,
                fontFamily: 'Outfit', letterSpacing: '-0.02em'
            }
        }, value)
    );
}

// Helper: Legend item
function legendItem(label, color) {
    return e('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        e('div', {
            style: {
                width: '8px', height: '8px', borderRadius: '50%', background: color
            }
        }),
        e('span', {
            style: {
                fontSize: '0.72rem', fontWeight: 700,
                color: 'hsl(var(--muted-foreground))',
                textTransform: 'uppercase'
            }
        }, label)
    );
}
