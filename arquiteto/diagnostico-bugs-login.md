# Diagnostico: Bugs no Sistema de Login

**Agente:** @architect (Aria)
**Projeto:** totalAssistente (totalassistente.com.br)
**Repo:** https://github.com/luizporto-ai/novo-site-testing
**Data:** 2026-02-23
**Status:** CRITICO — 3 bugs encontrados

---

## Resumo Rapido

Encontrei **3 bugs** no `Account.tsx`. O arquivo foi refatorado recentemente e
**deixou de usar os metodos seguros do AuthContext**, passando a chamar o Supabase
diretamente com parametros errados.

| # | Bug | Severidade | Arquivo | Linha |
|---|-----|-----------|---------|-------|
| 1 | Google OAuth redireciona para URL errada | CRITICO | Account.tsx | 76 |
| 2 | OTP enviado sem sessao 2FA (pula seguranca) | CRITICO | Account.tsx | 90 |
| 3 | Verificacao OTP usa type errado | CRITICO | Account.tsx | 143, 151 |

---

## BUG 1 — Google OAuth: Redirect URL errada

### Onde
`src/pages/Account.tsx` — linha 76

### O que esta errado
```typescript
// ERRADO (como esta)
redirectTo: `${window.location.origin}/dashboard`

// CERTO (como deveria ser)
redirectTo: `${window.location.origin}/auth/callback`
```

### Por que quebra
O `/dashboard` e rota protegida. Quando o Google redireciona de volta:
1. O token chega na URL do `/dashboard`
2. O `ProtectedRoute` verifica se tem sessao → NAO TEM (token nao foi processado)
3. Redireciona para `/conta` (login) → token perdido
4. Loop infinito, usuario nunca entra

### Como o AuthContext faz (correto)
```typescript
// AuthContext.tsx linha 723
redirectTo: `${window.location.origin}/auth/callback`  // ← correto
```
O `/auth/callback` (AuthCallback.tsx) processa o token, cria a sessao, e SO ENTAO vai para o dashboard.

### Correcao
Trocar `/dashboard` por `/auth/callback` na linha 76.

**OU MELHOR:** Usar o `signInWithGoogle()` do AuthContext em vez de chamar Supabase direto:
```typescript
const { signInWithGoogle } = useAuth();
// ...
const handleGoogleSignIn = async () => {
  await signInWithGoogle();
};
```

---

## BUG 2 — OTP enviado sem sessao 2FA (o principal)

### Onde
`src/pages/Account.tsx` — linha 87-108 (funcao `sendOtpCode`)

### O que esta errado
O Account.tsx chama `supabase.auth.signInWithOtp()` DIRETO, pulando todo o
sistema de seguranca 2FA que existe no AuthContext.

**O que o Account.tsx faz (ERRADO):**
```
1. Verifica se email existe (check-email-exists)
2. Chama supabase.auth.signInWithOtp() direto  ← PULA A SEGURANCA
3. Vai para tela de OTP
```

**O que o AuthContext faz (CORRETO):**
```
1. Valida credenciais com signInWithPassword()
2. Cria sessao 2FA server-side (create_2fa_session RPC)
3. Armazena token seguro no sessionStorage
4. Faz signOut() (limpa sessao parcial)
5. SO ENTAO chama signInWithOtp()
6. Vai para tela de OTP
```

### Por que o codigo de 6 digitos NAO CHEGA

O problema esta nesta sequencia do Account.tsx:

```typescript
// Account.tsx linhas 110-132
const handleEmailSubmit = async (e) => {
  const exists = await checkUserExists(email);  // Chama edge function
  if (exists) {
    await sendOtpCode(email, false);  // Chama signInWithOtp DIRETO
    setStep('otp');
  } else {
    setStep('not-found');
  }
};
```

**Possiveis razoes para o email nao chegar:**

