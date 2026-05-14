import fetch from "node-fetch";
import os from "os";
import { z } from "zod";
import { OutputStream } from "../app/daemon";
import { HTTP_DAEMON_PORT } from "../constants";
import { getClusterConfig, hasClusterConfig, syncConfigToCluster } from "../cluster/config";
import { requestLeaderElection } from "../cluster/leaderElection";
import { parseOrThrowWithMessage } from "../utils/zod";

const KickOptionsSchema = z.object({
	nodeId: z.number().int().min(1).max(255),
});

export async function kickNodeHandler(args: unknown, stream: OutputStream): Promise<void> {
	if (!hasClusterConfig()) {
		throw new Error("Create a new cluster before kicking nodes.");
	}

	const clusterConfig = getClusterConfig();
	if (clusterConfig.coordinatorNode.hostname !== os.hostname()) {
		throw new Error("Only the coordinator node can kick nodes.");
	}

	const options = parseOrThrowWithMessage(KickOptionsSchema, args);
	const nodeToKick = clusterConfig.getNodeById(options.nodeId);
	if (!nodeToKick) throw new Error("Could not find node in the cluster configuration.");
	if (clusterConfig.isCoordinatorNode(nodeToKick)) throw new Error("Cannot kick the coordinator node.");

	const wasLeader = clusterConfig.leaderNode.id === options.nodeId;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);

	try {
		const response = await fetch(`http://${nodeToKick.wireguardIp}:${HTTP_DAEMON_PORT}/reset_node`, {
			method: "POST",
			headers: {
				"x-access-key": clusterConfig.accessKey,
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			const responseBody = await response.text();
			console.warn(`Failed to request reset for ${nodeToKick.hostname} (${response.status}): ${responseBody}`);
		}
	} catch (error) {
		console.warn(`Failed to request reset for ${nodeToKick.hostname}: ${error instanceof Error ? error.message : "Unknown error."}`);
	} finally {
		clearTimeout(timeout);
	}

	const kickedNode = clusterConfig.kickNode(options.nodeId);

	await syncConfigToCluster(clusterConfig);
	if (wasLeader) await requestLeaderElection();

	stream.sendOutput(`Node #${kickedNode.id} (${kickedNode.hostname}) has been kicked.`);
}
