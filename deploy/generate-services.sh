#!/bin/bash
# Generate systemd service and env files from characters.json
# Usage: ./deploy/generate-services.sh [working-dir]
#
# Reads characters.json and produces:
#   deploy/systemd/lain-<id>.service   per character
#   deploy/env/lain-<id>.env           per character (PEER_CONFIG)
#   deploy/systemd/lain.target         updated with all service names

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${1:-$(cd "$SCRIPT_DIR/.." && pwd)}"
MANIFEST="$PROJECT_DIR/characters.json"
TEMPLATE="$SCRIPT_DIR/systemd/character.service.template"
TARGET_FILE="$SCRIPT_DIR/systemd/lain.target"
ENV_DIR="$SCRIPT_DIR/env"

if [ ! -f "$MANIFEST" ]; then
  echo "No characters.json found at $MANIFEST — skipping character service generation."
  echo "Only infrastructure services (gateway, telegram, etc.) will be available."
  exit 0
fi

if [ ! -f "$TEMPLATE" ]; then
  echo "ERROR: Service template not found at $TEMPLATE"
  exit 1
fi

mkdir -p "$ENV_DIR"

TOWN_NAME=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).town.name)")
CHARACTERS_JSON=$(node -e "
  const m = JSON.parse(require('fs').readFileSync('$MANIFEST','utf8'));
  for (const c of m.characters) {
    const peers = m.characters.filter(p => p.id !== c.id).map(p => ({id:p.id, name:p.name, url:'http://localhost:'+p.port}));
    console.log(JSON.stringify({...c, peers}));
  }
")

INFRA_SERVICES="lain-gateway.service lain-telegram.service lain-voice.service"
CHAR_SERVICES=""

while IFS= read -r line; do
  CHAR_ID=$(echo "$line" | node -e "const c=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(c.id)")
  CHAR_NAME=$(echo "$line" | node -e "const c=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(c.name)")
  CHAR_NAME_ENV=$(echo "$line" | node -e "const c=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(JSON.stringify(c.name))")
  PORT=$(echo "$line" | node -e "const c=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(c.port)")
  WORKSPACE=$(echo "$line" | node -e "const c=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(c.workspace)")
  SERVER=$(echo "$line" | node -e "const c=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(c.server)")
  PEERS=$(echo "$line" | node -e "const c=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(JSON.stringify(c.peers))")

  SERVICE_NAME="lain-${CHAR_ID}"
  LAIN_HOME="/root/.lain-${CHAR_ID}"
  SERVICE_FILE="$SCRIPT_DIR/systemd/${SERVICE_NAME}.service"

  if [ "$SERVER" = "web" ]; then
    EXEC_CMD="web"
  else
    EXEC_CMD="character ${CHAR_ID}"
  fi

  sed \
    -e "s|@@TOWN_NAME@@|${TOWN_NAME}|g" \
    -e "s|@@CHAR_NAME@@|${CHAR_NAME}|g" \
    -e "s|@@CHAR_ID@@|${CHAR_ID}|g" \
    -e "s|@@PORT@@|${PORT}|g" \
    -e "s|@@LAIN_HOME@@|${LAIN_HOME}|g" \
    -e "s|@@WORKSPACE@@|${WORKSPACE}|g" \
    -e "s|@@WORKING_DIR@@|${PROJECT_DIR}|g" \
    -e "s|@@SERVICE_NAME@@|${SERVICE_NAME}|g" \
    "$TEMPLATE" > "$SERVICE_FILE"

  if [ "$SERVER" = "web" ]; then
    sed -i'' -e "s|ExecStart=.*|ExecStart=/usr/bin/node dist/index.js web --port ${PORT}|" "$SERVICE_FILE"
  fi

  echo "  Generated ${SERVICE_FILE}"

  {
    echo "LAIN_CHARACTER_ID=${CHAR_ID}"
    echo "LAIN_CHARACTER_NAME=${CHAR_NAME_ENV}"
    echo "PEER_CONFIG=${PEERS}"
  } > "$ENV_DIR/${SERVICE_NAME}.env"
  echo "  Generated ${ENV_DIR}/${SERVICE_NAME}.env"

  CHAR_SERVICES="${CHAR_SERVICES} ${SERVICE_NAME}.service"
done <<< "$CHARACTERS_JSON"

cat > "$TARGET_FILE" << EOF
[Unit]
Description=${TOWN_NAME} - All Services
Wants=${INFRA_SERVICES}${CHAR_SERVICES}

[Install]
WantedBy=multi-user.target
EOF

echo ""
echo "Generated lain.target with services:${INFRA_SERVICES}${CHAR_SERVICES}"
echo ""
echo "To install: sudo cp deploy/systemd/*.service deploy/systemd/*.target /etc/systemd/system/ && sudo systemctl daemon-reload"
