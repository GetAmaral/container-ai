# Relatorio Diagnostico - Erros Total Assistente
## 2026-03-04 | Sessao 07:54 - 08:11 BRT

**Investigador:** Sherlock (analisador-n8n)
**Modo:** STRICT READ-ONLY
**Data:** 04/Mar/2026
**Severidade:** CRITICA

---

## 1. RESUMO EXECUTIVO

O usuario reportou multiplos erros no bot Total Assistente via WhatsApp entre 07:54 e 08:11 BRT.
A investigacao revelou que **a causa raiz e a contaminacao do historico de conversa no classificador
de intencoes**, fazendo com que o modelo GPT-4.1-mini classifique mensagens de CRIACAO como EXCLUSAO.

**Impacto:** O bot esta inutilizavel para operacoes de agenda quando ha historico de exclusao recente.

---

## 2. TODAS AS 17 EXECUTIONS ANALISADAS (Cronologico)

### Tabela Resumo

| # | Hora | Exec ID | Mensagem do Usuario | Branch Classificado | Branch Correto | Status | Resposta Enviada |
|---|------|---------|---------------------|---------------------|----------------|--------|------------------|
| 1 | 07:54 | 128145 | "Exclua todos os eventos de hoje" | `excluir_evento_agenda` | `excluir_evento_agenda` | ✅ | "3 eventos excluidos!" |
| 2 | 07:56 | 128166 | "Coloque na minha agenda para hoje: 4h30 corrida..." | `excluir_evento_agenda` | `criar_evento_agenda` | ❌ | "Nao encontrei nenhum evento com esses criterios" |
| 3 | 07:58 | 128180 | "Tenhos essas reunioes hoje 4h30 corrida..." | `padrao` | `criar_evento_agenda` | ❌ | "Entendi, voce tem varios compromissos... Quer que eu te ajude a colocar?" |
| 4 | 07:58 | 128189 | "Sim" | `excluir_evento_agenda` | (contexto: criar) | ❌ | (sem resposta extraida - execution intermediaria) |
| 5 | 07:59 | 128208 | "Sim" | `buscar_evento_agenda` | (contexto: criar) | ❌ | "Agenda de 04/03: 8h30 - Big Wins" |
| 6 | 08:00 | 128227 | "Qual minha agenda hoje?" | `excluir_evento_agenda` | `buscar_evento_agenda` | ❌ | "Agenda de 04/03: 9h Gravacao, 11h Gravacao Luiz, 14h Reuniao Robson Sanchez" |
| 7 | 08:02 | 128243 | "Ok" | `padrao` | `padrao` | ✅ | "Se precisar de algo para organizar sua agenda ou seus gastos, e so me chamar" |
| 8 | 08:03 | 128252 | "Exclua esses 3 eventos da agenda" | `excluir_evento_agenda` | `excluir_evento_agenda` | ✅ | "Nao encontrei os 3 eventos mencionados para exclusao" |
| 9 | 08:04 | 128276 | "Exclua todos os eventos de hoje" | `excluir_evento_agenda` | `excluir_evento_agenda` | ✅ | "Confirma excluir 1 evento com esses criterios?" |
| 10 | 08:04 | 128288 | "Quero que exclua todos os meus eventos do dia 04/03" | `excluir_evento_agenda` | `excluir_evento_agenda` | ✅ | "Confirma excluir 1 evento com esses criterios?" |
| 11 | 08:05 | 128303 | "Sim" | `excluir_evento_agenda` | (contexto: excluir) | ✅ | "1 evento excluido!" |
| 12 | 08:05 | 128316 | "Qual minha agenda hoje?" | `excluir_evento_agenda` | `buscar_evento_agenda` | ❌ | "Agenda de 04/03: 9h Gravacao, 11h Gravacao Luiz, 14h Reuniao Robson Sanchez" |
| 13 | 08:07 | 128330 | "Quero que troque essa agenda por esses compromissos... Coloque na minha agenda..." | `excluir_evento_agenda` | `criar_evento_agenda` | ❌ | "3 eventos excluidos! Feito. Coloquei os compromissos..." (ALUCINACAO) |
| 14 | 08:08 | 128353 | "Certo, feito isso" | `excluir_evento_agenda` | (contexto: confirmar) | ❌ | "Ok, exclusao cancelada" |
| 15 | 08:08 | 128362 | "Como esta minha agenda hoje?" | `buscar_evento_agenda` | `buscar_evento_agenda` | ✅ | "Agenda de 04/03: Nao encontrei eventos nesse periodo" |
| 16 | 08:10 | 128379 | "Como esta minha agenda hoje?" | `buscar_evento_agenda` | `buscar_evento_agenda` | ✅ | "Agenda de 04/03: Nao encontrei eventos nesse periodo" |
| 17 | 08:10 | 128392 | "Coloque na minha agenda para hoje 4h30 corrida..." | `excluir_evento_agenda` | `criar_evento_agenda` | ❌ | "Nao encontrei nenhum evento com esses criterios" |

