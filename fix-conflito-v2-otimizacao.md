# Fix Conflito v2 — Otimização Completa (Meta: 4 segundos)

## Situação Atual (medições reais, 10 execuções)

| Componente | Tempo Médio | % do Total |
|---|---|---|
| AI Agent (LLM) | ~4700ms | 74% |
| Escolher Branch | ~942ms | 15% |
| HTTP Send (resposta final) | ~678ms | 11% |
| **Total** | **~6320ms** | 100% |

---

## 1. NODES MORTOS/ÓRFÃOS PARA REMOVER

Estes nodes estão desconectados do fluxo principal ou nunca são ativados. Remova-os para limpar o workflow:

1. **Text Classifier** — não está no caminho crítico, órfão
2. **prompt_rel_mensal** (node de prompt) — não conectado ao Switch-Branches1
3. **Send Message** — órfão (conectado apenas a NoOp)
4. **NoOp** — sem função
5. **Sticky Notes** sem conexão — apenas visuais, não afetam execução mas poluem o workflow

**Impacto**: Limpeza visual. Não afeta tempo diretamente, mas facilita manutenção.

---

## 2. COMPRESSÃO DE PROMPTS (MAIOR IMPACTO)

GPT-4.1-mini processa ~1000 tokens/s no input. Cada token economizado = 1ms a menos.

### Resumo das Compressões

| Prompt | Original | Comprimido | Redução |
|---|---|---|---|
| prompt_criar1 | 26,984 | 8,641 | 68% |
| prompt_busca1 | 18,235 | 5,729 | 69% |
| prompt_editar1 | 15,008 | 2,737 | 82% |
| prompt_rel_mensal | 13,773 | 2,244 | 84% |
| prompt_rel | 15,029 | 2,661 | 83% |
| prompt_excluir | 13,345 | 3,245 | 76% |
| editar_gasto | 13,960 | 2,676 | 81% |
| prompt_lembrete | 10,949 | 1,972 | 82% |
| excluir2 | 10,616 | 2,442 | 77% |
| padrao | 8,759 | 1,999 | 78% |
| prompt_lembrete1 | 8,183 | 1,737 | 79% |
| buscar_gasto | 11,976 | 2,533 | 79% |
| **TOTAL** | **166,817** | **38,616** | **77%** |

**Economia total: ~128,000 caracteres (~32,000 tokens)**

### Impacto Estimado no AI Agent

O AI Agent carrega o system prompt + tool descriptions a cada execução. Com prompts 77% menores:
- Tempo de processamento do input reduz proporcionalmente
- Estimativa conservadora: **AI Agent de ~4700ms para ~3200-3500ms** (-1200 a -1500ms)

### Prompts Comprimidos (copiar/colar)

Cada prompt comprimido está em `/tmp/compressed-*.txt`. Nomes dos arquivos:

```
/tmp/compressed-prompt_criar1.txt
/tmp/compressed-prompt_busca1.txt
/tmp/compressed-prompt_editar1.txt
/tmp/compressed-prompt_rel_mensal.txt
/tmp/compressed-prompt_rel.txt
/tmp/compressed-prompt_excluir.txt
/tmp/compressed-editar_gasto.txt
/tmp/compressed-prompt_lembrete.txt
/tmp/compressed-excluir2.txt
/tmp/compressed-padrao.txt
/tmp/compressed-prompt_lembrete1.txt
/tmp/compressed-buscar_gasto.txt
```

---

## 3. OTIMIZAÇÃO DO HTTP SEND (~678ms)

O node HTTP Request que envia a resposta final usa a URL pública da WhatsApp Cloud API:
`https://graph.facebook.com/v23.0/744582292082931/messages`

Esta é a API oficial do WhatsApp e NÃO pode ser substituída por URL interna (diferente do Main workflow onde usamos Evolution API via Docker).

**Opção**: Se estiver usando Evolution API como intermediário, trocar para URL interna Docker:
`http://n8n-webhook:5678/webhook/...` (mesma lógica do fix do Main workflow)

---

## 4. OTIMIZAÇÃO DO ESCOLHER BRANCH (~942ms)

O node "Escolher Branch" faz uma segunda chamada LLM para rotear a resposta do AI Agent para o branch correto (criar_evento, buscar_eventos, etc.).

**Já otimizado**: O prompt do classificador já foi comprimido em sessão anterior (escolher-branch-prompt-v5-comprimido.txt).

**Se ainda lento**: Verificar se o modelo usado no Escolher Branch pode ser trocado por um mais rápido (GPT-4.1-nano ou similar) sem perder qualidade de roteamento.

---

## 5. PROJEÇÃO COM TODAS AS OTIMIZAÇÕES

| Componente | Atual | Otimizado | Economia |
|---|---|---|---|
| AI Agent | ~4700ms | ~3200ms | -1500ms |
| Escolher Branch | ~942ms | ~700ms | -242ms |
| HTTP Send | ~678ms | ~678ms | 0ms |
| **Total** | **~6320ms** | **~4578ms** | **-1742ms** |

Com compressão agressiva dos prompts, a projeção fica em **~4.5 segundos**.

Para chegar aos 4 segundos:
- Verificar se Escolher Branch pode usar modelo mais rápido
- Considerar cache de respostas frequentes
- Avaliar se algum branch pode ter resposta pré-computada

---

## 6. CHECKLIST DE IMPLEMENTAÇÃO

### Fase 1: Compressão de Prompts (maior impacto, sem risco)
- [ ] Substituir cada prompt original pelo comprimido correspondente
- [ ] Testar cada branch após substituição (criar evento, buscar, editar, excluir, lembretes, financeiro, relatórios)
- [ ] Verificar que nenhuma funcionalidade foi perdida

### Fase 2: Limpeza de Nodes
- [ ] Remover Text Classifier órfão
- [ ] Remover prompt_rel_mensal desconectado (se confirmado órfão)
- [ ] Remover Send Message + NoOp órfãos
- [ ] Remover Sticky Notes desnecessários

### Fase 3: Escolher Branch
- [ ] Testar modelo mais rápido para classificação
- [ ] Medir tempo antes/depois

### Fase 4: Medir Resultados
- [ ] Executar 10 testes após todas as mudanças
- [ ] Comparar com baseline de ~6320ms
- [ ] Meta: ≤4500ms (aceitável), ideal ≤4000ms
