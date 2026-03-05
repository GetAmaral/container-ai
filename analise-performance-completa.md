# Análise Completa de Performance — Total Assistente
## Investigador: Sherlock (analisador-n8n) | 05/Mar/2026

---

## 1. RESUMO EXECUTIVO

| Métrica | Valor Atual |
|---------|-------------|
| **E2E P50 (user msg → resposta)** | **~11s** |
| **E2E P90** | **~16s** |
| **E2E P95** | **~20s** |
| **E2E pior caso** | **~29s** |
| **E2E melhor caso** | **~5.2s** |
| **Main error rate** | **89.7% (35/39)** |
| **Fix Conflito v2 P50** | **10.7s** |
| **Fix Conflito v2 avg** | **11.5s** |
| **Meta desejada** | **5s E2E** |

### Veredicto: 5 segundos é possível, mas exige mudanças significativas

Com GPT-4.1-mini o LLM sozinho leva ~3-6s. Para alcançar 5s E2E, é preciso:
1. Eliminar 1 das 2 chamadas LLM (o classificador)
2. Reduzir drasticamente o tamanho dos prompts
3. Eliminar redundâncias no workflow (165 nodes ativos, 20 Redis nodes)
4. Corrigir os 89% de erro da Main

---

## 2. ONDE O TEMPO ESTÁ SENDO GASTO

### 2.1 Breakdown End-to-End (execução típica ~10s)

```
┌─────────────────────────────────────────────────────┐
│ Main Workflow (~1.1s)                                │
│   trigger-whatsapp ──► Edit Fields ──► Send "🔄"    │
│   ──► If ──► Get a row ──► setar_user ──► HTTP call │
│   [Send "Processando": 489ms | Supabase: 230ms]     │
│   [HTTP→Fix Conflito: 366ms]                        │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│ Fix Conflito v2 (~9.4s típico)                      │
│                                                     │
│  ★ LLM 1: Escolher Branch (classificador)           │
│    OpenAI Chat Model2 + LLM Chain = ~620ms          │
│                                                     │
│  ★ LLM 2: AI Agent (execução principal)             │
│    OpenAI Chat Model + Agent = ~3300ms (bom caso)   │
│                          até ~24000ms (pior caso)   │
│                                                     │
│  Redis ops (20 nodes!): ~200ms                      │
│  Supabase (buscar_relatorios, Get a row,            │
│            Buscar Conflitos): ~775ms                 │
│  HTTP sub-workflows: ~584ms                         │
│  Code nodes (9): ~100ms                             │
│  Send message WhatsApp: ~500ms                      │
│  Set/Aggregate/NoOp (50 nodes): ~50ms               │
└─────────────────────────────────────────────────────┘
```

### 2.2 Por que o AI Agent é tão lento?

O **system message** do AI Agent tem **~30.000 caracteres** (≈8.000 tokens de input).

Composição:
- System message template: **~8.000 chars**
- Prompt específico injetado (registrar_gasto etc): **~11.000 chars**
- Histórico (confirmados): variável
- Input text: variável

GPT-4.1-mini processa ~1000 tokens/s de input, então **8K tokens = ~8s** só de processamento de input em casos complexos. Em casos simples (prompt menor), cai para ~3s.

### 2.3 Classificador LLM — É necessário?

O `Escolher Branch` usa GPT-4.1-mini para classificar a intenção (~620ms). Além dele, existe um `Text Classifier` (OpenAI Chat Model1) que aparece desconectado do fluxo principal.

**4 Chat Models ativos:**
| # | Node | Para quê |
|---|------|----------|
| 1 | OpenAI Chat Model | AI Agent (execução principal) |
| 2 | OpenAI Chat Model1 | Text Classifier (desconectado?) |
| 3 | OpenAI Chat Model2 | Escolher Branch (classificador) |
| 4 | OpenAI Chat Model6 | Information Extractor2 |

---

## 3. ERROS DA MAIN — 89.7% DE FALHA

### Causa: WhatsApp envia `statuses` webhooks que a Main não filtra

Cada vez que o bot envia uma mensagem, o WhatsApp envia webhooks de `status`:
- `sent` → quando a mensagem é enviada
- `delivered` → quando chega no telefone
- `read` → quando o usuário lê

