# PLANO: Sistema de Log Logico — Total Assistente

**Versao:** 1.0
**Data:** 2026-02-25
**Autor:** @architect (Aria)
**Projeto:** Total Assistente — Painel Analise Total
**Repositorio:** https://github.com/luizporto-ai/analise-total

---

## 1. DIAGNOSTICO COMPLETO DO SISTEMA ATUAL

### 1.1 Arquitetura Geral

O painel "Analise Total" e uma SPA (Single Page Application) em React puro (sem JSX, usando `React.createElement`) servida via Nginx (Docker). O sistema usa **dois bancos Supabase separados**:

| Instancia | URL | Papel |
|-----------|-----|-------|
| **DB1** (Principal) | `hkzgttizcfklxfafkzfl.supabase.co` | Auth do painel, tabela `log_users_messages`, tabela `resposta_ia` |
| **DB2** (Gestao) | `ldbdtakddxznfridsarn.supabase.co` | Tabela `profiles`, tabela `subscriptions` (gestao de usuarios/planos) |

### 1.2 Tabelas Identificadas

#### DB1 — `log_users_messages` (Chat Log Principal)
Campos observados no codigo:
- `id` (PK)
- `user_id` (identificador unico do usuario)
- `user_name` (nome do usuario)
- `user_phone` (telefone WhatsApp)
- `user_email` (email)
- `user_message` (mensagem enviada pelo usuario)
- `ai_message` (resposta da IA)
- `timestamp` (data/hora da interacao)

**Observacao critica:** O `user_id` e o campo principal de agrupamento, porem o sistema tambem utiliza `user_name`, `user_phone` e `user_email` como atributos desnormalizados em cada registro de mensagem (nao ha tabela separada de usuarios no DB1).

#### DB1 — `resposta_ia` (Chat Total Experimental)
Campos observados:
- `id` (PK)
- `mensagem` (texto da resposta da IA)
- `created_at` (timestamp de criacao)

Tabela usada exclusivamente pelo componente "Chat Total" (interface experimental de chat direto com a IA).

#### DB2 — `profiles`
Campos observados:
- `id` (PK, mesmo UUID do auth)
- `name`
- `email`
- `phone`
- `plan_type` ('premium' | 'free')
- `plan_status` (boolean)
- `created_at`

#### DB2 — `subscriptions`
Campos observados:
- `user_id` (FK para profiles.id)
- `email`
- `current_plan`
- `plan_period`
- `status` ('active' | 'canceled')
- `start_date`
- `end_date`

### 1.3 Fluxo de Dados Atual

```
WhatsApp User
     |
     v
  n8n Webhook (http://n8n-*.sslip.io/webhook/...)
     |
     v
  Processamento IA
     |
     +---> DB1.log_users_messages (user_message + ai_message)
     +---> DB1.resposta_ia (mensagem da IA)
```

### 1.4 Views do Frontend (app.js)

| View | Componente | Funcao |
|------|-----------|--------|
| `menu` | `Menu` | Tela inicial com 3 botoes (Chat Total, User Log, Gerenciar Usuarios) |
| `chat` | `ChatTotal` | Interface experimental de chat direto com IA (envia para n8n, le de `resposta_ia`) |
| `log` | `UserLog` | Painel estilo WhatsApp: sidebar com lista de usuarios + area de chat com historico |
| `users` | `UserManager` | CRUD de usuarios no DB2 (profiles + subscriptions) |

### 1.5 Como as Mensagens sao Renderizadas (UserLog > ChatArea)

No componente `ChatArea` (linha 799-855 do app.js):
1. Faz query em `log_users_messages` filtrando por `user_id`
2. Ordena por `timestamp ASC`
3. Para cada mensagem, renderiza um **par** (user_message + ai_message) no mesmo bloco
4. Cada mensagem e um `<div class="message user">` ou `<div class="message ai">`

**Ponto de injecao identificado:** Os logs logicos devem se inserir ENTRE esses pares de mensagem, como um terceiro tipo visual: `<div class="message system">`.

### 1.6 Problema da Identificacao de Usuarios

O `user_id` no DB1 (`log_users_messages`) **NAO** e o mesmo UUID do DB2 (`profiles.id`). O DB1 recebe dados vindos do WhatsApp via n8n, onde o `user_id` parece ser derivado do numero de telefone ou um identificador do WhatsApp. O DB2 usa UUIDs do Supabase Auth.

**Correlacao possivel:** `DB1.user_phone` <-> `DB2.profiles.phone`

