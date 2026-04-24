import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { ClusterInfo, ClusterInfoSchema, ClusterService, ClusterServiceSchema, NodeInfo, NodeInfoSchema } from "../models/config";
import { ClusterConfigError, MaximumNodesReachedError, NoClusterConfigError, NodeAlreadyExistsError } from "../errors/configErrors";
import { generateWireguardKeys, setupWireguardInterface, syncWireguardPeers } from "../adapters/wireguard";
import { parseOrThrow } from "../utils/zod";
import z from "zod";
import fetch from "node-fetch";
import { delay } from "../utils/misc";
import { StartupPingResponseSchema } from "../models/networking";

export const CONFIG_VERSION = 1;
export const CONFIG_PATH_CLUSTER = "/etc/linux-paas/config.json";
export const CONFIG_PATH_NODES = "/etc/linux-paas/nodes.json";
export const CONFIG_PATH_SERVICES = "/etc/linux-paas/services.json";
export const CONFIG_WIREGUARD_CIDR = 24;
export const CONFIG_WIREGUARD_NETWORK_IP = [10, 0, 0, 0];
export const CONFIG_WIREGUARD_LISTEN_PORT = 51820;
const CONFIG_PING_RETRY_DELAY_MS = 5_000;

export class ClusterNode {
	private readonly config: NodeInfo;

	constructor(config: NodeInfo) {
		parseOrThrow(NodeInfoSchema, config, new ClusterConfigError());
		this.config = config;
	}

	static create(node_id: number, hostname: string, publicIp: string, wireguardPublicKey: string): ClusterNode {
		const newNodeConfig = {
			node_id: node_id,
			hostname: hostname,
			public_ip: publicIp,
			wireguard_public_key: wireguardPublicKey,
		};
		return new ClusterNode(newNodeConfig);
	}

	get id(): number {
		return this.config.node_id;
	}

	get hostname(): string {
		return this.config.hostname;
	}

	get publicIp(): string {
		return this.config.public_ip;
	}

	get wireguardPublicKey(): string {
		return this.config.wireguard_public_key;
	}

	get wireguardIp(): string {
		return `${CONFIG_WIREGUARD_NETWORK_IP[0]}.${CONFIG_WIREGUARD_NETWORK_IP[1]}.${CONFIG_WIREGUARD_NETWORK_IP[2]}.${this.config.node_id}`;
	}

	get wireguardEndpoint(): string {
		return `${this.wireguardIp}:${CONFIG_WIREGUARD_LISTEN_PORT}`;
	}

	getCopy(): NodeInfo {
		return { ...this.config };
	}
}

export class Cluster {
	private config: ClusterInfo;
	private nodes_internal: ClusterNode[];
	private services_internal: ClusterService[];

	private constructor(state: ClusterInfo, nodes: ClusterNode[] = [], services: ClusterService[] = []) {
		parseOrThrow(ClusterInfoSchema, state, new ClusterConfigError());
		this.config = state;
		this.nodes_internal = nodes;
		this.services_internal = services;
		setupWireguardInterface();
	}

	static create(coordinatorHostname: string, coordinatorPublicIp: string): Cluster {
		const coordinatorWgPublicKey = generateWireguardKeys();
		const coordinatorNode = ClusterNode.create(1, coordinatorHostname, coordinatorPublicIp, coordinatorWgPublicKey);
		const now = new Date().toISOString();

		return new Cluster(
			{
				cluster_id: crypto.randomUUID(),
				access_key: crypto.randomBytes(32).toString("base64url"),
				version: CONFIG_VERSION,
				created_at: now,
				updated_at: now,
				coordinator_node_id: coordinatorNode.id,
				leader_node_id: coordinatorNode.id,
			},
			[coordinatorNode],
			[],
		);
	}

	static fromJSON(clusterData: unknown, nodesData: unknown, servicesData: unknown = []): Cluster {
		const clusterInfo = parseOrThrow(ClusterInfoSchema, clusterData, new ClusterConfigError());
		const nodesInfo = parseOrThrow(z.array(NodeInfoSchema).min(1), nodesData, new ClusterConfigError());
		const servicesInfo = parseOrThrow(z.array(ClusterServiceSchema), servicesData, new ClusterConfigError());

		const nodes = nodesInfo.map((nodeInfo) => new ClusterNode(nodeInfo));
		return new Cluster(clusterInfo, nodes, servicesInfo);
	}

	get clusterId(): string {
		return this.config.cluster_id;
	}

	get accessKey(): string {
		return this.config.access_key;
	}

	get createdAt(): string {
		return this.config.created_at;
	}

	get updatedAt(): string {
		return this.config.updated_at;
	}

	get coordinatorNode(): ClusterNode {
		return this.nodes_internal.find((node) => node.id === this.config.coordinator_node_id)!;
	}

