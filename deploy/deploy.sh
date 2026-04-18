#!/bin/bash
# Deploy Laintown — pull, build, restart all services
# Run from /opt/local-lain on the droplet.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║  Deploying Laintown...                                     ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# 1. Pull latest code
echo "[1/4] Pulling latest code..."
git pull --ff-only
echo ""

# 2. Install dependencies (only if lockfile changed)
if git diff HEAD@{1} --name-only 2>/dev/null | grep -q "package-lock.json"; then
  echo "[2/4] Installing dependencies..."
  npm ci
else
  echo "[2/4] Dependencies unchanged, skipping npm ci"
fi
echo ""

# 3. Build
echo "[3/4] Building..."
npm run build
echo ""

# 4. Restart services
echo "[4/4] Restarting services..."
systemctl daemon-reload
systemctl restart lain.target
echo ""

# Wait a moment then show status
sleep 3

echo "Service status:"
echo "───────────────────────────────────────────────────"
for svc in lain-wired lain-main lain-telegram lain-gateway lain-voice lain-dr-claude lain-pkd lain-mckenna lain-john lain-hiru; do
  STATUS=$(systemctl is-active "$svc" 2>/dev/null || echo "inactive")
  if [ "$STATUS" = "active" ]; then
    printf "  %-20s \e[32m●\e[0m %s\n" "$svc" "$STATUS"
  else
    printf "  %-20s \e[31m●\e[0m %s\n" "$svc" "$STATUS"
  fi
done
echo ""
echo "Deploy complete. Use 'journalctl -u <service> -f' to check logs."