Isso significa que para vincular log logico a ambos os contextos, o campo `user_id` do log logico deve usar o **mesmo `user_id` do DB1** (que e o identificador primario do fluxo WhatsApp).

---

## 2. PROPOSTA: TABELA `log_logico`

### 2.1 Definicao da Tabela (SQL para Supabase DB1)

```sql
-- =============================================================
-- TABELA: log_logico
-- Descricao: Registra acoes do sistema vinculadas ao usuario.
--            Aparece visualmente inline no chat como mensagem
--            do sistema e pode ser consumida por dashboards.
-- =============================================================

CREATE TABLE public.log_logico (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id         TEXT NOT NULL,                    -- Mesmo user_id de log_users_messages
    acao            TEXT NOT NULL,                    -- Codigo da acao (ex: 'plano_ativado', 'audio_recebido')
    descricao       TEXT NOT NULL,                    -- Texto legivel para exibir no chat (ex: "Plano Premium ativado")
    categoria       TEXT NOT NULL DEFAULT 'sistema',  -- Agrupador: 'sistema', 'pagamento', 'ia', 'whatsapp', 'admin'
    severidade      TEXT NOT NULL DEFAULT 'info',     -- 'info', 'warning', 'error', 'success'
    metadata        JSONB DEFAULT '{}'::jsonb,        -- Dados extras estruturados (flexivel)
    visivel_chat    BOOLEAN NOT NULL DEFAULT true,    -- Se deve aparecer inline no chat do usuario
    created_at      TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Indices para performance
CREATE INDEX idx_log_logico_user_id ON public.log_logico (user_id);
CREATE INDEX idx_log_logico_created_at ON public.log_logico (created_at DESC);
CREATE INDEX idx_log_logico_categoria ON public.log_logico (categoria);
CREATE INDEX idx_log_logico_acao ON public.log_logico (acao);
CREATE INDEX idx_log_logico_user_time ON public.log_logico (user_id, created_at DESC);

-- RLS (Row Level Security)
ALTER TABLE public.log_logico ENABLE ROW LEVEL SECURITY;

-- Politica: usuarios autenticados do painel podem ler todos os logs
CREATE POLICY "Authenticated users can read log_logico"
    ON public.log_logico
    FOR SELECT
    TO authenticated
    USING (true);

-- Politica: insercao via service_role (n8n, backend) apenas
CREATE POLICY "Service role can insert log_logico"
    ON public.log_logico
    FOR INSERT
    TO service_role
    USING (true);

-- Permitir insercao tambem pelo anon key (para o Chat Total enviar logs)
CREATE POLICY "Anon can insert log_logico"
    ON public.log_logico
    FOR INSERT
    TO anon
    WITH CHECK (true);
```

### 2.2 Descricao dos Campos

| Campo | Tipo | Obrigatorio | Descricao |
|-------|------|-------------|-----------|
| `id` | UUID | Auto | Identificador unico do registro |
| `user_id` | TEXT | Sim | Mesmo `user_id` usado em `log_users_messages`. E o campo de vinculacao principal |
| `acao` | TEXT | Sim | Codigo padronizado da acao (snake_case). Ex: `plano_ativado`, `mensagem_erro`, `audio_processado` |
| `descricao` | TEXT | Sim | Texto human-readable que sera exibido no chat. Ex: "Plano Premium ativado com sucesso" |
| `categoria` | TEXT | Sim | Classificacao da acao para filtros e dashboards |
| `severidade` | TEXT | Sim | Nivel visual: `info` (azul/cinza), `success` (verde), `warning` (amarelo), `error` (vermelho) |
| `metadata` | JSONB | Nao | Dados extras flexiveis. Ex: `{"plano": "premium", "valor": 29.90, "metodo": "pix"}` |
| `visivel_chat` | BOOLEAN | Sim | Controla se este log aparece inline no chat ou e apenas para dashboards |
| `created_at` | TIMESTAMPTZ | Auto | Timestamp de criacao para ordenacao temporal |

### 2.3 Exemplos de Acoes Previstas

