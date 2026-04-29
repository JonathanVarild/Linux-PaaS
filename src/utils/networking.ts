import dgram from "node:dgram";
import { NodeInfo } from "../models/config";
import { WIREGUARD_NETWORK_PREFIX } from "../constants";

export async function getPublicIP(): Promise<string> {
	return new Promise((resolve) => {
		const socket = dgram.createSocket("udp4");

		socket.connect(53, "1.1.1.1", () => {
			const address = socket.address().address;
			socket.close();
			resolve(address);
		});
	});
}

export function getNodeWireguardIp(node: NodeInfo): string {
	return `${WIREGUARD_NETWORK_PREFIX}.${node.node_id}`;
}
