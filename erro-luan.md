# Diagnostico: Erro Luan — Exclusao da agenda inteira + delay de 13h no WhatsApp

**Data do incidente:** 2026-03-09
**Usuario:** Luan (phone: 554398459145, user_id: 1bf0892e-c30a-4654-a06d-c396b12bba5c)
**Agente:** @analisador (Sherlock)

---

## Resumo executivo

Luan enviou "Exclua minha agenda de hoje" as **05:08 BRT** (08:08 UTC). A mensagem so foi processada pelo N8N as **18:44 BRT** (21:44 UTC) — um **atraso de 13 horas e 36 minutos**. Quando finalmente processou, a IA excluiu TODOS os 12 eventos do dia (comportamento esperado para "exclua minha agenda de hoje"), mas como ja eram 18:44, os eventos ja tinham passado e a exclusao foi inutil/inesperada para o usuario.

**O problema principal NAO e a IA ter excluido errado** — e o **WhatsApp/webhook nao ter entregue a mensagem a tempo**.

---

## Timeline completa (horarios em BRT, America/Sao_Paulo)

```
05:08:49 — Luan envia "Exclua minha agenda de hoje" pelo WhatsApp
           (timestamp WhatsApp: 1773043729 = 2026-03-09 05:08:49 BRT)

05:08 a 18:44 — BURACO NEGRO: 13h36min sem processamento
              - Nenhuma execucao do Main workflow (9WDlyel5xRCLAvtH) nesse periodo
              - Webhook do WhatsApp NAO foi entregue ao N8N
              - Lembretes (sjDpjKqtwLk7ycki) e Service Message (GNdoIS2zxGBa4CW0) rodaram normalmente
              - Apenas esses 2 workflows executaram — o sistema estava "vivo" mas sem receber webhooks

18:44:46 — Main workflow (ID: 159707) finalmente recebe o webhook
           Execucao: 18:44:46 → 18:44:48 (1.3s)
           - trigger-whatsapp recebe a mensagem
           - Edit Fields extrai: "Exclua minha agenda de hoje"
           - Get a row: busca perfil do Luan no Supabase
           - Premium User: roteia para Fix Conflito v2

18:44:48 — Fix Conflito v2 (ID: 159708) inicia
           Execucao: 18:44:48 → 18:45:08 (19.9s)

           +0ms     Webhook premium recebe dados
           +3ms     buscar_relatorios (312ms)
           +382ms   OpenAI Chat Model2 — Escolher Branch (1183ms)
                    Input: "Exclua minha agenda de hoje"
                    Output: { "branch": "excluir_evento_agenda" }
           +1645ms  Redis Chat Memory carrega historico (16s! — LENTO)
           +1719ms  buscar_eventos via webhook (1773ms)
                    Params: data_inicio="2026-03-09 00:00:00-03", data_fim="2026-03-09 23:59:59-03"
                    Retorno: 12 eventos
           +3494ms  excluir_evento — IA chama excluir 12 vezes em paralelo
           +4998ms  AI Agent processa (7047ms)
                    Output: "Todos os eventos da sua agenda de hoje foram excluídos!"
           +12050ms Send message — envia resposta WhatsApp (727ms)
           +12051ms Get a row + Create a row1 — log no Supabase

18:45:00 — Calendar WebHooks (ZZbMdcuCKx0fM712) disparam
           12 execucoes em paralelo (IDs: 159712-159721)
           Cada uma: recebe sessao_id → exclui do Google Calendar → exclui do Supabase
           Todas com status: success
           Mensagem: "exclusão do evento na agenda google e padrão feito com sucesso"
```

## Os 12 eventos excluidos

