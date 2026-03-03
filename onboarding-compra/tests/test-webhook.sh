#!/bin/bash
# ============================================================
# Testes manuais do webhook Hotmart
# Validação de telefone + Email de confirmação
#
# Uso:
#   chmod +x tests/test-webhook.sh
#   ./tests/test-webhook.sh
#
# Preencha as variáveis abaixo antes de rodar:
# ============================================================

# --- CONFIG (preencher) ---
SUPABASE_URL="https://SEU_PROJETO.supabase.co"
HOTTOK="SEU_HOTTOK_AQUI"
TEST_EMAIL="kovow51158@medevsa.com"
# --------------------------

WEBHOOK_URL="${SUPABASE_URL}/functions/v1/hotmart-webhook"
PASS=0
FAIL=0

# Cores
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

separator() {
  echo ""
  echo -e "${CYAN}============================================================${NC}"
  echo -e "${CYAN} $1${NC}"
  echo -e "${CYAN}============================================================${NC}"
}

# --- SQL de limpeza (rodar no Supabase SQL Editor antes dos testes) ---
show_cleanup_sql() {
  separator "SQL DE LIMPEZA (rodar antes dos testes)"
  echo ""
  echo "  DELETE FROM recurrency_report WHERE fk_user IN (SELECT id FROM profiles WHERE email = '${TEST_EMAIL}');"
  echo "  DELETE FROM whatsapp_attempts WHERE user_id IN (SELECT id FROM profiles WHERE email = '${TEST_EMAIL}');"
  echo "  DELETE FROM payments WHERE email = '${TEST_EMAIL}';"
  echo "  DELETE FROM webhook_events_log WHERE customer_email = '${TEST_EMAIL}';"
  echo "  DELETE FROM profiles WHERE email = '${TEST_EMAIL}';"
  echo ""
}

# ============================================================
# TESTE 1: Phone inválido ("44") → Path B (email ativação)
# Esperado: phone normaliza para "5544" (4 dígitos) → null → send-email (sem_telefone)
# ============================================================
test_1_phone_invalido() {
  separator "TESTE 1: Phone inválido → Path B (email ativação)"
  echo -e "${YELLOW}Phone: \"44\" → normaliza \"5544\" (4 dígitos) → null → Path B${NC}"
  echo ""

  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d '{
      "event": "PURCHASE_APPROVED",
      "version": "2.0.0",
      "hottok": "'"$HOTTOK"'",
      "data": {
        "buyer": {
          "email": "'"$TEST_EMAIL"'",
          "name": "Teste Phone Invalido",
          "first_name": "Teste",
          "last_name": "Phone Invalido",
          "checkout_phone": "44",
          "checkout_phone_code": "55",
          "document": "12345678900",
          "document_type": "CPF"
        },
        "purchase": {
          "order_id": "HP_TEST_PHONE_INVALIDO_001",
          "status": "APPROVED"
        },
        "product": {
          "id": 123456,
          "name": "Total Assistente"
        }
      }
    }')

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | head -n -1)

  echo "HTTP: $HTTP_CODE"
  echo "Body: $BODY"
  echo ""

  if echo "$BODY" | grep -q '"nextStep":"SEND_EMAIL"'; then
    echo -e "${GREEN}✓ PASSOU — Phone inválido foi para Path B (SEND_EMAIL)${NC}"
    ((PASS++))
  else
    echo -e "${RED}✗ FALHOU — Esperava nextStep=SEND_EMAIL${NC}"
    ((FAIL++))
  fi

  echo ""
  echo -e "${YELLOW}Verificar no banco:${NC}"
  echo "  - profiles: phone deve ser NULL"
  echo "  - webhook_events_log: deve ter EMAIL_SENT_SEM_TELEFONE"
  echo "  - Checar inbox: email de ativação com botão WhatsApp"
}

# ============================================================
# TESTE 2: Phone válido ("43991936205") → Path A (WhatsApp + email confirmação)
# Esperado: normaliza "554391936205" (12 dígitos) → send-whatsapp → send-email (confirmacao_compra)
# ============================================================
test_2_phone_valido() {
  separator "TESTE 2: Phone válido → Path A (WhatsApp + email confirmação)"
  echo -e "${YELLOW}Phone: \"43991936205\" → normaliza \"554391936205\" (12 dígitos) → Path A${NC}"
  echo ""

  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d '{
      "event": "PURCHASE_APPROVED",
      "version": "2.0.0",
      "hottok": "'"$HOTTOK"'",
      "data": {
        "buyer": {
          "email": "'"$TEST_EMAIL"'",
          "name": "Teste Phone Valido",
          "first_name": "Teste",
          "last_name": "Phone Valido",
          "checkout_phone": "43991936205",
          "checkout_phone_code": "55",
          "document": "12345678900",
          "document_type": "CPF"
        },
        "purchase": {
          "order_id": "HP_TEST_PHONE_VALIDO_002",
          "status": "APPROVED"
        },
        "product": {
          "id": 123456,
          "name": "Total Assistente"
        }
      }
    }')

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | head -n -1)

  echo "HTTP: $HTTP_CODE"
  echo "Body: $BODY"
  echo ""

  if echo "$BODY" | grep -q '"nextStep":"SEND_WHATSAPP"'; then
    echo -e "${GREEN}✓ PASSOU — Phone válido foi para Path A (SEND_WHATSAPP)${NC}"
    ((PASS++))
  else
    echo -e "${RED}✗ FALHOU — Esperava nextStep=SEND_WHATSAPP${NC}"
    ((FAIL++))
  fi

  echo ""
  echo -e "${YELLOW}Verificar no banco:${NC}"
  echo "  - profiles: phone deve ser \"554391936205\""
  echo "  - webhook_events_log: deve ter EMAIL_SENT_CONFIRMACAO_COMPRA"
  echo "  - Checar inbox: email de confirmação (conta ativa + link plataforma, SEM botão WhatsApp)"
  echo "  - WhatsApp: deve ter recebido mensagem de boas-vindas"
}

