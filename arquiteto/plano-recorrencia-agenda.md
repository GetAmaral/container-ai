# Plano: Eventos Recorrentes na Agenda (estilo Google Calendar)

**Agente:** @architect (Aria)
**Projeto:** totalAssistente (totalassistente.com.br)
**Repo:** https://github.com/GetAmaral/totalAssistente
**Data:** 2026-02-23
**Status:** Aprovado para implementacao

---

## Objetivo

Fazer os eventos recorrentes aparecerem em TODOS os dias que ocorrem no calendario,
igual ao Google Calendar. Sem criar registros separados no banco — a rrule e expandida
no front-end.

**Exemplo:** Um evento "Reuniao Semanal" com `FREQ=WEEKLY;BYDAY=MO` deve aparecer
em TODAS as segundas-feiras no calendario, mesmo tendo apenas 1 registro no banco.

---

## Diagnostico: O que ja existe

### No Banco (Supabase) — TUDO PRONTO

| Campo | Tipo | Funcao |
|-------|------|--------|
| `is_recurring` | boolean | Marca se o evento e recorrente |
| `rrule` | string | Regra RFC 5545 (ex: `FREQ=WEEKLY;BYDAY=MO,WE,FR`) |
| `next_fire_at` | timestamptz | Proxima ocorrencia (usado para lembretes) |
| `last_fired_at` | timestamptz | Ultima vez que disparou |
| `repeats_until` | timestamptz | Data limite da recorrencia |
| `exdates` | string[] | Datas excluidas (ex: feriado, cancelamento) |

### Funcoes PostgreSQL — TUDO PRONTO

- `next_occurrence(base_ts, rrule, tz)` — calcula proxima ocorrencia
- `rrule_get_component(rrule, key)` — extrai partes da rrule
- `byday_to_dow_array(byday)` — converte dias da semana
- `reset_recurring_reminders()` — atualiza next_fire_at automaticamente

### Indices — TUDO PRONTO

```sql
idx_calendar_active_recurring ON calendar(user_id, is_recurring, active)
  WHERE is_recurring = true AND active = true
```

### O que FALTA (so front-end)

O `Calendar.tsx` hoje mapeia cada registro do banco como UM evento no FullCalendar:

```typescript
// Calendar.tsx (linha 83-96) — MAPEAMENTO ATUAL
{
  id: event.id,
  title: event.event_name,
  start: event.start_event,    // uma unica data
  end: event.end_event,        // uma unica data
  ...
}
```

**Resultado:** evento recorrente aparece so uma vez. Precisa expandir a rrule
em multiplas ocorrencias visuais.

---

## Arquitetura da Solucao

```
Banco (1 registro)          Front-end (N ocorrencias visuais)
┌──────────────────┐        ┌──────────────────────────────┐
│ Reuniao Semanal  │        │ Seg 03/03 - Reuniao Semanal  │
│ rrule: WEEKLY;MO │  ───>  │ Seg 10/03 - Reuniao Semanal  │
│ is_recurring: T  │        │ Seg 17/03 - Reuniao Semanal  │
│ (1 linha no DB)  │        │ Seg 24/03 - Reuniao Semanal  │
└──────────────────┘        │ Seg 31/03 - Reuniao Semanal  │
                            │ (N eventos visuais)           │
                            └──────────────────────────────┘
```

**Quem faz a expansao:** O front-end, usando a lib `rrule` (JavaScript).
O banco continua com 1 registro. Zero mudanca no backend.

---

## Opcao A vs Opcao B

Existem duas formas de fazer isso. Recomendo a **Opcao A**:

### Opcao A — Plugin nativo do FullCalendar (RECOMENDADA)

O FullCalendar tem um plugin oficial `@fullcalendar/rrule` que faz isso automaticamente.
Voce so passa a rrule no objeto do evento e o calendario expande sozinho.

**Vantagens:**
- FullCalendar cuida de tudo (expansao, limites de data, performance)
- Menos codigo para escrever
- Mantem consistencia com o resto do FullCalendar

### Opcao B — Expansao manual com lib `rrule`

