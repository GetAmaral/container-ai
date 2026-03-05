# squad-pixel - Facebook Pixel Implementation

Pixel ID: `1584825002799208` | Site: Total Assistente | Gerado: 2026-03-05

## Arquivos

### Ordem de implementacao recomendada:

| # | Arquivo | Conteudo |
|---|---------|----------|
| 01 | `01-analise-site-passo-a-passo.txt` | Diagnostico completo do site (rotas, funil, gargalos) |
| 02 | `02-consent-banner-code.txt` | Componente React de consentimento LGPD |
| 02 | `02-consent-banner-passo-a-passo.txt` | Guia de implementacao do banner |
| 03 | `03-pixel-base-code.txt` | Pixel base com fix SPA (React Router) |
| 03 | `03-pixel-base-passo-a-passo.txt` | Guia de instalacao do pixel |
| 04 | `04-eventos-tracking-code.txt` | Todos os eventos (standard + custom) |
| 04 | `04-eventos-tracking-passo-a-passo.txt` | Guia de implementacao por componente |
| 05 | `05-conversions-api-code.txt` | Purchase server-side via Hotmart webhook |
| 05 | `05-conversions-api-passo-a-passo.txt` | Guia de configuracao CAPI + token |
| 06 | `06-supabase-schema-code.txt` | Schema SQL para analytics proprio |
| 06 | `06-supabase-schema-passo-a-passo.txt` | Guia de execucao do SQL |
| 07 | `07-validacao-passo-a-passo.txt` | Plano de testes completo (QA) |

## Eventos Configurados

| Evento | Tipo | Trigger |
|--------|------|---------|
| PageView | Standard | Cada navegacao (fix SPA) |
| ViewContent | Standard | Ver secao de pricing |
| InitiateCheckout | Standard | Clicar "Garantir Oferta" |
| Lead | Standard | Iniciar cadastro |
| CompleteRegistration | Standard | Completar perfil |
| Purchase | Standard | Compra confirmada (CAPI) |
| Contact | Standard | Clicar WhatsApp |
| ScrollToPrice | Custom | Scroll ate pricing |
| ClickCTA | Custom | Clicar CTA do hero |
| DashboardView | Custom | Acessar dashboard |

## Modo de Operacao

**READ-ONLY** - Nenhum arquivo do site foi alterado. Todas as solucoes estao nesta pasta.

---

*AIOS Squad Pixel v1.0.0*
