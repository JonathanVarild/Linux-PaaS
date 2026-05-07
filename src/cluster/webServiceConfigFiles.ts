import { WebService } from "../models/config";
import { generateTemplateFromFile } from "../utils/serviceConfig";

export function generateWebServiceFiles(service: WebService, wireguardIp: string): Record<string, string> {
	return {
		"docker-compose.yml": generateTemplateFromFile("web/docker-compose.yml.template", {
			IMAGE: service.image,
			ENVIRONMENT: generateEnvironmentConfig(service.env),
			WIREGUARD_IP: wireguardIp,
			EXPOSED_PORT: String(service.exposed_port),
			INTERNAL_PORT: String(service.internal_port),
		}),
	};
}

function generateEnvironmentConfig(env: Record<string, string> | undefined): string {
	const envs = Object.entries(env ?? {}).sort(([left], [right]) => left.localeCompare(right));
	if (envs.length === 0) return "";
	return `    environment:\n${envs.map(([key, value]) => `      ${key}: '${value.replace(/'/g, "''")}'`).join("\n")}\n`;
}