Esses webhooks **não têm `contacts`** nem `messages`. A Main recebe, tenta extrair `contacts[0].wa_id` no node "Send message" (para enviar "🔄 Processando...") e **CRASH**:

```
Error: "The parameter 'to' is required"
HTTP 400 | OAuthException code 100
```

### Impacto:
- **35 erros em 39 execuções** nas últimas 200 runs
- Cada erro gera log, consome CPU, polui métricas
- Não impacta o usuário diretamente (é silencioso), mas desperdiça recursos

### Fix simples:
Adicionar um **If** logo após `trigger-whatsapp` que verifica:
```
{{ $json.messages !== undefined && $json.messages.length > 0 }}
```
Se falso → parar (é um status webhook). Se verdadeiro → continuar o fluxo.

---

## 4. REDUNDÂNCIAS E DESPERDÍCIOS NO FIX CONFLITO V2

### 4.1 Números assustadores

| Categoria | Quantidade | Observação |
|-----------|-----------|------------|
| **Total nodes** | **165** | Enorme para um único workflow |
| **Redis nodes** | **20** | 8x `lastGet*`, 8x `Redis*` (delete) |
| **Set nodes** | **27** | Muitos só renomeiam campos |
| **NoOp nodes** | **10** | "No Operation, do nothing" |
| **httpRequest** | **23** | Inclui sub-workflow calls duplicadas |
| **Aggregate nodes** | **11** | Muitos não agregam nada útil |
| **Code nodes** | **11** | 2 duplicados (Code, Code1 = idênticos) |
| **WhatsApp Send** | **9** | Múltiplos pontos de envio |
| **Sticky Notes** | **6** | Não executam, mas poluem |
| **Disabled** | **1** | Premium User1 (inútil) |

### 4.2 Redis Debounce — 20 nodes para algo que deveria ser 3

O padrão atual de debounce é:
```
firstGet → pushRedisMessage → mediumGet → lastGet → ... → lastGet10 → Redis (delete)
```

Existem **8 variações de `lastGet`** (lastGet, lastGet1, lastGet2, lastGet3, lastGet5, lastGet7, lastGet10) e **8 variações de `Redis` delete** (Redis, Redis2, Redis3, Redis6, Redis8, Redis10, Redis11). Isso acontece porque cada branch do fluxo (criar gasto, criar evento, excluir, etc.) tem sua própria cópia do cleanup de debounce.

**Solução:** Centralizar o cleanup em um único caminho no final do fluxo, usando 3 nodes no máximo:
- `firstGet` → ler debounce
- `pushRedisMessage` → push
- `cleanupDebounce` → delete (no final, independente do branch)

### 4.3 Code e Code1 são idênticos (1530 chars cada)

Ambos fazem OCR/Mistral page concatenation. Provavelmente um é copy-paste do outro.

### 4.4 HTTP sub-workflow duplicados

- `HTTP - Create Tool`, `HTTP - Create Tool1`, `HTTP - Create Tool2` → 3 nodes que chamam o mesmo webhook `registrar-gasto`
- `HTTP - Create Calendar Tool`, `HTTP - Create Calendar Tool2`, `HTTP - Create Calendar Tool4`, `HTTP - Create Calendar Tool6` → 4 nodes que chamam o mesmo webhook para eventos
- `HTTP - Create Calendar Tool3`, `HTTP - Create Calendar Tool5` → 2 nodes para lembrete recorrente

**Cada branch tem sua própria cópia** do HTTP call, em vez de centralizar.

### 4.5 LLM calls — 4 Chat Models ativos

Cada chamada LLM adiciona 500-3000ms. Com 2 chamadas sequenciais no caminho crítico (Escolher Branch + AI Agent), o mínimo teórico é ~4s só de LLM.

---

## 5. PLANO PARA ALCANÇAR 5 SEGUNDOS

### 5.1 Cenário Atual vs. Meta

```
ATUAL (típico 11s):
  Main (1.1s) + Classificador (0.6s) + Setup (0.8s) + AI Agent (6s) + Send (0.5s) + Cleanup (2s)

META (5s):
  Main (0.5s) + Router (0.01s) + Setup (0.3s) + AI Agent (3.5s) + Send (0.5s) + Cleanup (0.2s)
```

### 5.2 Mudanças necessárias (por impacto)

