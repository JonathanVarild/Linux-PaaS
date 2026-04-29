import { generateTemplateFromFile, getHAProxyId } from "../utils/serviceConfig";
import type { Cluster } from "./config";

export function generateHaproxyFiles(cluster: Cluster): Record<string, string> {
	return {
		"docker-compose.yml": generateTemplateFromFile("haproxy/haproxy.docker-compose.yml.template"),
		"haproxy.cfg": generateTemplateFromFile("haproxy/haproxy.cfg.template", {
			WEB_HOST_RULES: generateWebHostRules(cluster),
			SERVICE_PROXY_SECTIONS: generateServiceProxySections(cluster),
		}),
	};
}

function generateWebHostRules(cluster: Cluster): string {
	const lines: string[] = [];

	for (const [serviceId, service] of cluster.getSortedServices()) {
		if (service.type !== "web") continue;

		const haproxyName = getHAProxyId(serviceId);
		lines.push(`    acl host_${haproxyName} hdr(host) -i ${service.domain}`);
		lines.push(`    use_backend web_${haproxyName} if host_${haproxyName}`);
	}

	return lines.join("\n");
}

function generateServiceProxySections(cluster: Cluster): string {
	const lines: string[] = [];

	for (const [serviceId, service] of cluster.getSortedServices()) {
		if (service.type === "web") {
			lines.push(
				generateTemplateFromFile("haproxy/web.proxy.template", {
					HAPROXY_NAME: getHAProxyId(serviceId),
					SERVER_LINES: cluster.nodes
						.map((node) => `    server node_${node.id} ${node.wireguardIp}:${service.exposed_port} check`)
						.join("\n"),
				}),
				"",
			);
		} else {
			lines.push(
				generateTemplateFromFile("haproxy/patroni.proxy.template", {
					HAPROXY_NAME: getHAProxyId(serviceId),
					READ_WRITE_PORT: String(service.read_write_port),
					READ_ONLY_PORT: String(service.read_only_port),
					RW_SERVER_LINES: cluster.nodes
						.map((node) => `    server node_${node.id} ${node.wireguardIp}:${service.postgres_port} check port ${service.patroni_rest_port}`)
						.join("\n"),
					RO_SERVER_LINES: cluster.nodes
						.map((node) => `    server node_${node.id} ${node.wireguardIp}:${service.postgres_port} check port ${service.patroni_rest_port}`)
						.join("\n"),
				}),
				"",
			);
		}
	}

	return lines.join("\n").trimEnd();
}
