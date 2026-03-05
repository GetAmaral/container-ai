# Fix Main Workflow — Guia Completo de Otimização

## 1. ESTADO ATUAL (pós filtro status + typing indicator)

```
trigger-whatsapp (0ms)
  → If4 - Filtro Status (1ms)     ← filtra webhooks de status ✅ FEITO
  → Edit Fields (1ms)             ← extrai messageSet
  → HTTP Request - Typing (424ms) ← typing indicator via WhatsApp Cloud API ✅ FEITO
  → If (1ms)                      ← é "Resuma para mim"?
  → If3 (1ms)                     ← é áudio encaminhado?
  → Get a row (285ms)             ← busca perfil no Supabase (profiles)
  → If8 (1ms)                     ← perfil existe?
  → If9 (1ms)                     ← plan_status = true?
  → setar_user (2ms)              ← monta dados do user
  → If2 (1ms)                     ← plan_type = premium?
  → Premium User (419ms)          ← HTTP POST → Fix Conflito v2
Total: ~1135ms
```

### Resultados das medições (5 execuções reais):

| Exec | HTTP Request (Typing) | Get a row | Premium User | TOTAL |
|------|----------------------|-----------|-------------|-------|
| 136267 | 456ms | 382ms | 438ms | 1285ms |
| 136254 | 463ms | 267ms | 252ms | 988ms |
| 136242 | 355ms | 226ms | 824ms | 1412ms |
| 136237 | 530ms | 291ms | 189ms | 1017ms |
| 136220 | 316ms | 258ms | 393ms | 972ms |
| **Média** | **424ms** | **285ms** | **419ms** | **1135ms** |

---

## 2. OTIMIZAÇÕES DISPONÍVEIS

### Fix 3: Paralelizar Typing com o resto (economia ~424ms)

O Typing Indicator não precisa estar no caminho sequencial. Pode rodar em paralelo.

```
Edit Fields → [2 saídas]
  Saída 1: HTTP Request (Typing) → para
  Saída 2: If → If3 → Get a row → If8 → If9 → setar_user → If2 → Premium User
```

**Como implementar:**
1. Desconectar `HTTP Request` → `If`
2. Conectar `Edit Fields` diretamente ao `If`
3. Manter `Edit Fields` → `HTTP Request` como branch paralelo (sem continuação)

Resultado: max(424, 285+419) = max(424, 704) = **~704ms**

### Fix 4: Cache Redis para profile (economia ~275ms)

Cachear perfil no Redis. 90%+ das mensagens serão cache hit (~10ms vs 285ms).

**Detalhes completos:** ver `fix-cache-redis-profile.md`

Resultado com Fix 3: max(424, 10+419) = **~434ms** (cache hit)

### Fix 5: URL interna para Premium User (economia ~370ms)

O request Premium User vai pela internet pública (`https://totalassistente.com.br/...`) mesmo estando tudo no mesmo servidor. Trocando para URL interna do Docker elimina DNS + TLS + proxy.

**Detalhes completos:** ver `fix-premium-user-latencia.md`

```
ANTES: https://totalassistente.com.br/webhook/12801cb9-...
DEPOIS: http://n8n-webhook:5678/webhook/12801cb9-...
```

Resultado: Premium User cai de ~419ms para ~30ms.

---

## 3. PROJEÇÃO COMBINADA

| Cenário | Typing | Get a row | Premium User | Total (paralelo) |
|---------|--------|-----------|-------------|------------------|
| **Atual** | 424ms | 285ms | 419ms | 1135ms |
| + Fix 3 (paralelizar) | 424ms// | 285ms | 419ms | **704ms** |
| + Fix 4 (cache Redis) | 424ms// | 10ms | 419ms | **434ms** |
| + Fix 5 (URL interna) | 424ms// | 10ms | 30ms | **424ms** |
| **TUDO junto** | 424ms// | 10ms | 30ms | **~424ms** |

// = paralelo (não soma no total)

### Com TUDO: Main cai de ~1135ms para **~424ms** (cache hit) ou **~454ms** (cache miss)

O gargalo final será o Typing Indicator (~424ms) que é o tempo da WhatsApp Cloud API — não tem como reduzir.

---

## 4. PROJEÇÃO E2E

| Componente | Antes | Depois |
|------------|-------|--------|
| Main | 1.135ms | ~424ms |
| Fix Conflito v2 (prompts comprimidos) | 10.700ms (P50) | ~6.000ms (P50 estimado) |
| **Total E2E** | **~11.8s** | **~6.4s** |

---

## 5. PRIORIDADE DE IMPLEMENTAÇÃO

| # | Fix | Economia | Dificuldade | Depende de |
|---|-----|----------|-------------|------------|
| ✅ | Fix 1: Filtro Status | Elimina erros | Fácil | — |
| ✅ | Fix 2: Typing Indicator | ~163ms vs Send message | Fácil | — |
| 3 | **Fix 3: Paralelizar Typing** | ~431ms | Fácil | — |
| 4 | **Fix 5: URL interna** | ~370ms | Fácil | Validar com funcionário |
| 5 | **Fix 4: Cache Redis** | ~275ms | Média | Ajustar setar_user e If2 |

**Recomendação:** Fix 3 + Fix 5 primeiro (fáceis, grande impacto). Fix 4 depois se quiser ir abaixo de 500ms.

---

Sherlock 🔬
