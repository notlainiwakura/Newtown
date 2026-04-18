#!/bin/bash
# Laintown healthcheck — diagnose and auto-fix service issues
#
# Run modes:
#   ./deploy/healthcheck.sh          # check + report only
#   ./deploy/healthcheck.sh --fix    # check + auto-fix issues
#   ./deploy/healthcheck.sh --quiet  # only output if something is wrong
#
# Exit codes:
#   0 = all healthy
#   1 = issues found (reported or fixed)
#   2 = issues found and fix failed
#
# Designed to run from cron/systemd timer every 5 minutes.

set -euo pipefail

FIX=false
QUIET=false
for arg in "$@"; do
  case "$arg" in
    --fix) FIX=true ;;
    --quiet) QUIET=true ;;
  esac
done

# ── Service definitions ──────────────────────────────────────
# Format: "systemd-name:port:display-name:type"
# type: node (HTTP), telegram (no port), gateway (no port), python (HTTP)
SERVICES=(
  "lain-wired:3000:Wired Lain:node"
  "lain-main:3001:Lain:node"
  "lain-telegram::Telegram Bot:telegram"
  "lain-gateway::Gateway:gateway"
  "lain-dr-claude:3002:Dr. Claude:node"
  "lain-pkd:3003:PKD:node"
  "lain-mckenna:3004:McKenna:node"
  "lain-john:3005:John:node"
  "lain-hiru:3006:Hiru:node"
)

ISSUES=()
FIXES=()
FAILED_FIXES=()

log() {
  if ! $QUIET || [ "${2:-}" = "force" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
  fi
}

issue() {
  ISSUES+=("$1")
  log "ISSUE: $1" force
}

fixed() {
  FIXES+=("$1")
  log "FIXED: $1" force
}

fix_failed() {
  FAILED_FIXES+=("$1")
  log "FIX FAILED: $1" force
}

# ── Check functions ──────────────────────────────────────────

check_systemd_status() {
  local svc="$1" name="$2"
  local status
  status=$(systemctl is-active "$svc" 2>/dev/null || true)
  status=$(echo "$status" | head -1 | tr -d '[:space:]')

  case "$status" in
    active)
      return 0
      ;;
    failed)
      issue "$name ($svc) is in FAILED state"
      if $FIX; then
        fix_failed_service "$svc" "$name"
      fi
      return 1
      ;;
    activating)
      # Service is starting up — not an issue yet
      log "$name ($svc) is activating..."
      return 0
      ;;
    inactive|dead)
      issue "$name ($svc) is INACTIVE"
      if $FIX; then
        fix_inactive_service "$svc" "$name"
      fi
      return 1
      ;;
    *)
      issue "$name ($svc) has unknown status: $status"
      if $FIX; then
        fix_failed_service "$svc" "$name"
      fi
      return 1
      ;;
  esac
}

check_http_health() {
  local svc="$1" port="$2" name="$3"
  [ -z "$port" ] && return 0  # no port to check

  local http_status
  http_status=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 3 --max-time 5 "http://localhost:$port/" 2>/dev/null || echo "000")
  http_status="${http_status:0:3}"  # normalize to 3 digits

  if [ "$http_status" -ge 200 ] 2>/dev/null && [ "$http_status" -lt 500 ] 2>/dev/null; then
    return 0
  else
    issue "$name HTTP health check failed (port $port, status $http_status)"
    if $FIX; then
      fix_unresponsive_service "$svc" "$port" "$name"
    fi
    return 1
  fi
}

check_port_conflict() {
  local svc="$1" port="$2" name="$3"
  [ -z "$port" ] && return 0

  # Get the PID that systemd thinks owns this service
  local svc_pid
  svc_pid=$(systemctl show "$svc" --property=MainPID --value 2>/dev/null || echo "0")

  # Get the PID actually holding the port
  local port_pid
  port_pid=$(fuser "$port/tcp" 2>/dev/null | tr -d ' ' || echo "")

  if [ -n "$port_pid" ] && [ "$port_pid" != "$svc_pid" ] && [ "$svc_pid" != "0" ]; then
    issue "$name port $port held by rogue PID $port_pid (service PID is $svc_pid)"
    if $FIX; then
      fix_port_conflict "$svc" "$port" "$name" "$port_pid"
    fi
    return 1
  fi

  return 0
}

check_restart_loop() {
  local svc="$1" name="$2"
  # Check if service has restarted more than 3 times in the last 10 minutes
  local restart_count
  restart_count=$(journalctl -u "$svc" --since "10 min ago" --no-pager 2>/dev/null \
    | grep -c "Scheduled restart job" || true)
  restart_count="${restart_count:-0}"

  if [ "$restart_count" -gt 3 ]; then
    issue "$name is in a restart loop ($restart_count restarts in 10 min)"
    if $FIX; then
      fix_restart_loop "$svc" "$name"
    fi
    return 1
  fi

  return 0
}

