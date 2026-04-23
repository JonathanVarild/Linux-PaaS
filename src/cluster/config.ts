import crypto from "crypto";
import { ClusterInfo, ClusterInfoSchema, NodeInfo, NodeInfoSchema } from "../models/config";
import { ClusterConfigError, MaximumNodesReachedError, NoClusterConfigError, NodeAlreadyExistsError } from "../errors/configErrors";
import { generateWireguardKeys } from "../adapters/wireguard";
import { parseOrThrow } from "../utils/zod";

export const CONFIG_VERSION = 1;
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

	private constructor(state: ClusterInfo) {
		parseOrThrow(ClusterInfoSchema, state, new ClusterConfigError());
		this.config = state;
	}

	static create(coordinatorHostname: string, coordinatorPublicIp: string): Cluster {
		const coordinatorWgPublicKey = generateWireguardKeys();
		const coordinatorNode = ClusterNode.create(1, coordinatorHostname, coordinatorPublicIp, coordinatorWgPublicKey);
		const now = new Date().toISOString();

		return new Cluster({
			cluster_id: crypto.randomUUID(),
			access_key: crypto.randomBytes(32).toString("base64url"),
			version: CONFIG_VERSION,
			created_at: now,
			updated_at: now,
			coordinator_node: coordinatorNode.getCopy(),
			leader_node: coordinatorNode.getCopy(),
			nodes: [coordinatorNode.getCopy()],
			services: {},
		});
	}

	static fromJSON(data: unknown): Cluster {
		return new Cluster(parseOrThrow(ClusterInfoSchema, data, new ClusterConfigError()));
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

	get coordinatorNode(): NodeInfo {
		return this.config.coordinator_node;
	}

	get leaderNode(): NodeInfo | null {
		return this.config.leader_node || null;
	}

	get nodes(): NodeInfo[] {
		return this.config.nodes;
	}

	joinNode(hostname: string, publicIp: string, wgPublicKey: string): void {
		const wireguardIpExists = this.config.nodes.some((node) => node.wireguard_public_key === wgPublicKey);
		const publicIpExists = this.config.nodes.some((node) => node.public_ip === publicIp);

		if (wireguardIpExists || publicIpExists) {
			throw new NodeAlreadyExistsError();
		}

		const assignedNodeIds = new Set(this.config.nodes.map((node) => node.node_id));
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

		const newConfig: ClusterInfo = {
			...this.config,
			nodes: [...this.config.nodes, newNode.getCopy()],
			updated_at: new Date().toISOString(),
		};

		this.config = newConfig;
	}

	getCopy(): ClusterInfo {
		return {
			...this.config,
			coordinator_node: { ...this.config.coordinator_node },
			leader_node: this.config.leader_node ? { ...this.config.leader_node } : undefined,
			nodes: this.config.nodes.map((node) => ({ ...node })),
			services: { ...this.config.services },
		};
	}
}

var clusterConfigSingleton: Cluster | null = null;

export function setClusterConfig(config: Cluster): void {
	clusterConfigSingleton = config;
}

export function hasClusterConfig(): boolean {
	return clusterConfigSingleton !== null;
}

export function getClusterConfig() {
	if (clusterConfigSingleton === null) {
		throw new NoClusterConfigError();
	}

	return clusterConfigSingleton;
}
