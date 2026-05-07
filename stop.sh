#!/bin/bash
# Stop all services — reads characters.json for port list
# Falls back to PID file and process pattern matching.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$SCRIPT_DIR/characters.json"

# Build port list from manifest + known infrastructure ports
PORTS=(8765)  # voice service
if [ -f "$MANIFEST" ]; then
  CHAR_PORTS=$(node -e "
    const m = JSON.parse(require('fs').readFileSync('$MANIFEST','utf8'));
    console.log(m.characters.map(c => c.port).join(' '));
  ")
  for P in $CHAR_PORTS; do PORTS+=("$P"); done
fi

PROCESS_PATTERNS=(
  "node dist/index.js web"
  "node dist/index.js character"
  "node dist/index.js telegram"
  "node dist/index.js gateway"
  "python -m lain_voice.main"
  "python3 -m lain_voice.main"
)

collect_pids() {
  local pids=()
  if [ -f ~/.lain/pids.txt ]; then
    for PID in $(cat ~/.lain/pids.txt); do
      if kill -0 "$PID" 2>/dev/null; then pids+=("$PID"); fi
    done
  fi
  for PORT in "${PORTS[@]}"; do
    local port_pids
    port_pids=$(lsof -ti:"$PORT" 2>/dev/null || true)
    if [ -n "$port_pids" ]; then
      while IFS= read -r PID; do [ -n "$PID" ] && pids+=("$PID"); done <<< "$port_pids"
    fi
  done
  for PATTERN in "${PROCESS_PATTERNS[@]}"; do
    local found
    found=$(pgrep -f "$PATTERN" 2>/dev/null || true)
    if [ -n "$found" ]; then
      while IFS= read -r PID; do
        [ -n "$PID" ] && [ "$PID" != "$$" ] && pids+=("$PID")
      done <<< "$found"
    fi
  done
  printf '%s\n' "${pids[@]}" | sort -un
}

echo "Stopping services..."

PIDS=$(collect_pids)
if [ -z "$PIDS" ]; then
  echo "No running services found."
  rm -f ~/.lain/pids.txt ~/.lain/start.lock
  exit 0
fi

for PID in $PIDS; do
  if kill -0 "$PID" 2>/dev/null; then
    echo "  Stopping PID $PID ($(ps -p "$PID" -o args= 2>/dev/null | head -c 60))..."
    kill "$PID" 2>/dev/null || true
  fi
done

for i in $(seq 1 10); do
  ALIVE=0
  for PID in $PIDS; do
    if kill -0 "$PID" 2>/dev/null; then ALIVE=1; break; fi
  done
  [ "$ALIVE" -eq 0 ] && break
  sleep 0.5
done

for PID in $PIDS; do
  if kill -0 "$PID" 2>/dev/null; then
    echo "  Force-killing PID $PID..."
    kill -9 "$PID" 2>/dev/null || true
  fi
done

sleep 0.5
rm -f ~/.lain/pids.txt ~/.lain/start.lock
echo "All services stopped."
