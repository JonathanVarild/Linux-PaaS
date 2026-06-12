#!/usr/bin/env bash
set -eu

# set a variable for the root of the repository, the locatiion of the live-build config, and the directory where the live-build will be built.
REPO_ROOT="$(pwd)"
LIVE_BUILD_CONFIG="${REPO_ROOT}/scripts/live-build"
WORK_DIR="$(mktemp -d)"

# Create a helper function to install a file with the correct permissions.
install_config() {
	local permissions="$1"
	local source="$2"
	local target="$3"

	# Install the file wth correct permissions, and create any directories if needed.
	install -D -m "${permissions}" "${LIVE_BUILD_CONFIG}/${source}" "${target}"
}

# Helper for installing a file with owner read-write and others with read-only permissions.
install_file() {
	install_config 644 "$1" "$2"
}

# Helper for installing a file with owner read-write-execute and others with read and execute permissions.
install_executable() {
	install_config 755 "$1" "$2"
}

# Helper for installing a sudoers file with owner read, group read, and others with no permissions.
install_sudoers() {
	install_config 440 "$1" "$2"
}

# Move to the temporary work directory.
cd "${WORK_DIR}"

# Set up live build to use Trixie, debian live installer, and no installer gui.
lb config --distribution trixie --debian-installer live --debian-installer-gui false --debian-installer-preseedfile preseed.cfg

# Create a dirrectory for the live build root filesystem, and copy the linux-paas repository into it, excluding unnecessary files and directories.
mkdir -p config/includes.chroot/opt/linux-paas
rsync -a --exclude '.git' --exclude '.github' --exclude 'build' --exclude 'dist' --exclude 'node_modules' --exclude 'out' "${REPO_ROOT}/" config/includes.chroot/opt/linux-paas/

# Install necessary config files and scripts into the live build root filesystem with the correct permissions.
install_file configs/packages config/package-lists/linux-paas.list.chroot
install_file configs/preseed.cfg config/preseed/preseed.cfg
install_file configs/sources.list config/includes.chroot/usr/local/share/linux-paas/sources.list
install_file configs/20auto-upgrades config/includes.chroot/etc/apt/apt.conf.d/20auto-upgrades
install_file configs/52no-auto-reboot config/includes.chroot/etc/apt/apt.conf.d/52no-auto-reboot
install_file configs/fail2ban-sshd.conf config/includes.chroot/etc/fail2ban/jail.d/sshd.conf
install_file configs/linux-paas-ufw.service config/includes.chroot/etc/systemd/system/linux-paas-ufw.service
install_file configs/linux-paas.service config/includes.chroot/etc/systemd/system/linux-paas.service
install_file configs/motd config/includes.chroot/etc/motd
install_file configs/pwquality.conf config/includes.chroot/etc/security/pwquality.conf.d/linux-paas.conf

# Install necessary scripts into the live build root filesystem with the correct permissions.
install_executable post-scripts/hook.chroot config/hooks/live/99-linux-paas.hook.chroot
install_executable post-scripts/linux-paas-late-command config/includes.chroot/usr/local/sbin/linux-paas-late-command
install_executable post-scripts/paas config/includes.chroot/usr/local/bin/paas

# Install necessary sudoers files into the live build root filesystem with the correct permissions.
install_sudoers configs/sudoers-paas config/includes.chroot/etc/sudoers.d/linux-paas
install_sudoers configs/sudoers-superadmin config/includes.chroot/etc/sudoers.d/linux-paas-superadmin

# Build the live image.
lb build

# Copy the resulting ISO to the dist directory in the repository.
mkdir -p "${REPO_ROOT}/dist"
cp ./*.iso "${REPO_ROOT}/dist/linux-paas-debian13-amd64.iso"
