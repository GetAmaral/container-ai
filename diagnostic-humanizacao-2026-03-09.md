# Diagnostico: Humanizacao da IA — Fix Conflito v2

**Data:** 2026-03-09
**Workflow:** Fix Conflito v2 - Workflow Principal com Supabase Nativo (ID: tyJ3YAAtSg1UurFj)
**Arquivos de alteracao:**
- `system-message-ai-agent-v4-humanizado.txt` — System Message do AI Agent
- `prompt-padrao-v2-humanizado.txt` — Prompt do branch padrao

---

## Onde aplicar

### Alteracao 1: System Message do AI Agent
**Node:** AI Agent → Parameters → Options → System Message
**Workflow:** Fix Conflito v2 (ID: tyJ3YAAtSg1UurFj)
**Acao:** Substituir o conteudo inteiro pelo conteudo de `system-message-ai-agent-v4-humanizado.txt`

### Alteracao 2: Prompt do branch padrao
**Node:** padrao (Set node) → campo "prompt"
**Workflow:** Fix Conflito v2 (ID: tyJ3YAAtSg1UurFj)
**Acao:** Substituir o conteudo inteiro pelo conteudo de `prompt-padrao-v2-humanizado.txt`
**Por que:** O prompt padrao e acionado para cumprimentos, perguntas sobre o sistema, pedidos fora de escopo e mensagens ambiguas. Estava desalinhado com o tom e escopo do system message v4.

## O que mudou (v3 → v4)

| Aspecto | v3 (atual) | v4 (novo) |
|---------|-----------|-----------|
| Identidade | "sistema fechado" | "Total, assistente pessoal" |
| Tom | "direto, informal, frases curtas" | Secretaria profissional, acolhedora, humana |
| Fora de escopo | 1 frase generica | Lista de 7 coisas que NAO faz + exemplos de recusa |
| Dicas | Nenhuma | 5 dicas contextuais (site, Google, audio, PDF, recorrentes) |
| Escopo | Implicito | Lista explicita de 14 funcionalidades |
| Regras tecnicas | Preservadas | Preservadas (identicas) |

## Mapa de capacidades (referencia)

AGENDA: criar/buscar/editar/excluir eventos, lembretes pontuais, eventos recorrentes
FINANCEIRO: registrar/buscar/editar/excluir gastos e receitas
RELATORIOS: semanal, mensal, personalizado
PROCESSAMENTO: audio (Whisper), PDF/imagem (extrator), deteccao de conflitos

## Impacto

- Tempo de resposta: +50-150ms (negligivel)
- Padronizacao JSON dos modulos: NAO muda
- Repeticoes/respostas burras: NAO resolve (e problema de memoria/Redis — proximo item)

## Testes recomendados

Apos aplicar, testar com:
1. "oi" → deve cumprimentar como secretaria, pode dar 1 dica
2. "o que voce faz?" → deve listar funcionalidades de forma humana
3. "cria um planejamento financeiro" → deve recusar com elegancia e sugerir relatorio
4. "me ajuda com investimentos" → deve recusar e explicar foco
5. "reuniao amanha 15h" → deve criar normalmente (comportamento tecnico preservado)
6. "gastei 50 no mercado" → deve registrar normalmente

## Proximos itens pendentes

1. Erro de memoria (IA confunde coisas) → investigar Code9 + Redis Chat Memory
2. Erro de exclusao multipla → investigar fluxo excluir_evento
3. Lembretes falhando (~3%) → investigar Schedule Trigger
