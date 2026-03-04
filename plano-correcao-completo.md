# Plano de Correcao Completo — Zero Erros
## Total Assistente | Fix Conflito v2

**Investigador:** Sherlock (analisador-n8n)
**Data:** 04/Mar/2026
**Objetivo:** Eliminar TODOS os erros de classificacao e interpretacao encontrados

---

## MAPA DOS PROBLEMAS

Existem **5 pontos de falha** que se alimentam mutuamente. Para zero erros, TODOS precisam ser corrigidos:

```
PONTO 1: Classificador "Escolher Branch" (prompt)
    ↓ classifica errado
PONTO 2: Code9 (historico enviado ao classificador)
    ↓ historico contamina
PONTO 3: Switch - Branches1 (rota para prompt errado)
    ↓ prompt errado injetado
PONTO 4: AI Agent (Redis Chat Memory + system message)
    ↓ memoria confunde o agente
PONTO 5: Ausencia de tratamento para operacoes compostas
    ↓ "troque a agenda" nao tem branch dedicado
```

---

## CORRECAO 1: PROMPT DO CLASSIFICADOR "Escolher Branch"

### O que esta errado

O prompt atual tem 3 falhas criticas:

**Falha 1A:** A Regra 3 lista "minha agenda" como sinal de BUSCA:
```
Palavras/sinais de busca: ... "minha agenda", "agenda de hoje" ...
```
Mas o usuario diz "Coloque na **minha agenda**" — que e CRIACAO. O classificador ve "minha agenda" e pende para busca/exclusao.

**Falha 1B:** A Regra 5 diz "Use o historico apenas para desambiguar", mas o historico e enviado JUNTO com a mensagem sem separacao clara. O modelo GPT-4.1-mini nao consegue ignorar o historico quando ele e dominante (ex: 5 pares de exclusao vs 1 mensagem de criacao).

**Falha 1C:** A Regra B (Confirmacao Curta) diz que "sim" deve seguir o branch do ultimo pedido. Mas quando o ultimo pedido foi uma RESPOSTA do bot (nao do usuario), o classificador confunde quem pediu o que.

### Como corrigir

**Substituir a secao PRIORIDADE DE INTERPRETACAO inteira por esta versao:**

```
PRIORIDADE DE INTERPRETACAO (REGRAS BASE)

REGRA SUPREMA — MENSAGEM ATUAL E SOBERANA

A MENSAGEM ATUAL do usuario tem PRIORIDADE ABSOLUTA sobre qualquer historico.
O historico serve APENAS para resolver ambiguidades quando a mensagem atual for curta
e sem contexto proprio (ex: "sim", "ok", "esse", "o primeiro").

Se a mensagem atual contiver um VERBO DE ACAO + OBJETO CLARO, classifique SOMENTE
pela mensagem atual. IGNORE o historico completamente.

REGRA DE CRIACAO — PRIORIDADE MAXIMA

Se a mensagem atual contiver QUALQUER um destes padroes, retorne criar_evento_agenda
INDEPENDENTE do historico:
- "coloque/coloca/bota/adicione/adiciona/crie/cria/agende/agenda pra mim/marca" + horarios ou nomes de eventos
- Lista de compromissos com horarios (ex: "4h30 corrida, 6h treino")
- "tenho essas reunioes/compromissos" + lista com horarios
- Qualquer mensagem com 3+ itens que contenham horario + nome de atividade

Exemplos que SEMPRE devem ir para criar_evento_agenda:
- "Coloque na minha agenda para hoje: 4h30 corrida, 6h treino" → criar_evento_agenda
- "Tenho essas reunioes hoje 9h reuniao, 11h gravacao" → criar_evento_agenda
- "Bota na agenda: reuniao 15h, dentista 17h" → criar_evento_agenda
- "Agenda pra mim amanha: 8h corrida, 10h medico" → criar_evento_agenda

REGRA DE EXCLUSAO

Retorne excluir_evento_agenda SOMENTE quando a mensagem atual contiver
verbos EXPLICITOS de exclusao:
- "exclua/exclui/excluir/apague/apaga/apagar/delete/remova/remove/remover/tire/tira/tirar"
- "quero que exclua/apague/remova"

NUNCA classifique como excluir quando nao houver verbo de exclusao na MENSAGEM ATUAL.

REGRA DE BUSCA

Retorne buscar_evento_agenda SOMENTE quando a mensagem atual contiver
sinais EXPLICITOS de busca:
- "qual/quais/como esta/como está/o que tem/me mostra/mostrar/lista/listar"
- "agenda de hoje" (sem verbo de acao anterior)
- "buscar/busca eventos"

Nota: "minha agenda" sozinho NAO e sinal de busca. Precisa de verbo de busca junto.
- "Qual minha agenda hoje?" → buscar (tem "qual")
- "Coloque na minha agenda" → criar (tem "coloque")
- "minha agenda?" → padrao (pergunta generica, Regra 0)

REGRA DE OPERACAO COMPOSTA (TROCAR/SUBSTITUIR)

Se a mensagem atual contiver "troque/trocar/substitua/substituir" + nova lista de eventos:
→ retorne criar_evento_agenda (o modulo de criacao deve lidar com a substituicao)

0. REGRA DE PERGUNTA GENERICA / META
[manter a regra atual sem alteracao]

1-4. [remover as regras atuais 1-4, substituidas pelas regras acima]

5. REGRA DE HISTORICO (LIMITADA)
Use o historico APENAS quando a mensagem atual for AMBIGUA, ou seja:
- Mensagem com 1-3 palavras sem verbo de acao (ex: "sim", "ok", "esse", "o primeiro", "pode")
- Referencia pronominal sem antecedente na propria mensagem (ex: "exclua esses")

Quando usar o historico:
- Identifique o ULTIMO PEDIDO DO USUARIO (nao da IA) no historico
- Retorne o branch correspondente ao pedido do usuario

Quando NAO usar:
- Mensagem com verbo de acao claro + objeto → classifique pela mensagem atual
- Mensagem com lista de compromissos → criar_evento_agenda (sempre)
```