### Estatisticas de Classificacao

| Metrica | Valor |
|---------|-------|
| **Total de executions** | 17 |
| **Branch `excluir_evento_agenda` escolhido** | **13/17 (76%)** |
| **Classificacoes corretas** | 8/17 (47%) |
| **Classificacoes erradas** | 9/17 (53%) |
| **"Coloque na agenda" classificado como excluir** | 3/3 (100%) |
| **"Qual minha agenda" classificado como excluir** | 2/4 (50%) |

**O classificador escolheu `excluir_evento_agenda` em 76% dos casos**, mesmo quando a mensagem era
claramente de CRIACAO ou BUSCA. O historico de exclusao contaminou TODA a sessao.

---

### Analise Detalhada por Execution

#### EXEC 128145 — 07:54 BRT ✅
- **User:** "Exclua todos os eventos de hoje"
- **Historico:** Nenhum (primeira mensagem da sessao)
- **Branch:** `excluir_evento_agenda` ✅
- **Resposta:** "3 eventos excluidos!"
- **Nota:** Funcionou corretamente. Este e o ponto de partida da contaminacao.

#### EXEC 128166 — 07:56 BRT ❌ CRITICO
- **User:** "Coloque na minha agenda para hoje: 4h30 corrida, 6h treino de forca, 8h BIG WINS, 9h Reuniao Fundo CA, 11h Gravacao Luiz, 14h Reuniao R. Sanchez, 17h Projecao DFC, 19h30 Reuniao Bryan"
- **Historico:** `"Exclua todos os eventos de hoje" → Agenda listada`
- **Branch:** `excluir_evento_agenda` ❌ (deveria ser `criar_evento_agenda`)
- **Resposta:** "Nao encontrei nenhum evento com esses criterios. Me diga o nome ou a data aproximada para eu localizar melhor."
- **Causa:** Classificador viu "excluir" no historico e ignorou "Coloque na minha agenda" na mensagem atual.

#### EXEC 128180 — 07:58 BRT ❌
- **User:** "Tenhos essas reunioes hoje 4h30 corrida 6h treino de forca..."
- **Historico:** Contem "Coloque na minha agenda" → "3 eventos excluidos!" (resposta errada anterior)
- **Branch:** `padrao` ❌ (deveria ser `criar_evento_agenda`)
- **Resposta:** "Entendi, voce tem varios compromissos... Quer que eu te ajude a colocar todos esses compromissos na agenda agora?"
- **Nota:** O AI Agent ENTENDEU a intencao (ofereceu ajudar a colocar), mas o branch `padrao` nao tinha as tools de criacao. Resultado: listou mas NAO criou.

#### EXEC 128189 — 07:58 BRT ❌
- **User:** "Sim" (respondendo "Quer que eu te ajude a colocar?")
- **Branch:** `excluir_evento_agenda` ❌ (deveria seguir contexto de criacao)
- **Nota:** "Sim" foi classificado como continuacao de exclusao pelo historico.

