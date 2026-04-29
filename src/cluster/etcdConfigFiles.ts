import { ETCD_CLIENT_PORT, ETCD_PEER_PORT } from "../constants";
import { generateTemplateFromFile } from "../utils/serviceConfig";
import type { Cluster, ClusterNode } from "./config";

export function generateEtcdFiles(cluster: Cluster): Record<string, string> {
	const localNode = cluster.getLocalNode();
	return {
		".env": generateTemplateFromFile("etcd/etcd.env.template", {
			ETCD_NAME: `node-${localNode.id}`,
			ETCD_INITIAL_ADVERTISE_PEER_URLS: getEtcdPeerUrl(localNode),
			ETCD_ADVERTISE_CLIENT_URLS: getEtcdClientUrl(localNode),
			ETCD_INITIAL_CLUSTER_STATE: cluster.nodes.length === 1 ? "new" : "existing",
			ETCD_INITIAL_CLUSTER_TOKEN: cluster.clusterId,
			ETCD_INITIAL_CLUSTER: cluster.nodes.map((node) => `node-${node.id}=${getEtcdPeerUrl(node)}`).join(","),
		}),
		"docker-compose.yml": generateTemplateFromFile("etcd/etcd.docker-compose.yml.template"),
	};
}

export function getEtcdPeerUrl(node: ClusterNode): string {
	return `http://${node.wireguardIp}:${ETCD_PEER_PORT}`;
}

export function getEtcdClientUrl(node: ClusterNode): string {
	return `http://${node.wireguardIp}:${ETCD_CLIENT_PORT}`;
}
