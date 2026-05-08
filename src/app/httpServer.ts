import { execFile } from "child_process";
import express from "express";
import os from "os";
import { isPatroniLeader } from "../adapters/patroni";
import { attemptLeaderElection } from "../cluster/leaderElection";
import { applyClusterConfig, getClusterConfig, getClusterConfigHash, getConfigPayload, hasClusterConfig } from "../cluster/config";
import { nodeNeedsReboot } from "../cluster/healthManager";
import { ClusterConfigRequestSchema, ConfigCheckRequestSchema, LeaderElectionRequestSchema } from "../models/networking";
import { HTTP_DAEMON_PORT, REBOOT_REQUIRED_LOAD_VALUE } from "../constants";

export const expressApp = express();

const REBOOT_RETRY_COUNT = 3;

expressApp.use(express.json());

/**
 * Function to get a list of patroni services that the local node is currently the leader of.
 * @returns A promise that resolves to a list of service IDs that the local node is the leader of.
 */
async function getLocalPatroniLeaderships(): Promise<string[]> {
	const clusterConfig = getClusterConfig();
	const leaderServiceChecks = await Promise.all(
		clusterConfig.getSortedServices().map(async ([serviceId, service]) => {
			if (service.type !== "patroni") return null;
			return (await isPatroniLeader(service)) ? serviceId : null;
		}),
	);

	return leaderServiceChecks.filter((serviceId): serviceId is string => serviceId !== null);
}

/**
 * Function that waits up to 15 seconds for the local node to be ready for a reboot.
 * @returns A promise that resolves to true if the node is ready for reboot or false if its still a patroni leader after 15 sec.
 */
async function waitUntilRebootSafe(): Promise<boolean> {
	for (let attempt = 0; attempt < 2; attempt++) {
		if ((await getLocalPatroniLeaderships()).length === 0) return true;
		await new Promise((resolve) => setTimeout(resolve, 5000));
	}

	return false;
}

expressApp.use((err: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
	if (err instanceof SyntaxError) {
		res.status(400).send("JSON is invalid, please try again.");
		return;
	}
	next(err);
});

// Middleware to validate access token and that cluster config is available.
expressApp.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
	if (!hasClusterConfig()) {
		res.status(503).send("Cluster configuration is not available.");
		return;
	}

	if (req.headers["x-access-key"] !== getClusterConfig().accessKey) {
		res.status(401).send("Access key is invalid, please try again.");
		return;
	}
	next();
});

/**
 * Endpoint for health checks to verify that the node is responsive.
 */
expressApp.get("/ping", (_req: express.Request, res: express.Response) => {
	res.status(204).send();
});

/**
 * Endpoint for coordinator where nodes check if their config is up to date and retrieve the latest config if not.
 */
expressApp.post("/config_check", (req: express.Request, res: express.Response) => {
	const configCheckRequestResult = ConfigCheckRequestSchema.safeParse(req.body);
	if (!configCheckRequestResult.success) {
		res.status(400).send("Config check payload is invalid.");
		return;
	}

	const clusterConfig = getClusterConfig();
	if (clusterConfig.coordinatorNode.hostname !== os.hostname()) {
		res.status(409).send("Only the coordinator node can process config checks.");
		return;
	}

	if (configCheckRequestResult.data.config_hash === getClusterConfigHash()) {
		res.json({ up_to_date: true });
		return;
	}

	res.json({
		up_to_date: false,
		...getConfigPayload(),
	});
});

/**
 * Endpoint for nodes to receive cluster config updates from coordinator.
 */
expressApp.post("/set_config", (req: express.Request, res: express.Response) => {
	const payloadResult = ClusterConfigRequestSchema.safeParse(req.body);
	if (!payloadResult.success) {
		res.status(400).send("Config update payload is invalid.");
		return;
	}

	try {
		applyClusterConfig(payloadResult.data.cluster, payloadResult.data.nodes, payloadResult.data.services);
		res.status(204).send();
	} catch {
		res.status(400).send("Config update payload is invalid.");
	}
});

/**
 * Endpoint for nodes to report their status to the coordinator during leader election.
 * Returns the nodes' current 5 minute load average and which nodes it considers offline.
 */
expressApp.get("/get_node_status", async (_req: express.Request, res: express.Response) => {
	res.json({
		load_value: (await nodeNeedsReboot()) ? REBOOT_REQUIRED_LOAD_VALUE : (os.loadavg()[1] ?? 0),
		offline_node_ids: getClusterConfig()
			.nodes.filter((node) => !node.status)
			.map((node) => node.id),
	});
});

/**
 * Endpoint for coordinator to receive leader election requests.
 */
expressApp.post("/request_leader_election", (req: express.Request, res: express.Response) => {
	// Ensure that the leader election request is valid.
	const payloadResult = LeaderElectionRequestSchema.safeParse(req.body);
	if (!payloadResult.success) {
		res.status(400).send("Leader election payload is invalid.");
		return;
	}

	const clusterConfig = getClusterConfig();

	// Ensure that we are the coordinator.
	if (clusterConfig.coordinatorNode.hostname !== os.hostname()) {
		res.status(409).send("Only the coordinator node can process leader election requests.");
		return;
	}

	// Ensure that the requesting node's config is up to date.
	if (payloadResult.data.config_hash !== getClusterConfigHash()) {
		res.status(409).send("Reporting node config is out of date.");
		return;
	}

	// Attempt a leader election.
	if (attemptLeaderElection(true)) {
		res.status(202).send();
	} else {
		res.status(409).send("Failed to initiate leader election.");
	}
});

expressApp.post("/get_node_report", async (_req: express.Request, res: express.Response) => {
	// Respond with the data.
	res.json({
		average_load: os.loadavg()[1] ?? 0,
		requires_restart: await nodeNeedsReboot(),
		patroni_leaderships: await getLocalPatroniLeaderships(),
	});
});

expressApp.post("/reboot", async (_req: express.Request, res: express.Response) => {
	if (!(await waitUntilRebootSafe())) {
		console.warn("Reboot cancelled to avoid instability, node is currently a patroni leader.");
		res.status(409).send("Node is currently a patroni leader, reboot cancelled to avoid instability.");
		return;
	}

	res.status(202).send();
	setTimeout(() => {
		execFile("reboot", [], (error) => {
			if (error) {
				console.warn(`Failed to reboot node: ${error.message}`);
			}
		});
	}, 1000);
});

expressApp.listen(HTTP_DAEMON_PORT, () => {
	console.log(`HTTP server is listening on port ${HTTP_DAEMON_PORT}`);
});
