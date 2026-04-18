#!/bin/bash
# Laintown service status — quick overview of all services
# Run from anywhere on the droplet.

SERVICES=(
  "lain-wired:3000:Wired Lain"
  "lain-main:3001:Lain"
  "lain-telegram::Telegram Bot"
  "lain-gateway::Gateway"
  "lain-dr-claude:3002:Dr. Claude"
  "lain-pkd:3003:PKD"
  "lain-mckenna:3004:McKenna"
  "lain-john:3005:John"
  "lain-hiru:3006:Hiru"
)

echo "╔════════════════════════════════════════════════════════════╗"
echo "║  Laintown Service Status                                   ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

printf "  %-20s %-10s %-8s %s\n" "SERVICE" "STATUS" "PORT" "UPTIME"
echo "  ──────────────────────────────────────────────────────────"

ALL_OK=true
for entry in "${SERVICES[@]}"; do
  IFS=':' read -r SVC PORT NAME <<< "$entry"

  STATUS=$(systemctl is-active "$SVC" 2>/dev/null || echo "dead")

  # Get uptime from ActiveEnterTimestamp
  if [ "$STATUS" = "active" ]; then
    SINCE=$(systemctl show "$SVC" --property=ActiveEnterTimestamp --value 2>/dev/null)
    if [ -n "$SINCE" ]; then
      START_EPOCH=$(date -d "$SINCE" +%s 2>/dev/null || echo "0")
      NOW_EPOCH=$(date +%s)
      DIFF=$((NOW_EPOCH - START_EPOCH))
      if [ "$DIFF" -ge 86400 ]; then
        UPTIME="$((DIFF / 86400))d"
      elif [ "$DIFF" -ge 3600 ]; then
        UPTIME="$((DIFF / 3600))h"
      elif [ "$DIFF" -ge 60 ]; then
        UPTIME="$((DIFF / 60))m"
      else
        UPTIME="${DIFF}s"
      fi
    else
      UPTIME="-"
    fi
    ICON="\e[32m●\e[0m"
  else
    UPTIME="-"
    ICON="\e[31m●\e[0m"
    ALL_OK=false
  fi

  PORT_DISPLAY="${PORT:-  -}"
  printf "  $ICON %-18s %-10s %-8s %s\n" "$NAME" "$STATUS" "$PORT_DISPLAY" "$UPTIME"
done

echo ""

# Health check — hit each HTTP port
echo "  Health checks:"
for entry in "${SERVICES[@]}"; do
  IFS=':' read -r SVC PORT NAME <<< "$entry"
  [ -z "$PORT" ] && continue
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://localhost:$PORT/" 2>/dev/null || echo "000")
  if [ "$HTTP_STATUS" -ge 200 ] && [ "$HTTP_STATUS" -lt 500 ]; then
    printf "    \e[32m✓\e[0m %-18s http://localhost:%s → %s\n" "$NAME" "$PORT" "$HTTP_STATUS"
  else
    printf "    \e[31m✗\e[0m %-18s http://localhost:%s → %s\n" "$NAME" "$PORT" "$HTTP_STATUS"
    ALL_OK=false
  fi
done

echo ""

if $ALL_OK; then
  echo "  All services healthy."
else
  echo "  Some services need attention. Check logs:"
  echo "    journalctl -u <service-name> --since '5min ago'"
fi
