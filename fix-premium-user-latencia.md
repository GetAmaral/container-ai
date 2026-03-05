# Fix Premium User — Latência de ~419ms desnecessária

## O PROBLEMA

O node `Premium User` na Main faz um HTTP POST para o Fix Conflito v2:
```
URL: https://totalassistente.com.br/webhook/12801cb9-3923-4517-bfbf-c24c54e613c2
```

Mesmo com o Fix Conflito v2 configurado com `responseMode: onReceived` (responde imediatamente sem processar), o request leva **~419ms em média** (varia de 189ms a 824ms).

## POR QUE ESTÁ LENTO

O request está fazendo o caminho completo pela **internet pública**, mesmo estando tudo no **mesmo servidor**:

```
CAMINHO ATUAL (lento):

  Main (N8N container)
    │
    ▼
  DNS resolve "totalassistente.com.br" → 188.245.190.178
    │
    ▼
  TLS handshake (HTTPS) → ~100-200ms
    │
    ▼
  Sai pela internet pública (188.245.190.178)
    │
    ▼
  Entra no Caddy/Nginx (totalassistente-site container)
    │
    ▼
  Reverse proxy → N8N webhook container
    │
    ▼
  Fix Conflito v2 recebe e responde
    │
    ▼
  Resposta volta pelo mesmo caminho
```

Cada etapa adiciona latência:
- DNS: ~10-50ms
- TLS handshake: ~50-150ms
- Caddy proxy: ~10-30ms
- Overhead total: **~100-400ms desnecessários**

## A SOLUÇÃO

Trocar a URL pública por uma URL **interna do Docker**. Todos os containers estão na mesma rede `totalassistente_backend`:

| Container | IP interno | DNS interno |
|-----------|-----------|-------------|
| totalassistente-n8n | 172.18.0.7 | `n8n` ou `totalassistente-n8n` |
| totalassistente-n8n-webhook | 172.18.0.6 | `n8n-webhook` ou `totalassistente-n8n-webhook` |

```
CAMINHO NOVO (rápido):

  Main (N8N container, 172.18.0.7)
    │
    ▼
  HTTP direto para n8n-webhook:5678 (rede interna Docker)
    │
    ▼
  Fix Conflito v2 recebe e responde
```

Sem DNS público, sem TLS, sem Caddy. Latência estimada: **~10-50ms**.

## O QUE MUDAR

No node `Premium User` da Main workflow:

**ANTES:**
```
URL: https://totalassistente.com.br/webhook/12801cb9-3923-4517-bfbf-c24c54e613c2
Authentication: HTTP Basic Auth
```

**DEPOIS (opção 1 — DNS interno do Docker):**
```
URL: http://n8n-webhook:5678/webhook/12801cb9-3923-4517-bfbf-c24c54e613c2
Authentication: None (rede interna, sem necessidade)
```

**DEPOIS (opção 2 — IP direto):**
```
URL: http://172.18.0.6:5678/webhook/12801cb9-3923-4517-bfbf-c24c54e613c2
Authentication: None
```

**Recomendo opção 1** (DNS interno) pois o IP pode mudar se o container reiniciar. O DNS `n8n-webhook` é resolvido automaticamente pelo Docker.

## ATENÇÃO

1. Trocar `https://` por `http://` (não precisa de TLS dentro da rede Docker)
2. Remover autenticação Basic Auth (não precisa dentro da rede interna)
3. **Testar primeiro**: enviar uma mensagem de teste e verificar se o Fix Conflito v2 recebe
4. Se não funcionar com `n8n-webhook:5678`, testar com `totalassistente-n8n-webhook:5678`
5. O mesmo vale para `Standard User2` e `Standard User3` que usam `https://totalassistente.com.br/webhook/standard`

## ECONOMIA ESTIMADA

| | Antes | Depois |
|---|---|---|
| Premium User | ~419ms | ~10-50ms |
| **Economia** | | **~370-400ms** |

## CHECKLIST PARA O FUNCIONÁRIO

- [ ] Abrir Main workflow no N8N
- [ ] Node `Premium User`: trocar URL para `http://n8n-webhook:5678/webhook/12801cb9-3923-4517-bfbf-c24c54e613c2`
- [ ] Node `Premium User`: mudar Authentication para `None`
- [ ] Node `Standard User2`: trocar URL para `http://n8n-webhook:5678/webhook/standard`
- [ ] Node `Standard User3`: trocar URL para `http://n8n-webhook:5678/webhook/standard`
- [ ] Salvar e testar com uma mensagem
- [ ] Verificar se Fix Conflito v2 recebeu e processou
- [ ] Se NÃO funcionar, testar com `totalassistente-n8n-webhook:5678` no lugar de `n8n-webhook:5678`
- [ ] Se AINDA não funcionar, reverter para a URL original