**Tambem substituir a secao REGRAS CRITICAS DE CONTEXTO:**

```
REGRAS CRITICAS DE CONTEXTO

A) REGRA DE RETRY / FALHA
[manter sem alteracao]

B) REGRA DE CONFIRMACAO CURTA (SIM/NAO) + CONTEXTO
Se a mensagem atual for "sim", "ok", "pode", "pode sim", "isso", "confirmo":
- Olhe o ULTIMO PEDIDO DO USUARIO no historico (NAO a ultima resposta da IA)
- Retorne o branch desse pedido

Se a mensagem atual for "nao", "nao quero", "cancela", "desistir":
- Retorne padrao

IMPORTANTE: "Certo, feito isso", "Pronto", "Beleza" NAO sao confirmacoes de exclusao.
Sao RECONHECIMENTOS de que algo foi concluido. Trate como padrao.
```

**E remover "minha agenda" da lista de sinais de busca na Regra 3:**

```
Palavras/sinais de busca: "buscar", "busca", "me mostra", "me mostre",
"mostrar", "lista", "listar", "quais", "qual", "o que tem", "tem algo",
"agenda de hoje", "mostrar eventos", "quanto gastei", "meus gastos",
"gastos de hoje", "gastos de outubro".
```

(Removido: "minha agenda" — era o conflito direto)

---

## CORRECAO 2: CODE9 (Preparacao do Historico)

### O que esta errado

O Code9 envia 5 pares de historico ao classificador. Apos uma sessao de exclusao, os 5 pares sao todos de exclusao, contaminando qualquer mensagem nova.

Alem disso, o historico inclui RESPOSTAS DA IA que contem palavras como "excluir", "excluido", "nao encontrei", que reforçam o vies de exclusao.

### Como corrigir

**Alterar o Code9 para:**

1. Reduzir de 5 para **2 pares** no historico enviado ao classificador
2. Enviar APENAS os pedidos do usuario (sem respostas da IA) ao classificador
3. Manter os 5 pares completos para o AI Agent (que precisa de contexto)

**Codigo novo do Code9:**

