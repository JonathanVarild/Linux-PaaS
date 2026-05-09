import os from "os";
import { z } from "zod";
import { OutputStream } from "../app/daemon";
import { getClusterConfig, hasClusterConfig, syncConfigToCluster } from "../cluster/config";
import { ServiceIdSchema } from "../models/config";
import { getPatroniPassword } from "../utils/credentials";
import { parseOrThrowWithMessage } from "../utils/zod";

// Schema for validating a web service or patroni service deployment.
const DeployOptionsSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("web"),
		id: ServiceIdSchema,
		image: z.string().trim().min(1),
		domain: z
			.string()
			.trim()
			.regex(/^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/),
		env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
		healthPath: z.string().trim().regex(/^\/[^\s]*$/).optional(),
		internalPort: z.number().int().min(1).max(65535),
	}),
	z.object({
		type: z.literal("patroni"),
		id: ServiceIdSchema,
		syncMode: z.enum(["async", "sync"]),
	}),
]);

// Command handler for deploying a service to the cluster.
export async function deployServiceHandler(args: unknown, stream: OutputStream): Promise<void> {
	if (!hasClusterConfig()) {
		throw new Error("Create a new cluster before deploying services.");
	}

	// Ensure the command is being run on coordinator.
	const clusterConfig = getClusterConfig();
	if (clusterConfig.coordinatorNode.hostname !== os.hostname()) {
		throw new Error("Only the coordinator node can deploy services.");
	}

	// Validate request data.
	const options = parseOrThrowWithMessage(DeployOptionsSchema, args);
	let service;

	// Check if we are deploying a web or patroni service and call the appropriate function.
	if (options.type === "web") {
		service = getClusterConfig().setWebService(options.id, options.image, options.domain, options.internalPort, options.env, options.healthPath);
	} else {
		service = getClusterConfig().setPatroniService(options.id, options.syncMode);
	}

	// Sync the configuration to the rest of the cluster.
	await syncConfigToCluster(clusterConfig);

	console.log(`[deploy] Setting ${service.type} service '${service.service_id}'.`);
	stream.sendOutput(`Service '${service.service_id}' has been scheduled for deployment.`);

	// Show database details if its a patroni service.
	if (service.type === "patroni") {
		stream.sendOutput(`Database admin credentials:\nusername: admin\npassword: ${getPatroniPassword(clusterConfig.accessKey, service.service_id, "admin")}`);
		stream.sendOutput(`Database ports:\nread-write: ${service.read_write_port}\nread-only: ${service.read_only_port}`);
	}
}
