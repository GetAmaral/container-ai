# Passo a passo: Correcoes pos-incidente Luan (09/03/2026)

## Correcoes encontradas

### 1. System Message v5 (APLICAR NO N8N)

**Arquivo:** `system-message-ai-agent-v5-historico-limpo.txt`
**Node:** AI Agent → Parameters → Options → System Message
**Workflow:** Fix Conflito v2 (ID: tyJ3YAAtSg1UurFj)

**O que mudou de v4 → v5:**

| Mudanca | Antes (v4) | Depois (v5) |
|---------|-----------|-------------|
| Historico linha 6 | `Histórico: {{ Code9.confirmados... }}` | **REMOVIDO** (duplicava Redis Chat Memory) |
| Historico linhas 66-67 | `HISTÓRICO COMPLETO: {{ Code9.confirmados... }}` | **REMOVIDO** (duplicava Redis Chat Memory) |
| Ultimas mensagens | `ÚLTIMAS MENSAGENS: {{ Code9.mensagem_final }}` | Renomeado para `CONTEXTO DA CONVERSA:` (mesmo conteudo) |
| Regra de confirmacao | `NUNCA peça confirmação. Interprete e aja.` | `NUNCA peça confirmação para CRIAR. Para EXCLUIR MÚLTIPLOS (3+), SEMPRE liste e peça confirmação.` |

**Por que:**
- O historico era injetado 3x no system message + 1x pelo Redis Chat Memory = 4x total
- Na execucao do Luan, o system message apareceu 5x no contexto do LLM (127k tokens desperdicados)
- A regra "NUNCA peca confirmacao" fez a IA excluir 12 eventos sem perguntar

**Como aplicar:**
1. Abrir Fix Conflito v2 no N8N
2. Clicar no node "AI Agent"
3. Ir em Parameters → Options → System Message
4. Selecionar TUDO e apagar
5. Colar o conteudo inteiro de `system-message-ai-agent-v5-historico-limpo.txt`
6. Salvar o workflow
7. NÃO precisa desativar/reativar — salvar ja aplica

### 2. Prompt padrao v2 (JA COMMITADO, APLICAR NO N8N)

**Arquivo:** `prompt-padrao-v2-humanizado.txt` (ja no GitHub)
**Node:** padrao (Set node) → campo "prompt"

**Como aplicar:**
1. No mesmo workflow, clicar no node "padrao"
2. No campo "prompt" (assignments), selecionar tudo e apagar
3. Colar o conteudo de `prompt-padrao-v2-humanizado.txt`
4. Salvar

### 3. Investigar delay do webhook (PENDENTE — manual)

O problema principal (13h de delay) nao e resolvivel por prompt. Precisa:

1. **Verificar logs do Nginx** no VPS:
   ```bash
   ssh -i ~/.ssh/totalassistente root@188.245.190.178
   # Ver logs do Nginx no dia 09/03 entre 05:00 e 18:00
   docker logs totalassistente-site --since '2026-03-09T05:00:00' --until '2026-03-09T18:00:00' 2>&1 | grep -i 'webhook\|POST\|502\|504\|timeout'
   ```

2. **Verificar health do container webhook:**
   ```bash
   docker logs totalassistente-n8n-webhook --since '2026-03-09T05:00:00' --until '2026-03-09T18:00:00' 2>&1 | grep -i 'error\|restart\|crash\|timeout\|SIGTERM'
   ```

3. **Meta Business Platform:** Verificar em business.facebook.com → Configuracoes → Webhooks se ha historico de falhas de entrega

4. **Considerar adicionar ao docker-compose.yml:**
   ```yaml
   totalassistente-n8n-webhook:
     healthcheck:
       test: ["CMD", "wget", "--spider", "-q", "http://localhost:5678/healthz"]
       interval: 30s
       timeout: 10s
       retries: 3
       start_period: 30s
     restart: always
   ```

## Resumo de arquivos no GitHub

| Arquivo | Descricao | Status |
|---------|-----------|--------|
| `system-message-ai-agent-v4-humanizado.txt` | System message v4 (humanizacao) | Commitado, SUBSTITUIDO por v5 |
| `system-message-ai-agent-v5-historico-limpo.txt` | System message v5 (historico limpo + confirmacao exclusao) | **USAR ESTE** |
| `prompt-padrao-v2-humanizado.txt` | Prompt do branch padrao | Commitado, aplicar no N8N |
| `erro-luan.md` | Diagnostico completo do incidente | Commitado |
| `passo-a-passo-erro-luan.md` | Este arquivo | Commitado |
| `diagnostic-humanizacao-2026-03-09.md` | Diagnostico da humanizacao | Commitado |

## Testes apos aplicar

1. **Exclusao em lote:** Enviar "exclua minha agenda de hoje" → deve listar eventos e pedir confirmacao
2. **Exclusao unitaria:** "exclui a reuniao de amanha 15h" → deve excluir direto (1 item, sem confirmacao)
3. **Criacao:** "reuniao amanha 15h" → deve criar direto sem perguntar (comportamento preservado)
4. **Padrao:** "oi" → deve responder como secretaria profissional
5. **Fora de escopo:** "cria um planejamento" → deve recusar com elegancia
