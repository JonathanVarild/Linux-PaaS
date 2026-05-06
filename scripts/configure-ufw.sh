#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
	echo "This script must be run as root." >&2
	exit 1
fi

if ! command -v ufw >/dev/null 2>&1; then
	echo "ufw must be installed before configuring firewall rules." >&2
	exit 1
fi

# Reset the rules.
ufw --force reset
ufw default deny incoming
ufw default allow outgoing

# Set basic rules for public services.
ufw allow 22/tcp # SSH access
ufw allow 80/tcp # HTTP access
ufw allow 8443/tcp # Accept/Join API server.
ufw allow 51820/udp # WireGuard listening port.
ufw allow 5432:7480/tcp # Public Patroni proxy range.

# Trust inter-node traffic inside the WireGuard network.
ufw allow from 10.0.0.0/24

ufw --force enable
ufw status verbose
