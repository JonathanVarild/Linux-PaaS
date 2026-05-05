import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import {
	ClusterInfo,
	ClusterInfoSchema,
	ClusterService,
	ClusterServiceSchema,
	ClusterServices,
	ClusterServicesSchema,
	NodeInfo,
	NodeInfoSchema,
	PatroniService,
	WebService,
} from "../models/config";
import {
	ClusterConfigError,
	CouldNotFindNodeError,
	MaximumNodesReachedError,
	NoClusterConfigError,
	NodeAlreadyExistsError,
	ServiceIdConflictError,
	ServicePortAllocationError,
} from "../errors/configErrors";
import { generateWireguardKeys, setupWireguardInterface, syncWireguardPeers } from "../adapters/wireguard";
import { parseOrThrow } from "../utils/zod";
import z from "zod";
import fetch from "node-fetch";
import { delay } from "../utils/misc";
import { StartupPingResponseSchema } from "../models/networking";
import { requestLeaderElection, attemptLeaderElection } from "./leaderElection";
import { setupServices } from "./serviceDeployment";
import {
	CONFIG_PATH_CONFIG,
	CONFIG_PATH_NODES,
	CONFIG_PATH_SERVICES,
	CONFIG_PING_RETRY_DELAY_MS,
	CONFIG_VERSION,
	HTTP_DAEMON_PORT,
	LEADER_ELECTION_INTERVAL_MS,
	LEADER_ELECTION_MAX_RETRIES,
	NODE_PING_INTERVAL_MS,
	PATRONI_PORT_START,
	PATRONI_REST_PORT_START,
	WEB_EXPOSED_PORT_START,
	WIREGUARD_LISTEN_PORT,
	WIREGUARD_NETWORK_PREFIX,
} from "../constants";

export class ClusterNode {
	private readonly config: NodeInfo;
	private nodeStatus: boolean;
	private failedPings: number;

	constructor(config: NodeInfo) {
		parseOrThrow(NodeInfoSchema, config, new ClusterConfigError());
		this.config = config;
		this.nodeStatus = config.hostname === os.hostname();
		this.failedPings = 0;
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
		return `${WIREGUARD_NETWORK_PREFIX}.${this.config.node_id}`;
	}

	get status(): boolean {
		return this.nodeStatus || this.config.hostname === os.hostname();
	}

	get failedPingCount(): number {
		return this.failedPings;
	}

	getCopy(): NodeInfo {
		return { ...this.config };
	}

	async ping(): Promise<void> {
		if (!hasClusterConfig() || this.config.hostname === os.hostname()) return;

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);

		try {
			const response = await fetch(`http://${this.wireguardIp}:${HTTP_DAEMON_PORT}/ping`, {
				headers: {
					"x-access-key": getClusterConfig().accessKey,
				},
				signal: controller.signal,
			});

			if (response.ok) {
				this.nodeStatus = true;
				this.failedPings = 0;
				return;
			}
		} catch {
		} finally {
			clearTimeout(timeout);
		}

		this.nodeStatus = false;
		this.failedPings += 1;
	}
}

export class Cluster {
	private config: ClusterInfo;
	private nodes_internal: ClusterNode[];
	private services_internal: ClusterServices;

