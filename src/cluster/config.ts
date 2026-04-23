import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { ClusterInfo, ClusterInfoSchema, NodeInfo, NodeInfoSchema } from "../models/config";
import { ClusterConfigError, MaximumNodesReachedError, NoClusterConfigError, NodeAlreadyExistsError } from "../errors/configErrors";
import { generateWireguardKeys, setupWireguardInterface, syncWireguardPeers } from "../adapters/wireguard";
import { parseOrThrow } from "../utils/zod";
import z from "zod";

export const CONFIG_VERSION = 1;
export const CONFIG_PATH_CLUSTER = "/etc/linux-paas/config.json";
export const CONFIG_PATH_NODES = "/etc/linux-paas/nodes.json";
export const CONFIG_WIREGUARD_CIDR = 24;
export const CONFIG_WIREGUARD_NETWORK_IP = [10, 0, 0, 0];
export const CONFIG_WIREGUARD_LISTEN_PORT = 51820;

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

	private constructor(state: ClusterInfo, nodes: ClusterNode[] = []) {
		parseOrThrow(ClusterInfoSchema, state, new ClusterConfigError());
		this.config = state;
		this.nodes_internal = nodes;
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
		);
	}

	static fromJSON(clusterData: unknown, nodesData: unknown): Cluster {
		const clusterInfo = parseOrThrow(ClusterInfoSchema, clusterData, new ClusterConfigError());
		const nodesInfo = parseOrThrow(z.array(NodeInfoSchema).min(1), nodesData, new ClusterConfigError());

		const nodes = nodesInfo.map((nodeInfo) => new ClusterNode(nodeInfo));
		return new Cluster(clusterInfo, nodes);
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

	getCopy(): ClusterInfo {
		return { ...this.config };
	}

	getNodesCopy(): NodeInfo[] {
		return this.nodes_internal.map((node) => node.getCopy());
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

export function saveClusterConfigToDisk(config: Cluster): void {
	const configCopy = config.getCopy();
	const nodesCopy = config.getNodesCopy();

	fs.mkdirSync(path.dirname(CONFIG_PATH_CLUSTER), { recursive: true });
	fs.mkdirSync(path.dirname(CONFIG_PATH_NODES), { recursive: true });

	fs.writeFileSync(CONFIG_PATH_CLUSTER, JSON.stringify(configCopy, null, 2));
	fs.writeFileSync(CONFIG_PATH_NODES, JSON.stringify(nodesCopy, null, 2));
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

// Load cluster config from disk if there is one.
if (fs.existsSync(CONFIG_PATH_CLUSTER)) {
	const clusterConfigJson = JSON.parse(fs.readFileSync(CONFIG_PATH_CLUSTER, "utf8"));

	let clusterNodesJson = [];
	if (fs.existsSync(CONFIG_PATH_NODES)) {
		clusterNodesJson = JSON.parse(fs.readFileSync(CONFIG_PATH_NODES, "utf8"));
	}

	const config = Cluster.fromJSON(clusterConfigJson, clusterNodesJson);
	clusterConfigSingleton = config;
	syncWireguardPeersFromClusterConfig();
}
