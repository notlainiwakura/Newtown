#!/bin/bash
# Setup systemd services for Lain
set -e

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Setting up systemd services for Lain..."

# Copy service files
cp "$DEPLOY_DIR/systemd/"*.service /etc/systemd/system/
cp "$DEPLOY_DIR/systemd/lain.target" /etc/systemd/system/

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

# Enable all services via target
systemctl enable lain.target
systemctl enable lain-web.service
systemctl enable lain-telegram.service
systemctl enable lain-gateway.service
systemctl enable lain-voice.service
systemctl enable lain-dr-claude.service
systemctl enable lain-pkd.service
systemctl enable lain-mckenna.service
systemctl enable lain-john.service

echo ""
echo "Systemd services installed and enabled."
echo ""
echo "Commands:"
echo "  systemctl start lain.target     # Start all services"
echo "  systemctl stop lain.target      # Stop all services"
echo "  systemctl status lain.target    # Check status"
echo "  journalctl -u lain-web -f       # Follow web logs"
echo "  journalctl -u lain-telegram -f  # Follow telegram logs"