	get leaderNode(): ClusterNode | null {
		return this.config.leader_node_id ? this.nodes_internal.find((node) => node.id === this.config.leader_node_id) || null : null;
	}

	get nodes(): ClusterNode[] {
		return [...this.nodes_internal];
	}

	get services(): ClusterService[] {
		return [...this.services_internal];
	}

	joinNode(hostname: string, publicIp: string, wgPublicKey: string): void {
		const wireguardIpExists = this.nodes_internal.some((node) => node.wireguardPublicKey === wgPublicKey);
		const publicIpExists = this.nodes_internal.some((node) => node.publicIp === publicIp);

		if (wireguardIpExists || publicIpExists) {
			throw new NodeAlreadyExistsError();
		}

		const assignedNodeIds = new Set(this.nodes_internal.map((node) => node.id));
		let nextNodeId: number | null = null;
		for (let i = 1; i <= 255; i++) {
			if (!assignedNodeIds.has(i)) {
				nextNodeId = i;
				break;
			}
		}

		if (nextNodeId === null) {
			throw new MaximumNodesReachedError();
		}

		const newNode = ClusterNode.create(nextNodeId, hostname, publicIp, wgPublicKey);

		this.nodes_internal.push(newNode);
		this.config.updated_at = new Date().toISOString();
		saveClusterConfigToDisk(this);
		syncWireguardPeersFromClusterConfig();
	}

	setService(service: ClusterService): void {
		parseOrThrow(ClusterServiceSchema, service, new ClusterConfigError());

		const existingServiceIndex = this.services_internal.findIndex(
			(existingService) => existingService.service_id === service.service_id && existingService.type === service.type,
		);
		if (existingServiceIndex === -1) {
			this.services_internal.push(service);
		} else {
			this.services_internal[existingServiceIndex] = service;
		}

		this.config.updated_at = new Date().toISOString();
		saveClusterConfigToDisk(this);
	}

	getCopy(): ClusterInfo {
		return { ...this.config };
	}

	getNodesCopy(): NodeInfo[] {
		return this.nodes_internal.map((node) => node.getCopy());
	}

	getServicesCopy(): ClusterService[] {
		return this.services_internal.map((service) => ({ ...service }));
	}
}

var clusterConfigSingleton: Cluster | null = null;

function syncWireguardPeersFromClusterConfig(): void {
	setupWireguardInterface();

	try {
		const localHostname = os.hostname();
		const other_nodes = clusterConfigSingleton?.nodes
			.filter((node) => node.hostname !== localHostname)
			.map((node) => ({
				publicKey: node.wireguardPublicKey,
				endpoint: `${node.publicIp}:${CONFIG_WIREGUARD_LISTEN_PORT}`,
				allowedIp: `${node.wireguardIp}/32`,
			}));

		syncWireguardPeers(other_nodes ?? []);
	} catch (error) {
		console.error(`Failed to update WireGuard peers from cluster config: ${error instanceof Error ? error.message : "Unknown error."}`);
	}
}

export function getConfigPayload(): { cluster: ClusterInfo; nodes: NodeInfo[]; services: ClusterService[] } {
	if (!clusterConfigSingleton) {
		throw new NoClusterConfigError();
	}

	return {
		cluster: clusterConfigSingleton.getCopy(),
		nodes: clusterConfigSingleton.getNodesCopy(),
		services: clusterConfigSingleton.getServicesCopy(),
	};
}

export function getClusterConfigHash(): string {
	const payload = getConfigPayload();
	payload.nodes.sort((left, right) => left.node_id - right.node_id);
	payload.services.sort((left, right) => left.service_id.localeCompare(right.service_id));
	return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function saveClusterConfigToDisk(config: Cluster): void {
	const configCopy = config.getCopy();
	const nodesCopy = config.getNodesCopy();
	const servicesCopy = config.getServicesCopy();

	fs.mkdirSync(path.dirname(CONFIG_PATH_CLUSTER), { recursive: true });
	fs.mkdirSync(path.dirname(CONFIG_PATH_NODES), { recursive: true });
	fs.mkdirSync(path.dirname(CONFIG_PATH_SERVICES), { recursive: true });

	fs.writeFileSync(CONFIG_PATH_CLUSTER, JSON.stringify(configCopy, null, 2));
	fs.writeFileSync(CONFIG_PATH_NODES, JSON.stringify(nodesCopy, null, 2));
	fs.writeFileSync(CONFIG_PATH_SERVICES, JSON.stringify(servicesCopy, null, 2));
}

export function applyClusterConfig(clusterData: unknown, nodesData: unknown, servicesData: unknown = []): Cluster {
	const config = Cluster.fromJSON(clusterData, nodesData, servicesData);
	setClusterConfig(config);
	saveClusterConfigToDisk(config);
	return config;
}

export async function syncConfigToCluster(clusterConfig: Cluster, ignoredNodeIds: number[] = []): Promise<void> {
	const configPayload = JSON.stringify({
		cluster: clusterConfig.getCopy(),
		nodes: clusterConfig.getNodesCopy(),
		services: clusterConfig.getServicesCopy(),
	});

	const ignoredNodeSet = new Set(ignoredNodeIds);
	const nodesToUpdate = clusterConfig.nodes.filter((node) => node.id !== clusterConfig.coordinatorNode.id && !ignoredNodeSet.has(node.id));

	await Promise.all(
		nodesToUpdate.map(async (node) => {
			try {
				const updateResponse = await fetch(`http://${node.wireguardIp}:8080/set_config`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-access-key": clusterConfig.accessKey,
					},
					body: configPayload,
				});

				if (updateResponse.ok) {
					return;
				}

				const responseBody = await updateResponse.text();
				console.warn(`Failed to sync config to ${node.hostname} (${updateResponse.status}): ${responseBody}`);
			} catch (error) {
				console.warn(`Failed to sync config to ${node.hostname}: ${error instanceof Error ? error.message : "Unknown error."}`);
			}
		}),
	);
}

