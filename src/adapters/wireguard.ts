import { execFileSync } from "child_process";
import { FailedToGenerateWireguardKeysError } from "../errors/adapterErrors";

export function generateWireguardKeys(): string {
	console.log("env:", process.env.NODE_ENV);
	
	if (process.env.NODE_ENV != "production" && process.env.NODE_ENV != "docker_dev" ) {
		return "DEVELOPMENT_PUBLIC_KEY";
	}

	const privateKey = execFileSync("wg", ["genkey"], { encoding: "utf8" }).trim();
	if (!privateKey) {
		throw new FailedToGenerateWireguardKeysError("Failed to generate WireGuard private key.");
	}

	const publicKey = execFileSync("wg", ["pubkey"], {
		input: `${privateKey}\n`,
		encoding: "utf8",
	}).trim();

	if (!publicKey) {
		throw new FailedToGenerateWireguardKeysError("Failed to derive WireGuard public key.");
	}

	return publicKey;
}