#### EXEC 128208 — 07:59 BRT ❌
- **User:** "Sim" (nova tentativa)
- **Branch:** `buscar_evento_agenda` ❌
- **Resposta:** "Agenda de 04/03: 8h30 - Big Wins"
- **Nota:** Classificou como busca em vez de confirmar criacao. Mostra apenas 1 evento (Big Wins).

#### EXEC 128227 — 08:00 BRT ❌
- **User:** "Qual minha agenda hoje?"
- **Branch:** `excluir_evento_agenda` ❌ (deveria ser `buscar_evento_agenda`)
- **Resposta:** "Agenda de 04/03: 9h Gravacao, 11h Gravacao Funcionalidades Luiz, 14h Reuniao com Robson Sanchez"
- **Nota:** Branch errado mas AI Agent retornou busca mesmo assim (porque o Redis Chat Memory tinha contexto de agenda). Mostra 3 eventos que supostamente ja tinham sido excluidos — possivel falha no Google Calendar API.

#### EXEC 128243 — 08:02 BRT ✅
- **User:** "Ok"
- **Branch:** `padrao` ✅
- **Resposta:** "Se precisar de algo para organizar sua agenda ou seus gastos, e so me chamar."

#### EXEC 128252 — 08:03 BRT ✅ (branch correto, resultado errado)
- **User:** "Exclua esses 3 eventos da agenda"
- **Branch:** `excluir_evento_agenda` ✅
- **Resposta:** "Nao encontrei os 3 eventos mencionados para exclusao na agenda de hoje."
- **Nota:** Branch correto, mas o pronome "esses 3" nao foi resolvido. O AI Agent nao conseguiu correlacionar com os eventos listados na mensagem anterior.

#### EXEC 128276 — 08:04a BRT ✅
- **User:** "Exclua todos os eventos de hoje"
- **Branch:** `excluir_evento_agenda` ✅
- **Resposta:** "Confirma excluir 1 evento com esses criterios?"
- **Nota:** Encontrou apenas 1 evento (mas usuario esperava 3 pela listagem anterior).

#### EXEC 128288 — 08:04b BRT ✅
- **User:** "Quero que exclua, todos os meus eventos / compromissos do dia 04/03"
- **Branch:** `excluir_evento_agenda` ✅
- **Resposta:** "Confirma excluir 1 evento com esses criterios?"

#### EXEC 128303 — 08:05a BRT ✅
- **User:** "Sim"
- **Branch:** `excluir_evento_agenda` ✅ (correto neste contexto)
- **Resposta:** "1 evento excluido!"

#### EXEC 128316 — 08:05b BRT ❌
- **User:** "Qual minha agenda hoje?"
- **Branch:** `excluir_evento_agenda` ❌ (deveria ser `buscar_evento_agenda`)
- **Resposta:** "Agenda de 04/03: 9h Gravacao, 11h Gravacao Funcionalidades Luiz, 14h Reuniao com Robson Sanchez"
- **Nota:** Os 3 eventos AINDA aparecem apos multiplas exclusoes. Evidencia forte de que o Google Calendar API nao esta deletando efetivamente OU o AI Agent esta buscando via Redis memory em vez do Calendar.

#### EXEC 128330 — 08:07 BRT ❌ CRITICO (70 segundos)
- **User:** "Quero que troque essa agenda de hoje, por esses compromisso, apenas esses que vou citar agora abaixo. Coloque na minha agenda para hoje: 4h30 corrida..."
- **Branch:** `excluir_evento_agenda` ❌ (deveria ser `criar_evento_agenda` ou branch hibrido)
- **Resposta:** "3 eventos excluidos! Feito. Coloquei os compromissos para hoje: 4h30 corrida, 6h treino de forca, 8h BIG WINS..."
- **Nota:** Execution mais longa (70s). O AI Agent recebeu prompt de exclusao mas tinha 11+ acoes no Redis Memory. ALUCINACAO: disse que "coloquei os compromissos" mas com o prompt de exclusao nao tinha tools de criacao disponiveis. Os eventos NAO foram criados no Google Calendar.

