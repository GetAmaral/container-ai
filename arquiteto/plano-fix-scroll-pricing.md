# Plano: Corrigir Scroll para #pricing (Planos)

**Agente:** @architect (Aria)
**Projeto:** totalAssistente (totalassistente.com.br)
**Repo:** https://github.com/GetAmaral/totalAssistente
**Data:** 2026-02-23
**Status:** Aprovado para implementacao

---

## Problema

O link `/#pricing` (menu "PLANOS" e botao "Quero um assistente") nem sempre leva o usuario ate a secao de planos. As vezes a pagina carrega mas nao faz o scroll, ou para no meio do caminho.

---

## Causa Raiz

O arquivo `ScrollToTop.tsx` tem um `setTimeout` com delay de **0ms**:

```typescript
// ScrollToTop.tsx (linha 13-15)
setTimeout(() => {
  element.scrollIntoView({ behavior: 'smooth' });
}, 0);
```

**Por que falha:**
- 0ms nao e tempo suficiente para a pagina renderizar completamente
- O `PricingSection` tem imagens, cards e animacoes que demoram para carregar
- Quando o componente ainda nao tem altura final, o `scrollIntoView` calcula a posicao errada
- Em conexoes lentas ou mobile, o problema piora porque o layout "pula" apos o scroll
- Se o usuario ja esta na home (mesma rota), o `useEffect` nao dispara de novo porque `pathname` e `hash` nao mudam

---

## Arquivos Envolvidos

| Arquivo | Caminho | O que fazer |
|---------|---------|-------------|
| ScrollToTop.tsx | `site/src/components/ScrollToTop.tsx` | Reescrever logica de scroll |
| Header.tsx | `site/src/components/Header.tsx` | Ajustar links para funcionar na mesma pagina |
| HeroSection.tsx | `site/src/components/HeroSection.tsx` | Mesmo ajuste do link /#pricing |

---

## Passo a Passo

### PASSO 1 — Reescrever o ScrollToTop.tsx

**Arquivo:** `site/src/components/ScrollToTop.tsx`

**Substituir TODO o conteudo por:**

A nova logica deve fazer o seguinte:

1. Quando detectar um hash na URL (ex: `#pricing`):
   - Tentar encontrar o elemento com aquele `id`
   - Se nao encontrar de primeira, **tentar de novo a cada 100ms ate 2 segundos** (maximo 20 tentativas)
   - Isso garante que mesmo se o componente ainda nao renderizou, vai esperar ate ele aparecer

2. Quando encontrar o elemento:
   - Usar `element.scrollIntoView({ behavior: 'smooth', block: 'start' })`
   - Adicionar `block: 'start'` para garantir que a secao fique no topo da tela

3. Quando nao tiver hash:
   - Fazer `window.scrollTo({ top: 0, behavior: 'smooth' })` (isso ja funciona, manter)

**Codigo da nova logica (useEffect interno):**

```
Se tem hash:
  extrair o id (remover o #)
  criar um intervalo que roda a cada 100ms
  a cada tick:
    tentar document.getElementById(id)
    se encontrou:
      scrollIntoView com behavior smooth e block start
      limpar o intervalo
    se ja tentou 20 vezes (2 segundos):
      limpar o intervalo (desistir graciosamente)

  retornar cleanup que limpa o intervalo

Se nao tem hash:
  scrollTo topo
```

**Por que isso resolve:**
- O retry garante que vai esperar o componente renderizar
- 2 segundos de timeout e mais que suficiente para qualquer pagina
- O `block: 'start'` posiciona a secao corretamente no topo
- O cleanup evita memory leaks se o usuario navegar antes do scroll

---

### PASSO 2 — Ajustar links na Header.tsx para funcionar na mesma pagina

**Arquivo:** `site/src/components/Header.tsx`

**Problema adicional:**
Quando o usuario ja esta na pagina inicial e clica em "PLANOS", o React Router ve que a rota e a mesma (`/`) e o hash e o mesmo (`#pricing`), entao o `useEffect` do ScrollToTop nao dispara de novo.

**O que fazer:**

Nos links de navegacao que apontam para ancoras (`/#pricing` e `/#how-it-works`), adicionar logica de click:

1. Verificar se o usuario ja esta na pagina inicial (pathname === "/")
2. Se estiver, em vez de usar o `<Link>`, fazer o scroll manualmente:
   - `e.preventDefault()`
   - `document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth', block: 'start' })`
3. Se nao estiver na home, deixar o `<Link>` funcionar normal (navega para `/` e o ScrollToTop cuida)

**Onde aplicar:**
- Nos links do desktop (linha 48-54)
- Nos links do mobile menu (linha 81-89) — aqui tambem fechar o menu apos clicar

**Logica para cada link de ancora:**

```
onClick do link:
  se o link comeca com "/#" E pathname atual === "/":
    preventDefault()
    extrair o id do hash
    scrollIntoView no elemento
    se for mobile: fechar menu
  senao:
    deixar o Link funcionar normalmente
```

---

### PASSO 3 — Mesmo ajuste no HeroSection.tsx

**Arquivo:** `site/src/components/HeroSection.tsx`

**Linha afetada:** Botao "Quero um assistente" que aponta para `/#pricing`

**O que fazer:**
Mesmo tratamento do passo 2. Se o usuario ja esta na home, ao clicar no botao:
- `e.preventDefault()`
- `document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth', block: 'start' })`

Se nao esta na home, deixar o `<Link to="/#pricing">` funcionar normal.

---

### PASSO 4 — Testar

| # | Cenario | Resultado Esperado |
|---|---------|-------------------|
| 1 | Acessar `/#pricing` direto pela URL (primeiro acesso) | Scroll suave ate a secao de planos |
| 2 | Estar na home e clicar em "PLANOS" no menu | Scroll suave ate pricing |
| 3 | Estar na home e clicar "PLANOS" de novo (ja esta la) | Scroll de novo para pricing |
| 4 | Estar no `/dashboard` e clicar "PLANOS" | Navega para home + scroll ate pricing |
| 5 | Clicar "Quero um assistente" no hero | Scroll suave ate pricing |
| 6 | Testar em mobile (menu hamburger) | Scroll funciona + menu fecha |
| 7 | Testar com internet lenta (3G throttle no DevTools) | Scroll espera a secao carregar |
| 8 | Clicar "COMO FUNCIONA" no menu | Scroll funciona para #how-it-works |
| 9 | Acessar `/#how-it-works` direto pela URL | Scroll correto para a secao |

---

## Resumo de Mudancas

| Arquivo | Acao | Dificuldade |
|---------|------|-------------|
| `site/src/components/ScrollToTop.tsx` | Reescrever com retry + block start | Facil |
| `site/src/components/Header.tsx` | Adicionar onClick nos links de ancora | Facil |
| `site/src/components/HeroSection.tsx` | Adicionar onClick no botao CTA | Facil |

**Total de arquivos:** 3
**Arquivos novos:** 0
**Mudancas no backend:** Nenhuma
**Risco:** Baixo (so muda comportamento de scroll)

---

## Nota Tecnica

A URL que voce mencionou `http://localhost:8082/#pricing` tem um `#` antes de `pricing` que pode parecer hash routing, mas o projeto usa **BrowserRouter** (roteamento por URL, nao por hash). O formato correto dos links no projeto e `/#pricing` onde:
- `/` = rota da home
- `#pricing` = ancora para a secao

O dev server roda na porta **8081** (definido no package.json), nao 8082. Confirme se a porta que voce acessa esta correta.

---

*Plano criado por Aria (@architect) — arquitetando o futuro*
