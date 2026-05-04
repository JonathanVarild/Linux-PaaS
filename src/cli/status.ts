import { OutputStream } from "../app/daemon";
import { getClusterConfig, hasClusterConfig } from "../cluster/config";

export async function statusServerHandler(_args: unknown, stream: OutputStream): Promise<void> {
	if (!hasClusterConfig()) {
		throw new Error("Create a new cluster before viewing status.");
	}

	stream.sendOutput(
		getClusterConfig()
			.nodes.map((node) => `${node.hostname} (${node.publicIp} -> ${node.wireguardIp}): ${node.status ? "up" : `down (${node.failedPingCount})`}`)
			.join("\n"),
	);
}