Instalar a lib `rrule` e expandir manualmente antes de passar para o FullCalendar.

**Desvantagens:**
- Mais codigo para manter
- Precisa gerenciar limites de data manualmente
- Reinventa o que o plugin ja faz

**Decisao: Opcao A (plugin nativo)**

---

## Passo a Passo

### PASSO 1 — Instalar o plugin rrule do FullCalendar

**O que fazer:**
Abrir o terminal na pasta `site/` e rodar:

```bash
cd site
npm install @fullcalendar/rrule rrule
```

**O que cada lib faz:**
- `@fullcalendar/rrule` — plugin que conecta o FullCalendar a lib rrule
- `rrule` — lib JavaScript que interpreta regras RFC 5545 (mesma spec do Google Calendar)

**Arquivo afetado:** `site/package.json`

**Verificacao:**
Conferir no package.json se apareceu:
```json
"@fullcalendar/rrule": "^6.x.x",
"rrule": "^2.x.x"
```

---

### PASSO 2 — Registrar o plugin no FullCalendar (Calendar.tsx)

**Arquivo:** `site/src/pages/Calendar.tsx`

**O que fazer:**

1. Adicionar o import no topo do arquivo:
   ```typescript
   import rrulePlugin from '@fullcalendar/rrule'
   ```

2. Adicionar `rrulePlugin` no array de plugins do FullCalendar.
   Hoje o array esta assim (linha ~520):
   ```typescript
   plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
   ```
   Deve ficar:
   ```typescript
   plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin, rrulePlugin]}
   ```

**So isso nesse passo.** O plugin vai ser ativado mas ainda nao muda nada
ate a gente mudar o formato dos eventos.

---

### PASSO 3 — Alterar o mapeamento de eventos para incluir rrule

**Arquivo:** `site/src/pages/Calendar.tsx`

**Onde:** No trecho que mapeia os eventos do banco para o formato do FullCalendar
(aproximadamente linhas 83-96).

**Logica atual (simplificada):**
```typescript
const calendarEvents = events.map(event => ({
  id: event.id,
  title: event.event_name,
  start: event.start_event,
  end: event.end_event,
  ...
}));
```

**Nova logica (o que mudar):**

Para cada evento, verificar se `is_recurring === true && rrule !== null`.

**Se NAO for recorrente** (evento normal):
Manter exatamente como esta hoje. Nada muda:
```
{
  id: event.id,
  title: event.event_name,
  start: event.start_event,
  end: event.end_event,
  backgroundColor: ...,
  textColor: ...,
  extendedProps: { ... }
}
```

**Se FOR recorrente** (tem rrule):
Mudar o formato para usar as propriedades do plugin rrule:
```
{
  id: event.id,
  title: event.event_name,
  backgroundColor: ...,
  textColor: ...,
  extendedProps: {
    description: event.desc_event,
    reminder: event.reminder,
    originalEvent: event,
    isRecurring: true        // novo: flag para saber que e recorrente
  },

  // SUBSTITUIR start/end POR ESTAS PROPRIEDADES:
  rrule: {
    freq: extrair de event.rrule (ex: "weekly"),
    interval: extrair de event.rrule (ex: 1),
    byweekday: extrair de event.rrule se tiver BYDAY,
    bymonthday: extrair de event.rrule se tiver BYMONTHDAY,
    dtstart: event.start_event,
    until: event.repeats_until || null
  },
  duration: calcular diferenca entre end_event e start_event em formato HH:MM:SS,
  exdate: event.exdates || []    // datas excluidas
}
```

**IMPORTANTE sobre o campo `rrule`:**
O plugin aceita duas formas:

Forma 1 — Objeto (mais facil de montar):
```javascript
rrule: {
  freq: 'weekly',
  interval: 1,
  byweekday: ['mo', 'we', 'fr'],
  dtstart: '2026-01-06T09:00:00',
  until: '2026-12-31T23:59:59'
}
```

Forma 2 — String RRULE direta (mais simples se a string do banco ja esta no formato certo):
```javascript
rrule: 'DTSTART:20260106T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;INTERVAL=1'
```