| # | Evento | Horario | Google Session ID |
|---|--------|---------|-------------------|
| 1 | Revisao Clientes Genes | 09:00-09:30 | g9g1n9u7ve0jgujrt6lbb9b2ok |
| 2 | Pagar Social Midia | 09:30-10:30 | g3kuq9bu0vd6k77rcrtf22gi9c |
| 3 | Lembrete Sem Descricao | 10:00-10:15 | u3f4tmklhi7jcalcuo2cud79i0 |
| 4 | Alinhamento Davi | 10:30-11:00 | e2sufff28pub38hcoq3smknhuk |
| 5 | Influencer Manoela Rj | 12:00-12:30 | nna1eqg3s9dkh1nqck4qje7r4c |
| 6 | Entrevista Bni | 14:00-14:30 | 8ms8ofsl6s34o61lhfo8ciogrc |
| 7 | Adesivo | 14:00-14:30 | qqubrruf3ocble6brvb3cthfdo |
| 8 | Definicao Clientes Total | 15:00-15:30 | ppc17ogk5jcbgqlfnrcgcgimrc |
| 9 | On-Boarding Hotmart | 17:30-18:00 | au07vk3ocvs3csav00cj6pdp9c |
| 10 | Gravacoes | 18:00-18:30 | sph0s29vnj6lfia1lcp5ep9sho |
| 11 | Cobrar Luiz Bg | 18:00-18:30 | lbr2jvd5i6da4927at61c27olk |
| 12 | Entregar Clientes Atualizado | 19:00-19:30 | 7gi4ek230q21i67ulta1tqceh4 |

**Nota:** O evento #3 "Lembrete Sem Descricao" era RECORRENTE (RRULE: FREQ=WEEKLY;BYDAY=MO). A exclusao pode ter afetado futuras ocorrencias dependendo de como o Calendar WebHooks processou.

---

## Analise de causa raiz

### Problema 1: Delay de 13h36min no webhook (CRITICO)

**Sintoma:** Mensagem enviada as 05:08, processada as 18:44.

**Evidencias:**
- Nenhuma execucao do Main workflow entre 05:08 e 18:44 para o telefone do Luan
- Lembretes e Service Message executaram normalmente nesse periodo (sistema estava vivo)
- O webhook do WhatsApp NAO chegou ao N8N-webhook container

**Causas possiveis (em ordem de probabilidade):**

1. **Fila do WhatsApp Business API (Meta)** — Meta pode ter enfileirado o webhook e so entregou horas depois. Isso acontece quando:
   - O endpoint retorna timeout ou erro e Meta faz retry com backoff exponencial
   - A conta WhatsApp Business tem throttling por volume
   - Instabilidade na rede entre Meta e o VPS Hetzner

2. **N8N webhook container indisponivel temporariamente** — Se o container `totalassistente-n8n-webhook` estava reiniciando ou com problema entre 05:08 e 18:44, o webhook do Meta nao seria aceito e entraria em retry queue do lado da Meta.

3. **Queue mode do N8N (RabbitMQ)** — A mensagem pode ter entrado na fila mas o worker nao processou. Improvavel porque outros workflows rodaram normalmente.

4. **Nginx proxy timeout** — O reverse proxy pode ter rejeitado o webhook com timeout, causando retry do lado da Meta.

### Problema 2: IA excluiu tudo sem confirmar (ESPERADO mas problematico)

**Sintoma:** A IA excluiu 12 eventos sem pedir confirmacao.

**Evidencia:** O prompt_excluir tem regra clara:
```
4. Lote ("todos","apague tudo") → buscar → confirmar: "Confirma excluir N eventos?" → só após confirmação excluir
```

**Porem:** O system message do AI Agent diz:
```
NUNCA peça confirmação. Interprete e aja.
```

**Conflito:** A regra do system message ("NUNCA peca confirmacao") sobrescreve a regra do prompt_excluir ("confirme antes de excluir em lote"). A IA seguiu o system message e excluiu direto.

### Problema 3: System message repetido 5x no prompt (NOVO)

**Evidencia:** Na execucao 159708, o system message completo (6700+ chars) aparece nos items [935], [940], [945], [950] e [955] — **5 copias identicas** totalizando ~127.000 tokens de contexto desperdicado. Isso e causado pela interacao do Redis Chat Memory com o AI Agent: cada tool call gera uma nova iteracao do loop do agente, e cada iteracao reinclui o system message.

