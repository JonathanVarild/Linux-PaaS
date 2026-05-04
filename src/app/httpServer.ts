import express from "express";
import os from "os";
import { applyClusterConfig, getClusterConfig, getClusterConfigHash, getConfigPayload, hasClusterConfig } from "../cluster/config";
import { ClusterConfigRequestSchema, StartupPingRequestSchema } from "../models/networking";
import { HTTP_DAEMON_PORT } from "../constants";

export const expressApp = express();

expressApp.use(express.json());

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
 * Endpoint for coordinator where nodes send a startup ping to check if their config is up to date and to retrieve the latest config if not.
 */
expressApp.post("/startup_ping", (req: express.Request, res: express.Response) => {
	const startupPingRequestResult = StartupPingRequestSchema.safeParse(req.body);
	if (!startupPingRequestResult.success) {
		res.status(400).send("Startup ping payload is invalid.");
		return;
	}

	const clusterConfig = getClusterConfig();
	if (clusterConfig.coordinatorNode.hostname !== os.hostname()) {
		res.status(409).send("Only the coordinator node can process startup pings.");
		return;
	}

	if (startupPingRequestResult.data.config_hash === getClusterConfigHash()) {
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

expressApp.listen(HTTP_DAEMON_PORT, () => {
	console.log(`HTTP server is listening on port ${HTTP_DAEMON_PORT}`);
});