check_telegram_conflict() {
  # Check for duplicate telegram bot processes
  local count
  count=$(pgrep -f "dist/index.js telegram" 2>/dev/null | wc -l || echo "0")
  if [ "$count" -gt 1 ]; then
    issue "Multiple Telegram bot processes running ($count instances)"
    if $FIX; then
      fix_telegram_conflict
    fi
    return 1
  fi
  return 0
}

# ── Fix functions ────────────────────────────────────────────

fix_failed_service() {
  local svc="$1" name="$2"
  log "Attempting to fix $name..."

  # Reset the failed state so systemd will try again
  systemctl reset-failed "$svc" 2>/dev/null || true

  # Check for port conflicts before restarting
  local port
  port=$(get_port "$svc")
  if [ -n "$port" ]; then
    local stale_pid
    stale_pid=$(fuser "$port/tcp" 2>/dev/null | tr -d ' ' || echo "")
    if [ -n "$stale_pid" ]; then
      log "Killing stale process $stale_pid on port $port"
      kill "$stale_pid" 2>/dev/null || true
      sleep 2
      # Force kill if still alive
      kill -9 "$stale_pid" 2>/dev/null || true
      sleep 1
    fi
  fi

  systemctl start "$svc" 2>/dev/null
  sleep 3

  if systemctl is-active "$svc" >/dev/null 2>&1; then
    fixed "$name restarted successfully"
  else
    fix_failed "$name failed to restart — check: journalctl -u $svc -n 30"
  fi
}

fix_inactive_service() {
  local svc="$1" name="$2"
  log "Starting $name..."

  systemctl start "$svc" 2>/dev/null
  sleep 3

  if systemctl is-active "$svc" >/dev/null 2>&1; then
    fixed "$name started"
  else
    fix_failed "$name failed to start — check: journalctl -u $svc -n 30"
  fi
}

fix_unresponsive_service() {
  local svc="$1" port="$2" name="$3"
  log "Restarting unresponsive $name..."

  systemctl restart "$svc" 2>/dev/null
  sleep 5

  local http_status
  http_status=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 3 --max-time 5 "http://localhost:$port/" 2>/dev/null || echo "000")
  http_status="${http_status:0:3}"  # normalize to 3 digits

  if [ "$http_status" -ge 200 ] 2>/dev/null && [ "$http_status" -lt 500 ] 2>/dev/null; then
    fixed "$name restarted and responding (HTTP $http_status)"
  else
    fix_failed "$name still unresponsive after restart (HTTP $http_status)"
  fi
}

fix_port_conflict() {
  local svc="$1" port="$2" name="$3" rogue_pid="$4"
  log "Killing rogue PID $rogue_pid on port $port..."

  kill "$rogue_pid" 2>/dev/null || true
  sleep 2
  kill -9 "$rogue_pid" 2>/dev/null || true
  sleep 1

  # Now restart the service
  systemctl restart "$svc" 2>/dev/null
  sleep 3

  if systemctl is-active "$svc" >/dev/null 2>&1; then
    fixed "$name — killed rogue process, service restarted"
  else
    fix_failed "$name — killed rogue process but service won't start"
  fi
}

fix_restart_loop() {
  local svc="$1" name="$2"
  log "Breaking restart loop for $name..."

  # Stop it, reset, wait, then try once more
  systemctl stop "$svc" 2>/dev/null || true
  systemctl reset-failed "$svc" 2>/dev/null || true
  sleep 5

  # Clean up any stale port
  local port
  port=$(get_port "$svc")
  if [ -n "$port" ]; then
    fuser -k "$port/tcp" 2>/dev/null || true
    sleep 2
  fi

  systemctl start "$svc" 2>/dev/null
  sleep 5

  if systemctl is-active "$svc" >/dev/null 2>&1; then
    fixed "$name — broke restart loop, service running"
  else
    fix_failed "$name — restart loop persists, manual intervention needed"
  fi
}

fix_telegram_conflict() {
  log "Killing duplicate Telegram bot processes..."

  # Kill all telegram processes, let systemd restart the one it manages
  pkill -f "dist/index.js telegram" 2>/dev/null || true
  sleep 3
  systemctl restart lain-telegram 2>/dev/null || true
  sleep 5

  if systemctl is-active lain-telegram >/dev/null 2>&1; then
    fixed "Telegram bot — killed duplicates, restarted via systemd"
  else
    fix_failed "Telegram bot — still failing after killing duplicates"
  fi
}

# ── Helpers ──────────────────────────────────────────────────

get_port() {
  local svc="$1"
  for entry in "${SERVICES[@]}"; do
    IFS=':' read -r s p n t <<< "$entry"
    if [ "$s" = "$svc" ]; then
      echo "$p"
      return
    fi
  done
}

# ── Main ─────────────────────────────────────────────────────

log "Laintown healthcheck starting..."