```javascript
// ===== Helpers =====
function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function sanitize(text) {
  if (!text) return '';
  return String(text)
    .replace(/\s+/g, ' ')
    .trim();
}

// ================================
// 1) HISTORICO CONFIRMADO (IA <-> USER)
// ================================
let listaMemoria = [];

const memItems = $items('Redis Chat Memory7');
if (memItems?.length) {
  const redisItem = memItems[0].json;
  if (Array.isArray(redisItem?.Lista)) listaMemoria = redisItem.Lista;
}

const amostra = listaMemoria.slice(-20);

const eventos = amostra
  .map(raw => (typeof raw === 'string' ? safeParse(raw) : raw))
  .filter(Boolean)
  .map(e => ({
    type: e.type,
    content: sanitize(e.data?.content ?? '')
  }))
  .filter(e => e.content);

// Monta pares completos (para AI Agent — 5 pares)
const paresCompletos = [];
for (let i = eventos.length - 1; i >= 0 && paresCompletos.length < 5; i--) {
  if (eventos[i].type !== 'ai') continue;
  let j = i - 1;
  while (j >= 0 && eventos[j].type !== 'human') j--;
  if (j >= 0) {
    const userText = eventos[j].content;
    const aiParsed = safeParse(eventos[i].content);
    const respostaFinal = sanitize(aiParsed?.mensagem ?? eventos[i].content);
    paresCompletos.unshift({ pedido: userText, resposta: respostaFinal });
    i = j;
  }
}

// Pares reduzidos para o classificador (2 pares, SEM respostas da IA)
const paresClassificador = paresCompletos.slice(-2);

// ================================
// 2) MENSAGEM ATUAL (DEBOUNCE)
// ================================
let mensagemPrincipal = '';

const firstGetItems = $items('firstGet');
if (firstGetItems?.length) {
  const redisDebounce = firstGetItems[0].json;
  const listaDebounce = redisDebounce?.Lista ?? redisDebounce?.lista ?? [];
  const coletadas = [];

  if (Array.isArray(listaDebounce)) {
    for (const v of listaDebounce) {
      if (typeof v === 'string') {
        const p = safeParse(v);
        coletadas.push(sanitize(p?.message_user ?? p?.text ?? v));
      } else {
        coletadas.push(sanitize(v?.message_user ?? v?.text ?? ''));
      }
    }
  } else if (typeof listaDebounce === 'string') {
    const p = safeParse(listaDebounce);
    coletadas.push(sanitize(p?.message_user ?? p?.text ?? listaDebounce));
  }

  mensagemPrincipal = coletadas.filter(Boolean).slice(-1)[0] ?? '';
}

mensagemPrincipal = sanitize(mensagemPrincipal);

// ================================
// 3) TEXTO FINAL PARA CLASSIFICADOR (historico reduzido)
// ================================
let mensagemFinal = '';

if (paresClassificador.length) {
  mensagemFinal += 'Historico recente (apenas pedidos do usuario):\n';
  for (const p of paresClassificador) {
    mensagemFinal += `- "${p.pedido}"\n`;
  }
  mensagemFinal += '\n';
}

mensagemFinal += `Mensagem principal do usuario: ${mensagemPrincipal}`;

// ================================
// 4) SAIDA
// ================================
return {
  json: {
    mensagem_final: mensagemFinal,
    // Para o classificador: pares reduzidos
    confirmados_classificador: paresClassificador,
    // Para o AI Agent: pares completos (com respostas da IA)
    confirmados: paresCompletos,
    mensagem_principal: mensagemPrincipal
  }
};
```

**Mudancas no "Escolher Branch":**

No final do prompt, onde injeta o historico, alterar de:

```
HISTORICO (ultimas 5 interacoes):
{{ $('Code9').item.json.confirmados.map(c => `User: ${c.pedido}\nIA: ${c.resposta}`).join("\n") }}
```

Para:

```
HISTORICO RECENTE (apenas pedidos do usuario, para contexto):
{{ $('Code9').item.json.confirmados_classificador.map(c => `User: "${c.pedido}"`).join("\n") }}
```

Isso remove as respostas da IA do input do classificador. O classificador nao precisa saber o que a IA respondeu — so precisa saber o que o usuario pediu antes.

---

## CORRECAO 3: REDIS CHAT MEMORY

### O que esta errado

O Redis Chat Memory tem TTL de 3600s (1 hora) e alimenta o AI Agent com TODA a conversa. Quando o usuario faz 17 interacoes em 20 minutos (como neste caso), o Agent recebe um historico enorme e confuso com operacoes contraditorias.

### Como corrigir

**Opcao 3A (rapida): Reduzir TTL para 300s (5 minutos)**

