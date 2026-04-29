import crypto from "crypto";

export function getPatroniPassword(clusterAccessKey: string, serviceId: string, username: string): string {
	return crypto.createHmac("sha256", clusterAccessKey).update(`patroni:${username}:${serviceId}`).digest("base64url").slice(0, 32);
}
