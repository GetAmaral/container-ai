# Solucao: Prevenir delay de webhook por credencial expirada

**Problema:** Em 09/03/2026, a credencial do site expirou, derrubando o proxy que roteia webhooks da Meta para o N8N. Resultado: 13h36min de delay na mensagem do Luan, que ao ser processada, excluiu 12 eventos retroativamente.

**Causa raiz:** Credencial expirada no container `totalassistente-site` → webhooks da Meta rejeitados → backoff exponencial da Meta (ate horas entre retries).

---

## Correcoes implementadas (prompt/logica)

### 1. System Message v5 — Confirmacao para exclusao em lote
**Status:** Arquivo criado (`system-message-ai-agent-v5-historico-limpo.txt`), pendente aplicacao no N8N.

Mesmo que o delay ocorra novamente, a IA agora pedira confirmacao antes de excluir 3+ itens. Isso teria evitado a exclusao dos 12 eventos do Luan.

### 2. Prompt Padrao v2
**Status:** Arquivo criado (`prompt-padrao-v2-humanizado.txt`), pendente aplicacao no N8N.

---

## Correcoes de infraestrutura (prevenir o delay)

### 3. Health check no container do site (RECOMENDADO)

Adicionar no `docker-compose.yml` para o container `totalassistente-site`:

```yaml
totalassistente-site:
  # ... config existente ...
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:80/"]
    interval: 60s
    timeout: 10s
    retries: 3
    start_period: 30s
  restart: always
```

**Por que:** Se a credencial expirar e o container parar de responder, o Docker reinicia automaticamente. Nao resolve a credencial mas garante que o container esta vivo.

### 4. Health check no container webhook do N8N (RECOMENDADO)

```yaml
totalassistente-n8n-webhook:
  # ... config existente ...
  healthcheck:
    test: ["CMD", "wget", "--spider", "-q", "http://localhost:5678/healthz"]
    interval: 30s
    timeout: 10s
    retries: 3
    start_period: 30s
  restart: always
```

### 5. Monitoramento externo do webhook (FORTEMENTE RECOMENDADO)

Configurar um cron ou servico externo que verifica se o endpoint do webhook esta respondendo:

**Opcao A — Cron no VPS (simples):**
```bash
# /root/scripts/check-webhook.sh
#!/bin/bash
WEBHOOK_URL="https://n8n.totalassistente.com.br/webhook/e47421cc-2944-439f-8065-d3d53ee772a0/webhook"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$WEBHOOK_URL" -H "Content-Type: application/json" -d '{"test": true}' --max-time 10)

if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "404" ]; then
  # Enviar alerta via WhatsApp/email
  echo "$(date) WEBHOOK DOWN - HTTP $HTTP_CODE" >> /var/log/webhook-monitor.log
  # Restart automatico
  cd /root/totalassistente && docker compose restart totalassistente-site totalassistente-n8n-webhook
fi
```

```bash
# Crontab: verificar a cada 5 minutos
*/5 * * * * /root/scripts/check-webhook.sh
```

**Opcao B — UptimeRobot/BetterUptime (mais robusto):**
- Criar monitor HTTP para `https://n8n.totalassistente.com.br/webhook-test/e47421cc-2944-439f-8065-d3d53ee772a0/webhook`
- Intervalo: 5 minutos
- Alerta por: WhatsApp, email ou Telegram
- Gratis ate 50 monitores no UptimeRobot

### 6. Renovacao automatica de credenciais (IDEAL)

Investigar qual credencial expirou:
- Se e certificado SSL (Let's Encrypt) → Traefik ja renova automaticamente via ACME. Verificar se o resolver esta configurado corretamente.
- Se e token da Meta/WhatsApp Business API → Configurar renovacao automatica ou usar token permanente (System User Token).
- Se e credencial do Google → Verificar OAuth refresh token.

**Verificar:**
```bash
# Checar certificados SSL
docker exec totalassistente-traefik cat /letsencrypt/acme.json | python3 -c "import json,sys; d=json.load(sys.stdin); [print(k, c['Certificates'][0]['domain']['main'] if c.get('Certificates') else 'none') for k,c in d.items()]"

# Checar logs do Traefik por erros de certificado
docker logs totalassistente-traefik --since '2026-03-09T00:00:00' --until '2026-03-09T12:00:00' 2>&1 | grep -i 'cert\|acme\|error\|expire'
```

### 7. Protecao contra mensagens atrasadas (IMPORTANTE)

Independente de prevenir o delay, proteger contra mensagens que chegam muito depois de enviadas:

**No workflow Main (trigger-whatsapp):**
Adicionar um node "Check Message Age" apos receber o webhook:

```javascript
// Code node: verificar idade da mensagem
const messageTimestamp = $input.item.json.entry[0].changes[0].value.messages[0].timestamp;
const now = Math.floor(Date.now() / 1000);
const ageSeconds = now - parseInt(messageTimestamp);
const MAX_AGE = 3600; // 1 hora

if (ageSeconds > MAX_AGE) {
  // Mensagem tem mais de 1 hora de atraso
  // Nao processar — enviar aviso ao usuario
  return [{
    json: {
      skip: true,
      reason: `Mensagem atrasada (${Math.round(ageSeconds / 60)} min). Descartada por seguranca.`,
      original_message: $input.item.json.entry[0].changes[0].value.messages[0].text?.body
    }
  }];
}

// Mensagem dentro do prazo — processar normalmente
return [{
  json: {
    skip: false,
    ageSeconds: ageSeconds
  }
}];
```

**Apos esse node, adicionar um IF:**
- Se `skip == true` → Enviar mensagem ao usuario: "Oi! Recebi sua mensagem com atraso. Pode repetir o que precisa?"
- Se `skip == false` → Continuar fluxo normal

**ESTA E A CORRECAO MAIS IMPORTANTE.** Mesmo que tudo mais falhe e o webhook atrase horas, essa protecao evita que comandos destrutivos sejam executados fora de contexto.

---

## Resumo de prioridades

| # | Correcao | Prioridade | Complexidade | Onde |
|---|---------|-----------|-------------|------|
| 1 | System Message v5 (confirmacao exclusao) | URGENTE | Baixa (copiar/colar) | N8N UI |
| 2 | Prompt Padrao v2 | URGENTE | Baixa (copiar/colar) | N8N UI |
| 3 | Protecao contra mensagens atrasadas | ALTA | Media (novo node) | Workflow Main |
| 4 | Monitoramento externo (UptimeRobot) | ALTA | Baixa (5 min) | Externo |
| 5 | Health checks Docker | MEDIA | Baixa (editar compose) | docker-compose.yml |
| 6 | Renovacao automatica de credenciais | MEDIA | Depende da credencial | VPS |
| 7 | Script de monitoramento local | BAIXA | Baixa (cron) | VPS |

---

## Testes apos implementar

1. **Simular webhook atrasado:** Enviar POST manual com timestamp antigo → deve recusar
2. **Exclusao em lote:** "exclua minha agenda de hoje" → deve listar e pedir confirmacao
3. **Health check:** `docker inspect --format '{{.State.Health.Status}}' totalassistente-site` → deve retornar "healthy"
4. **Monitor externo:** Derrubar o container site → alerta deve chegar em ate 10 minutos