#### A) ELIMINAR O CLASSIFICADOR LLM (Escolher Branch) → Economia: ~620ms
**Impacto: ALTO | Dificuldade: MÉDIA**

Substituir por um **router baseado em código** (Code node com keyword matching):

```javascript
// Classificador por keywords — 0ms vs 620ms do LLM
const msg = mensagemPrincipal.toLowerCase();

// Gastos/receitas
if (/\b(gastei|paguei|recebi|ganhei|comprei|reais|r\$|\d+[.,]\d{2})\b/.test(msg)
    && !/\b(agenda|evento|reuniao|consulta)\b/.test(msg)) {
  return 'criar_gasto';
}

// Busca financeira
if (/\b(quanto gastei|relat[oó]rio|gastos? d[eoa]|minhas despesas)\b/.test(msg)) {
  return 'buscar_gasto';
}

// Criar evento
if (/\b(marcar?|agendar?|criar|compromisso|reuni[aã]o|consulta|treino)\b/.test(msg)
    && /\b(\d{1,2}h|\d{1,2}:\d{2}|amanh[aã]|hoje|segunda|ter[cç]a|quarta)\b/.test(msg)) {
  return 'criar_evento_agenda';
}

// Buscar agenda
if (/\b(minha agenda|compromissos|o que tenho|agenda de)\b/.test(msg)) {
  return 'buscar_evento_agenda';
}

// ... etc
return 'padrao';
```

**Pros:** 0ms vs 620ms, determinístico, sem custo de API, sem bugs de JSON garbled
**Contras:** Menos flexível que LLM, precisa manutenção para novos padrões

#### B) REDUZIR O PROMPT DO AI AGENT → Economia: ~2-4s
**Impacto: MUITO ALTO | Dificuldade: ALTA**

O system message tem 30K chars (8K tokens). Reduzir para ~10K chars (3K tokens) cortaria ~3s do tempo de processamento.

Sugestões:
1. Mover regras de segurança/anti-vazamento para guardrails no próprio N8N (não precisa estar no prompt)
2. Comprimir exemplos — 10 exemplos de teste ocupam ~500 chars que o LLM não precisa ver em runtime
3. Remover seções 4-8 do system message geral (segurança, estilo, lógica rápida, confirmações, escape) — são ~4K chars que repetem o que já está no prompt específico
4. Usar prompt específico enxuto para ações simples (e.g., buscar agenda não precisa das 270 linhas do registrar_gasto)

#### C) CORRIGIR MAIN — FILTRAR STATUS WEBHOOKS → Economia: elimina 89% de erros
**Impacto: ALTO (limpeza) | Dificuldade: BAIXA**

Adicionar If node logo após `trigger-whatsapp`:
```
Condition: {{ $json.messages }} exists AND is not empty
True → Edit Fields (fluxo normal)
False → NoOp (parar)
```

#### D) ELIMINAR REDUNDÂNCIA DE REDIS DEBOUNCE → Economia: ~100-200ms
**Impacto: MÉDIO | Dificuldade: MÉDIA**

Reduzir de 20 Redis nodes para 5:
- 1x firstGet (no início)
- 1x push (logo após)
- 1x mediumGet/lastGet (comparação)
- 1x Redis delete (no final, compartilhado por todas as branches)
- 1x Redis Chat Memory

#### E) CENTRALIZAR HTTP SUB-WORKFLOW CALLS → Economia: simplificação
**Impacto: BAIXO (tempo) | Dificuldade: MÉDIA**

Ao invés de 9 nodes HTTP duplicados, usar 3 (1 por tipo: gasto, evento, lembrete) com parâmetros dinâmicos.

#### F) ENVIAR "Processando..." VIA EVOLUTION API (JÁ EXISTENTE) → Economia: ~489ms
**Impacto: MÉDIO | Dificuldade: BAIXA**

O Fix Conflito v2 já usa Evolution API para enviar a resposta final. Se o "Processando..." fosse enviado pela Evolution API dentro do Fix Conflito (ao invés da Main via WhatsApp Cloud API), eliminaria a latência extra da Main.

#### G) REMOVER NoOp NODES → Economia: marginal (~10ms)
**Impacto: BAIXO | Dificuldade: FÁCIL**

