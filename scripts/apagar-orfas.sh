#!/usr/bin/env bash
# Apaga do conector as 17 sessões órfãs identificadas em 18/11/2026.
# São sessões que não existem mais no Backster e ficavam em laço de QR a
# cada 2 minutos. As 9 linhas de etiquetas em uso NÃO estão nesta lista.
#
# Uso:
#   CONNECTOR_URL=https://seu-conector  CONNECTOR_API_KEY=sua-chave  bash scripts/apagar-orfas.sh
set -euo pipefail
: "${CONNECTOR_URL:?defina CONNECTOR_URL (sem barra no final)}"
: "${CONNECTOR_API_KEY:?defina CONNECTOR_API_KEY}"

ORFAS=(
  org_50b07d5e_mtr63tj4
  org_50b07d5e_mtr6cims
  org_50b07d5e_mtr6nakp
  org_50b07d5e_mtr6ruzd
  org_50b07d5e_mttgo0ub
  org_50b07d5e_mttwlex5
  org_50b07d5e_mtuvd5c2
  org_50b07d5e_mtuvhs6p
  org_50b07d5e_mtuvi8zr
  org_50b07d5e_mtzsvaft
  org_50b07d5e_mtzsz852
  org_50b07d5e_mtzumkpr
  org_50b07d5e_mu13ldlo
  org_50b07d5e_mu13ljc8
  org_50b07d5e_muifs291
  org_50b07d5e_muifsnej
  org_50b07d5e_mum2bxwv
)

for id in "${ORFAS[@]}"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE \
    -H "X-Api-Key: ${CONNECTOR_API_KEY}" \
    "${CONNECTOR_URL}/sessions/${id}?wipe=true")
  echo "${id} -> HTTP ${code}"
  sleep 1
done

echo "Pronto. Confira o que sobrou:"
curl -s -H "X-Api-Key: ${CONNECTOR_API_KEY}" "${CONNECTOR_URL}/sessions"
echo