# Phase 1: Check systemd status
for entry in "${SERVICES[@]}"; do
  IFS=':' read -r SVC PORT NAME TYPE <<< "$entry"
  check_systemd_status "$SVC" "$NAME" || true
done

# Phase 2: Check for restart loops (only for active-but-struggling services)
for entry in "${SERVICES[@]}"; do
  IFS=':' read -r SVC PORT NAME TYPE <<< "$entry"
  check_restart_loop "$SVC" "$NAME" || true
done

# Phase 3: Check for port conflicts
for entry in "${SERVICES[@]}"; do
  IFS=':' read -r SVC PORT NAME TYPE <<< "$entry"
  check_port_conflict "$SVC" "$PORT" "$NAME" || true
done

# Phase 4: HTTP health checks (only for services with ports)
for entry in "${SERVICES[@]}"; do
  IFS=':' read -r SVC PORT NAME TYPE <<< "$entry"
  check_http_health "$SVC" "$PORT" "$NAME" || true
done

# Phase 5: Check for telegram-specific issues
check_telegram_conflict || true

# Phase 6: Disk usage monitoring
DISK_WARN_PERCENT=80
DISK_CRIT_PERCENT=90
DISK_USAGE=$(df / --output=pcent 2>/dev/null | tail -1 | tr -d ' %' || echo "0")
if [ "$DISK_USAGE" -ge "$DISK_CRIT_PERCENT" ] 2>/dev/null; then
  ISSUES+=("CRITICAL: Disk usage at ${DISK_USAGE}%")
elif [ "$DISK_USAGE" -ge "$DISK_WARN_PERCENT" ] 2>/dev/null; then
  ISSUES+=("WARNING: Disk usage at ${DISK_USAGE}%")
fi

# Phase 7: Check DB sizes
for DB_PATH in /root/.lain-wired/lain.db /root/.lain/lain.db /root/.lain-pkd/lain.db /root/.lain-mckenna/lain.db /root/.lain-john/lain.db /root/.lain-dr-claude/lain.db /root/.lain-hiru/lain.db; do
  if [ -f "$DB_PATH" ]; then
    DB_SIZE_MB=$(du -m "$DB_PATH" 2>/dev/null | cut -f1)
    if [ "${DB_SIZE_MB:-0}" -ge 500 ] 2>/dev/null; then
      DB_NAME=$(basename "$(dirname "$DB_PATH")")
      ISSUES+=("WARNING: $DB_NAME DB is ${DB_SIZE_MB}MB")
    fi
  fi
done

# ── Telegram Alert ──────────────────────────────────────────

send_telegram_alert() {
  local MESSAGE="$1"
  # Read bot token and chat ID from env file
  local BOT_TOKEN CHAT_ID
  BOT_TOKEN=$(grep -oP 'TELEGRAM_BOT_TOKEN=\K.*' /opt/local-lain/.env 2>/dev/null | head -1)
  CHAT_ID=$(grep -oP 'LAIN_ADMIN_CHAT_ID=\K.*' /opt/local-lain/.env 2>/dev/null | head -1)

  if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ]; then
    return 0  # No alert config, skip silently
  fi

  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    -d "text=${MESSAGE}" \
    -d "parse_mode=Markdown" \
    --max-time 10 >/dev/null 2>&1 || true
}

# ── Report ───────────────────────────────────────────────────

echo ""
if [ ${#ISSUES[@]} -eq 0 ]; then
  log "All ${#SERVICES[@]} services healthy." force
  exit 0
fi

log "Found ${#ISSUES[@]} issue(s):" force
for i in "${ISSUES[@]}"; do
  echo "  - $i"
done

if [ ${#FIXES[@]} -gt 0 ]; then
  echo ""
  log "Auto-fixed ${#FIXES[@]} issue(s):" force
  for f in "${FIXES[@]}"; do
    echo "  + $f"
  done
fi

if [ ${#FAILED_FIXES[@]} -gt 0 ]; then
  echo ""
  log "Failed to fix ${#FAILED_FIXES[@]} issue(s):" force
  for f in "${FAILED_FIXES[@]}"; do
    echo "  ! $f"
  done

  # Send Telegram alert for unfixed issues
  ALERT_MSG="⚠️ *Laintown Health Alert*%0A"
  for f in "${FAILED_FIXES[@]}"; do
    ALERT_MSG+="• ${f}%0A"
  done
  send_telegram_alert "$ALERT_MSG"

  exit 2
fi

# Send alert if there are issues that weren't auto-fixed
if ! $FIX && [ ${#ISSUES[@]} -gt 0 ]; then
  ALERT_MSG="⚠️ *Laintown Health Alert*%0A"
  for i in "${ISSUES[@]}"; do
    ALERT_MSG+="• ${i}%0A"
  done
  send_telegram_alert "$ALERT_MSG"
fi

if $FIX && [ ${#FIXES[@]} -eq ${#ISSUES[@]} ]; then
  exit 0  # all issues fixed
fi

exit 1