1. **A edge function `check-email-exists` pode estar falhando/retornando false:**
   - Ela faz `listUsers()` SEM filtro e carrega TODOS os usuarios
   - Se o banco tem muitos usuarios, pode dar timeout
   - Se falha, retorna `false` (catch retorna false)
   - Usuario vai para "Conta nao encontrada" em vez de receber OTP
   - O usuario nem percebe que o erro esta aqui

2. **O Supabase pode estar rejeitando o OTP sem sessao 2FA:**
   - O AuthContext faz `signInWithPassword()` primeiro, depois `signOut()`, depois `signInWithOtp()`
   - O Account.tsx pula o password check e chama `signInWithOtp()` direto
   - Dependendo da config do Supabase, isso pode ser bloqueado

3. **Rate limiting pode estar bloqueando:**
   - O AuthContext usa rate limiting controlado
   - O Account.tsx nao usa rate limiting nenhum
   - Mas o Supabase tem rate limiting interno (4 emails por hora por padrao)
   - Se o usuario tentou varias vezes, pode estar bloqueado

### Correcao
O Account.tsx NAO deveria implementar o fluxo de login por conta propria.
Deveria usar os metodos do AuthContext que ja existem e funcionam:

- `signInWithEmail(email, password)` → para login com senha + 2FA
- `signInWithGoogle()` → para login Google
- `completeTwoFactor(code, email, token)` → para verificar OTP

**Problema:** O Account.tsx tem um fluxo diferente (so email, sem senha).
Se essa e a intencao (login SEM senha, so OTP), o fluxo precisa ser:

```
1. checkUserExists(email)
2. Se existe: chamar signInWithOtp() com os parametros corretos
3. Supabase envia o email
4. Usuario digita o codigo
5. verifyOtp() com type: 'email' (NAO 'signup' ou 'magiclink')
```

Mas se o AuthContext ja tem um fluxo 2FA (senha + OTP), entao talvez o Account.tsx
deveria pedir a senha tambem. Essa e uma decisao de produto.

---

## BUG 3 — Verificacao OTP usa type errado

### Onde
`src/pages/Account.tsx` — linhas 140-154 (funcao `handleOtpSubmit`)

### O que esta errado
```typescript
// Account.tsx — ERRADO
// Tentativa 1: type 'signup'
const { error } = await supabase.auth.verifyOtp({
  email: email,
  token: otpCode,
  type: 'signup'       // ← ERRADO
});

// Tentativa 2 (fallback): type 'magiclink'
const { error: loginError } = await supabase.auth.verifyOtp({
  email: email,
  token: otpCode,
  type: 'magiclink'    // ← ERRADO
});
```

### O type correto
O `signInWithOtp()` envia um codigo do tipo `email`.
A verificacao PRECISA usar o mesmo tipo:

```typescript
// AuthContext.tsx linha 489-493 — CORRETO
const { error: verifyError } = await supabase.auth.verifyOtp({
  email,
  token: code,
  type: 'email',       // ← CORRETO
});
```

### Explicacao dos types do Supabase
| Metodo de envio | Type para verifyOtp |
|-----------------|---------------------|
| `signInWithOtp()` | `'email'` |
| `signUp()` | `'signup'` |
| Magic Link (link no email) | `'magiclink'` |

O Account.tsx envia com `signInWithOtp()` mas verifica com `signup` e `magiclink`.
Nunca vai bater. Mesmo que o codigo de 6 digitos chegue, a verificacao vai falhar.

### Correcao
Trocar ambas as tentativas por uma unica com `type: 'email'`:
```typescript
const { error } = await supabase.auth.verifyOtp({
  email: email.toLowerCase().trim(),
  token: otpCode,
  type: 'email'
});
```

---

## Comparacao: Account.tsx vs AuthContext.tsx

