#!/usr/bin/env sh
set -eu

SERVICE_NAME="linux-paas"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

if [ "$(id -u)" -ne 0 ]; then
	echo "This script must be run as root." >&2
	exit 1
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
NPM_BIN="$(command -v npm)"

cat >"${SERVICE_PATH}" <<EOF
[Unit]
Description=Linux PaaS daemon
Wants=network-online.target docker.service
After=network-online.target docker.service

[Service]
Type=simple
User=root
WorkingDirectory=${PROJECT_DIR}
Environment=NODE_ENV=production
ExecStart=${NPM_BIN} start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"
systemctl status --no-pager "${SERVICE_NAME}.service"
