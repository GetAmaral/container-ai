# Fix Main Workflow — Filtro de Status + Typing Indicator + Paralelização

## 1. FLUXO ATUAL (caminho premium, ~1.216ms)

```
trigger-whatsapp (0ms)
  → Edit Fields (1ms)           ← extrai messageSet
  → Send message (587ms)        ← "🔄 Processando..." via WhatsApp Cloud API
  → If (1ms)                    ← é "Resuma para mim"?
  → If3 (1ms)                   ← é áudio encaminhado?
  → Get a row (263ms)           ← busca perfil no Supabase (profiles)
  → If8 (1ms)                   ← perfil existe?
  → If9 (1ms)                   ← plan_status = true?
  → setar_user (2ms)            ← monta dados do user
  → If2 (1ms)                   ← plan_type = premium?
  → Premium User (359ms)        ← HTTP POST → Fix Conflito v2
                                  (webhook retorna rápido, processamento é async)
```

3 gargalos:
| Node | Tempo | % |
|------|-------|---|
| Send message ("Processando...") | 587ms | 48% |
| Premium User (HTTP webhook) | 359ms | 30% |
| Get a row (Supabase) | 263ms | 22% |

---

## 2. FIX 1: FILTRAR STATUS WEBHOOKS (elimina 89% erros)

### Problema
O WhatsApp envia webhooks de `status` (sent/delivered/read) além de `messages`.
Esses webhooks NÃO têm `contacts` nem `messages`.
A Main tenta enviar "Processando..." → crash: `contacts[0].wa_id` undefined.

**35 de 39 execuções recentes = ERROR.**

### Solução
Adicionar um **If node** logo após `trigger-whatsapp`, ANTES de `Edit Fields`:

**Node: "Filtro Status"** (tipo: If)
```
Condition:
  leftValue:  {{ $json.messages }}
  operator:   exists

True  → Edit Fields (fluxo normal)
False → No Operation (parar — é status webhook)
```

### Como implementar no N8N:
1. Abrir Main workflow
2. Desconectar `trigger-whatsapp` → `Edit Fields`
3. Adicionar novo If node entre eles:
   - Nome: `Filtro Status`
   - Condition: `{{ $json.messages }}` → exists
4. Conectar:
   - `trigger-whatsapp` → `Filtro Status`
   - `Filtro Status` (True) → `Edit Fields`
   - `Filtro Status` (False) → (nada, ou um NoOp)

---

## 3. FIX 2: SUBSTITUIR "Processando..." POR TYPING INDICATOR (~490ms economia)

### Problema
O node `Send message` ("🔄 Processando...") leva ~587ms — é o maior gargalo da Main (48%).

### Solução
Substituir por um **HTTP Request** que envia o **typing indicator** nativo do WhatsApp ("digitando...").
Tempo estimado: ~50-100ms (vs 587ms).

### Node: "Typing Indicator" (HTTP Request)

**Configuração no N8N:**
- **Nome:** `Typing Indicator`
- **Method:** POST
- **URL:** `https://graph.facebook.com/v23.0/744582292082931/messages`
- **Authentication:** Generic Credential Type → Header Auth
- **Credential:** `WhatsApp Header Auth` (id: `TDDrQvr1s0RxXTTC` — já existe no workflow)
- **Headers:**
  - `Content-Type`: `application/json`
- **Send Body:** Yes
- **Content Type:** JSON
- **JSON Body:**

```json
{
  "messaging_product": "whatsapp",
  "status": "read",
  "message_id": "{{ $('trigger-whatsapp').item.json.messages[0].id }}",
  "typing_indicator": {
    "type": "text"
  }
}
```

### O que acontece:
1. Marca a mensagem do usuário como **lida** (tiques azuis ✓✓)
2. Mostra **"digitando..."** nativo do WhatsApp
3. O indicador dura até **25 segundos** ou até a resposta final chegar