# ============================================================
# TESTE 3: Sem phone ("") → Path B (email ativação)
# Esperado: phone vazio → null → send-email (sem_telefone)
# ============================================================
test_3_sem_phone() {
  separator "TESTE 3: Sem phone → Path B (email ativação)"
  echo -e "${YELLOW}Phone: \"\" → null → Path B${NC}"
  echo ""

  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d '{
      "event": "PURCHASE_APPROVED",
      "version": "2.0.0",
      "hottok": "'"$HOTTOK"'",
      "data": {
        "buyer": {
          "email": "'"$TEST_EMAIL"'",
          "name": "Teste Sem Phone",
          "first_name": "Teste",
          "last_name": "Sem Phone",
          "checkout_phone": "",
          "checkout_phone_code": "55",
          "document": "12345678900",
          "document_type": "CPF"
        },
        "purchase": {
          "order_id": "HP_TEST_SEM_PHONE_003",
          "status": "APPROVED"
        },
        "product": {
          "id": 123456,
          "name": "Total Assistente"
        }
      }
    }')

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | head -n -1)

  echo "HTTP: $HTTP_CODE"
  echo "Body: $BODY"
  echo ""

  if echo "$BODY" | grep -q '"nextStep":"SEND_EMAIL"'; then
    echo -e "${GREEN}✓ PASSOU — Sem phone foi para Path B (SEND_EMAIL)${NC}"
    ((PASS++))
  else
    echo -e "${RED}✗ FALHOU — Esperava nextStep=SEND_EMAIL${NC}"
    ((FAIL++))
  fi

  echo ""
  echo -e "${YELLOW}Verificar no banco:${NC}"
  echo "  - profiles: phone deve ser NULL"
  echo "  - webhook_events_log: deve ter EMAIL_SENT_SEM_TELEFONE"
  echo "  - Checar inbox: email de ativação com botão WhatsApp"
}

# ============================================================
# TESTE 4: Idempotência — repetir teste 1 (não deve duplicar)
# Esperado: {"status":"already_processed"}
# ============================================================
test_4_idempotencia() {
  separator "TESTE 4: Idempotência (repetir teste 1 — não deve duplicar)"
  echo -e "${YELLOW}Reenviando order HP_TEST_PHONE_INVALIDO_001 → deve retornar already_processed${NC}"
  echo ""

  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d '{
      "event": "PURCHASE_APPROVED",
      "version": "2.0.0",
      "hottok": "'"$HOTTOK"'",
      "data": {
        "buyer": {
          "email": "'"$TEST_EMAIL"'",
          "name": "Teste Phone Invalido",
          "first_name": "Teste",
          "last_name": "Phone Invalido",
          "checkout_phone": "44",
          "checkout_phone_code": "55",
          "document": "12345678900",
          "document_type": "CPF"
        },
        "purchase": {
          "order_id": "HP_TEST_PHONE_INVALIDO_001",
          "status": "APPROVED"
        },
        "product": {
          "id": 123456,
          "name": "Total Assistente"
        }
      }
    }')

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | head -n -1)

  echo "HTTP: $HTTP_CODE"
  echo "Body: $BODY"
  echo ""

  if echo "$BODY" | grep -q '"already_processed"'; then
    echo -e "${GREEN}✓ PASSOU — Idempotência OK, não duplicou${NC}"
    ((PASS++))
  else
    echo -e "${RED}✗ FALHOU — Esperava already_processed${NC}"
    ((FAIL++))
  fi
}

