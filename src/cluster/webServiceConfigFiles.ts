import { WebService } from "../models/config";
import { generateTemplateFromFile } from "../utils/serviceConfig";

export function generateWebServiceFiles(service: WebService): Record<string, string> {
	return {
		"docker-compose.yml": generateTemplateFromFile("web/docker-compose.yml.template", {
			IMAGE: service.image,
			EXPOSED_PORT: String(service.exposed_port),
			INTERNAL_PORT: String(service.internal_port),
		}),
	};
}
