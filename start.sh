#!/bin/bash
# Town startup script — reads characters.json for character list
# Starts infrastructure services + all characters defined in the manifest.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

LOCKFILE=~/.lain/start.lock
mkdir -p ~/.lain
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "ERROR: Another start.sh is already running (lockfile: $LOCKFILE)"
  exit 1
fi

MANIFEST="$SCRIPT_DIR/characters.json"
LAUNCHED_PIDS=()

cleanup() {
  local exit_code=$?
  flock -u 9 2>/dev/null || true
  if [ "$STARTED_OK" = "true" ]; then
    echo ""
    echo "Shutting down all services..."
    "$SCRIPT_DIR/stop.sh"
  elif [ ${#LAUNCHED_PIDS[@]} -gt 0 ]; then
    echo ""
    echo "Startup failed — cleaning up ${#LAUNCHED_PIDS[@]} launched processes..."
    for PID in "${LAUNCHED_PIDS[@]}"; do kill "$PID" 2>/dev/null || true; done
    sleep 1
    for PID in "${LAUNCHED_PIDS[@]}"; do kill -9 "$PID" 2>/dev/null || true; done
    rm -f ~/.lain/pids.txt
  fi
  exit "$exit_code"
}
trap cleanup EXIT

if [ -f .env ]; then
  echo "Loading environment from .env file..."
  export $(grep -v '^#' .env | grep -v '^\s*$' | xargs)
fi

if [ -z "$ANTHROPIC_API_KEY" ]; then echo "Warning: ANTHROPIC_API_KEY not set"; fi
if [ -z "$LAIN_INTERLINK_TOKEN" ]; then echo "Warning: LAIN_INTERLINK_TOKEN not set"; fi
echo ""

echo "Stopping any existing services..."
"$SCRIPT_DIR/stop.sh"
sleep 2
echo ""

if [ ! -d "dist" ] || [ "src" -nt "dist" ]; then
  echo "Building..."
  npm run build
fi

if [ ! -f "$MANIFEST" ]; then
  echo "No characters.json found. Create one to add characters (see characters.example.json)."
  echo "Only infrastructure services will start."
  echo ""
fi

mkdir -p ~/.lain/logs
set +e

TOWN_NAME="Town"
if [ -f "$MANIFEST" ]; then
  TOWN_NAME=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).town?.name || 'Town')")
fi

echo "Starting $TOWN_NAME..."
echo ""

# Start gateway
node dist/index.js gateway > ~/.lain/logs/gateway.log 2>&1 &
GW_PID=$!
LAUNCHED_PIDS+=("$GW_PID")
echo "  [1] Gateway (PID $GW_PID)"

SERVICE_NUM=2

# Start characters from manifest
if [ -f "$MANIFEST" ]; then
  CHARACTERS=$(node -e "
    const m = JSON.parse(require('fs').readFileSync('$MANIFEST','utf8'));
    for (const c of m.characters) {
      const peers = m.characters.filter(p => p.id !== c.id).map(p => ({id:p.id, name:p.name, url:'http://localhost:'+p.port}));
      console.log([c.id, c.name, c.port, c.server, c.workspace, JSON.stringify(peers)].join('|'));
    }
  ")

  FIRST_WEB_PID=""
  while IFS='|' read -r CHAR_ID CHAR_NAME PORT SERVER WORKSPACE PEERS; do
    [ -z "$CHAR_ID" ] && continue

    CHAR_HOME=~/.lain-${CHAR_ID}
    mkdir -p "$CHAR_HOME/workspace"
    if [ -d "$WORKSPACE" ]; then
      cp -r "$WORKSPACE/"* "$CHAR_HOME/workspace/" 2>/dev/null || true
    fi

    if [ "$SERVER" = "web" ]; then
      CMD="web"
    else
      CMD="character $CHAR_ID"
    fi

    LAIN_HOME="$CHAR_HOME" \
      LAIN_CHARACTER_ID="$CHAR_ID" \
      LAIN_CHARACTER_NAME="$CHAR_NAME" \
      PEER_CONFIG="$PEERS" \
      PORT="$PORT" \
      node dist/index.js $CMD --port "$PORT" > ~/.lain/logs/${CHAR_ID}.log 2>&1 &
    CHAR_PID=$!
    LAUNCHED_PIDS+=("$CHAR_PID")
    echo "  [$SERVICE_NUM] $CHAR_NAME (PID $CHAR_PID) -> http://localhost:$PORT"
    SERVICE_NUM=$((SERVICE_NUM + 1))

    if [ "$SERVER" = "web" ] && [ -z "$FIRST_WEB_PID" ]; then
      FIRST_WEB_PID=$CHAR_PID
    fi
  done <<< "$CHARACTERS"
fi

echo "${LAUNCHED_PIDS[*]}" > ~/.lain/pids.txt

sleep 3

FAILED=0
if [ -n "$FIRST_WEB_PID" ]; then
  if ! kill -0 "$FIRST_WEB_PID" 2>/dev/null; then
    echo "  ERROR: Primary web server died on startup!"
    FAILED=1
  fi
fi

if [ "$FAILED" -eq 1 ]; then
  echo "Critical services failed. Check logs: tail ~/.lain/logs/*.log"
  exit 1
fi

STARTED_OK=true

echo ""
echo "All services running. Logs at ~/.lain/logs/"
echo "Press Ctrl+C to stop all services"
echo ""

wait
