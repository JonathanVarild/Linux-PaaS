import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { FailedToGenerateWireguardKeysError, FailedToAddWireguardPeerError, FailedToReadWireguardPeersError, FailedToRemoveWireguardPeerError } from "../errors/adapterErrors";
import { getClusterConfig, hasClusterConfig } from "../cluster/config";
import { WIREGUARD_CIDR, WIREGUARD_INTERFACE, WIREGUARD_LISTEN_PORT, WIREGUARD_PRIVATE_KEY_PATH } from "../constants";

// Type for Wireguard peer information.
export type WireguardPeer = {
	publicKey: string;
	endpoint: string;
	allowedIp: string;
};

/**
 * Function to generate a WireGuard key pair, but only return the public key.
 * Private key is stored on disk.
 * @returns The generated WireGuard public key.
 * @throws {FailedToGenerateWireguardKeysError} If key generation fails.
 */
export function generateWireguardKeys(): string {
	const privateKey = getWireguardPrivateKey();
	if (!privateKey) {
		throw new FailedToGenerateWireguardKeysError("Failed to generate WireGuard private key.");
	}

	const publicKey = execFileSync("wg", ["pubkey"], {
		input: `${privateKey}\n`,
		encoding: "utf8",
	}).trim();

	if (!publicKey) {
		throw new FailedToGenerateWireguardKeysError("Failed to derive WireGuard public key.");
	}

	return publicKey;
}

/**
 * Function used to retrieve the WireGuard private key from disk or generate a new one if it doesn't exist.
 * @returns The WireGuard private key.
 * @throws {FailedToGenerateWireguardKeysError} If key generation fails.
 */
function getWireguardPrivateKey(): string {
	fs.mkdirSync(path.dirname(WIREGUARD_PRIVATE_KEY_PATH), { recursive: true });

	if (fs.existsSync(WIREGUARD_PRIVATE_KEY_PATH)) {
		const existingPrivateKey = fs.readFileSync(WIREGUARD_PRIVATE_KEY_PATH, "utf8").trim();
		if (existingPrivateKey) return existingPrivateKey;
	}

	const privateKey = execFileSync("wg", ["genkey"], { encoding: "utf8" }).trim();
	if (!privateKey) {
		throw new FailedToGenerateWireguardKeysError("Failed to generate WireGuard private key.");
	}

	fs.writeFileSync(WIREGUARD_PRIVATE_KEY_PATH, `${privateKey}\n`, { mode: 0o600 });
	return privateKey;
}

/**
 * Function to configure the Wireguard interface with the keys, ports, and IPs.
 */
function configureWireguardInterface(): void {
	getWireguardPrivateKey();
	execFileSync("wg", ["set", WIREGUARD_INTERFACE, "private-key", WIREGUARD_PRIVATE_KEY_PATH, "listen-port", String(WIREGUARD_LISTEN_PORT)], {
		stdio: "ignore",
	});
	execFileSync("ip", ["address", "replace", `${getClusterConfig().getLocalNode().wireguardIp}/${WIREGUARD_CIDR}`, "dev", WIREGUARD_INTERFACE], { stdio: "ignore" });
}

/**
 * Function used to add a new WireGuard peer to the interface.
 * @param peer The WireGuard peer information to add.
 * @throws {FailedToAddWireguardPeerError} If adding the peer fails.
 */
function addWireguardPeer(peer: WireguardPeer): void {
	console.log(`Added ${peer.endpoint} (${peer.publicKey}) to ${peer.allowedIp}.`);

	try {
		execFileSync("wg", ["set", WIREGUARD_INTERFACE, "peer", peer.publicKey, "endpoint", peer.endpoint, "allowed-ips", peer.allowedIp, "persistent-keepalive", "25"]);
	} catch (error) {
		throw new FailedToAddWireguardPeerError(peer);
	}
}

/**
 * Removed or adds WireGuard peers to match the provided list of peers.
 * @param peers The peers to synchronize with the WireGuard interface.
 * @throws {FailedToReadWireguardPeersError} If reading current peers from the Wireguard interface fails.
 * @throws {FailedToRemoveWireguardPeerError} If removing a peer fails.
 * @throws {FailedToAddWireguardPeerError} If adding a peer fails.
 */
export function syncWireguardPeers(peers: WireguardPeer[]): void {
	configureWireguardInterface();

	const peersToAdd = new Map<string, WireguardPeer>();
	for (const peer of peers) {
		peersToAdd.set(peer.publicKey, peer);
	}

	let currentPeersPublicKeys: string[] = [];
	try {
		const output = execFileSync("wg", ["show", WIREGUARD_INTERFACE, "peers"], { encoding: "utf8" }).trim();
		currentPeersPublicKeys = output ? output.split(/\s+/).filter((value) => value.length > 0) : [];
	} catch (error) {
		throw new FailedToReadWireguardPeersError(WIREGUARD_INTERFACE);
	}

	for (const publicKey of currentPeersPublicKeys) {
		if (peersToAdd.has(publicKey)) {
			peersToAdd.delete(publicKey);
			continue;
		}

		try {
			execFileSync("wg", ["set", WIREGUARD_INTERFACE, "peer", publicKey, "remove"]);
		} catch (error) {
			throw new FailedToRemoveWireguardPeerError(publicKey);
		}
	}

	for (const peer of peersToAdd.values()) {
		addWireguardPeer(peer);
	}
}

/**
 * Function to set up all WireGuard interface configurations, enable it, etc.
 */
export function setupWireguardInterface(): void {
	if (!hasClusterConfig()) return;

	let interfaceExists = false;
	try {
		execFileSync("ip", ["link", "show", WIREGUARD_INTERFACE], { stdio: "ignore" });
		interfaceExists = true;
	} catch {}

	try {
		if (!interfaceExists) {
			execFileSync("ip", ["link", "add", "dev", WIREGUARD_INTERFACE, "type", "wireguard"], { stdio: "ignore" });
			console.log(`Created WireGuard interface ${WIREGUARD_INTERFACE}.`);
		}
		configureWireguardInterface();
		execFileSync("ip", ["link", "set", "up", "dev", WIREGUARD_INTERFACE], { stdio: "ignore" });
	} catch (error) {
		console.warn(`Failed to set up WireGuard interface ${WIREGUARD_INTERFACE}: ${error instanceof Error ? error.message : "Unknown error."}`);
	}
}

// Set up the interface on startup.
setupWireguardInterface();