| Etapa | Account.tsx (QUEBRADO) | AuthContext.tsx (FUNCIONA) |
|-------|----------------------|--------------------------|
| Google OAuth redirect | `/dashboard` ❌ | `/auth/callback` ✅ |
| Verifica credenciais | Nao ❌ | `signInWithPassword()` ✅ |
| Cria sessao 2FA | Nao ❌ | `create_2fa_session` RPC ✅ |
| Limpa sessao antes do OTP | Nao ❌ | `signOut()` ✅ |
| Envia OTP | `signInWithOtp()` direto | `signInWithOtp()` apos preparo ✅ |
| Verifica OTP type | `'signup'` e `'magiclink'` ❌ | `'email'` ✅ |
| Valida sessao 2FA no verify | Nao ❌ | `verify_2fa_session` RPC ✅ |
| Rate limiting | Nenhum ❌ | Controlado ✅ |

---

## Passo a Passo para Corrigir

### PASSO 1 — Corrigir Google OAuth redirect

**Arquivo:** `src/pages/Account.tsx` — linha 76

**Trocar:**
```typescript
redirectTo: `${window.location.origin}/dashboard`,
```

**Por:**
```typescript
redirectTo: `${window.location.origin}/auth/callback`,
```

---

### PASSO 2 — Corrigir verificacao OTP type

**Arquivo:** `src/pages/Account.tsx` — linhas 140-154

**Trocar todo o bloco de verificacao** (as duas tentativas com 'signup' e 'magiclink') por uma unica chamada:

```typescript
const { error } = await supabase.auth.verifyOtp({
  email: email.toLowerCase().trim(),
  token: otpCode,
  type: 'email'
});

if (error) throw error;
```

Remover a logica de fallback ('magiclink'). Com o type correto, nao precisa de fallback.

---

### PASSO 3 — Investigar se check-email-exists esta retornando false

**Como testar:**
1. Abrir o DevTools do navegador (F12)
2. Ir na aba Network
3. Digitar o email e clicar "Continuar com E-mail"
4. Procurar a chamada para `check-email-exists`
5. Ver a resposta: `{ exists: true }` ou `{ exists: false }`?

**Se retornar false para um email que existe:**
A edge function `check-email-exists` tem um problema de performance:
- Ela chama `listUsers()` SEM filtro (carrega TODOS os usuarios)
- Se tiver muitos usuarios, pode dar timeout
- Se der erro, o catch retorna `false`

**Correcao recomendada para a edge function:**
Trocar a busca por todos os usuarios por uma busca direta na tabela `auth.users`
ou usar `getUserByEmail()` se disponivel na versao do Supabase.

---

### PASSO 4 — Testar o fluxo completo

| # | Cenario | Resultado Esperado |
|---|---------|-------------------|
| 1 | Login Google | Redireciona para /auth/callback, processa token, vai para dashboard |
| 2 | Email existente → OTP | Codigo de 6 digitos chega no email |
| 3 | Digitar codigo correto | Verificacao com type 'email' funciona, entra no dashboard |
| 4 | Email inexistente | Mostra "Conta nao encontrada" |
| 5 | Novo usuario → nome → OTP | Codigo chega, consegue criar conta |
| 6 | Codigo errado | Mensagem de erro clara |
| 7 | Reenviar codigo | Novo codigo chega |

---

## Recomendacao Arquitetural

O Account.tsx deveria **parar de reimplementar a logica de auth** e usar os metodos
do AuthContext. Ter dois caminhos de login diferentes (Account.tsx direto vs
AuthContext) e uma receita para bugs.

**Opcao A (recomendada):** Refatorar Account.tsx para usar `useAuth()` hooks
**Opcao B (rapida):** Corrigir os 3 bugs pontuais e manter o fluxo separado

A Opcao A e mais segura porque o AuthContext ja tem rate limiting, sessoes 2FA
server-side e audit logging. O Account.tsx nao tem nada disso.

---

## Arquivos Afetados na Correcao

| Arquivo | O que fazer | Dificuldade |
|---------|-------------|-------------|
| `src/pages/Account.tsx` (linha 76) | Trocar redirect URL | Facil (1 linha) |
| `src/pages/Account.tsx` (linhas 140-154) | Trocar type para 'email' | Facil (3 linhas) |
| `supabase/functions/check-email-exists/index.ts` | Investigar e otimizar busca | Media |

---

*Diagnostico criado por Aria (@architect) — arquitetando o futuro*
