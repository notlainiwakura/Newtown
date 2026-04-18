#!/bin/bash
# Setup nginx reverse proxy for Lain
set -e

echo "Setting up nginx for Lain..."

# Install nginx if not present
if ! command -v nginx &> /dev/null; then
    apt-get update
    apt-get install -y nginx
fi

# Copy config
cp "$(dirname "$0")/nginx/lain.conf" /etc/nginx/sites-available/lain

# Enable site, disable default
ln -sf /etc/nginx/sites-available/lain /etc/nginx/sites-enabled/lain
rm -f /etc/nginx/sites-enabled/default

# Test config
nginx -t

# Reload
systemctl reload nginx
systemctl enable nginx

echo "nginx configured and running."
echo "  Proxying port 80 -> localhost:3000 (web), 3002-3005 (characters), 8765 (voice)"