| acao | categoria | severidade | descricao (exemplo) |
|------|-----------|------------|---------------------|
| `plano_ativado` | pagamento | success | "Plano Premium ativado ate 25/02/2027" |
| `plano_expirado` | pagamento | warning | "Seu plano Premium expirou" |
| `pagamento_confirmado` | pagamento | success | "Pagamento de R$29,90 confirmado via PIX" |
| `audio_processado` | ia | info | "Audio de 0:45 transcrito com sucesso" |
| `mensagem_erro` | sistema | error | "Erro ao processar mensagem: timeout no servidor" |
| `ia_fallback` | ia | warning | "IA usou resposta alternativa (modelo principal indisponivel)" |
| `usuario_criado` | admin | info | "Novo usuario registrado no sistema" |
| `sessao_iniciada` | whatsapp | info | "Nova sessao de conversa iniciada" |
| `limite_atingido` | sistema | warning | "Limite de 100 mensagens/dia atingido" |
| `bot_reiniciado` | sistema | info | "Bot reiniciado pelo administrador" |

---

## 3. INJECAO VISUAL NO CHAT (Frontend)

### 3.1 Estrategia: Merge Temporal

O componente `ChatArea` atualmente faz:
```
1. Query: log_users_messages WHERE user_id = X ORDER BY timestamp ASC
2. Render: para cada item, mostra user_message + ai_message
```

A proposta e:
```
1. Query PARALELA:
   a) log_users_messages WHERE user_id = X ORDER BY timestamp ASC
   b) log_logico WHERE user_id = X AND visivel_chat = true ORDER BY created_at ASC
2. MERGE as duas listas por timestamp/created_at
3. Render:
   - Se item vem de log_users_messages -> renderiza par user/ai
   - Se item vem de log_logico -> renderiza como mensagem de sistema
```

### 3.2 Codigo: Funcao de Merge

```javascript
function mergeMessagesAndLogs(messages, logs) {
    const merged = [];

    // Normalizar mensagens
    messages.forEach(msg => {
        merged.push({
            type: 'message',
            timestamp: new Date(msg.timestamp).getTime(),
            data: msg
        });
    });

    // Normalizar logs
    logs.forEach(log => {
        merged.push({
            type: 'log',
            timestamp: new Date(log.created_at).getTime(),
            data: log
        });
    });

    // Ordenar por timestamp
    merged.sort((a, b) => a.timestamp - b.timestamp);

    return merged;
}
```

### 3.3 Codigo: Componente `SystemLogMessage`

```javascript
function SystemLogMessage({ log }) {
    const severityStyles = {
        info: {
            bg: 'hsla(210, 50%, 50%, 0.08)',
            border: 'hsla(210, 50%, 50%, 0.2)',
            color: 'hsla(210, 50%, 50%, 1)',
            icon: 'info'
        },
        success: {
            bg: 'hsla(var(--primary) / 0.08)',
            border: 'hsla(var(--primary) / 0.2)',
            color: 'hsl(var(--primary))',
            icon: 'check'
        },
        warning: {
            bg: 'hsla(45, 100%, 50%, 0.08)',
            border: 'hsla(45, 100%, 50%, 0.2)',
            color: 'hsla(45, 80%, 40%, 1)',
            icon: 'alert'
        },
        error: {
            bg: 'hsla(var(--negative) / 0.08)',
            border: 'hsla(var(--negative) / 0.2)',
            color: 'hsl(var(--negative))',
            icon: 'x'
        }
    };

    const style = severityStyles[log.severidade] || severityStyles.info;
    const time = new Date(log.created_at).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
    });

    return e('div', {
        className: 'message system-log',
        style: {
            alignSelf: 'center',
            maxWidth: '70%',
            padding: '12px 24px',
            borderRadius: '16px',
            background: style.bg,
            border: `1px solid ${style.border}`,
            textAlign: 'center',
            fontSize: '0.85rem',
            color: style.color,
            fontWeight: '600',
            margin: '8px auto'
        }
    },
        e('div', null, log.descricao),
        e('div', {
            style: {
                fontSize: '0.7rem',
                opacity: 0.6,
                marginTop: '6px',
                fontWeight: '500'
            }
        }, `${log.categoria.toUpperCase()} - ${time}`)
    );
}
```

### 3.4 Codigo: ChatArea Modificado

