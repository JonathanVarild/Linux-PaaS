import { PatroniService } from "../models/config";
import { ETCD_CLIENT_PORT } from "../constants";
import { getPatroniPassword } from "../utils/credentials";
import { generateTemplateFromFile } from "../utils/serviceConfig";
import type { Cluster, ClusterNode } from "./config";

export function generatePatroniServiceFiles(cluster: Cluster, service: PatroniService): Record<string, string> {
	return {
		"docker-compose.yml": generateTemplateFromFile("patroni/docker-compose.yml.template"),
		"patroni.yml": generatePatroniConfig(cluster, service),
	};
}

function generatePatroniConfig(cluster: Cluster, service: PatroniService): string {
	const localNode = cluster.getLocalNode();
	return generateTemplateFromFile("patroni/patroni.yml.template", {
		SERVICE_ID: service.service_id,
		LOCAL_NODE_ID: String(localNode.id),
		INTERNAL_IP: localNode.wireguardIp,
		PATRONI_REST_PORT: String(service.patroni_rest_port),
		ETCD_HOSTS: getOrderedEtcdNodesRules(cluster),
		SYNCHRONOUS_MODE: service.sync_mode === "sync" ? "true" : "false",
		BOOTSTRAP_PG_HBA_RULES: getHBARules(cluster, 2),
		POSTGRESQL_PG_HBA_RULES: getHBARules(cluster, 1),
		ADMIN_PASSWORD: getPatroniPassword(cluster.accessKey, service.service_id, "admin"),
		POSTGRES_PORT: String(service.postgres_port),
		POSTGRES_PASSWORD: getPatroniPassword(cluster.accessKey, service.service_id, "postgres"),
		REPLICATOR_PASSWORD: getPatroniPassword(cluster.accessKey, service.service_id, "replicator"),
	});
}

function getOrderedEtcdNodesRules(cluster: Cluster): string {
	const localNode = cluster.getLocalNode();
	const remainingNodes = cluster.nodes.filter((node) => node.id !== localNode.id && node.id !== cluster.coordinatorNode.id);

	let orderedNodes: ClusterNode[];
	if (cluster.isCoordinatorNode(localNode)) orderedNodes = [localNode, ...remainingNodes];
	else orderedNodes = [localNode, cluster.coordinatorNode, ...remainingNodes];

	return orderedNodes.map((node) => `${node.wireguardIp}:${ETCD_CLIENT_PORT}`).join(",");
}

function getHBARules(cluster: Cluster, indentIndex: number): string {
	const rules: string[] = [];

	rules.push("local all all scram-sha-256");
	rules.push("host all all 127.0.0.1/32 scram-sha-256");
	rules.push("host all all ::1/128 scram-sha-256");
	rules.push("host replication replicator 127.0.0.1/32 scram-sha-256");
	rules.push("host replication replicator ::1/128 scram-sha-256");

	for (const node of cluster.nodes) {
		rules.push(`host replication replicator ${node.wireguardIp}/32 scram-sha-256`);
		rules.push(`host all all ${node.wireguardIp}/32 scram-sha-256`);
	}

	return rules.map((rule) => `${"    ".repeat(indentIndex)}- ${rule}`).join("\n");
}
