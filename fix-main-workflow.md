# Fix Main Workflow — Filtro de Status + Análise de Tempo

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

## 3. ANÁLISE: COMO REDUZIR 1 SEGUNDO

### Opção A: Paralelizar Send message + Get a row (~589ms economia)

Atualmente tudo é **sequencial**. Mas `Send message` e `Get a row` não dependem um do outro:

- `Send message` precisa de: `contacts[0].wa_id` (do trigger)
- `Get a row` precisa de: `messages[0].from` (do trigger)

Se rodarmos em paralelo:

```
                              ┌→ Send message (587ms) ───────────┐
trigger → Filtro → Edit Fields│                                   │→ (fim)
                              └→ Get a row (263ms) → If8 → If9  │
                                 → setar_user → If2             │
                                 → Premium User (359ms) ────────┘
```

Tempos:
- Branch A (Send message): 587ms
- Branch B (Get a row → Premium User): 263 + 5 + 359 = 627ms
- Total: max(587, 627) = **~627ms**
- **Economia: ~589ms (de 1216ms para 627ms)**

**Como implementar:**
1. Após `Edit Fields`, criar 2 caminhos:
   - Caminho 1: `Edit Fields` → `Send message` (e para aqui)
   - Caminho 2: `Edit Fields` → `Get a row` → `If8` → `If9` → `setar_user` → `If2` → `Premium User`
2. Remover a conexão `Send message` → `If`
3. Adicionar conexão `Edit Fields` → `Get a row` (direta)
4. O `If` ("Resuma para mim") e `If3` (áudio encaminhado) devem ficar no caminho 2, antes de `Get a row`

**Fluxo reestruturado:**
```
trigger → Filtro Status → Edit Fields → [2 saídas]
  Saída 1: Send message (dispara e para)
  Saída 2: If → If3 → Get a row → If8 → If9 → setar_user → If2 → Premium User
```

### Opção B: Mover "Processando..." para o Fix Conflito v2 (~587ms economia)

Remover `Send message` da Main e colocar como primeiro passo do Fix Conflito v2 (via Evolution API que já existe lá).

**Prós:** Main cai para ~629ms. Simples.
**Contras:** O "Processando..." chega ~300ms mais tarde ao usuário (pois precisa passar pela Main → webhook → Fix Conflito primeiro).

### Opção C: Trocar Supabase por Redis para lookup de perfil (~200ms economia)

Cachear o perfil do usuário em Redis (key: `profile:{phone}`, TTL: 1h). A primeira consulta vai ao Supabase, as seguintes vão ao Redis (~10ms vs 263ms).

**Prós:** Supabase cai de 263ms para ~10ms.
**Contras:** Precisa criar lógica de cache + invalidação.

### Recomendação

| Opção | Economia | Dificuldade | Recomendo? |
|-------|----------|-------------|------------|
| **Fix 1: Filtro Status** | Elimina 89% erros | Fácil | ✅ SIM (urgente) |
| **Opção A: Paralelizar** | ~589ms | Média | ✅ SIM (maior ganho) |
| Opção B: Mover Processando | ~587ms | Fácil | Alternativa se A for difícil |
| Opção C: Cache Redis | ~200ms | Média | Opcional (futuro) |

Com Fix 1 + Opção A: **Main cai de ~1.216ms para ~627ms** (economia de ~589ms ≈ 0.6s)

---

## 4. PROJEÇÃO E2E COM TODAS AS OTIMIZAÇÕES

| Componente | Antes | Depois |
|------------|-------|--------|
| Main | 1.216ms | 627ms |
| Fix Conflito v2 (prompts comprimidos) | 10.700ms (P50) | ~6.000ms (P50 estimado) |
| **Total E2E** | **~11.9s** | **~6.6s** |

Com todas as otimizações juntas (Main paralela + prompts comprimidos):
**P50 estimado: ~6.5-7s**

---

Sherlock 🔬
