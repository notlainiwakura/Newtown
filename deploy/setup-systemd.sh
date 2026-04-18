#!/bin/bash
# Setup systemd services for Laintown
# Run once on the droplet to install all unit files and enable auto-start.
set -e

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Setting up systemd services for Laintown..."

# Remove old unit file if present (replaced by lain-wired + lain-main)
if [ -f /etc/systemd/system/lain-web.service ]; then
  echo "  Removing old lain-web.service (replaced by lain-wired + lain-main)..."
  systemctl stop lain-web.service 2>/dev/null || true
  systemctl disable lain-web.service 2>/dev/null || true
  rm -f /etc/systemd/system/lain-web.service
fi

# Copy service files
cp "$DEPLOY_DIR/systemd/"*.service /etc/systemd/system/
cp "$DEPLOY_DIR/systemd/lain.target" /etc/systemd/system/

# Copy healthcheck timer
cp "$DEPLOY_DIR/systemd/lain-healthcheck.timer" /etc/systemd/system/

# Make healthcheck script executable
chmod +x "$DEPLOY_DIR/healthcheck.sh"

# Configure journald for generous log retention
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/lain.conf << 'EOF'
[Journal]
Storage=persistent
SystemMaxUse=4G
MaxRetentionSec=6month
RateLimitBurst=10000
RateLimitIntervalSec=30s
Compress=yes
EOF

# Setup logrotate for debug log files
cp "$DEPLOY_DIR/logrotate/lain" /etc/logrotate.d/lain

# Restart journald to pick up config
systemctl restart systemd-journald

# Reload systemd
systemctl daemon-reload

# Enable all services (they start on boot via lain.target → multi-user.target)
SERVICES=(
  lain.target
  lain-wired.service
  lain-main.service
  lain-telegram.service
  lain-gateway.service
  lain-voice.service
  lain-dr-claude.service
  lain-pkd.service
  lain-mckenna.service
  lain-john.service
  lain-hiru.service
  lain-healthcheck.timer
)

for svc in "${SERVICES[@]}"; do
  systemctl enable "$svc"
done

echo ""
echo "Systemd services installed and enabled."
echo ""
echo "Commands:"
echo "  systemctl start lain.target      # Start all services"
echo "  systemctl stop lain.target       # Stop all services"
echo "  systemctl restart lain-wired     # Restart single service"
echo "  systemctl status 'lain-*'        # Check all service statuses"
echo "  journalctl -u lain-wired -f      # Follow Wired Lain logs"
echo "  journalctl -u lain-main -f       # Follow Lain logs"
echo "  journalctl -u lain-pkd -f        # Follow PKD logs"
echo ""
echo "Healthcheck (runs every 5 min via timer):"
echo "  ./deploy/healthcheck.sh           # Check only"
echo "  ./deploy/healthcheck.sh --fix     # Check + auto-fix"
echo "  journalctl -u lain-healthcheck    # View healthcheck logs"
echo "  systemctl list-timers lain-*      # Verify timer is active"
echo ""
echo "Deploy new code:"
echo "  cd /opt/local-lain && ./deploy/deploy.sh"
