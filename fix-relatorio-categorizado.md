# Fix: Relatório Categorizado por Categoria

## Nó afetado: `gerar-html`

## Problema
O relatório financeiro lista todos os gastos em uma tabela única sem separação por categoria.

## Solução
Agrupar saídas e entradas por categoria, com subtotais por categoria.

## Código corrigido (substituir todo o conteúdo do nó `gerar-html`)

```javascript
const webhookData = $('webhook-report').item.json;
const body = webhookData.body || webhookData;

const tipo = body.tipo || 'mensal';
const label = body.label || '';
const startPeriod = body.startDate || '';
const endPeriod = body.endDate || '';

const itemsSrc = $items('buscar-gastos');

function round2(n) {
  const x = Number(n ?? 0);
  return Number.isFinite(x) ? Number(x.toFixed(2)) : 0;
}

function dISO(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return '';
  const dia = String(d.getDate()).padStart(2, '0');
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const ano = d.getFullYear();
  return `${dia}/${mes}/${ano}`;
}

function formatDateShortISO(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const dia = String(d.getDate()).padStart(2, '0');
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const ano = d.getFullYear();
  return `${dia}/${mes}/${ano}`;
}

let labelSaidas = 'Total de saídas:';
let labelEntradas = 'Total de entradas:';
let labelSaldo = 'Saldo:';

if (tipo === 'semanal') {
  labelSaidas = 'Saídas na semana:';
  labelEntradas = 'Entradas na semana:';
  labelSaldo = 'Saldo da semana:';
}

let periodoDatas = '';
if (startPeriod && endPeriod) {
  const inicio = formatDateShortISO(startPeriod);
  const fim = formatDateShortISO(endPeriod);
  if (inicio && fim) {
    periodoDatas = `${inicio} a ${fim}`;
  }
}

const regs = itemsSrc.map(it => ({
  Data: dISO(it.json.date_spent),
  Nome: it.json.name_spent ?? '',
  Categoria: it.json.category_spent ?? 'Sem categoria',
  Transacao: String(it.json.transaction_type || '').toLowerCase(),
  Valor: round2(it.json.value_spent)
})).filter(r => !!r.Data);

const saidas = regs.filter(r => r.Transacao === 'saida');
const entradas = regs.filter(r => r.Transacao === 'entrada');

const cmp = (a, b) => {
  if (a.Data < b.Data) return -1;
  if (a.Data > b.Data) return 1;
  return (a.Nome || '').localeCompare(b.Nome || '', 'pt-BR', { sensitivity: 'base' });
};

saidas.sort(cmp);
entradas.sort(cmp);

const totalSaidas = round2(saidas.reduce((s, r) => s + (r.Valor || 0), 0));
const totalEntradas = round2(entradas.reduce((s, r) => s + (r.Valor || 0), 0));
const saldoFinal = round2(totalEntradas - totalSaidas);

// --- AGRUPAR POR CATEGORIA ---
function agruparPorCategoria(items) {
  const grupos = {};
  for (const r of items) {
    const cat = r.Categoria || 'Sem categoria';
    if (!grupos[cat]) grupos[cat] = [];
    grupos[cat].push(r);
  }
  // Ordenar categorias alfabeticamente
  const sorted = Object.keys(grupos).sort((a, b) =>
    a.localeCompare(b, 'pt-BR', { sensitivity: 'base' })
  );
  return sorted.map(cat => ({
    categoria: cat,
    items: grupos[cat],
    total: round2(grupos[cat].reduce((s, r) => s + (r.Valor || 0), 0))
  }));
}

function gerarTabelaCategoria(grupo, corFundo) {
  const linhas = grupo.items.map(r => `
    <tr style="background:${corFundo};">
      <td>${r.Data}</td>
      <td>${r.Nome}</td>
      <td style="text-align:right;">R$ ${r.Valor.toFixed(2).replace('.', ',')}</td>
    </tr>
  `).join('\n');

  return `
    <div class="categoria-bloco">
      <div class="categoria-header">
        <span class="categoria-nome">${grupo.categoria}</span>
        <span class="categoria-total">R$ ${grupo.total.toFixed(2).replace('.', ',')}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Data</th>
            <th>Nome</th>
            <th>Valor</th>
          </tr>
        </thead>
        <tbody>
          ${linhas}
        </tbody>
      </table>
    </div>
  `;
}

const gruposSaidas = agruparPorCategoria(saidas);
const gruposEntradas = agruparPorCategoria(entradas);

const htmlSaidas = gruposSaidas.length > 0
  ? `<h2 class="secao-titulo secao-saidas">Saídas</h2>` + gruposSaidas.map(g => gerarTabelaCategoria(g, '#fff5f5')).join('\n')
  : '';

const htmlEntradas = gruposEntradas.length > 0
  ? `<h2 class="secao-titulo secao-entradas">Entradas</h2>` + gruposEntradas.map(g => gerarTabelaCategoria(g, '#f3faf3')).join('\n')
  : '';

const logoUrl = 'data:image/webp;base64,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...';

const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<title>Relatório - Total Assistente</title>
<style>
  body {
    font-family: Arial, sans-serif;
    margin: 32px;
    color: #333;
  }
  .header {
    display: flex;
    align-items: center;
    margin-bottom: 32px;
  }
  .header img {
    height: 40px;
  }
  .periodo {
    text-align: left;
    font-size: 22px;
    font-weight: 700;
    color: #111;
    margin-bottom: 4px;
  }
  .periodo-datas {
    font-size: 13px;
    color: #888;
    margin-bottom: 28px;
  }
  .secao-titulo {
    font-size: 18px;
    font-weight: 700;
    margin-top: 32px;
    margin-bottom: 16px;
    padding-bottom: 8px;
    border-bottom: 2px solid #222;
  }
  .secao-saidas { color: #c00; }
  .secao-entradas { color: #0a7a00; }
  .categoria-bloco {
    margin-bottom: 24px;
  }
  .categoria-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 8px;
    background: #f7f7f7;
    border-radius: 6px 6px 0 0;
    border-bottom: 1px solid #ddd;
  }
  .categoria-nome {
    font-weight: 700;
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #444;
  }
  .categoria-total {
    font-weight: 700;
    font-size: 14px;
    color: #222;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  th {
    text-align: left;
    padding: 10px 8px;
    border-bottom: 2px solid #222;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #666;
  }
  th:last-child {
    text-align: right;
  }
  td {
    padding: 8px;
    border-bottom: 1px solid #eee;
  }
  .totais {
    margin-top: 28px;
    font-size: 14px;
  }
  .totais .linha {
    display: flex;
    justify-content: space-between;
    padding: 6px 0;
    border-bottom: 1px solid #f0f0f0;
  }
  .totais .linha:last-child {
    border-bottom: none;
    padding-top: 10px;
    font-size: 16px;
  }
  .positivo {
    color: #0a7a00;
    font-weight: 700;
  }
  .negativo {
    color: #c00;
    font-weight: 700;
  }
  .footer {
    margin-top: 40px;
    font-size: 10px;
    text-align: center;
    color: #aaa;
  }
</style>
</head>
<body>
  <div class="header">
    <img src="${logoUrl}" alt="Total Assistente" />
  </div>

  <div class="periodo">${label || 'Relatório'}</div>
  <div class="periodo-datas">${periodoDatas}</div>

  ${htmlSaidas || ''}
  ${htmlEntradas || ''}

  ${(!htmlSaidas && !htmlEntradas) ? '<p style="text-align:center;color:#aaa;padding:24px;">Nenhum lançamento no período.</p>' : ''}

  <div class="totais">
    <div class="linha">
      <span>${labelSaidas}</span>
      <span>R$ ${totalSaidas.toFixed(2).replace('.', ',')}</span>
    </div>
    <div class="linha">
      <span>${labelEntradas}</span>
      <span>R$ ${totalEntradas.toFixed(2).replace('.', ',')}</span>
    </div>
    <div class="linha">
      <span>${labelSaldo}</span>
      <span class="${saldoFinal >= 0 ? 'positivo' : 'negativo'}">
        R$ ${saldoFinal.toFixed(2).replace('.', ',')}
      </span>
    </div>
  </div>

  <div class="footer">
    Total Assistente
  </div>
</body>
</html>
`;

return [{ json: { html } }];
```

## O que mudou

1. **Nova função `agruparPorCategoria(items)`** — agrupa itens por `category_spent`, ordena categorias alfabeticamente, calcula subtotal de cada uma
2. **Nova função `gerarTabelaCategoria(grupo, corFundo)`** — renderiza um bloco com header da categoria (nome + subtotal) e tabela dos itens
3. **Seções "Saídas" e "Entradas"** — cada uma com seus blocos de categoria separados
4. **CSS novo** — `.secao-titulo`, `.categoria-bloco`, `.categoria-header`, `.categoria-nome`, `.categoria-total`
5. **Coluna "Categoria" removida da tabela** — já que os itens estão dentro do bloco da categoria, não precisa repetir

## Como aplicar

1. Abrir o workflow no N8N dev (`http://76.13.172.17:5678/workflow/`)
2. Clicar no nó `gerar-html`
3. Substituir **todo** o código JavaScript pelo conteúdo acima
4. Salvar e testar