export function setClusterConfig(config: Cluster): void {
	clusterConfigSingleton = config;
	syncWireguardPeersFromClusterConfig();
}

export function hasClusterConfig(): boolean {
	return !!clusterConfigSingleton;
}

export function getClusterConfig() {
	if (clusterConfigSingleton === null) {
		throw new NoClusterConfigError();
	}

	return clusterConfigSingleton;
}

async function syncClusterConfigFromCoordinatorOnStartup(): Promise<void> {
	while (true) {
		if (!hasClusterConfig()) return;
		const clusterConfig = getClusterConfig();
		if (clusterConfig.coordinatorNode.hostname === os.hostname()) return;

		await delay(1000);

		try {
			const startupPingResponse = await fetch(`http://${clusterConfig.coordinatorNode.wireguardIp}:8080/startup_ping`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-access-key": clusterConfig.accessKey,
				},
				body: JSON.stringify({ config_hash: getClusterConfigHash() }),
			});

			const responseBody = await startupPingResponse.text();

			if (!startupPingResponse.ok) {
				console.warn(`Failed startup ping (${startupPingResponse.status}): ${responseBody}. Retrying...`);
				await delay(CONFIG_PING_RETRY_DELAY_MS);
				continue;
			}

			let responseJson: unknown;
			try {
				responseJson = JSON.parse(responseBody);
			} catch {
				console.warn("Startup ping response is not valid JSON. Retrying...");
				await delay(CONFIG_PING_RETRY_DELAY_MS);
				continue;
			}

			const startupPingResponseResult = StartupPingResponseSchema.safeParse(responseJson);
			if (!startupPingResponseResult.success) {
				console.warn("Startup ping response is invalid. Retrying...");
				await delay(CONFIG_PING_RETRY_DELAY_MS);
				continue;
			}

			if (startupPingResponseResult.data.up_to_date) {
				console.log("Cluster config has not changed since last connection.");
				return;
			}

			if (startupPingResponseResult.data.cluster === undefined || startupPingResponseResult.data.nodes === undefined) {
				console.warn("Startup ping response is missing cluster data. Retrying...");
				await delay(CONFIG_PING_RETRY_DELAY_MS);
				continue;
			}

			applyClusterConfig(startupPingResponseResult.data.cluster, startupPingResponseResult.data.nodes, startupPingResponseResult.data.services);
			console.log("Synchronized cluster config on startup.");
			return;
		} catch (error) {
			console.warn(`Coordinator is not ready for startup sync. Retrying...`);
			await delay(CONFIG_PING_RETRY_DELAY_MS);
		}
	}
}

// Load cluster config from disk if there is one.
if (fs.existsSync(CONFIG_PATH_CLUSTER)) {
	const clusterConfigJson = JSON.parse(fs.readFileSync(CONFIG_PATH_CLUSTER, "utf8"));

	let clusterNodesJson = [];
	if (fs.existsSync(CONFIG_PATH_NODES)) {
		clusterNodesJson = JSON.parse(fs.readFileSync(CONFIG_PATH_NODES, "utf8"));
	}

	let clusterServicesJson = [];
	if (fs.existsSync(CONFIG_PATH_SERVICES)) {
		clusterServicesJson = JSON.parse(fs.readFileSync(CONFIG_PATH_SERVICES, "utf8"));
	}

	const config = Cluster.fromJSON(clusterConfigJson, clusterNodesJson, clusterServicesJson);
	clusterConfigSingleton = config;
	syncWireguardPeersFromClusterConfig();
}

syncClusterConfigFromCoordinatorOnStartup();
