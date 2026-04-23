import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
	FailedToGenerateWireguardKeysError,
	FailedToAddWireguardPeerError,
	FailedToReadWireguardPeersError,
	FailedToRemoveWireguardPeerError,
	FailedToGetLocalWireguardAddressError,
} from "../errors/adapterErrors";
import { getClusterConfig, hasClusterConfig } from "../cluster/config";

export type WireguardPeer = {
	publicKey: string;
	endpoint: string;
	allowedIp: string;
};

const WIREGUARD_INTERFACE = process.env.WIREGUARD_INTERFACE ?? "wg0";
const WIREGUARD_PEER_KEEPALIVE_SECONDS = "25";
const WIREGUARD_LISTEN_PORT = "51820";
const WIREGUARD_PRIVATE_KEY_PATH = "/etc/linux-paas/private.key";

function shouldExecuteWireguardCommands(): boolean {
	return process.env.NODE_ENV === "production" || process.env.NODE_ENV === "docker_dev";
}

export function generateWireguardKeys(): string {
	if (!shouldExecuteWireguardCommands()) return "DEVELOPMENT_PUBLIC_KEY";

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

function getLocalWireguardAddress(): string {
	const localNode = getClusterConfig().nodes.find((node) => node.hostname === os.hostname());
	if (!localNode) {
		throw new FailedToGetLocalWireguardAddressError();
	}

	return `${localNode.wireguardIp}/24`;
}

function configureWireguardInterface(): void {
	getWireguardPrivateKey();
	execFileSync("wg", ["set", WIREGUARD_INTERFACE, "private-key", WIREGUARD_PRIVATE_KEY_PATH, "listen-port", WIREGUARD_LISTEN_PORT], {
		stdio: "ignore",
	});
	execFileSync("ip", ["address", "replace", getLocalWireguardAddress(), "dev", WIREGUARD_INTERFACE], { stdio: "ignore" });
}

export function addWireguardPeer(peer: WireguardPeer): void {
	if (!shouldExecuteWireguardCommands()) return;

	console.log(`Added ${peer.endpoint} (${peer.publicKey}) to ${peer.allowedIp}.`);

	try {
		execFileSync("wg", [
			"set",
			WIREGUARD_INTERFACE,
			"peer",
			peer.publicKey,
			"endpoint",
			peer.endpoint,
			"allowed-ips",
			peer.allowedIp,
			"persistent-keepalive",
			WIREGUARD_PEER_KEEPALIVE_SECONDS,
		]);
	} catch (error) {
		throw new FailedToAddWireguardPeerError(peer);
	}
}

export function syncWireguardPeers(peers: WireguardPeer[]): void {
	if (!shouldExecuteWireguardCommands()) {
		return;
	}

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

export function setupWireguardInterface(): void {
	if (!shouldExecuteWireguardCommands() || !hasClusterConfig()) return;

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

setupWireguardInterface();