```javascript
function ChatArea({ userId, userName, onBack }) {
    const [messages, setMessages] = useState([]);
    const [systemLogs, setSystemLogs] = useState([]);
    const [loading, setLoading] = useState(false);
    const messagesEndRef = useRef(null);

    const scrollToBottom = (behavior = 'auto') => {
        messagesEndRef.current?.scrollIntoView({ behavior, block: 'end' });
    };

    useEffect(() => {
        if (messages.length > 0 || systemLogs.length > 0) scrollToBottom('auto');
    }, [messages, systemLogs, userId]);

    useEffect(() => { if (userId) fetchAllData(); }, [userId]);

    async function fetchAllData() {
        setLoading(true);
        try {
            // Queries em paralelo
            const [messagesResult, logsResult] = await Promise.all([
                supabase
                    .from('log_users_messages')
                    .select('*')
                    .eq('user_id', userId)
                    .order('timestamp', { ascending: true }),
                supabase
                    .from('log_logico')
                    .select('*')
                    .eq('user_id', userId)
                    .eq('visivel_chat', true)
                    .order('created_at', { ascending: true })
            ]);

            if (messagesResult.error) throw messagesResult.error;
            if (logsResult.error) throw logsResult.error;

            setMessages(messagesResult.data);
            setSystemLogs(logsResult.data);
        } catch (err) {
            console.error('Error fetching data:', err);
        } finally {
            setLoading(false);
        }
    }

    // Merge para renderizacao
    const mergedTimeline = mergeMessagesAndLogs(messages, systemLogs);

    return e('div', {
        className: 'chat-area main-content',
        style: { border: 'none', background: 'transparent' }
    },
        // Header (mesmo de antes)
        e('div', { className: 'chat-header', /* ... estilos existentes ... */ },
            // ... conteudo existente do header ...
        ),
        // Mensagens com logs injetados
        e('div', { className: 'chat-messages' },
            loading
                ? e('div', { style: { textAlign: 'center', padding: '20px', opacity: 0.5 } },
                    'Buscando historico...')
                : mergedTimeline.map((item, index) => {
                    if (item.type === 'log') {
                        return e(SystemLogMessage, {
                            key: `log_${item.data.id}`,
                            log: item.data
                        });
                    }
                    // Mensagem normal (par user/ai)
                    const msg = item.data;
                    return e('div', {
                        key: `msg_${msg.id}`,
                        className: 'message-group',
                        style: { display: 'flex', flexDirection: 'column', gap: '4px' }
                    },
                        e('div', { className: 'message user' },
                            e('div', null, msg.user_message),
                            e('div', { className: 'message-time', style: { color: 'rgba(255,255,255,0.7)' } },
                                new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
                        ),
                        e('div', { className: 'message ai glass-effect' },
                            e('div', null, msg.ai_message),
                            e('div', { className: 'message-time' },
                                new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
                        )
                    );
                }),
            e('div', { ref: messagesEndRef })
        )
    );
}
```

---

## 4. CSS ADICIONAL PARA O LOG DE SISTEMA

Adicionar ao `style.css`:

```css
/* System Log Messages (inline no chat) */
.message.system-log {
    align-self: center !important;
    max-width: 70%;
    padding: 12px 24px;
    border-radius: 16px;
    text-align: center;
    font-size: 0.85rem;
    font-weight: 600;
    margin: 12px auto;
    animation: slideUp 0.4s cubic-bezier(0.2, 0.8, 0.2, 1);
    box-shadow: none;
}

.message.system-log .log-category {
    font-size: 0.7rem;
    opacity: 0.6;
    margin-top: 6px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
}

/* Severidade: visual distinto */
.message.system-log.severity-info {
    background: hsla(210, 50%, 50%, 0.08);
    border: 1px solid hsla(210, 50%, 50%, 0.2);
    color: hsla(210, 50%, 50%, 1);
}

.message.system-log.severity-success {
    background: hsla(var(--primary) / 0.08);
    border: 1px solid hsla(var(--primary) / 0.2);
    color: hsl(var(--primary));
}

.message.system-log.severity-warning {
    background: hsla(45, 100%, 50%, 0.08);
    border: 1px solid hsla(45, 100%, 50%, 0.2);
    color: hsla(45, 80%, 40%, 1);
}

.message.system-log.severity-error {
    background: hsla(var(--negative) / 0.08);
    border: 1px solid hsla(var(--negative) / 0.2);
    color: hsl(var(--negative));
}

/* Dark mode adjustments */
[data-theme='dark'] .message.system-log.severity-info {
    background: hsla(210, 50%, 50%, 0.12);
    color: hsla(210, 60%, 70%, 1);
}

[data-theme='dark'] .message.system-log.severity-warning {
    background: hsla(45, 100%, 50%, 0.1);
    color: hsla(45, 100%, 65%, 1);
}
```

---

## 5. USO EM ESTATISTICAS / DASHBOARDS

### 5.1 Queries Uteis para Dashboards

