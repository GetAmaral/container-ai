# Dashboard - Guia de Implementacao

Passo a passo para adicionar a view Dashboard no site analise-total.
Nenhuma tabela e criada ou alterada. Tudo le do `log_total` existente.

---

## Passo 1: SQL no Supabase DB2

Abrir o **SQL Editor** no Supabase (projeto ldbdtakddxznfridsarn).
Colar e executar o conteudo de `sql-views-functions.sql`.

Isso cria:
- 6 views de leitura (`v_dashboard_*`)
- 3 functions com filtro de periodo (`fn_dashboard_*`)

**Verificar:** Ir em Table Editor > Views e confirmar que as 6 views aparecem.

---

## Passo 2: Chart.js no index.html

No `index.html`, **antes** da linha `<script type="module" src="app.js"></script>`, adicionar:

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
```

---

## Passo 3: Botao Dashboard no Navbar

No `app.js`, encontrar o componente `Navbar` (funcao `function Navbar`).

Localizar onde estao os botoes de navegacao (Inicio, Chat, Logs, Usuarios).
Adicionar **apos** o botao Usuarios:

```javascript
e('button', {
    className: `nav-btn ${view === 'dashboard' ? 'active' : ''}`,
    onClick: () => setView('dashboard')
}, 'Dashboard'),
```

---

## Passo 4: Case no renderView

No `app.js`, encontrar a funcao `renderView` dentro do componente `App`.

No `switch(view)`, adicionar **antes do `default:`**:

```javascript
case 'dashboard': return e(Dashboard, { onBack: () => setView('menu') });
```

---

## Passo 5: Botao no Menu

No `app.js`, encontrar o componente `Menu`.

Adicionar um card/botao seguindo o padrao dos existentes (Chat, Logs, Usuarios):

```javascript
e('div', {
    className: 'menu-card glass-effect',
    onClick: () => setView('dashboard'),
    style: { cursor: 'pointer' }
},
    e(Zap, { size: 24 }),
    e('span', null, 'Dashboard')
)
```

Obs: Adaptar ao padrao exato dos cards existentes no Menu.

---

## Passo 6: Componente Dashboard

Colar o conteudo completo de `dashboard-component.js` no `app.js`.

Posicionar **antes** do `ReactDOM.createRoot(...)` (final do arquivo).

O componente inclui:
- `Dashboard` - componente principal
- `kpiCard` - helper para cards de KPI
- `legendItem` - helper para legendas dos graficos

---

## Passo 7: CSS

Colar o conteudo de `dashboard-extra.css` no **final** do `style.css`.

---

## Estrutura da Dashboard

```
+------------------------------------------+
|  Dashboard              [7d] [30d] [90d] |
|  Ultimos 30 dias                         |
+------------------------------------------+
| Total Acoes | Usuarios | Categ. | Media  |
|     142     |    12    |   4    |  4.7   |
+------------------------------------------+
| Atividade Diaria (line)  | Categorias    |
| [chart: acoes + users]   | [doughnut]    |
+------------------------------------------+
| Categoria -> Acao (detalhe)              |
|                                          |
| * CALENDARIO                      32 tot |
|   criar_compromisso    4 users       18  |
|   editar_compromisso   2 users        8  |
|   excluir_compromisso  3 users        6  |
|                                          |
| * PAGAMENTO                       24 tot |
|   relatorio_enviado    6 users       24  |
|                                          |
| * GERAL                           86 tot |
|   mensagem_recebida    12 users      86  |
+------------------------------------------+
| Usuarios Mais Ativos                     |
| #1  5511999...    3 cat.           42    |
| #2  5511888...    2 cat.           28    |
| #3  5511777...    4 cat.           18    |
+------------------------------------------+
```

---

## O que cada view/function faz

| Nome | Tipo | Funcao |
|------|------|--------|
| `v_dashboard_categorias` | View | KPI cards - total por categoria |
| `v_dashboard_acoes` | View | Detalhe categoria + subcategoria |
| `v_dashboard_atividade_diaria` | View | Line chart - ultimos 90 dias |
| `v_dashboard_atividade_hora` | View | Heatmap - hora x dia da semana |
| `v_dashboard_top_users` | View | Ranking de usuarios ativos |
| `v_dashboard_tendencia_categoria` | View | Tendencia por categoria no tempo |
| `fn_dashboard_resumo` | Function | KPI cards com filtro de periodo |
| `fn_dashboard_acoes_periodo` | Function | Detalhe com filtro de periodo |
| `fn_dashboard_diario_periodo` | Function | Line chart com filtro de periodo |