**Impacto:**
- Desperdicio de tokens (custo)
- Latencia adicional (o modelo processa 127k tokens de contexto repetido)
- Confusao potencial (historico poluido)

---

## Problemas de historico/memoria confirmados

Da investigacao anterior + esta execucao:

| # | Problema | Evidencia nesta execucao |
|---|----------|--------------------------|
| 1 | Historico duplicado 3x no system message | Linhas 6, 26 e 28-29 do system message injetam os mesmos dados |
| 2 | Redis Chat Memory injeta historico automatico + system message manual | O LLM recebe historico 4x |
| 3 | System message repetido 5x dentro da conversa do AI Agent | Items 935/940/945/950/955 (5 copias de 6700 chars cada) |
| 4 | Respostas da IA em JSON bruto no historico | O Redis armazena `{"acao":"criar_evento","tool":[...],"mensagem":"..."}` como contexto |
| 5 | Redis Chat Memory com 16s de latencia | Carregamento da memoria levou 16 segundos nesta execucao |

---

## Acoes recomendadas

### URGENTE — Exclusao em lote precisa de confirmacao

**Onde:** System message do AI Agent (node AI Agent → Options → System Message)

**Alterar de:**
```
NUNCA peça confirmação. Interprete e aja. Só pergunte quando falta info essencial.
```

**Para:**
```
NUNCA peça confirmação para CRIAR. Interprete e aja.
Para EXCLUIR MÚLTIPLOS itens (3+), SEMPRE liste e peça confirmação antes.
Só pergunte quando falta info essencial.
```

**Motivo:** Criar e uma acao segura (pode desfazer). Excluir 12 eventos e destrutivo e irreversivel.

### URGENTE — Investigar delay do webhook WhatsApp

**Acoes:**
1. Verificar logs do Nginx para 09/03 entre 05:00-18:00 BRT → buscar rejeicoes do webhook WhatsApp
2. Verificar health do container n8n-webhook nesse periodo
3. Considerar adicionar health check + auto-restart no docker-compose para o webhook container
4. Verificar se Meta tem dashboard de webhook delivery com status dos envios

### IMPORTANTE — Limpar historico duplicado

**System message v5** deve:
1. Remover "Historico:" (linha 6) — redundante
2. Remover "HISTORICO COMPLETO:" (linhas 28-29) — redundante com Redis Chat Memory
3. Manter apenas "ULTIMAS MENSAGENS:" (Code9.mensagem_final)

### IMPORTANTE — Limpar JSON do historico no Redis

**Code9 v4** deve:
- Na montagem de `confirmados`, extrair apenas `.mensagem` das respostas da IA
- Nao armazenar o JSON completo com `acao`, `tool`, etc.

---

## Dados tecnicos de referencia

### IDs das execucoes analisadas

| Execution ID | Workflow | Inicio (UTC) | Fim (UTC) | Duracao |
|-------------|----------|-------------|----------|---------|
| 159707 | Main - Total Assistente | 21:44:46 | 21:44:48 | 1.3s |
| 159708 | Fix Conflito v2 | 21:44:48 | 21:45:08 | 19.9s |
| 159712-159721 | Calendar WebHooks (x12) | 21:45:00 | 21:45:03 | ~3s cada |

### Timestamp WhatsApp original

- Raw: `1773043729` (Unix epoch)
- UTC: `2026-03-09 08:08:49 UTC`
- BRT: `2026-03-09 05:08:49 BRT`
- Delay ate processamento: **13h 36min 0seg**

### Redis Chat Memory no momento da execucao

- Key: `chatmem-554398459145`
- Tipo: list
- Entradas: 14 (antes da execucao)
- TTL configurado no LangChain: 300s (5min)
- Latencia de carregamento: 16.039ms (16s!)

---

— Sherlock, diagnosticando com precisao 🔬