### Como implementar:
1. **Desativar ou remover** o node `Send message` ("🔄 Processando...")
2. **Adicionar** um novo HTTP Request node no lugar dele
3. Configurar conforme acima
4. Conectar no mesmo lugar: `Edit Fields` → `Typing Indicator` → `If`

### Comparação:
| | Antes (Send message) | Depois (Typing Indicator) |
|---|---|---|
| Tempo | ~587ms | ~50-100ms |
| Feedback visual | Mensagem "🔄 Processando..." | "digitando..." nativo |
| Marca como lido | Não | Sim (tiques azuis) |
| Duração | Permanente | Até 25s ou até resposta |
| **Economia** | — | **~490ms** |

### Nota (março 2026):
Feature em **Public Beta** da Meta. Se o endpoint retornar erro, reativar o Send message antigo.

---

## 4. FIX 3: PARALELIZAR TYPING + GET A ROW (~490ms economia total)

### Situação com Typing Indicator
Com o Typing Indicator (~100ms) substituindo o Send message (~587ms), o fluxo fica:

```
trigger → Filtro Status → Edit Fields → Typing Indicator (~100ms) → If → If3 → Get a row (263ms) → ... → Premium User (359ms)
Total: ~100 + 263 + 359 = ~722ms
```

### Paralelização opcional
Rodar Typing Indicator em paralelo com o restante do fluxo:

```
trigger → Filtro Status → Edit Fields → [2 saídas]
  Saída 1: Typing Indicator (dispara e para)
  Saída 2: If → If3 → Get a row → If8 → If9 → setar_user → If2 → Premium User
```

Tempos:
- Branch A (Typing Indicator): ~100ms
- Branch B (Get a row → Premium User): 263 + 5 + 359 = ~627ms
- Total: max(100, 627) = **~627ms**
- **Economia adicional: ~95ms** (de 722ms para 627ms)

Como o Typing Indicator já é rápido, a paralelização ganha pouco a mais. O grande ganho já veio da substituição do Send message.

---

## 5. OPÇÕES ADICIONAIS

### Opção C: Cache Redis para lookup de perfil (~200ms economia)

Cachear o perfil do usuário em Redis (key: `profile:{phone}`, TTL: 1h). A primeira consulta vai ao Supabase, as seguintes vão ao Redis (~10ms vs 263ms).

**Prós:** Supabase cai de 263ms para ~10ms.
**Contras:** Precisa criar lógica de cache + invalidação.

---

## 6. RESUMO DE TODAS AS OTIMIZAÇÕES

| Fix | O que faz | Economia | Dificuldade |
|-----|-----------|----------|-------------|
| **Fix 1: Filtro Status** | Filtra webhooks de status | Elimina 89% erros | Fácil |
| **Fix 2: Typing Indicator** | Substitui Send message por typing nativo | ~490ms | Fácil |
| **Fix 3: Paralelizar** | Typing em paralelo com fluxo | ~95ms adicional | Média |
| Opção C: Cache Redis | Cache de perfil | ~200ms | Média |

### Projeção com Fix 1 + Fix 2:
- Main: de ~1.216ms para **~722ms** (economia de ~494ms)

### Projeção com Fix 1 + Fix 2 + Fix 3:
- Main: de ~1.216ms para **~627ms** (economia de ~589ms)

### Projeção com TUDO (Fix 1-3 + Cache Redis):
- Main: de ~1.216ms para **~430ms** (economia de ~786ms)

---

## 7. PROJEÇÃO E2E COM TODAS AS OTIMIZAÇÕES

| Componente | Antes | Depois (Fix 1+2) | Depois (tudo) |
|------------|-------|-------------------|---------------|
| Main | 1.216ms | 722ms | 430ms |
| Fix Conflito v2 (prompts comprimidos) | 10.700ms (P50) | ~6.000ms | ~6.000ms |
| **Total E2E** | **~11.9s** | **~6.7s** | **~6.4s** |

**P50 estimado com Fix 1+2 + prompts comprimidos: ~6.5-7s**

---

Sherlock 🔬