**Recomendacao:** Use a Forma 2 (string) se sua rrule no banco ja esta no formato
`FREQ=WEEKLY;BYDAY=MO,WE,FR`. Basta concatenar o DTSTART:
```javascript
rrule: `DTSTART:${formatarParaIcal(event.start_event)}\nRRULE:${event.rrule}`
```

---

### PASSO 4 — Criar funcao helper para formatar DTSTART

**Arquivo:** `site/src/pages/Calendar.tsx` (ou em um utils se preferir)

**O que fazer:**
Criar uma funcao simples que converte a data ISO do banco para o formato iCalendar:

**Input:** `"2026-03-03T09:00:00.000Z"` (formato ISO do Supabase)
**Output:** `"20260303T090000Z"` (formato iCalendar sem tracos e dois-pontos)

**Logica:**
1. Pegar a string da data
2. Remover tracos, dois-pontos e pontos
3. Pegar os primeiros 16 caracteres + "Z"

**Exemplo:**
```
"2026-03-03T09:00:00.000Z"  →  "20260303T090000Z"
```

---

### PASSO 5 — Criar funcao helper para calcular duration

**Arquivo:** mesmo do passo 4

**O que fazer:**
O FullCalendar precisa saber a DURACAO do evento (nao o end), porque o end
muda a cada ocorrencia mas a duracao e sempre a mesma.

**Input:** `start_event` e `end_event` do banco
**Output:** string no formato `"HH:MM:SS"` ou `"HH:MM"`

**Logica:**
1. Calcular diferenca em milissegundos entre end e start
2. Converter para horas e minutos
3. Retornar no formato `"01:30"` (1 hora e 30 minutos)

**Exemplo:**
```
start: "2026-03-03T09:00:00"
end:   "2026-03-03T10:30:00"
→ duration: "01:30"
```

**Caso especial:** Se nao tiver end_event, usar duration padrao de `"01:00"` (1 hora).

---

### PASSO 6 — Tratar exdates (datas excluidas)

**Arquivo:** `site/src/pages/Calendar.tsx`

**O que fazer:**
O campo `exdates` no banco e um array de strings com datas que foram canceladas
(ex: o usuario cancelou a reuniao de uma segunda-feira especifica).

Passar esse array na propriedade `exdate` do evento:

```javascript
exdate: event.exdates || []
```

**Formato esperado:** Array de strings ISO ou iCalendar.
Se o banco guardar em ISO (`"2026-03-10T09:00:00Z"`), converter para iCalendar
usando a mesma funcao do passo 4.

Se o banco guardar como data simples (`"2026-03-10"`), pode passar direto.

---

### PASSO 7 — Diferenciar visualmente eventos recorrentes

**Arquivo:** `site/src/pages/Calendar.tsx`

**O que fazer (opcional mas recomendado):**

Adicionar um indicador visual para o usuario saber que aquele evento e recorrente.

Opcoes simples:
1. Adicionar um icone de "repeat" (↻) antes do titulo
2. Usar uma cor de fundo levemente diferente
3. Adicionar um badge "recorrente" no card do evento

**Sugestao mais simples:**
No titulo do evento, prefixar com "↻ " se for recorrente:
```javascript
title: event.is_recurring ? `↻ ${event.event_name}` : event.event_name
```

---

### PASSO 8 — Tratar clique em evento recorrente

**Arquivo:** `site/src/pages/Calendar.tsx`

**O que fazer:**
Quando o usuario clicar em uma ocorrencia de um evento recorrente,
o `handleEventClick` precisa saber:
- Qual e o evento original (para editar/deletar)
- Em qual data especifica o usuario clicou

O FullCalendar ja passa isso automaticamente:
- `info.event.extendedProps.originalEvent` — o registro original do banco
- `info.event.start` — a data especifica da ocorrencia clicada

**Comportamento esperado ao clicar:**
1. Abrir o modal de edicao com os dados do evento original
2. Mostrar a data da ocorrencia especifica