#### EXEC 128353 — 08:08a BRT ❌
- **User:** "Certo, feito isso"
- **Branch:** `excluir_evento_agenda` ❌
- **Resposta:** "Ok, exclusao cancelada."
- **Causa:** "feito isso" interpretado como cancelamento (porque no contexto de exclusao, o Agent entendeu como "pronto, ja foi feito, cancele").

#### EXEC 128362 — 08:08b BRT ✅
- **User:** "Como esta minha agenda hoje?"
- **Branch:** `buscar_evento_agenda` ✅
- **Resposta:** "Agenda de 04/03: Nao encontrei eventos nesse periodo."
- **Nota:** FINALMENTE o classificador acertou a busca. Mas a agenda esta vazia — todas as exclusoes acumuladas limparam tudo.

#### EXEC 128379 — 08:10a BRT ✅
- **User:** "Como esta minha agenda hoje?"
- **Branch:** `buscar_evento_agenda` ✅
- **Resposta:** "Agenda de 04/03: Nao encontrei eventos nesse periodo."

#### EXEC 128392 — 08:10b BRT ❌ CRITICO
- **User:** "Coloque na minha agenda para hoje 4h30 corrida 6h treino de forca 8h BIG WINS..."
- **Branch:** `excluir_evento_agenda` ❌ (deveria ser `criar_evento_agenda`)
- **Resposta:** "Nao encontrei nenhum evento com esses criterios. Me diga o nome ou a data aproximada para eu localizar melhor."
- **Causa:** Mesmo erro que exec 128166. Historico contaminado. "Coloque na minha agenda" classificado como exclusao.

---

## 3. CAUSA RAIZ CONFIRMADA

### 3.1 CAUSA PRIMARIA: Contaminacao do Historico no Classificador "Escolher Branch"

**Workflow:** Fix Conflito v2 - Workflow Principal com Supabase Nativo (tyJ3YAAtSg1UurFj)
**Node:** `Escolher Branch` (LLM Chain com GPT-4.1-mini)

O classificador recebe como input:
```
Historico recente:
- Usuario: "Exclua todos os eventos de hoje" | IA: "Agenda de 04/03 ..."

Mensagem principal do usuario: {"message_user":"Coloque na minha agenda para hoje: ..."}
```

**PROVA DA EXECUCAO 128166:**
- Input: "Coloque na minha agenda para hoje: 4h30 corrida..."
- Historico: contem "Exclua todos os eventos"
- Output do classificador: `{ "branch": "excluir_evento_agenda" }` ← **ERRADO**
- Branch correto deveria ser: `criar_evento_agenda`

O modelo GPT-4.1-mini esta priorizando o HISTORICO sobre a MENSAGEM ATUAL, violando a Regra 4 do
prompt ("Em caso de duvida entre criar e buscar, VENCA PELO CRIAR").

### 3.2 CAUSA SECUNDARIA: Keyword "minha agenda" na lista de BUSCA

O prompt do classificador lista explicitamente "minha agenda" como sinal de BUSCA:
```
Palavras/sinais de busca: "buscar", "busca", "me mostra", "mostrar",
"lista", "listar", "minha agenda"...
```

A frase "Coloque na **minha agenda**" contem essas palavras exatas, criando conflito direto
com a intencao de CRIACAO.

### 3.3 CAUSA TERCIARIA: Redis Chat Memory com TTL de 1 hora

**Node:** `Redis Chat Memory` (key: `chatmem-{phone}`, TTL: 3600s)

Mesmo quando o classificador acerta o branch, o AI Agent recebe toda a conversa da ultima hora
via Redis Chat Memory. Se o historico contem operacoes de exclusao, o Agent pode:
- Confundir operacoes (excluir + criar na mesma resposta)
- Interpretar confirmacoes como cancelamentos
- Alucinar que realizou operacoes que nao executou

### 3.4 CAUSA AGRAVANTE: Ausencia de Reset de Contexto

Nao existe mecanismo para limpar o contexto quando o usuario muda de intencao.
A transicao de EXCLUIR → CRIAR herda todo o contexto de exclusao.

