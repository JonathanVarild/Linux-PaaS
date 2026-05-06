#!/usr/bin/env sh
set -eu

COMMAND_PATH="/usr/local/bin/paas"

if [ "$(id -u)" -ne 0 ]; then
	echo "This script must be run as root." >&2
	exit 1
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"

cat >"${COMMAND_PATH}" <<EOF
#!/usr/bin/env sh
set -eu

if [ "\$(id -u)" -ne 0 ]; then
	echo "Run 'paas' as root or with sudo." >&2
	exit 1
fi

cd "${PROJECT_DIR}"
export NODE_ENV=production
exec ./node_modules/.bin/tsx src/cli.ts "\$@"
EOF

chmod 755 "${COMMAND_PATH}"
echo "Installed PaaS command to system PATH."
