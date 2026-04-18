#!/bin/bash
# Restart ONLY the Lain web server (port 3001)
# CRITICAL: Must set LAIN_HOME=/root/.lain or she uses wrong database
set -e
cd /opt/wired-lain

echo "Stopping Lain (port 3001)..."
ps aux | grep "node dist/index.js web --port 3001" | grep -v grep | awk "{print \$2}" | xargs kill 2>/dev/null || true
sleep 2

# Load .env safely
while IFS="=" read -r key value; do
  [[ "$key" =~ ^#.*$ ]] && continue
  [[ -z "$key" ]] && continue
  export "$key=$value"
done < .env

# CRITICAL env vars for Lain
export LAIN_HOME=/root/.lain
export LAIN_CHARACTER_ID=lain
export LAIN_CHARACTER_NAME="Lain"
export LAIN_INTERLINK_TARGET=http://localhost:3000/api/interlink/letter

echo "Starting Lain with LAIN_HOME=$LAIN_HOME..."
nohup node dist/index.js web --port 3001 >> /root/.lain/logs/lain.log 2>&1 &
PID=$!
sleep 3

# Verify correct database
DB=$(lsof -p $PID 2>/dev/null | grep "lain.db " | head -1 | awk "{print \$NF}")
if [[ "$DB" == "/root/.lain/lain.db" ]]; then
  echo "OK: Lain (PID $PID) using $DB"
else
  echo "ERROR: Lain is using WRONG database: $DB"
  echo "Expected: /root/.lain/lain.db"
  exit 1
fi
