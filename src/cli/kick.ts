import os from "os";
import { z } from "zod";
import { OutputStream } from "../app/daemon";
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
	const wasLeader = clusterConfig.leaderNode.id === options.nodeId;
	const kickedNode = clusterConfig.kickNode(options.nodeId);

	await syncConfigToCluster(clusterConfig);
	if (wasLeader) await requestLeaderElection();

	stream.sendOutput(`Node #${kickedNode.id} (${kickedNode.hostname}) has been kicked.`);
}