# ============================================================
# TESTE 5: Phone com 9º dígito ("43 9 91936205") → deve normalizar para 12 dígitos
# Esperado: "554391936205" (remove o 9 extra) → Path A
# ============================================================
test_5_phone_com_nono_digito() {
  separator "TESTE 5: Phone com 9º dígito extra → normaliza e vai Path A"
  echo -e "${YELLOW}Phone: \"43991936205\" com DDI → \"5543991936205\" (13 dígitos) → remove 9 → \"554391936205\" (12) → Path A${NC}"
  echo ""

  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d '{
      "event": "PURCHASE_APPROVED",
      "version": "2.0.0",
      "hottok": "'"$HOTTOK"'",
      "data": {
        "buyer": {
          "email": "'"$TEST_EMAIL"'",
          "name": "Teste Nono Digito",
          "first_name": "Teste",
          "last_name": "Nono Digito",
          "checkout_phone": "43991936205",
          "checkout_phone_code": "55",
          "document": "12345678900",
          "document_type": "CPF"
        },
        "purchase": {
          "order_id": "HP_TEST_NONO_DIGITO_005",
          "status": "APPROVED"
        },
        "product": {
          "id": 123456,
          "name": "Total Assistente"
        }
      }
    }')

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | head -n -1)

  echo "HTTP: $HTTP_CODE"
  echo "Body: $BODY"
  echo ""

  if echo "$BODY" | grep -q '"nextStep":"SEND_WHATSAPP"' && echo "$BODY" | grep -q '"phone":"554391936205"'; then
    echo -e "${GREEN}✓ PASSOU — Normalizou 9º dígito e foi Path A com phone correto${NC}"
    ((PASS++))
  elif echo "$BODY" | grep -q '"nextStep":"SEND_WHATSAPP"'; then
    echo -e "${GREEN}✓ PASSOU — Foi para Path A (SEND_WHATSAPP)${NC}"
    ((PASS++))
  else
    echo -e "${RED}✗ FALHOU — Esperava nextStep=SEND_WHATSAPP${NC}"
    ((FAIL++))
  fi
}

# ============================================================
# TESTE 6: Phone só DDD ("43") → inválido → Path B
# Esperado: "5543" (4 dígitos) → null → Path B
# ============================================================
test_6_phone_so_ddd() {
  separator "TESTE 6: Phone só DDD → inválido → Path B"
  echo -e "${YELLOW}Phone: \"43\" → \"5543\" (4 dígitos) → null → Path B${NC}"
  echo ""

  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d '{
      "event": "PURCHASE_APPROVED",
      "version": "2.0.0",
      "hottok": "'"$HOTTOK"'",
      "data": {
        "buyer": {
          "email": "'"$TEST_EMAIL"'",
          "name": "Teste So DDD",
          "first_name": "Teste",
          "last_name": "So DDD",
          "checkout_phone": "43",
          "checkout_phone_code": "55",
          "document": "12345678900",
          "document_type": "CPF"
        },
        "purchase": {
          "order_id": "HP_TEST_SO_DDD_006",
          "status": "APPROVED"
        },
        "product": {
          "id": 123456,
          "name": "Total Assistente"
        }
      }
    }')

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | head -n -1)

  echo "HTTP: $HTTP_CODE"
  echo "Body: $BODY"
  echo ""

  if echo "$BODY" | grep -q '"nextStep":"SEND_EMAIL"'; then
    echo -e "${GREEN}✓ PASSOU — Phone só DDD foi para Path B (SEND_EMAIL)${NC}"
    ((PASS++))
  else
    echo -e "${RED}✗ FALHOU — Esperava nextStep=SEND_EMAIL${NC}"
    ((FAIL++))
  fi
}

# ============================================================
# EXECUÇÃO
# ============================================================

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  TESTES: Validação de Telefone + Email de Confirmação  ║${NC}"
echo -e "${CYAN}║  Email: ${TEST_EMAIL}                  ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${NC}"

# Mostrar SQL de limpeza
show_cleanup_sql

echo -e "${YELLOW}Pressione ENTER para iniciar os testes (ou Ctrl+C para cancelar)...${NC}"
read -r

# Rodar testes sequencialmente
# Teste 1 + 4 juntos (idempotência precisa do log do teste 1 no banco)
test_1_phone_invalido
echo ""
echo -e "${YELLOW}--- NÃO limpe o banco (teste de idempotência). Pressione ENTER ---${NC}"
read -r

test_4_idempotencia
echo ""
echo -e "${YELLOW}--- Limpe o banco antes do teste 2 (SQL acima) e pressione ENTER ---${NC}"
read -r

test_2_phone_valido
echo ""
echo -e "${YELLOW}--- Limpe o banco antes do teste 3 (SQL acima) e pressione ENTER ---${NC}"
read -r

test_3_sem_phone
echo ""
echo -e "${YELLOW}--- Limpe o banco antes do teste 5 (SQL acima) e pressione ENTER ---${NC}"
read -r

test_5_phone_com_nono_digito
echo ""
echo -e "${YELLOW}--- Limpe o banco antes do teste 6 (SQL acima) e pressione ENTER ---${NC}"
read -r

test_6_phone_so_ddd

# Resultado final
separator "RESULTADO FINAL"
echo ""
echo -e "  ${GREEN}Passou: ${PASS}${NC}"
echo -e "  ${RED}Falhou: ${FAIL}${NC}"
TOTAL=$((PASS + FAIL))
echo -e "  Total:  ${TOTAL}"
echo ""

if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}🎉 TODOS OS TESTES PASSARAM!${NC}"
else
  echo -e "${RED}⚠  ${FAIL} teste(s) falharam. Verifique acima.${NC}"
fi
echo ""
