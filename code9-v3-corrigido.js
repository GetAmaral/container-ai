// ============================================================
// Node: "Code9" — v3 CORRIGIDO
// ============================================================
// CORREÇÕES v3:
// 1. $items() → $() para compatibilidade Code v2
// 2. Extração de message_user com fallback robusto
//    (corrige bug: mensagem_principal saía como JSON bruto)
// 3. Histórico: 2 pares para classificador, 5 para AI Agent
// ============================================================

// ===== Helpers =====
function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function sanitize(text) {
  if (!text) return '';
  return String(text)
    .replace(/\s+/g, ' ')
    .trim();
}

// Extrai texto puro de uma entrada de debounce (string ou objeto)
function extractMessageText(v) {
  if (!v) return '';

  // Se for objeto direto: { message_user: "..." }
  if (typeof v === 'object' && v !== null) {
    return sanitize(v.message_user ?? v.text ?? '');
  }

  // Se for string, pode ser JSON simples ou duplo-stringificado
  if (typeof v === 'string') {
    const p = safeParse(v);

    // Parse retornou objeto → extrair message_user
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      return sanitize(p.message_user ?? p.text ?? '');
    }

    // Parse retornou string → pode ser duplo-stringificado
    if (typeof p === 'string') {
      const p2 = safeParse(p);
      if (p2 && typeof p2 === 'object') {
        return sanitize(p2.message_user ?? p2.text ?? '');
      }
      return sanitize(p);
    }

    // Parse falhou → usar string raw
    return sanitize(v);
  }

  return '';
}

// ================================
// 1) HISTORICO CONFIRMADO (IA <-> USER)
// ================================
let listaMemoria = [];

try {
  const memItems = $('Redis Chat Memory7').all();
  if (memItems?.length) {
    const redisItem = memItems[0].json;
    if (Array.isArray(redisItem?.Lista)) listaMemoria = redisItem.Lista;
  }
} catch (e) {
  listaMemoria = [];
}

const amostra = listaMemoria.slice(-20);

const eventos = amostra
  .map(raw => (typeof raw === 'string' ? safeParse(raw) : raw))
  .filter(Boolean)
  .map(e => ({
    type: e.type,
    content: sanitize(e.data?.content ?? '')
  }))
  .filter(e => e.content);

// Monta pares completos (para AI Agent — 5 pares)
const paresCompletos = [];
for (let i = eventos.length - 1; i >= 0 && paresCompletos.length < 5; i--) {
  if (eventos[i].type !== 'ai') continue;
  let j = i - 1;
  while (j >= 0 && eventos[j].type !== 'human') j--;
  if (j >= 0) {
    const userText = eventos[j].content;
    const aiParsed = safeParse(eventos[i].content);
    const respostaFinal = sanitize(aiParsed?.mensagem ?? eventos[i].content);
    paresCompletos.unshift({ pedido: userText, resposta: respostaFinal });
    i = j;
  }
}

// Pares reduzidos para o classificador (2 pares, SEM respostas da IA)
const paresClassificador = paresCompletos.slice(-2);

// ================================
// 2) MENSAGEM ATUAL (DEBOUNCE)
// ================================
let mensagemPrincipal = '';

try {
  const firstGetItems = $('firstGet').all();
  if (firstGetItems?.length) {
    const redisDebounce = firstGetItems[0].json;
    const listaDebounce = redisDebounce?.Lista ?? redisDebounce?.lista ?? [];
    const coletadas = [];

    if (Array.isArray(listaDebounce)) {
      for (const v of listaDebounce) {
        const texto = extractMessageText(v);
        if (texto) coletadas.push(texto);
      }
    } else if (typeof listaDebounce === 'string') {
      const texto = extractMessageText(listaDebounce);
      if (texto) coletadas.push(texto);
    } else if (typeof listaDebounce === 'object' && listaDebounce !== null) {
      const texto = extractMessageText(listaDebounce);
      if (texto) coletadas.push(texto);
    }

    mensagemPrincipal = coletadas.filter(Boolean).slice(-1)[0] ?? '';
  }
} catch (e) {
  mensagemPrincipal = '';
}

mensagemPrincipal = sanitize(mensagemPrincipal);

// ================================
// 3) TEXTO FINAL PARA CLASSIFICADOR (historico reduzido)
// ================================
let mensagemFinal = '';

if (paresClassificador.length) {
  mensagemFinal += 'Historico recente (apenas pedidos do usuario):\n';
  for (const p of paresClassificador) {
    mensagemFinal += `- "${p.pedido}"\n`;
  }
  mensagemFinal += '\n';
}

mensagemFinal += `Mensagem principal do usuario: ${mensagemPrincipal}`;

// ================================
// 4) SAIDA
// ================================
return {
  json: {
    mensagem_final: mensagemFinal,
    // Para o classificador: pares reduzidos
    confirmados_classificador: paresClassificador,
    // Para o AI Agent: pares completos (com respostas da IA)
    confirmados: paresCompletos,
    mensagem_principal: mensagemPrincipal
  }
};