No node `Redis Chat Memory`:
- Alterar `sessionTTL` de `3600` para `300`

Isso faz com que apos 5 minutos de inatividade, o contexto seja limpo. O usuario pode "recomecar" facilmente.

**Opcao 3B (robusta): Limpar memoria ao trocar de intencao**

Adicionar um node `Redis DELETE` entre o `Switch - Branches1` e o `Aggregate` que limpa a memoria quando o branch atual e DIFERENTE do branch anterior:

1. Armazenar o ultimo branch em Redis: `{phone}_last_branch`
2. No inicio do fluxo (apos Escolher Branch), comparar branch atual com `{phone}_last_branch`
3. Se diferente: executar `DEL chatmem-{phone}` para limpar a memoria
4. Atualizar `{phone}_last_branch` com o branch atual

Isso garante que ao mudar de excluir para criar, o Agent comeca com memoria limpa.

**Opcao 3C (ideal): Implementar ambas (3A + 3B)**

---

## CORRECAO 4: AI AGENT SYSTEM MESSAGE

### O que esta errado

O system message do AI Agent injeta o historico NOVAMENTE:
```
Historico/Contexto recente de conversa do usuario:
{{ $('Code9').item.json.confirmados.map(...) }}
```

Isso e redundante com o Redis Chat Memory e amplifica a contaminacao.

### Como corrigir

**Remover a linha de historico do system message** e confiar no Redis Chat Memory como unica fonte de historico:

Substituir:
```
Historico/Contexto recente de conversa do usuario (use como referencia de contexto, nao repita tudo):
{{ $('Code9').item.json.confirmados.map(c => `User: ${c.pedido} | IA: ${c.resposta}`).join(" | ") }}
```

Por:
```
(O historico da conversa ja esta disponivel via memoria. Foque na mensagem atual e no prompt especifico abaixo.)
```

Ou, se quiser manter algum contexto, incluir apenas o ULTIMO par:
```
Ultima interacao:
{{ $('Code9').item.json.confirmados.length > 0
   ? `User: ${$('Code9').item.json.confirmados.slice(-1)[0].pedido}`
   : 'Nenhuma interacao anterior' }}
```

---

## CORRECAO 5: PROMPT DE EXCLUSAO (prompt_excluir)

### O que esta errado

Quando o usuario diz "Certo, feito isso" apos o bot dizer "Coloquei os compromissos...", o prompt de exclusao interpreta como parte do fluxo de exclusao e responde "exclusao cancelada".

### Como corrigir

**Adicionar ao prompt_excluir:**

```
REGRA DE RECONHECIMENTO vs CONFIRMACAO

Se o usuario disser algo como:
- "Certo", "Certo, feito isso", "Pronto", "Beleza", "Ok, feito", "Ja foi"
E NAO houver nenhuma exclusao pendente de confirmacao:
→ responda com acao="padrao" e mensagem amigavel.
→ NAO interprete como "cancelar exclusao".

"Cancelar" so se aplica quando:
- Voce ACABOU de perguntar "Confirma excluir N eventos?"
- E o usuario responde "nao", "cancela", "desistir"
```

---

## CORRECAO 6: TRATAMENTO DE "ESSES" (Referencia Pronominal)

### O que esta errado

Quando o usuario diz "Exclua esses 3 eventos", o AI Agent nao consegue resolver "esses" para os eventos que ACABOU de listar.

### Como corrigir

**No prompt_excluir, adicionar:**

```
REGRA DE REFERENCIA PRONOMINAL

Se o usuario usar "esses", "esses ai", "esses 3", "os que voce mostrou",
"os de cima", "todos esses":
- Verifique o HISTORICO RECENTE para encontrar a ultima lista de eventos mostrada
- Use os nomes/datas dessa lista como criterio de busca
- Se o historico mostrar N eventos listados, busque por TODOS eles

Exemplo:
- IA mostrou: "9h Gravacao, 11h Gravacao Luiz, 14h Reuniao Robson Sanchez"
- User: "Exclua esses 3"
- Acao: buscar cada um por nome e excluir
```

---

## CORRECAO 7: EVENTOS "FANTASMA" NO GOOGLE CALENDAR

### O que esta errado

Na exec 128316 (08:05), apos "1 evento excluido!", a agenda AINDA mostra os mesmos 3 eventos. Isso sugere que:
- A exclusao pode estar falhando silenciosamente no Google Calendar API
- OU o AI Agent esta buscando do Redis memory em vez do Calendar real