```sql
-- Total de logs por categoria (ultimos 30 dias)
SELECT categoria, COUNT(*) as total
FROM log_logico
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY categoria
ORDER BY total DESC;

-- Erros por usuario (ranking de problemas)
SELECT user_id, COUNT(*) as erros
FROM log_logico
WHERE severidade = 'error'
  AND created_at >= NOW() - INTERVAL '7 days'
GROUP BY user_id
ORDER BY erros DESC
LIMIT 20;

-- Timeline de atividade do sistema (por hora)
SELECT
    DATE_TRUNC('hour', created_at) as hora,
    COUNT(*) as total,
    COUNT(*) FILTER (WHERE severidade = 'error') as erros,
    COUNT(*) FILTER (WHERE severidade = 'success') as sucessos
FROM log_logico
WHERE created_at >= NOW() - INTERVAL '24 hours'
GROUP BY hora
ORDER BY hora;

-- Acoes mais frequentes
SELECT acao, COUNT(*) as total
FROM log_logico
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY acao
ORDER BY total DESC;

-- Logs de um usuario especifico (para debug)
SELECT *
FROM log_logico
WHERE user_id = 'XXXXX'
ORDER BY created_at DESC
LIMIT 50;
```

### 5.2 Integracao Futura com Dashboard

O `dashboard.html` atualmente mostra dados estaticos/mockados. Os cards podem ser alimentados com queries reais:

- **Card "Usuarios Ativos":** `SELECT COUNT(DISTINCT user_id) FROM log_logico WHERE created_at >= NOW() - INTERVAL '24 hours'`
- **Card "Erros Recentes":** `SELECT COUNT(*) FROM log_logico WHERE severidade = 'error' AND created_at >= NOW() - INTERVAL '24 hours'`
- **Grafico "Desempenho Semanal":** Timeline de acoes por dia da semana

---

## 6. INTEGRACAO COM n8n (Onde os Logs sao Gerados)

### 6.1 Pontos de Emissao de Log no Fluxo n8n

O webhook n8n que processa mensagens do WhatsApp deve ser modificado para inserir registros em `log_logico` nos seguintes pontos:

| Momento | acao | severidade |
|---------|------|------------|
| Mensagem de texto recebida | `mensagem_recebida` | info |
| Audio recebido e transcrito | `audio_processado` | success |
| Audio falhou na transcricao | `audio_erro` | error |
| IA respondeu com sucesso | `ia_resposta_ok` | success |
| IA falhou (timeout/erro) | `ia_resposta_erro` | error |
| IA usou fallback | `ia_fallback` | warning |
| Usuario novo detectado | `usuario_novo` | info |
| Limite de mensagens atingido | `limite_atingido` | warning |

### 6.2 Exemplo de Insert via n8n (HTTP Request Node)

```json
{
    "method": "POST",
    "url": "https://hkzgttizcfklxfafkzfl.supabase.co/rest/v1/log_logico",
    "headers": {
        "apikey": "SUA_SUPABASE_KEY",
        "Authorization": "Bearer SUA_SUPABASE_KEY",
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
    },
    "body": {
        "user_id": "{{ $json.user_id }}",
        "acao": "audio_processado",
        "descricao": "Audio de {{ $json.duracao }} transcrito com sucesso",
        "categoria": "ia",
        "severidade": "success",
        "metadata": {
            "duracao": "{{ $json.duracao }}",
            "modelo": "whisper-v3",
            "tamanho_bytes": "{{ $json.tamanho }}"
        },
        "visivel_chat": true
    }
}
```

---

## 7. PLANO DE IMPLEMENTACAO (FASES)

### FASE 1 — Banco de Dados (Estimativa: 15 min)
- [ ] Executar SQL de criacao da tabela `log_logico` no Supabase DB1
- [ ] Criar indices
- [ ] Configurar RLS
- [ ] Inserir 3-5 registros de teste manualmente
- [ ] Validar que a query funciona via Supabase Dashboard

### FASE 2 — Frontend: Componente Visual (Estimativa: 1h)
- [ ] Criar funcao `mergeMessagesAndLogs()` no app.js
- [ ] Criar componente `SystemLogMessage` no app.js
- [ ] Modificar `ChatArea` para fazer query dupla (messages + logs)
- [ ] Modificar o render para usar o merge temporal
- [ ] Adicionar CSS de `.message.system-log` no style.css
- [ ] Testar com os registros de teste

### FASE 3 — Integracao n8n (Estimativa: 30 min)
- [ ] Adicionar nodes de INSERT em `log_logico` no workflow n8n
- [ ] Mapear os pontos de emissao (ver tabela na secao 6.1)
- [ ] Testar envio de mensagem e verificar se log aparece no chat