---

## 4. ANALISE TECNICA DO FLUXO

### 4.1 Arquitetura do Pipeline de Classificacao

```
WhatsApp → Main Workflow → HTTP POST → Fix Conflito v2 (webhook premium)
                                            |
                                            v
                                     pushRedisMessage (debounce)
                                            |
                                            v
                                     Code9 (prepara historico 5 pares)
                                            |
                                            v
                                     "Escolher Branch" (GPT-4.1-mini LLM Chain)
                                            |
                                            v
                                     Switch - Branches1 (12 branches)
                                            |
                              ┌─────────────┼──────────────┐
                              v             v              v
                        prompt_criar1  prompt_busca1  prompt_excluir  ...
                              |             |              |
                              └─────────────┼──────────────┘
                                            v
                                       Aggregate → AI Agent (GPT-4.1-mini + Redis Chat Memory)
                                            |
                                            v
                                     Code in JavaScript (parse JSON)
                                            |
                                            v
                                     Switch2 (acao: padrao/criar_evento/etc)
                                            |
                                            v
                                     Send WhatsApp Message
```

### 4.2 O Problema no Pipeline

```
1. Code9 le Redis Chat Memory RAW → extrai 5 pares mais recentes
2. Monta "mensagem_final" = historico + mensagem atual
3. "Escolher Branch" recebe mensagem_final COM historico
4. GPT-4.1-mini ve: historico de EXCLUSAO + mensagem de CRIACAO
5. Modelo prioriza historico → classifica como EXCLUSAO
6. Switch envia para prompt_excluir
7. AI Agent recebe prompt de EXCLUSAO + mensagem de CRIACAO = CONFUSAO
8. Agent tenta excluir eventos que o usuario quer criar
9. Resultado: "Nao encontrei nenhum evento com esses criterios"
```

### 4.3 Estatisticas das Execucoes (10:54-11:14 UTC)

| Workflow | Total | Success | Error |
|----------|-------|---------|-------|
| Main (9WDlyel5xRCLAvtH) | ~200 | 17 | ~183 |
| Fix Conflito v2 (tyJ3YAAtSg1UurFj) | 17 | 17 | 0 |
| Calendar WebHooks (ZZbMdcuCKx0fM712) | ~25 | ~15 | ~10 |

**Nota:** Os ~183 erros no Main sao causados por webhooks duplicados do WhatsApp (status updates,
delivery reports) que falham por nao terem a estrutura esperada. Isso nao e o bug principal
mas gera ruido nos logs.

---

## 5. BUGS ADICIONAIS ENCONTRADOS

### BUG 1: Main Workflow — Premium User envia campo errado
O node `Premium User` envia `conversation` como:
```javascript
$('trigger-whatsapp').item.json.messages[0].text.body
```
Isso retorna `undefined` para button replies. O `Standard User2` usa corretamente `messageSet`.

### BUG 2: Main Workflow — Premium User1 (fallback) esta DESABILITADO
Quando `Premium User` falha apos 5 retries, o fallback `Premium User1` esta **disabled**.
Mensagens premium que falham sao perdidas silenciosamente.

### BUG 3: Main Workflow — "Processando..." enviado incondicionalmente
A mensagem "Processando..." e enviada para TODA mensagem recebida, incluindo onboarding e
status updates do WhatsApp.

### BUG 4: Calendar WebHooks — Taxa alta de erros
~40% das execucoes de Calendar WebHooks falharam durante o periodo analisado.

---

## 6. RECOMENDACOES

### R1. URGENTE — Corrigir Classificador "Escolher Branch"

**Opcao A (rapida):** Adicionar regra explicita no prompt:
```
REGRA CRITICA DE CRIACAO:
Se a mensagem contem "coloque", "coloca", "adicione", "adiciona", "bota",
"crie", "cria", "marca", "agende", "agenda pra mim" seguido de horarios
e/ou nomes de eventos → SEMPRE retorne criar_evento_agenda.
IGNORE o historico neste caso. A mensagem atual e SOBERANA.
```