### Como corrigir

**Investigar (requer mais dados):**

1. Verificar nos logs se a tool `excluir_evento` esta retornando sucesso ou erro
2. Verificar se a tool `buscar_eventos` esta consultando o Google Calendar ou o Supabase/cache
3. Se a exclusao retorna sucesso mas o evento persiste:
   - Pode ser latencia do Google Calendar API (cache)
   - Adicionar verificacao pos-exclusao: apos excluir, chamar buscar para confirmar

**Adicionar ao prompt_excluir:**
```
VERIFICACAO POS-EXCLUSAO

Apos excluir um ou mais eventos:
1. Chame buscar_eventos novamente para o mesmo periodo
2. Verifique se os eventos excluidos realmente sumiram
3. Se ainda aparecerem: informe o usuario que a exclusao pode demorar alguns segundos
```

---

## RESUMO DE IMPLEMENTACAO

### Prioridade 1 — Correcoes URGENTES (resolver hoje)

| # | O que | Onde | Tempo estimado |
|---|-------|------|----------------|
| 1 | Reescrever regras do classificador | Node "Escolher Branch" | 15 min |
| 2 | Remover "minha agenda" dos sinais de busca | Node "Escolher Branch" | 1 min |
| 3 | Reduzir historico para 2 pares no classificador | Node "Code9" | 10 min |
| 4 | Remover respostas da IA do input do classificador | Node "Code9" + "Escolher Branch" | 5 min |
| 5 | Adicionar regra "feito isso ≠ cancelar" | Node "prompt_excluir" | 5 min |

### Prioridade 2 — Correcoes IMPORTANTES (resolver esta semana)

| # | O que | Onde | Tempo estimado |
|---|-------|------|----------------|
| 6 | Reduzir TTL Redis Chat Memory para 300s | Node "Redis Chat Memory" | 1 min |
| 7 | Remover historico duplicado do AI Agent system msg | Node "AI Agent" | 5 min |
| 8 | Adicionar regra de referencia pronominal | Node "prompt_excluir" | 10 min |
| 9 | Adicionar verificacao pos-exclusao | Node "prompt_excluir" | 5 min |

### Prioridade 3 — Melhorias ESTRUTURAIS (resolver este mes)

| # | O que | Onde | Tempo estimado |
|---|-------|------|----------------|
| 10 | Implementar reset de memoria ao trocar intencao | Novo node Redis entre Switch e Aggregate | 30 min |
| 11 | Corrigir campo `conversation` no Premium User | Node "Premium User" no Main workflow | 5 min |
| 12 | Habilitar ou corrigir Premium User1 (fallback) | Node "Premium User1" no Main workflow | 5 min |
| 13 | Investigar eventos fantasma no Google Calendar | Logs + Calendar API | 1-2h |

---

## TESTE DE VALIDACAO

Apos implementar as correcoes, testar EXATAMENTE esta sequencia (que reproduz o bug):

```
1. "Exclua todos os eventos de hoje"
   → Esperado: branch=excluir_evento_agenda, eventos excluidos

2. "Coloque na minha agenda para hoje: 9h reuniao, 11h gravacao, 14h dentista"
   → Esperado: branch=criar_evento_agenda, 3 eventos criados
   → CRITICO: NAO deve classificar como excluir

3. "Qual minha agenda hoje?"
   → Esperado: branch=buscar_evento_agenda, mostra os 3 eventos criados

4. "Exclua esses 3 eventos"
   → Esperado: branch=excluir_evento_agenda, referencia resolvida, 3 excluidos

5. "Coloque na minha agenda: 8h corrida, 10h reuniao"
   → Esperado: branch=criar_evento_agenda (mesmo apos exclusao)

6. "Certo, feito isso"
   → Esperado: branch=padrao, mensagem amigavel (NAO "exclusao cancelada")

7. "Qual minha agenda hoje?"
   → Esperado: branch=buscar_evento_agenda, mostra os 2 eventos do passo 5

8. "Sim" (sem contexto pendente)
   → Esperado: branch=padrao
```

Se todos os 8 passos retornarem o branch correto, o bug esta corrigido.

---

— Sherlock, diagnosticando com precisao 🔬