### FASE 4 — Realtime (Estimativa: 30 min)
- [ ] Adicionar subscription Supabase Realtime para `log_logico` no ChatArea
- [ ] Quando um novo log for inserido, injetar automaticamente no chat
- [ ] Testar fluxo end-to-end (WhatsApp -> n8n -> log_logico -> chat atualiza)

### FASE 5 — Dashboard de Estatisticas (Estimativa: 2h, futura)
- [ ] Criar nova view `stats` no app.js (ou nova aba na Navbar)
- [ ] Implementar cards com queries reais contra `log_logico`
- [ ] Graficos de erros/sucesso por periodo
- [ ] Filtros por categoria e severidade

---

## 8. MAPA DE ARQUIVOS AFETADOS

| Arquivo | Acao | Descricao |
|---------|------|-----------|
| **Supabase DB1** | CREATE TABLE | Criar tabela `log_logico` + indices + RLS |
| `/app.js` | MODIFICAR | Adicionar `SystemLogMessage`, `mergeMessagesAndLogs`, modificar `ChatArea` |
| `/style.css` | MODIFICAR | Adicionar estilos de `.message.system-log` e variantes de severidade |
| **n8n Workflow** | MODIFICAR | Adicionar nodes de INSERT em `log_logico` nos pontos estrategicos |
| `/coolify_upload/app.js` | MODIFICAR | Mesmo que app.js principal (versao de deploy) |

---

## 9. CONSIDERACOES TECNICAS

### 9.1 Sobre o user_id
O campo `user_id` em `log_logico` deve ser do tipo **TEXT** (nao UUID) porque o `user_id` no `log_users_messages` vem do fluxo WhatsApp/n8n e pode nao ser um UUID padrao do Supabase. Usar TEXT garante compatibilidade.

### 9.2 Sobre Performance
- O indice composto `(user_id, created_at DESC)` garante que a query do ChatArea (filtrar por user + ordenar por tempo) seja rapida
- A query de merge usa `Promise.all` para executar ambas em paralelo
- O campo `visivel_chat` permite que logs de sistema existam para estatisticas sem poluir o chat

### 9.3 Sobre Realtime
O Supabase Realtime ja esta sendo usado no `ChatTotal` (tabela `resposta_ia`). O mesmo padrao pode ser replicado para `log_logico` no `ChatArea`, adicionando um channel listener para INSERTs filtrados por `user_id`.

### 9.4 Sobre o metadata JSONB
O campo `metadata` e propositalmente flexivel (JSONB) para acomodar dados extras sem precisar alterar o schema. Exemplos:
- Log de pagamento: `{"valor": 29.90, "metodo": "pix", "gateway": "stripe"}`
- Log de audio: `{"duracao": "0:45", "modelo": "whisper-v3", "idioma": "pt-BR"}`
- Log de erro: `{"stack_trace": "...", "endpoint": "/webhook/...", "status_code": 500}`

---

## 10. PERGUNTAS PENDENTES PARA O USUARIO

Antes de iniciar a implementacao, preciso confirmar:

1. **Qual e o formato exato do `user_id` no `log_users_messages`?** E o numero de telefone WhatsApp (ex: "554391936205"), um UUID, ou outro formato? Isso e critico para o campo `user_id` do `log_logico`.

2. **A tabela `log_logico` deve ficar no DB1 (mesmo do log_users_messages) ou prefere um terceiro banco?** Recomendo DB1 por simplicidade e porque o join logico e com `log_users_messages`.

3. **Quais acoes sao prioridade na Fase 3 (n8n)?** A lista da secao 6.1 e uma sugestao completa, mas posso focar nas mais urgentes primeiro.

4. **O dashboard de estatisticas (Fase 5) deve ser uma nova view no app.js existente ou uma pagina separada (como o dashboard.html que ja existe)?** Posso integrar ao SPA principal com uma nova aba na Navbar.

5. **Voce quer que os logs antigos (anteriores a criacao da tabela) sejam retroativamente gerados, ou so a partir de agora?**

6. **Sobre visibilidade: todos os logs devem aparecer no chat por padrao, ou apenas categorias especificas?** A proposta atual usa `visivel_chat = true` como padrao, mas posso inverter para `false` se preferir que a maioria fique apenas nos dashboards.

---

*Documento gerado por @architect (Aria) — Total Assistente*
*Pronto para implementacao apos aprovacao das perguntas pendentes.*
