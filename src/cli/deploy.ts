import os from "os";
import { z } from "zod";
import { OutputStream } from "../app/daemon";
import { getClusterConfig, hasClusterConfig, syncConfigToCluster } from "../cluster/config";
import { ClusterService } from "../models/config";
import { parseOrThrowWithMessage } from "../utils/zod";

const DEFAULT_PATRONI_READ_WRITE_PORT = 5432;
const DEFAULT_PATRONI_READ_ONLY_PORT = 5433;
type PatroniService = Extract<ClusterService, { type: "patroni" }>;

const DeployOptionsSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("web"),
		id: z.string().trim().min(1),
		image: z.string().trim().min(1),
		domain: z
			.string()
			.trim()
			.regex(/^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/),
		internalPort: z.number().int().min(1).max(65535),
	}),
	z.object({
		type: z.literal("patroni"),
		id: z.string().trim().min(1),
		syncMode: z.enum(["async", "sync"]),
	}),
]);

export async function deployServiceHandler(args: unknown, stream: OutputStream): Promise<void> {
	if (!hasClusterConfig()) {
		throw new Error("Create a new cluster before deploying services.");
	}

	const clusterConfig = getClusterConfig();
	if (clusterConfig.coordinatorNode.hostname !== os.hostname()) {
		throw new Error("Only the coordinator node can deploy services.");
	}

	const options = parseOrThrowWithMessage(DeployOptionsSchema, args);
	let service: ClusterService;
	if (options.type === "web") {
		service = {
			service_id: options.id,
			type: "web",
			image: options.image,
			domain: options.domain,
			internal_port: options.internalPort,
		};
	} else {
		const existingService = clusterConfig.services.find((service): service is PatroniService => service.type === "patroni" && service.service_id === options.id);
		let readWritePort = existingService?.read_write_port ?? DEFAULT_PATRONI_READ_WRITE_PORT;
		let readOnlyPort = existingService?.read_only_port ?? DEFAULT_PATRONI_READ_ONLY_PORT;

		const usedPorts = new Set<number>();
		for (const service of clusterConfig.services) {
			if (service.type !== "patroni" || service.service_id !== options.id) continue;
			usedPorts.add(service.read_write_port);
			usedPorts.add(service.read_only_port);
		}

		while (usedPorts.has(readWritePort) || usedPorts.has(readOnlyPort)) {
			readWritePort += 2;
			readOnlyPort += 2;
			if (readOnlyPort > 65535) {
				throw new Error("No available Patroni port pair could be assigned.");
			}
		}

		service = {
			service_id: options.id,
			type: "patroni",
			sync_mode: options.syncMode,
			read_write_port: readWritePort,
			read_only_port: readOnlyPort,
		};
	}

	clusterConfig.setService(service);
	await syncConfigToCluster(clusterConfig);

	stream.sendOutput(JSON.stringify(service, null, 2));
}