10 nodes "No Operation, do nothing" não fazem nada. Reconectar as arestas diretamente.

---

## 6. PROJEÇÃO DE TEMPO COM TODAS AS OTIMIZAÇÕES

### Cenário Otimizado (REALISTA):

| Etapa | Atual | Otimizado | Economia |
|-------|-------|-----------|----------|
| Main (trigger → HTTP) | 1100ms | 600ms | 500ms (remover "Processando" da Main) |
| Classificador LLM | 620ms | 10ms | 610ms (Code router) |
| Redis debounce | 200ms | 50ms | 150ms (simplificar) |
| Supabase queries | 775ms | 400ms | 375ms (paralelizar) |
| **AI Agent (LLM)** | **3300-24000ms** | **2000-5000ms** | **1300-19000ms** (reduzir prompt) |
| HTTP sub-workflows | 584ms | 400ms | 184ms |
| WhatsApp send | 500ms | 500ms | 0ms |
| **TOTAL** | **7079-27779ms** | **3960-6960ms** | **~50% redução** |

### Cenário com prompt reduzido (P50):
```
600ms (Main) + 10ms (router) + 50ms (Redis) + 400ms (Supabase)
+ 2500ms (AI Agent) + 400ms (sub-wf) + 500ms (WhatsApp send)
= ~4460ms ≈ 4.5s ✅
```

### Cenário com prompt longo (P90):
```
600ms + 10ms + 50ms + 400ms + 5000ms + 400ms + 500ms = ~6960ms ≈ 7s
```

**Veredicto: 5 segundos P50 é alcançável. P90 ficará em ~7s.**

Para garantir P95 < 5s, seria necessário:
- Usar GPT-4.1-nano (quando disponível) ou modelo mais rápido
- Reduzir prompt para < 2K tokens
- Implementar streaming na resposta WhatsApp

---

## 7. GPT-4.1-MINI — É O GARGALO?

**Não é o modelo que é lento — é o prompt que é grande.**

GPT-4.1-mini já é um dos modelos mais rápidos disponíveis. O problema é que com 8K tokens de input, qualquer modelo levará tempo.

| Cenário | Input tokens | Tempo esperado GPT-4.1-mini |
|---------|-------------|------------------------------|
| Prompt atual completo | ~8000 | 3-6s |
| Prompt reduzido (50%) | ~4000 | 2-3s |
| Prompt mínimo | ~2000 | 1-2s |

**NÃO recomendo trocar de modelo.** GPT-4.1-mini é a melhor relação custo/velocidade/qualidade para este caso. A otimização deve ser no prompt e no fluxo.

---

## 8. PRIORIDADE DE IMPLEMENTAÇÃO

| # | Ação | Economia | Dificuldade | Prioridade |
|---|------|----------|-------------|------------|
| 1 | **Fix Main (filtrar statuses)** | Elimina 89% erros | Fácil | 🔴 URGENTE |
| 2 | **Code9 v3 + Classificador v4** | Corrige bugs de classificação | Pronto (ctrl+c ctrl+v) | 🔴 URGENTE |
| 3 | **Router por código (sem LLM)** | ~620ms | Média | 🟡 ALTO |
| 4 | **Reduzir prompt do AI Agent** | ~2-4s | Alta | 🟡 ALTO |
| 5 | **Simplificar Redis debounce** | ~150ms | Média | 🟢 MÉDIO |
| 6 | **Centralizar HTTP calls** | Simplificação | Média | 🟢 MÉDIO |
| 7 | **Remover NoOps** | ~10ms | Fácil | 🔵 BAIXO |

---

## 9. RESPOSTA DIRETA: É POSSÍVEL 5 SEGUNDOS?

**Sim, é possível alcançar ~5s E2E na maioria dos casos (P50), mas não em todos.**

- Com as otimizações 1-4 acima: **P50 ~4.5s, P90 ~7s**
- Sem mudar nada: **P50 ~11s, P90 ~16s**
- A diferença principal vem da **redução do prompt** (de 8K para ~3K tokens) e **eliminação do classificador LLM**

O modelo GPT-4.1-mini é adequado. O gargalo é o **tamanho do prompt** e a **quantidade de LLM calls** (2 sequenciais no caminho crítico).

---

— Sherlock, analisando com precisão cirúrgica 🔬