**Comportamento esperado ao deletar uma ocorrencia:**
Aqui tem 2 opcoes (igual ao Google Calendar):
- "Excluir este evento" — adicionar a data clicada ao array `exdates` no banco
- "Excluir todos os eventos" — deletar o registro inteiro

**Para a primeira versao:** implementar apenas "Excluir todos".
O "Excluir somente este" (exdates) pode vir numa segunda iteracao.

---

### PASSO 9 — Verificar se o FullAgenda.tsx tambem precisa de ajuste

**Arquivo:** `site/src/components/FullAgenda.tsx`

**O que fazer:**
Se esse componente tambem usa FullCalendar e mapeia eventos,
aplicar os mesmos ajustes dos passos 2, 3 e 7.

Verificar se ele tem seu proprio mapeamento de eventos ou se reutiliza o mesmo
do Calendar.tsx. Se reutilizar, nenhuma mudanca necessaria aqui.

---

### PASSO 10 — Testar

| # | Cenario | Resultado Esperado |
|---|---------|-------------------|
| 1 | Evento com `FREQ=DAILY` | Aparece todos os dias no calendario |
| 2 | Evento com `FREQ=WEEKLY;BYDAY=MO` | Aparece toda segunda-feira |
| 3 | Evento com `FREQ=WEEKLY;BYDAY=MO,WE,FR` | Aparece seg, qua, sex |
| 4 | Evento com `FREQ=MONTHLY;BYMONTHDAY=15` | Aparece todo dia 15 |
| 5 | Evento com `repeats_until` definido | Para de aparecer apos a data limite |
| 6 | Evento com `exdates` preenchido | Nao aparece nas datas excluidas |
| 7 | Evento normal (nao recorrente) | Funciona como antes, sem mudanca |
| 8 | Clicar em ocorrencia de evento recorrente | Abre modal com dados corretos |
| 9 | Navegar entre meses no calendario | Ocorrencias aparecem nos meses corretos |
| 10 | Visualizacao dia/semana/mes | Recorrencia funciona em todas as views |
| 11 | Evento com `FREQ=YEARLY` (aniversario) | Aparece uma vez por ano |
| 12 | Performance com muitos eventos recorrentes | Calendario nao trava |

---

## Resumo de Arquivos

| Arquivo | Acao | Dificuldade |
|---------|------|-------------|
| `site/package.json` | Adicionar @fullcalendar/rrule + rrule | Facil (npm install) |
| `site/src/pages/Calendar.tsx` | Registrar plugin + alterar mapeamento de eventos | Media |
| `site/src/components/FullAgenda.tsx` | Mesmo ajuste se tiver mapeamento proprio | Facil |

**Total de arquivos modificados:** 2-3
**Arquivos novos:** 0
**Mudancas no banco:** NENHUMA (banco ja esta pronto)
**Mudancas no backend:** NENHUMA

---

## Decisoes Arquiteturais

| Decisao | Escolha | Motivo |
|---------|---------|--------|
| Onde expandir rrule | Front-end (plugin FullCalendar) | Banco ja tem tudo, so falta visualizar |
| Lib de rrule | @fullcalendar/rrule + rrule | Plugin oficial, integrado nativamente |
| Formato da rrule | String iCalendar (Forma 2) | Banco ja guarda no formato certo |
| Delete de ocorrencia | Apenas "deletar todos" na v1 | Simplificar primeira entrega |
| Diferencial visual | Icone ↻ no titulo | Minimo esforco, maximo impacto |

---

## Complexidade Final

**Dificuldade: MEDIA-BAIXA**

Motivo: o trabalho pesado (schema, funcoes PostgreSQL, indices) ja esta feito.
So precisa conectar o front ao que ja existe. O plugin do FullCalendar faz o grosso
do trabalho de expansao.

**Estimativa de mudancas:**
- ~5 linhas para instalar e registrar plugin
- ~30 linhas para alterar o mapeamento de eventos
- ~10 linhas para funcoes helper (dtstart + duration)
- ~5 linhas para diferencial visual
- Total: ~50 linhas de codigo novo

---

*Plano criado por Aria (@architect) — arquitetando o futuro*
