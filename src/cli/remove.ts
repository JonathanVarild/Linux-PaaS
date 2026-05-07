import os from "os";
import { z } from "zod";
import { OutputStream } from "../app/daemon";
import { getClusterConfig, hasClusterConfig, syncConfigToCluster } from "../cluster/config";
import { ServiceIdSchema } from "../models/config";
import { parseOrThrowWithMessage } from "../utils/zod";

const RemoveOptionsSchema = z.object({
	id: ServiceIdSchema,
});

export async function removeServiceHandler(args: unknown, stream: OutputStream): Promise<void> {
	if (!hasClusterConfig()) {
		throw new Error("Create a new cluster before removing services.");
	}

	const clusterConfig = getClusterConfig();
	if (clusterConfig.coordinatorNode.hostname !== os.hostname()) {
		throw new Error("Only the coordinator node can remove services.");
	}

	const options = parseOrThrowWithMessage(RemoveOptionsSchema, args);
	const service = clusterConfig.removeService(options.id);
	await syncConfigToCluster(clusterConfig);

	console.log(`[remove] Removing ${service.type} service '${service.service_id}'.`);
	stream.sendOutput(`Service '${service.service_id}' has been removed from cluster config and will be undeployed from the cluster.`);
}
