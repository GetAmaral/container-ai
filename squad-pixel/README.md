# squad-pixel - Documentacao

Pasta de saida do **Squad Pixel** (AIOS) para implementacao de Facebook Pixel.

## Sobre

Esta pasta contem todos os arquivos gerados pelo squad-pixel, incluindo:

- Codigos de implementacao do Facebook Pixel
- Guias passo a passo com diagnosticos
- Schema SQL para Supabase
- Banner de consentimento LGPD
- Relatorios de validacao

## Formato dos Arquivos

Cada entrega gera dois arquivos TXT:

| Arquivo | Conteudo |
|---------|----------|
| `{nome}-code.txt` | Codigo de implementacao (pixel, eventos, SQL) |
| `{nome}-passo-a-passo.txt` | Guia de implementacao + diagnostico do sistema |

## Modo de Operacao

**READ-ONLY** - O squad apenas le o codigo do site e banco de dados. Todas as solucoes sao geradas aqui nesta pasta, sem alterar nada no site em producao.

## Squad Agents

| Agente | Funcao |
|--------|--------|
| Pixel (Lead) | Coordena o squad |
| Tracker (Analyst) | Analisa site e jornadas |
| Beacon (Architect) | Projeta pixel e codigo |
| Shield (Compliance) | LGPD e consentimento |
| Lens (QA) | Valida e testa |

---

*Gerado por AIOS Squad Pixel v1.0.0*