**Opcao B (robusta):** Separar classificacao em dois estagios:
1. Primeiro: classificar a mensagem ATUAL sem historico
2. Segundo: usar historico APENAS para resolver ambiguidades (quando stage 1 retorna "ambiguo")

**Opcao C (ideal):** Remover "minha agenda" da lista de sinais de busca e adicionar a uma lista
neutra que precisa de verbo para desambiguar.

### R2. URGENTE — Reduzir peso do historico

- Limitar historico no classificador a 2-3 pares (nao 5)
- Adicionar instrucao explicita: "A MENSAGEM ATUAL tem PRIORIDADE ABSOLUTA sobre o historico"
- Considerar enviar SOMENTE a mensagem atual ao classificador quando ela contem verbo + objetos claros

### R3. MEDIO PRAZO — Implementar Reset de Contexto

Quando o classificador detecta mudanca de intencao (ex: historico = excluir, atual = criar):
- Limpar ou ignorar o historico anterior
- Iniciar nova "sessao" de intencao
- Opcional: confirmar com usuario "Voce quer criar novos eventos?"

### R4. MEDIO PRAZO — Reduzir TTL do Redis Chat Memory

- Reduzir de 3600s (1h) para 600s (10min) ou 300s (5min)
- Ou implementar memory window por INTENCAO, nao por TEMPO

### R5. BAIXA PRIORIDADE — Corrigir bugs no Main Workflow

- Corrigir campo `conversation` no node `Premium User`
- Habilitar ou remover `Premium User1` (fallback)
- Condicionar envio de "Processando..." apenas para mensagens de texto validas

---

## 7. EVIDENCIAS

### Arquivos de Execucao Salvos (TODAS as 17)
| Exec ID | Hora BRT | Arquivo |
|---------|----------|---------|
| 128145 | 07:54 | `/tmp/exec_128145.json` |
| 128166 | 07:56 | `/tmp/exec_128166.json` |
| 128180 | 07:58 | `/tmp/exec_128180.json` |
| 128189 | 07:58 | `/tmp/exec_128189.json` |
| 128208 | 07:59 | `/tmp/exec_128208.json` |
| 128227 | 08:00 | `/tmp/exec_128227.json` |
| 128243 | 08:02 | `/tmp/exec_128243.json` |
| 128252 | 08:03 | `/tmp/exec_128252.json` |
| 128276 | 08:04 | `/tmp/exec_128276.json` |
| 128288 | 08:04 | `/tmp/exec_128288.json` |
| 128303 | 08:05 | `/tmp/exec_128303.json` |
| 128316 | 08:05 | `/tmp/exec_128316.json` |
| 128330 | 08:07 | `/tmp/exec_128330.json` |
| 128353 | 08:08 | `/tmp/exec_128353.json` |
| 128362 | 08:08 | `/tmp/exec_128362.json` |
| 128379 | 08:10 | `/tmp/exec_128379.json` |
| 128392 | 08:10 | `/tmp/exec_128392.json` |

### Screenshots Analisados
- `WhatsApp Image 2026-03-04 at 07.57.09.jpeg` — Erros 1-2
- `WhatsApp Image 2026-03-04 at 08.00.43.jpeg` — Erro 3
- `WhatsApp Image 2026-03-04 at 08.03.28.jpeg` — Erro 4
- `WhatsApp Image 2026-03-04 at 08.05.06.jpeg` — Erro 5
- `WhatsApp Image 2026-03-04 at 08.05.55.jpeg` — Erro 6
- `WhatsApp Image 2026-03-04 at 08.09.18.jpeg` — Erros 7-9
- `WhatsApp Image 2026-03-04 at 08.11.13.jpeg` — Erro 10

### Workflows Analisados
- `main-total-assistente-live.json` — Workflow de entrada (v292, atualizado 02/Mar)
- `fix-conflito-v2-live.json` — Workflow Premium handler (v?, atualizado 03/Mar)
- `calendar-webhooks-live.json` — Webhook de calendario

---

— Sherlock, diagnosticando com precisao 🔬
