# Fix Cache Redis — Profile Lookup (economia ~275ms)

## PROBLEMA

O node `Get a row` busca o perfil do usuário no Supabase (tabela `profiles`) em toda mensagem.
Tempo médio: **~285ms**.

O perfil raramente muda (nome, phone, plan_type, plan_status, id). Podemos cachear no Redis.

## SOLUÇÃO

Adicionar 3 nodes entre `If3` e `Get a row`:

```
ANTES:
  If3 (false) → Get a row (Supabase, ~285ms) → If8

DEPOIS:
  If3 (false) → Redis GET → If (cached?)
    → SIM: → If8 (dados do Redis, ~10ms)
    → NÃO: → Get a row (Supabase) → Redis SET → If8
```

---

## PASSO A PASSO

### Node 1: "Redis Get Profile" (Redis)

**Tipo:** Redis
**Credencial:** `Redis Germany` (id: `amNI4dVfk3J8Bz0v` — já existe)

**Configuração:**
- Operation: `Get`
- Key: `profile:{{ $('trigger-whatsapp').item.json.messages[0].from }}`
- Property Name: `cachedProfile`

### Node 2: "If Cached" (If)

**Tipo:** If

**Condition:**
- Left Value: `{{ $json.cachedProfile }}`
- Operator: `is not empty`

**True** → vai direto para `If8` (cache hit)
**False** → vai para `Get a row` (cache miss)

### Node 3: "Parse Cache" (Code)

Fica entre "If Cached" (True) e `If8`.
O Redis retorna uma string JSON. Precisamos parsear para que `If8`, `If9`, `setar_user` e `If2` funcionem normalmente.

**Tipo:** Code (JavaScript)

```javascript
// Parse cached profile from Redis
const cached = JSON.parse($json.cachedProfile);
return { json: cached };
```

### Node 4: "Redis Set Profile" (Redis)

Fica entre `Get a row` e `If8`.
Cacheia o perfil que acabou de vir do Supabase.

**Tipo:** Redis
**Credencial:** `Redis Germany`

**Configuração:**
- Operation: `Set`
- Key: `profile:{{ $('trigger-whatsapp').item.json.messages[0].from }}`
- Value: `{{ JSON.stringify($json) }}`
- Expire: `true`
- TTL: `3600` (1 hora)

---

## CONEXÕES

### Desconectar:
- `If3` (false) → `Get a row`

### Conectar:
1. `If3` (false) → `Redis Get Profile`
2. `Redis Get Profile` → `If Cached`
3. `If Cached` (True) → `Parse Cache` → `If8`
4. `If Cached` (False) → `Get a row` → `Redis Set Profile` → `If8`

### Diagrama:

```
If3 (false) → Redis Get Profile → If Cached?
                                    │
                           ┌────────┴────────┐
                           ▼ SIM             ▼ NÃO
                      Parse Cache        Get a row (Supabase)
                           │                 │
                           │            Redis Set Profile
                           │                 │
                           └────────┬────────┘
                                    ▼
                                   If8 → If9 → setar_user → If2 → ...
```

---

## COMPATIBILIDADE COM NODES EXISTENTES

Os nodes downstream esperam estes campos no `$json`:

| Node | Campo que usa | Vem de |
|------|--------------|--------|
| `If8` | `$json.id` (exists?) | Get a row |
| `If9` | `$json.plan_status` (true?) | Get a row |
| `setar_user` | `$('Get a row').item.json.phone` | Get a row |
| `setar_user` | `$('Get a row').item.json.name` | Get a row |
| `If2` | `$('Get a row').item.json.plan_type` | Get a row |

### Problema de referência

`setar_user` e `If2` referenciam `$('Get a row')` diretamente. No caminho do cache (sem Get a row), isso vai falhar.

### Solução: Ajustar setar_user

Trocar as expressões do `setar_user` de referências fixas para `$json`:

**ANTES:**
```
telefone: {{ $('Get a row').item.json.phone }}
nome:     {{ $('Get a row').item.json.name }}
id_user:  {{ $json.id }}
```

**DEPOIS:**
```
telefone: {{ $json.phone }}
nome:     {{ $json.name }}
id_user:  {{ $json.id }}
```

Funciona porque tanto o cache (Parse Cache) quanto o Supabase (Get a row / Redis Set Profile) passam o mesmo `$json` para `If8` → `If9` → `setar_user`.

### Ajustar If2

**ANTES:**
```
{{ $('Get a row').item.json.plan_type }} equals "premium"
```

**DEPOIS:**
```
{{ $('Get a row').item.json.plan_type }} equals "premium"
```

Hmm, `If2` referencia `$('Get a row')` diretamente. Para resolver:

**Opção A (simples):** Renomear o node `Parse Cache` para `Get a row` — assim as referências `$('Get a row')` funcionam nos dois caminhos.

**Opção B (mais limpo):** Trocar referências em `If2`:
```
ANTES: {{ $('Get a row').item.json.plan_type }}
DEPOIS: {{ $json.plan_type }}
```

Mas `If2` recebe dados de `setar_user`, que só tem `telefone`, `nome`, `id_user`. Não tem `plan_type`.

**Solução definitiva:** Adicionar `plan_type` ao `setar_user`:

```
telefone:  {{ $json.phone }}
nome:      {{ $json.name }}
id_user:   {{ $json.id }}
plan_type: {{ $json.plan_type }}    ← NOVO
```

E no `If2`:
```
ANTES: {{ $('Get a row').item.json.plan_type }}
DEPOIS: {{ $json.plan_type }}
```

---

## RESUMO DAS MUDANÇAS

### Nodes NOVOS (4):
1. **Redis Get Profile** — Redis GET `profile:{phone}`
2. **If Cached** — If `cachedProfile` is not empty
3. **Parse Cache** — Code node que parseia o JSON do Redis
4. **Redis Set Profile** — Redis SET `profile:{phone}` com TTL 1h

### Nodes EDITADOS (2):
1. **setar_user** — adicionar campo `plan_type` e trocar referências de `$('Get a row')` para `$json`
2. **If2** — trocar `$('Get a row').item.json.plan_type` para `$json.plan_type`

### Conexões NOVAS:
- `If3` (false) → `Redis Get Profile` → `If Cached`
- `If Cached` (true) → `Parse Cache` → `If8`
- `If Cached` (false) → `Get a row` → `Redis Set Profile` → `If8`

### Conexões REMOVIDAS:
- `If3` (false) → `Get a row` (agora passa pelo Redis primeiro)

---

## INVALIDAÇÃO DO CACHE

O cache tem TTL de 1 hora. Isso significa:
- Se o usuário mudar de plano (free → premium), pode levar até 1h para refletir
- Se isso for problema, reduzir TTL para 10 minutos (`600` segundos)
- Ou: quando o plano muda (no dashboard), adicionar um Redis DEL no backend

Para 99% dos casos, TTL de 1h é seguro — planos não mudam a cada hora.

---

## ECONOMIA

| Cenário | Get a row | Total |
|---------|-----------|-------|
| Sem cache (atual) | ~285ms | ~285ms |
| Cache MISS (1a mensagem) | ~285ms + ~15ms (Redis GET+SET) | ~300ms |
| Cache HIT (2a+ mensagem) | ~10ms (Redis GET) | ~10ms |
| **Economia no cache hit** | | **~275ms** |

Na prática, 90%+ das mensagens serão cache hit (mesmo usuário manda várias mensagens por hora).
