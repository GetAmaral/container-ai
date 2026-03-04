# Relatorio Diagnostico — Erro de Exclusao 10:43-10:44 BRT
## Total Assistente | Calendar WebHooks + Fix Conflito v2

**Investigador:** Sherlock (analisador-n8n)
**Data:** 04/Mar/2026
**Severidade:** CRITICA
**Modo:** STRICT READ-ONLY

---

## 1. RESUMO EXECUTIVO

O usuario pediu "exclua o evento das 9h30 testeeee". O evento **existe** na agenda (acabou de ser listado com sucesso). Porem o bot respondeu "Nao encontrei nenhum evento com esses criterios."

A causa raiz **NAO e o classificador** (ele acertou: `excluir_evento_agenda`). O problema esta no **sub-workflow Calendar WebHooks** — o node `Information Extractor1` **CRASHOU** antes de poder retornar o evento encontrado.

---

## 2. SCREENSHOT ANALISADO

**Arquivo:** `WhatsApp Image 2026-03-04 at 10.52.00.jpeg`

### Sequencia visivel no print:

| Hora | Quem | Mensagem |
|------|------|----------|
| 10:43 | Bot | Buscando... → Agenda de 04/03 (10 eventos listados, incluindo **9h30 - Testeeee**) |
| 10:43 | User | "exclua o evento das 9h30 testeeee" |
| 10:43 | Bot | Processando... |
| 10:44 | Bot | Buscando... |
| 10:44 | Bot | "Nao encontrei nenhum evento com esses criterios." |

---

## 3. EXECUTIONS ANALISADAS

### 3.1 Execution 129352 — Fix Conflito v2 (13:43:54 UTC)

| Campo | Valor |
|-------|-------|
| **Mensagem do usuario** | "exclua o evento das 9h30 testeeee" |
| **Branch classificado** | `excluir_evento_agenda` ✅ (CORRETO) |
| **Prompt injetado** | `prompt_excluir` ✅ (CORRETO) |
| **Tool call do AI Agent** | `buscar_eventos` com `nome_evento: "testeeee"`, `data_inicio: "2026-03-04 09:30:00-03"` |
| **Resultado do tool call** | **ERRO**: "The service was not able to process your request - Error in workflow" |
| **Resposta final** | "Nao encontrei nenhum evento com esses criterios" |

O AI Agent fez tudo certo — classificou corretamente, montou os parametros corretos. Mas a **tool `buscar_eventos` falhou** porque o webhook `busca-total-evento` retornou erro.

### 3.2 Execution 129358 — Calendar WebHooks (13:44:00 UTC)

Esta e a execution do sub-workflow que recebeu a chamada via webhook.

| Campo | Valor |
|-------|-------|
| **Webhook** | `busca-total-evento` |
| **Parametros recebidos** | `nome_evento: "testeeee"`, `data_inicio: "2026-03-04 09:30:00-03"` |
| **Nodes executados** | 14 nodes, 13 success + **1 error** |
| **Node que falhou** | `Information Extractor1` |
| **Erro exato** | `"Paired item data for item from node 'Expandir Recorrentes' is unavailable. Ensure 'Expandir Recorrentes' is providing the required output."` |
| **Tipo do node** | `@n8n/n8n-nodes-langchain.informationExtractor` v1.2 |

### 3.3 Tabela de todas as executions no periodo 10:40-10:50 BRT

| Exec ID | Hora UTC | Workflow | Msg/Acao | Branch | Status |
|---------|----------|----------|----------|--------|--------|
| 129337 | 13:43:24 | Fix Conflito v2 | "o que tenho na miha agenda hoje?" | buscar_evento_agenda | ✅ |
| 129341 | 13:43:29 | Calendar WebHooks | busca genérica (sem nome) | — | ✅ |
| **129352** | **13:43:54** | **Fix Conflito v2** | **"exclua o evento das 9h30 testeeee"** | **excluir_evento_agenda** | **✅ (mas tool falhou)** |
| **129358** | **13:44:00** | **Calendar WebHooks** | **busca por nome "testeeee"** | **—** | **❌ CRASH** |
| 129368 | 13:44:14 | Fix Conflito v2 | "exclua o evento das 13h hoje" | excluir_evento_agenda | ✅ |
| 129373 | 13:44:17 | Calendar WebHooks | busca por horario (sem nome) | — | ✅ |

---

## 4. CAUSA RAIZ

### O Fluxo do Calendar WebHooks (busca-total-evento)

```
Webhook recebe request
    |
    v
Edit Fields2 (extrai parametros: nome, descricao, start, end, user_id)
    |
    v
criterios (Aggregate) — junta nome+descricao em objeto
    |
    v
Code4 (monta queryString para Supabase, exclui recorrentes)
    |
    v
[PARALELO]
├── Get many rows9 (eventos NAO-recorrentes do Supabase)
└── Get Recorrentes (eventos recorrentes do Supabase)
    |
    v
Expandir Recorrentes (Code v2 — expande rrules em instancias individuais)
    |
    v
Merge (junta nao-recorrentes + recorrentes expandidos)
    |
    v
Aggregate8 (agrupa tudo em um array)
    |
    v
If5: nome E descricao estao vazios?
    ├── SIM → Aggregate5 → retorna todos os eventos (path simples)
    └── NAO → Information Extractor1 (LLM match por similaridade) ← ❌ CRASH
```

### O Bug Especifico

