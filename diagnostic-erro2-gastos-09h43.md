# Relatório Diagnóstico — Erro 2: Bot pede confirmação em vez de criar gastos
## Total Assistente | Fix Conflito v2

**Investigador:** Sherlock (analisador-n8n)
**Data:** 04/Mar/2026
**Severidade:** CRÍTICA
**Modo:** STRICT READ-ONLY

---

## 1. RESUMO EXECUTIVO

O usuário "Avelum/Ryan" enviou uma lista enorme de gastos e receitas (~20 itens com valores).
O bot, em vez de registrar imediatamente, **pediu confirmação**: "me confirme se quer que eu registre cada um desses valores agora".

O usuário respondeu "Faça do jeito que melhor entender, comece pelos gastos" e o bot **pediu confirmação novamente**.

### Causa Raiz: 3 falhas em cadeia

| # | Falha | Onde |
|---|-------|------|
| 1 | Code9 extraiu `mensagem_principal` como JSON bruto `{"message_user":"..."}` | Node Code9 |
| 2 | Classificador viu JSON garbled → classificou como `padrao` (deveria ser `criar_gasto`) | Node Escolher Branch |
| 3 | Follow-up "comece pelos gastos" classificado como `criar_gasto` ✅ mas histórico VAZIO no AI Agent | Node AI Agent (system message) |

---

## 2. EXECUTIONS ANALISADAS

### 2.1 Execution 128983 — Fix Conflito v2 (12:43 UTC / 09:43 BRT)

| Campo | Valor |
|-------|-------|
| **Mensagem do usuário** | Lista com ~20 gastos+receitas (camisa 179, calça 409, estacionamento 18...) |
| **mensagem_principal (Code9)** | `{"message_user":"Gastos: gastei 179 com uma camisa social..."}`  ❌ JSON BRUTO |
| **mensagem_final (Code9)** | `Mensagem principal do usuário: {"message_user":"Gastos: gastei 179..."}`  ❌ |
| **Branch classificado** | `padrao`  ❌ (deveria ser `criar_gasto`) |
| **Resultado** | Bot pediu confirmação em vez de registrar |

**Por que o Code9 retornou JSON bruto?**
O Code9 atual usa `$items('firstGet')` (sintaxe Code v1) em vez de `$('firstGet').all()` (Code v2).
Quando falha silenciosamente, o fallback captura o objeto `{message_user: "..."}` sem extrair o texto.

### 2.2 Execution 129017 — Fix Conflito v2 (12:47 UTC / 09:47 BRT)

| Campo | Valor |
|-------|-------|
| **Mensagem do usuário** | "Faça do jeito que melhor entender, comece pelos gastos" |
| **mensagem_principal (Code9)** | `Faça do jeito que melhor entender, comece pelos gastos`  ✅ |
| **Branch classificado** | `criar_gasto`  ✅ |
| **Prompt injetado** | `registrar_gasto`  ✅ (com REGRA ZERO) |
| **Histórico no system message** | **VAZIO** ❌ |
| **Resultado** | AI Agent retornou `acao: "padrao"` com mensagem de confirmação |

**Por que o AI Agent retornou padrao?**
1. A mensagem "comece pelos gastos" NÃO contém valores numéricos
2. O histórico estava VAZIO no system message (a expressão `$('Code9').item.json.confirmados.map(...)` retornou array vazio porque o Redis Chat Memory não tinha pares suficientes)
3. O prompt `registrar_gasto` diz: "Só use padrao quando NÃO houver NENHUM valor na mensagem inteira"
4. Sem valores na mensagem E sem histórico → o AI seguiu a regra corretamente, mas o CONTEXTO estava perdido

**Nota irônica:** O LLM em algum momento gerou o JSON correto com todos os 20+ lançamentos (encontrado no index 497 da execution), mas o output final foi `padrao` porque a cadeia de raciocínio priorizou "não tem valor na mensagem atual".

---

## 3. ANÁLISE DA CADEIA DE FALHAS

```
User envia lista de gastos (20+ itens)
    ↓
Code9 extrai mensagem_principal como JSON bruto ← BUG 1
    ↓
Classificador vê JSON → classifica "padrao" ← BUG 2 (consequência)
    ↓
AI Agent recebe prompt genérico (não registrar_gasto) → pede confirmação
    ↓
User manda "comece pelos gastos"
    ↓
Code9 extrai mensagem_principal OK: "Faça do jeito que melhor entender..."
    ↓
Classificador acerta: "criar_gasto" ✅
    ↓
AI Agent recebe prompt registrar_gasto ✅
    ↓
MAS: mensagem não tem valores + histórico VAZIO ← BUG 3
    ↓
AI Agent retorna "padrao" → pede confirmação NOVAMENTE
```

