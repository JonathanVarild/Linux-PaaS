import { WireguardPeer } from "../adapters/wireguard";

export class FailedToGenerateWireguardKeysError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FailedToGenerateWireguardKeysError";
	}
}

export class FailedToAddWireguardPeerError extends Error {
	constructor(peer: WireguardPeer) {
		super(`Failed to add WireGuard peer ${peer.publicKey} at ${peer.endpoint} with WireGuard IP ${peer.allowedIp}.`);
		this.name = "FailedToAddWireguardPeerError";
	}
}

export class FailedToReadWireguardPeersError extends Error {
	constructor(interfaceName: string) {
		super(`Failed to read WireGuard peers for ${interfaceName}.`);
		this.name = "FailedToReadWireguardPeersError";
	}
}

export class FailedToRemoveWireguardPeerError extends Error {
	constructor(publicKey: string) {
		super(`Failed to remove WireGuard peer ${publicKey}.`);
		this.name = "FailedToRemoveWireguardPeerError";
	}
}

export class FailedToGetLocalWireguardAddressError extends Error {
	constructor() {
		super("Failed to get local WireGuard address from cluster configuration.");
		this.name = "FailedToGetLocalWireguardAddressError";
	}
}