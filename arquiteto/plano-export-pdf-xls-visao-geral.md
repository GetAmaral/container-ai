# Plano: Exportar Transacoes para PDF e XLS na Visao Geral

**Agente:** @architect (Aria)
**Projeto:** totalAssistente (totalassistente.com.br)
**Repo:** https://github.com/GetAmaral/totalAssistente
**Data:** 2026-02-23
**Status:** Aprovado para implementacao

---

## Objetivo

Permitir que o usuario, na area "Visao Geral" do dashboard, ao clicar em "Ver todas transacoes", consiga aplicar filtros e exportar os resultados para **PDF** ou **XLS** (escolha do usuario).

---

## Diagnostico do Estado Atual

### O que ja existe:
- `AllTransactionsModal.tsx` — modal com lista completa de transacoes + filtros (tipo, categoria, data, busca)
- `exportUtils.ts` — funcoes prontas de export para Excel (`exportTransactionsToExcel`, `exportCategoryAnalysisToExcel`)
- Lib `xlsx` (v0.18.5) ja instalada no projeto
- Componentes Shadcn/ui (DropdownMenu, Button, etc.) ja disponiveis
- Toast notifications via `sonner` ja configurado
- Filtros ja calculam `filteredTransactions` no componente

### O que falta:
- Botao de exportar dentro do `AllTransactionsModal`
- Funcao de export para PDF (nenhuma lib de PDF no projeto)
- Dropdown para o usuario escolher formato (PDF ou XLS)

---

## Passo a Passo de Implementacao

### PASSO 1 — Instalar dependencia de PDF

**O que fazer:**
Abrir o terminal na pasta `site/` do projeto e rodar:

```bash
cd site
npm install jspdf jspdf-autotable
```

**Por que essas libs:**
- `jspdf` — gera PDFs no navegador (client-side, sem servidor)
- `jspdf-autotable` — plugin que cria tabelas formatadas automaticamente dentro do PDF
- Sao leves, bem mantidas e as mais usadas no ecossistema React

**Arquivo afetado:**
- `site/package.json` (as libs serao adicionadas automaticamente)

**Verificacao:**
Apos instalar, conferir no `package.json` se apareceu:
```json
"jspdf": "^2.x.x",
"jspdf-autotable": "^3.x.x"
```

---

### PASSO 2 — Criar funcao de export PDF no exportUtils.ts

**Arquivo:** `site/src/utils/exportUtils.ts`

**O que fazer:**
Adicionar uma nova funcao `exportTransactionsToPDF` nesse arquivo, abaixo das funcoes de Excel que ja existem.

**A funcao deve:**

1. Receber como parametro um array de transacoes filtradas (mesmo tipo usado no `exportTransactionsToExcel`)
2. Criar um novo documento PDF usando jsPDF (orientacao paisagem para caber a tabela)
3. Adicionar no topo:
   - Titulo: "Total Assistente — Relatorio de Transacoes"
   - Data e hora do export: "Gerado em: DD/MM/YYYY as HH:MM"
4. Criar uma tabela com as colunas:
   - Data | Descricao | Categoria | Tipo | Valor (R$)
5. Formatar os valores:
   - Data no formato DD/MM/YYYY
   - Tipo como "Receita" ou "Despesa"
   - Valor com 2 casas decimais e separador brasileiro (R$ 1.234,56)
   - Receitas em verde, despesas em vermelho (cor da fonte na coluna valor)
6. Adicionar no rodape da tabela um resumo:
   - Total de Transacoes: X
   - Total Receitas: R$ X.XXX,XX
   - Total Despesas: R$ X.XXX,XX
   - Saldo Liquido: R$ X.XXX,XX
7. Salvar o PDF com nome: `transacoes_YYYY-MM-DD_HH-MM.pdf`

**Referencia de codigo existente:**
Olhar a funcao `exportTransactionsToExcel` no mesmo arquivo para manter o mesmo padrao de tipos e formatacao.

**Import necessario no topo do arquivo:**
```typescript
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
```

---

### PASSO 3 — Adicionar botao Exportar no AllTransactionsModal.tsx