O node **`Expandir Recorrentes`** e um Code v2 que gera novos items (expandindo regras RRULE em instancias). Esses novos items sao criados como `{ json: {...} }` **SEM metadado `pairedItem`**.

Quando o N8N tenta executar `Information Extractor1` (que usa LangChain internamente), ele precisa rastrear a origem dos items via `pairedItem`. Como os items vindos de `Expandir Recorrentes` nao tem essa informacao, o N8N lanca:

```
"Paired item data for item from node 'Expandir Recorrentes' is unavailable"
```

### Por que so falha com busca por nome?

O node `If5` verifica se `nome` e `descricao` estao ambos vazios:
- **Busca generica** ("qual minha agenda hoje?") → nome=vazio, descricao=vazio → `If5` rota para path simples (Aggregate5) → **FUNCIONA**
- **Busca por nome** ("exclua testeeee") → nome="testeeee" → `If5` rota para `Information Extractor1` → **CRASH**

### Impacto

TODA busca que inclui nome_evento ou descricao_evento falha. Isso afeta:
- **Excluir por nome** → SEMPRE falha (precisa buscar antes de excluir)
- **Buscar por nome** → SEMPRE falha
- **Busca generica** → funciona (nao usa Information Extractor1)

**Estatisticas do dia (Calendar WebHooks):**
- Total executions: 103
- Sucesso: 86 (83%)
- Erro: 17 (17%)

---

## 5. COMO CORRIGIR

### Fix 1: Adicionar `pairedItem` no node `Expandir Recorrentes` (RECOMENDADO)

No final do Code v2 `Expandir Recorrentes`, cada item retornado precisa incluir `pairedItem`. Alterar de:

```javascript
return result.length > 0 ? result : [{ json: {} }];
```

Para:

```javascript
// Adicionar pairedItem a cada item
const withPairing = result.map((item, index) => ({
  json: item.json,
  pairedItem: { item: 0 }  // vincula ao primeiro item de entrada
}));
return withPairing.length > 0 ? withPairing : [{ json: {}, pairedItem: { item: 0 } }];
```

E no mesmo node, na parte final onde retorna os eventos expandidos:

```javascript
// ANTES:
expandidos.push({ json: { ...occ } });

// DEPOIS:
expandidos.push({ json: { ...occ }, pairedItem: { item: idx } });
```

Onde `idx` e o indice do item recorrente original no array de entrada.

### Fix 2: Alternativa — Desabilitar paired item checking no Information Extractor1

No node `Information Extractor1`, nas opcoes avancadas (Settings), ativar:
- **"Always Output Data"** = true
- **"On Error"** = "Continue (using error output)"

Isso evita que o workflow inteiro falhe, mas nao resolve a raiz do problema.

### Fix 3: Alternativa — Eliminar `Information Extractor1` completamente

O `Information Extractor1` usa um LLM (GPT) apenas para fazer matching de similaridade textual. Isso poderia ser substituido por um Code node com comparacao direta (Levenshtein/token overlap), que seria:
- Mais rapido (sem chamada LLM)
- Sem custo de API
- Sem risco de paired item issues
- Mais previsivel

---

## 6. CONTEXTO ADICIONAL — Outras Executions no Periodo

| Exec ID | Hora BRT | Mensagem | Branch | Resultado |
|---------|----------|----------|--------|-----------|
| 129267 | 10:40 | (busca agenda amanha) | buscar_evento_agenda | ✅ |
| 129279 | 10:40 | (busca agenda hoje) | buscar_evento_agenda | ✅ |
| 129302 | 10:41 | (mensagem generica?) | — | ✅ |
| 129317 | 10:41 | (outra interacao) | — | ✅ |
| 129337 | 10:43 | "o que tenho na miha agenda hoje?" | buscar_evento_agenda | ✅ (eventos listados) |
| **129352** | **10:43** | **"exclua o evento das 9h30 testeeee"** | **excluir_evento_agenda ✅** | **❌ tool falhou** |
| 129368 | 10:44 | "exclua o evento das 13h hoje" | excluir_evento_agenda | ✅ (excluiu "Sem Titulo") |
| 129384 | 10:44 | (busca agenda) | buscar_evento_agenda | ✅ |
| 129403 | 10:45 | (busca agenda) | buscar_evento_agenda | ✅ |
| 129419 | 10:46 | (criar evento "Reuniao") | criar_evento_agenda | ✅ |

**Nota importante:** A execution 129368 ("exclua o evento das 13h hoje") **FUNCIONOU**. Isso porque a busca foi feita por **horario** (13h) sem nome_evento, entao o `If5` roteou para o path simples que nao usa `Information Extractor1`.

Ja a execution 129352 ("exclua testeeee") passou nome_evento, ativou o `Information Extractor1`, e crashou.

---

## 7. RESUMO FINAL

| Aspecto | Status |
|---------|--------|
| **Classificador "Escolher Branch"** | ✅ Funcionou corretamente |
| **Prompt de exclusao** | ✅ Correto |
| **AI Agent tool call** | ✅ Parametros corretos |
| **Sub-workflow Calendar WebHooks** | ❌ CRASH no `Information Extractor1` |
| **Causa raiz** | `Expandir Recorrentes` nao inclui `pairedItem` nos items criados |
| **Quando falha** | TODA busca com nome_evento ou descricao_evento |
| **Quando funciona** | Busca generica (sem filtro por nome) |
| **Fix recomendado** | Adicionar `pairedItem` ao Code `Expandir Recorrentes` |

---

— Sherlock, diagnosticando com precisao 🔬
