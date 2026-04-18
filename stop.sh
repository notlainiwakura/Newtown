#!/bin/bash

set -euo pipefail

NEWTOWN_HOME="${NEWTOWN_HOME:-$HOME/.newtown}"
PID_FILE="$NEWTOWN_HOME/pids.txt"

echo "Stopping Newtown services..."

if [ ! -f "$PID_FILE" ]; then
  echo "No running services found."
  exit 0
fi

PIDS=$(cat "$PID_FILE")

for PID in $PIDS; do
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
  fi
done

sleep 2

for PID in $PIDS; do
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" 2>/dev/null || true
  fi
done

rm -f "$PID_FILE"
echo "All services stopped."
