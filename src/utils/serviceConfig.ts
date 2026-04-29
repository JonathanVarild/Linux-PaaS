import fs from "fs";
import path from "path";
import { SERVICE_TEMPLATES_PATH } from "../constants";

export function generateTemplateFromFile(relativePath: string, data: Record<string, string> = {}): string {
	let template = fs.readFileSync(path.join(SERVICE_TEMPLATES_PATH, relativePath), "utf8");

	for (const [tag, value] of Object.entries(data)) {
		template = template.split(`{${tag}}`).join(value);
	}

	return template;
}

export function getHAProxyId(value: string): string {
	return value.replace(/-/g, "_");
}