	private constructor(state: ClusterInfo, nodes: ClusterNode[] = [], services: ClusterServices = {}) {
		parseOrThrow(ClusterInfoSchema, state, new ClusterConfigError());
		this.config = state;
		this.nodes_internal = sortClusterNodes(nodes);
		this.services_internal = services;
		validateClusterConfig(this.config, this.nodes_internal);
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
			{},
		);
	}

	static fromJSON(clusterData: unknown, nodesData: unknown, servicesData: unknown = {}): Cluster {
		const clusterInfo = parseOrThrow(ClusterInfoSchema, clusterData, new ClusterConfigError());
		const nodesInfo = parseOrThrow(z.array(NodeInfoSchema).min(1), nodesData, new ClusterConfigError());
		const servicesInfo = parseOrThrow(ClusterServicesSchema, servicesData, new ClusterConfigError());

		const nodes = nodesInfo.map((nodeInfo) => new ClusterNode(nodeInfo));
		return new Cluster(clusterInfo, nodes, servicesInfo);
	}

	static async pingNodes(): Promise<void> {
		if (!hasClusterConfig()) return;

		const clusterConfig = getClusterConfig();
		const leaderNode = clusterConfig.leaderNode;

		await Promise.all(
			clusterConfig.nodes.map(async (node) => {
				if (node.hostname === os.hostname()) return;
				await node.ping();
			}),
		);

		// Return if we are the leader.
		if (leaderNode.hostname === os.hostname()) return;

		// Return if leader is online, or offline but haven't reached retry threshold.
		if (leaderNode.status || leaderNode.failedPingCount === 0 || leaderNode.failedPingCount % LEADER_ELECTION_MAX_RETRIES !== 0) return;

		// Request a leader election.
		await requestLeaderElection();
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

	get leaderNode(): ClusterNode {
		return this.nodes_internal.find((node) => node.id === this.config.leader_node_id)!;
	}

	get nodes(): ClusterNode[] {
		return [...this.nodes_internal];
	}

	getNodeById(nodeId: number): ClusterNode | null {
		return this.nodes_internal.find((node) => node.id === nodeId) ?? null;
	}

	getNodeByHostname(hostname: string): ClusterNode | null {
		return this.nodes_internal.find((node) => node.hostname === hostname) ?? null;
	}

	getLocalNode(): ClusterNode {
		const localNode = this.getNodeByHostname(os.hostname());
		if (!localNode) throw new CouldNotFindNodeError();
		return localNode;
	}

	isCoordinatorNode(node: ClusterNode): boolean {
		return this.coordinatorNode.id === node.id;
	}

	setLeaderNode(nodeId: number): boolean {
		if (!this.getNodeById(nodeId)) throw new CouldNotFindNodeError();
		if (this.config.leader_node_id === nodeId) return false;

		this.config.leader_node_id = nodeId;
		this.config.updated_at = new Date().toISOString();
		saveClusterConfigToDisk(this);
		return true;
	}

	getSortedServices(): Array<[string, ClusterService]> {
		return Object.entries(this.services_internal).sort(([left], [right]) => left.localeCompare(right));
	}

	joinNode(hostname: string, publicIp: string, wgPublicKey: string): void {
		const hostnameExists = this.nodes_internal.some((node) => node.hostname === hostname);
		const wireguardPublicKeyExists = this.nodes_internal.some((node) => node.wireguardPublicKey === wgPublicKey);
		const publicIpExists = this.nodes_internal.some((node) => node.publicIp === publicIp);

		if (hostnameExists || wireguardPublicKeyExists || publicIpExists) {
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
		this.nodes_internal = sortClusterNodes(this.nodes_internal);
		this.config.updated_at = new Date().toISOString();
		saveClusterConfigToDisk(this);
		syncWireguardPeersFromClusterConfig();
	}

	setWebService(service_id: string, image: string, domain: string, internal_port: number): WebService {
		const existingService = this.getService(service_id);
		if (existingService && existingService.type !== "web") throw new ServiceIdConflictError(service_id);

		const usedPorts = listUsedServicePorts(this.services_internal, service_id);
		const service: WebService = {
			service_id,
			image,
			domain,
			internal_port,
			type: "web",
			exposed_port: allocatePort(usedPorts, WEB_EXPOSED_PORT_START, existingService?.exposed_port),
		};

		this.setService(service);
		return service;
	}

	setPatroniService(service_id: string, sync_mode: "async" | "sync"): PatroniService {
		const existingService = this.getService(service_id);
		if (existingService && existingService.type !== "patroni") throw new ServiceIdConflictError(service_id);

		const usedPorts = listUsedServicePorts(this.services_internal, service_id);
		const service: PatroniService = {
			service_id,
			sync_mode,
			type: "patroni",
			postgres_port: allocatePort(usedPorts, PATRONI_PORT_START, existingService?.postgres_port),
			read_write_port: allocatePort(usedPorts, PATRONI_PORT_START, existingService?.read_write_port),
			read_only_port: allocatePort(usedPorts, PATRONI_PORT_START, existingService?.read_only_port),
			patroni_rest_port: allocatePort(usedPorts, PATRONI_REST_PORT_START, existingService?.patroni_rest_port),
		};

		this.setService(service);
		return service;
	}

	private setService(service: ClusterService): void {
		parseOrThrow(ClusterServiceSchema, service, new ClusterConfigError());
		const existingService = this.services_internal[service.service_id];
		if (existingService && existingService.type !== service.type) {
			throw new ServiceIdConflictError(service.service_id);
		}

		this.services_internal[service.service_id] = service;
		this.config.updated_at = new Date().toISOString();
		saveClusterConfigToDisk(this);
	}

	getService(serviceId: string): ClusterService | null {
		return this.services_internal[serviceId] ?? null;
	}

	getCopy(): ClusterInfo {
		return { ...this.config };
	}

	getNodesCopy(): NodeInfo[] {
		return this.nodes.map((node) => node.getCopy());
	}

	getServicesCopy(): ClusterServices {
		return Object.fromEntries(Object.entries(this.services_internal).map(([serviceId, service]) => [serviceId, { ...service }]));
	}
}

var clusterConfigSingleton: Cluster | null = null;

function syncWireguardPeersFromClusterConfig(): void {
	setupWireguardInterface();

	try {
		const localNode = clusterConfigSingleton?.getLocalNode();
		const otherNodes = clusterConfigSingleton?.nodes
			.filter((node) => node.id !== localNode?.id)
			.map((node) => ({
				publicKey: node.wireguardPublicKey,
				endpoint: `${node.publicIp}:${WIREGUARD_LISTEN_PORT}`,
				allowedIp: `${node.wireguardIp}/32`,
			}));

		syncWireguardPeers(otherNodes ?? []);
	} catch (error) {
		console.error(`Failed to update WireGuard peers from cluster config: ${error instanceof Error ? error.message : "Unknown error."}`);
	}
}

export function getConfigPayload(): { cluster: ClusterInfo; nodes: NodeInfo[]; services: ClusterServices } {
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
	const clusterConfig = getClusterConfig();

	const sortedPayload = {
		cluster: clusterConfig.getCopy(),
		nodes: clusterConfig.getNodesCopy(),
		services: Object.fromEntries(clusterConfig.getSortedServices()),
	};

	return crypto.createHash("sha256").update(JSON.stringify(sortedPayload)).digest("hex");
}

export function saveClusterConfigToDisk(config: Cluster): void {
	const configCopy = config.getCopy();
	const nodesCopy = config.getNodesCopy();
	const servicesCopy = config.getServicesCopy();

	fs.mkdirSync(path.dirname(CONFIG_PATH_CONFIG), { recursive: true });
	fs.mkdirSync(path.dirname(CONFIG_PATH_NODES), { recursive: true });
	fs.mkdirSync(path.dirname(CONFIG_PATH_SERVICES), { recursive: true });

	fs.writeFileSync(CONFIG_PATH_CONFIG, JSON.stringify(configCopy, null, 2));
	fs.writeFileSync(CONFIG_PATH_NODES, JSON.stringify(nodesCopy, null, 2));
	fs.writeFileSync(CONFIG_PATH_SERVICES, JSON.stringify(servicesCopy, null, 2));
	setupServices(config);
}

export function applyClusterConfig(clusterData: unknown, nodesData: unknown, servicesData: unknown = {}): Cluster {
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
				const updateResponse = await fetch(`http://${node.wireguardIp}:${HTTP_DAEMON_PORT}/set_config`, {
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
			const startupPingResponse = await fetch(`http://${clusterConfig.coordinatorNode.wireguardIp}:${HTTP_DAEMON_PORT}/startup_ping`, {
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

function listUsedServicePorts(services: ClusterServices, excludedId?: string): Set<number> {
	const usedPorts = new Set<number>();

	for (const [id, service] of Object.entries(services)) {
		if (id === excludedId) continue;

		if (service.type === "web") {
			if (service.exposed_port !== undefined) {
				usedPorts.add(service.exposed_port);
			}
		} else {
			if (service.postgres_port !== undefined) usedPorts.add(service.postgres_port);
			if (service.read_write_port !== undefined) usedPorts.add(service.read_write_port);
			if (service.read_only_port !== undefined) usedPorts.add(service.read_only_port);
			if (service.patroni_rest_port !== undefined) usedPorts.add(service.patroni_rest_port);
		}
	}

	return usedPorts;
}

function allocatePort(usedPorts: Set<number>, startPort: number, requestedPort: number | undefined): number {
	if (requestedPort && !usedPorts.has(requestedPort)) {
		usedPorts.add(requestedPort);
		return requestedPort;
	}

	for (let port = startPort; port <= 65535; port++) {
		if (usedPorts.has(port)) continue;
		usedPorts.add(port);
		return port;
	}

	throw new ServicePortAllocationError();
}

function validateClusterConfig(config: ClusterInfo, nodes: ClusterNode[]): void {
	const validCoordinatorNodeExists = nodes.some((node) => node.id === config.coordinator_node_id);
	const validLeaderNodeExists = nodes.some((node) => node.id === config.leader_node_id);

	if (!validCoordinatorNodeExists || !validLeaderNodeExists) throw new ClusterConfigError();

	const hostnames = new Set<string>();
	for (const node of nodes) {
		if (hostnames.has(node.hostname)) {
			throw new ClusterConfigError();
		}

		hostnames.add(node.hostname);
	}
}

function sortClusterNodes(nodes: ClusterNode[]): ClusterNode[] {
	return [...nodes].sort((left, right) => left.id - right.id);
}

// Load cluster config from disk if there is one.
if (fs.existsSync(CONFIG_PATH_CONFIG)) {
	const clusterConfigJson = JSON.parse(fs.readFileSync(CONFIG_PATH_CONFIG, "utf8"));

	let clusterNodesJson = [];
	if (fs.existsSync(CONFIG_PATH_NODES)) {
		clusterNodesJson = JSON.parse(fs.readFileSync(CONFIG_PATH_NODES, "utf8"));
	}

	let clusterServicesJson = {};
	if (fs.existsSync(CONFIG_PATH_SERVICES)) {
		clusterServicesJson = JSON.parse(fs.readFileSync(CONFIG_PATH_SERVICES, "utf8"));
	}

	const config = Cluster.fromJSON(clusterConfigJson, clusterNodesJson, clusterServicesJson);
	clusterConfigSingleton = config;
	syncWireguardPeersFromClusterConfig();
	setupServices(config);
}

syncClusterConfigFromCoordinatorOnStartup();
setInterval(Cluster.pingNodes, NODE_PING_INTERVAL_MS);
setInterval(() => {
	if (!hasClusterConfig()) return;
	attemptLeaderElection();
}, LEADER_ELECTION_INTERVAL_MS);
