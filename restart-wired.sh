#!/bin/bash
# Restart ONLY the Wired Lain web server (port 3000)
# CRITICAL: Must set LAIN_HOME=/root/.lain-wired or she uses Lain's database
set -e
cd /opt/wired-lain

echo "Stopping Wired Lain (port 3000)..."
ps aux | grep "node dist/index.js web --port 3000" | grep -v grep | awk "{print \$2}" | xargs kill 2>/dev/null || true
sleep 2

# Load .env safely
while IFS="=" read -r key value; do
  [[ "$key" =~ ^#.*$ ]] && continue
  [[ -z "$key" ]] && continue
  export "$key=$value"
done < .env

# CRITICAL env vars for Wired Lain
export LAIN_HOME=/root/.lain-wired
export LAIN_CHARACTER_ID=wired-lain
export LAIN_CHARACTER_NAME="Wired Lain"
export LAIN_INTERLINK_TARGET=http://localhost:3001/api/interlink/letter

echo "Starting Wired Lain with LAIN_HOME=$LAIN_HOME..."
nohup node dist/index.js web --port 3000 >> /root/.lain/logs/web.log 2>&1 &
PID=$!
sleep 3

# Verify correct database
DB=$(lsof -p $PID 2>/dev/null | grep "lain.db " | head -1 | awk "{print \$NF}")
if [[ "$DB" == *"lain-wired"* ]]; then
  echo "OK: Wired Lain (PID $PID) using $DB"
else
  echo "ERROR: Wired Lain is using WRONG database: $DB"
  echo "Expected: /root/.lain-wired/lain.db"
  exit 1
fi
