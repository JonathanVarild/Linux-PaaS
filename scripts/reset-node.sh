#!/usr/bin/env sh
set -eu

SERVICE_NAME="linux-paas.service"
CONFIG_DIR="/etc/linux-paas"

if [ "$(id -u)" -ne 0 ]; then
	echo "This script must be run as root." >&2
	exit 1
fi

echo "Stopping ${SERVICE_NAME}..."
systemctl stop "${SERVICE_NAME}"

echo "Stopping running Docker containers..."
CONTAINER_IDS="$(docker ps -q)"
if [ -n "${CONTAINER_IDS}" ]; then
	docker stop ${CONTAINER_IDS}
fi

echo "Removing ${CONFIG_DIR}..."
rm -rf "${CONFIG_DIR}"

echo "Restarting ${SERVICE_NAME}..."
systemctl restart "${SERVICE_NAME}"