---

## 4. CORREÇÕES NECESSÁRIAS

### Fix 1: Code9 v3 — Extrair texto limpo de message_user (CRÍTICO)
**Arquivo:** `code9-v3-corrigido.js` (JÁ ESCRITO)

Mudanças principais:
- `$items('firstGet')` → `$('firstGet').all()` (compatibilidade Code v2)
- Nova função `extractMessageText()` que desembrulha JSON simples e duplo-stringificado
- `mensagem_principal` agora retorna texto puro, nunca JSON

### Fix 2: Classificador v4 — Detectar listas de gastos (CRÍTICO)
**Arquivo:** `escolher-branch-prompt-v4-COMPLETO.txt` (JÁ ESCRITO)

Mudanças principais:
- `MENSAGEM ATUAL` agora usa `{{ $('Code9').item.json.mensagem_principal }}` (confiável)
- Detecção de gastos: "Se a mensagem mencionar dinheiro, valores, gastos..." → `criar_gasto`
- Removidas meta-instruções copiadas por engano (`[manter a regra atual sem alteracao]`)

### Fix 3: Prompt registrar_gasto v2 — Regra de Continuação com Histórico (NOVO)
**Arquivo:** `prompt-registrar-gasto-v2-corrigido.txt`

Nova seção adicionada:
```
REGRA DE CONTINUAÇÃO — FOLLOW-UP COM HISTÓRICO

Se a mensagem atual NÃO contém valores numéricos MAS contém sinais de continuação
("comece", "pode", "sim", "ok", "faça", "registre", "lance"...)
E o HISTÓRICO contém valores/gastos/receitas:
→ EXTRAIA os valores DO HISTÓRICO e registre com acao = "registrar_gasto"
```

Também atualizada a REGRA-MÃE:
```
SE HOUVER VALOR (na mensagem atual OU no histórico referenciado) →
VOCÊ É OBRIGADO A REGISTRAR
```

### Fix 4: System Message AI Agent v2 — Fallback para histórico vazio (NOVO)
**Arquivo:** `system-message-ai-agent-v2-corrigido.txt`

Mudança: expressão `confirmados.map(...)` agora tem guard:
```
{{ $('Code9').item.json.confirmados.length > 0
   ? $('Code9').item.json.confirmados.map(c => ...).join(" | ")
   : "(sem historico recente)" }}
```

Isso evita que a expressão falhe silenciosamente quando `confirmados` é vazio.

---

## 5. RESUMO DE TODOS OS ARQUIVOS CORRIGIDOS

| # | Arquivo | Node afetado | Status |
|---|---------|--------------|--------|
| 1 | `code9-v3-corrigido.js` | Code9 | ✅ Pronto |
| 2 | `escolher-branch-prompt-v4-COMPLETO.txt` | Escolher Branch (LLM Chain) | ✅ Pronto |
| 3 | `expandir-recorrentes-v3-corrigido.js` | Expandir Recorrentes (Calendar WebHooks) | ✅ Pronto |
| 4 | `prompt-registrar-gasto-v2-corrigido.txt` | registrar_gasto (Set node) | ✅ Pronto |
| 5 | `system-message-ai-agent-v2-corrigido.txt` | AI Agent (system message) | ✅ Pronto |

---

## 6. IMPACTO ESPERADO APÓS CORREÇÕES

| Cenário | Antes | Depois |
|---------|-------|--------|
| Lista de gastos grande | `padrao` (pede confirmação) | `criar_gasto` (registra todos) |
| "comece pelos gastos" (follow-up) | `padrao` (sem contexto) | `registrar_gasto` (extrai do histórico) |
| "amanha tenho isso: reuniao 16h..." | `excluir_evento_agenda` (JSON garbled) | `criar_evento_agenda` |
| "exclua testeeee" (por nome) | CRASH no Information Extractor1 | Funciona (pairedItem fix) |
| "quais meus compromissos hoje?" | `padrao` | `buscar_evento_agenda` |

---

— Sherlock, diagnosticando com precisão 🔬
