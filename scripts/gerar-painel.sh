#!/usr/bin/env bash
# Regenera src/panelHtml.ts a partir de scripts/painel.html (rodar na raiz do repo).
set -euo pipefail
python3 - <<'PY'
import json
html = open('scripts/painel.html', encoding='utf-8').read()
open('src/panelHtml.ts', 'w', encoding='utf-8').write(
    '// GERADO a partir de scripts/painel.html — edite o HTML e rode scripts/gerar-painel.sh\n'
    'export const PANEL_HTML: string = ' + json.dumps(html, ensure_ascii=False) + ';\n')
PY
echo "src/panelHtml.ts atualizado"
