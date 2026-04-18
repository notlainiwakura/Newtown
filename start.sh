#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

NEWTOWN_HOME="${NEWTOWN_HOME:-$HOME/.newtown}"
WEB_HOME="$NEWTOWN_HOME/guide"
NEO_HOME="$NEWTOWN_HOME/neo"
PLATO_HOME="$NEWTOWN_HOME/plato"
JOE_HOME="$NEWTOWN_HOME/joe"
LOG_DIR="$NEWTOWN_HOME/logs"
PID_FILE="$NEWTOWN_HOME/pids.txt"
WEB_PORT="${WEB_PORT:-3000}"
POSSESSION_TOKEN="${POSSESSION_TOKEN:-newtown}"
LAIN_INTERLINK_TOKEN="${LAIN_INTERLINK_TOKEN:-newtown-interlink}"
ENABLE_RESEARCH="${ENABLE_RESEARCH:-0}"
export POSSESSION_TOKEN LAIN_INTERLINK_TOKEN ENABLE_RESEARCH

mkdir -p "$LOG_DIR"

echo "Stopping any running Newtown services..."
"$SCRIPT_DIR/stop.sh" >/dev/null 2>&1 || true

echo "Building Newtown..."
npm run build

echo "Bootstrapping isolated homes..."
node dist/scripts/bootstrap-town.js --home "$WEB_HOME" --persona guide
node dist/scripts/bootstrap-town.js --home "$NEO_HOME" --persona neo
node dist/scripts/bootstrap-town.js --home "$PLATO_HOME" --persona plato
node dist/scripts/bootstrap-town.js --home "$JOE_HOME" --persona joe

echo "Starting services..."

LAIN_HOME="$WEB_HOME" node dist/scripts/run-service.js web "$WEB_PORT" > "$LOG_DIR/web.log" 2>&1 &
WEB_PID=$!

LAIN_HOME="$WEB_HOME" node dist/scripts/run-service.js gateway > "$LOG_DIR/gateway.log" 2>&1 &
GATEWAY_PID=$!

PEERS_NEO='[{"id":"plato","name":"Plato","url":"http://127.0.0.1:3004"},{"id":"joe","name":"Joe","url":"http://127.0.0.1:3005"}]'
PEERS_PLATO='[{"id":"neo","name":"Neo","url":"http://127.0.0.1:3003"},{"id":"joe","name":"Joe","url":"http://127.0.0.1:3005"}]'
PEERS_JOE='[{"id":"neo","name":"Neo","url":"http://127.0.0.1:3003"},{"id":"plato","name":"Plato","url":"http://127.0.0.1:3004"}]'

LAIN_HOME="$NEO_HOME" PORT=3003 PEER_CONFIG="$PEERS_NEO" CHARACTER_PROVIDER=openai CHARACTER_MODEL="${CHARACTER_MODEL:-${OPENAI_MODEL:-MiniMax-M2.7}}" CHARACTER_BASE_URL="${CHARACTER_BASE_URL:-${OPENAI_BASE_URL:-http://192.168.68.69:8080/v1}}" node dist/scripts/run-service.js neo 3003 > "$LOG_DIR/neo.log" 2>&1 &
NEO_PID=$!

LAIN_HOME="$PLATO_HOME" PORT=3004 PEER_CONFIG="$PEERS_PLATO" CHARACTER_PROVIDER=openai CHARACTER_MODEL="${CHARACTER_MODEL:-${OPENAI_MODEL:-MiniMax-M2.7}}" CHARACTER_BASE_URL="${CHARACTER_BASE_URL:-${OPENAI_BASE_URL:-http://192.168.68.69:8080/v1}}" node dist/scripts/run-service.js plato 3004 > "$LOG_DIR/plato.log" 2>&1 &
PLATO_PID=$!

LAIN_HOME="$JOE_HOME" PORT=3005 PEER_CONFIG="$PEERS_JOE" CHARACTER_PROVIDER=openai CHARACTER_MODEL="${CHARACTER_MODEL:-${OPENAI_MODEL:-MiniMax-M2.7}}" CHARACTER_BASE_URL="${CHARACTER_BASE_URL:-${OPENAI_BASE_URL:-http://192.168.68.69:8080/v1}}" node dist/scripts/run-service.js joe 3005 > "$LOG_DIR/joe.log" 2>&1 &
JOE_PID=$!

echo "$WEB_PID $GATEWAY_PID $NEO_PID $PLATO_PID $JOE_PID" > "$PID_FILE"
sleep 4

for PID in "$WEB_PID" "$GATEWAY_PID" "$NEO_PID" "$PLATO_PID" "$JOE_PID"; do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "A service exited during startup. Check logs in $LOG_DIR"
    exit 1
  fi
done

echo "Newtown is running at http://localhost:$WEB_PORT"
echo "Resident links: /neo/ /plato/ /joe/"
echo "Logs: $LOG_DIR"

wait