**Arquivo:** `site/src/components/dashboard/AllTransactionsModal.tsx`

**O que fazer:**

1. **Importar** as funcoes de export:
   ```typescript
   import { exportTransactionsToExcel, exportTransactionsToPDF } from '@/utils/exportUtils'
   ```

2. **Importar** componentes de UI necessarios (se ainda nao estiverem importados):
   - `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem` do Shadcn
   - Icone `Download` do `lucide-react`
   - `toast` do `sonner`

3. **Adicionar o botao** no header do modal, ao lado do titulo ou dos filtros.
   O botao deve:
   - Mostrar o texto "Exportar" com icone de download
   - Ao clicar, abrir um dropdown com 2 opcoes:
     - "Exportar PDF" (com icone de arquivo PDF)
     - "Exportar Excel" (com icone de planilha)

4. **Conectar cada opcao** do dropdown:
   - "Exportar PDF" chama: `exportTransactionsToPDF(filteredTransactions)`
   - "Exportar Excel" chama: `exportTransactionsToExcel(filteredTransactions)`

5. **Tratar lista vazia:**
   Se `filteredTransactions.length === 0`, ao clicar em exportar:
   - Nao gerar arquivo
   - Mostrar toast de aviso: "Nenhuma transacao para exportar. Ajuste os filtros."

6. **Feedback de sucesso:**
   Apos exportar com sucesso, mostrar toast: "Relatorio exportado com sucesso!"

**Onde posicionar o botao no layout:**
- No header do modal, a direita do titulo "Todas as Transacoes"
- Ou ao lado do indicador de contagem de transacoes filtradas
- O botao deve ficar visivel tanto em desktop quanto mobile

---

### PASSO 4 — Testar

**Cenarios de teste obrigatorios:**

| # | Cenario | Resultado Esperado |
|---|---------|-------------------|
| 1 | Exportar PDF sem filtro nenhum | PDF com todas as transacoes |
| 2 | Exportar XLS sem filtro nenhum | Excel com todas as transacoes + aba resumo |
| 3 | Filtrar so receitas → Exportar PDF | PDF so com receitas |
| 4 | Filtrar so despesas → Exportar XLS | Excel so com despesas |
| 5 | Filtrar por categoria especifica → Exportar | Arquivo so com aquela categoria |
| 6 | Filtrar por intervalo de datas → Exportar | Arquivo so com transacoes no periodo |
| 7 | Combinar multiplos filtros → Exportar | Arquivo com resultado combinado |
| 8 | Lista vazia (filtro sem resultado) → Exportar | Toast de aviso, nenhum arquivo gerado |
| 9 | PDF com muitas transacoes (100+) | PDF com paginacao automatica (autotable faz isso) |
| 10 | Testar em mobile (responsividade) | Botao acessivel e dropdown funcional |

---

## Resumo de Arquivos

| Arquivo | Acao | Dificuldade |
|---------|------|-------------|
| `site/package.json` | Adicionar jspdf + jspdf-autotable | Facil (npm install) |
| `site/src/utils/exportUtils.ts` | Adicionar funcao `exportTransactionsToPDF` | Media |
| `site/src/components/dashboard/AllTransactionsModal.tsx` | Adicionar botao Exportar com dropdown | Media |

**Total de arquivos modificados:** 3
**Arquivos novos:** 0
**Mudancas no backend/Supabase:** Nenhuma
**Tudo roda client-side** (no navegador do usuario)

---

## Decisoes Arquiteturais

| Decisao | Escolha | Motivo |
|---------|---------|--------|
| Lib de PDF | jsPDF + autotable | Leve, client-side, sem servidor, boa adocao |
| Lib de Excel | xlsx (ja existente) | Ja esta no projeto e funciona |
| Onde exportar | Dentro do AllTransactionsModal | E onde o usuario ja ve e filtra as transacoes |
| Server vs Client | Client-side | Zero custo de infra, funciona offline |
| UI do botao | DropdownMenu (Shadcn) | Ja existe no projeto, consistente com o design |

---

*Plano criado por Aria (@architect) — arquitetando o futuro*
