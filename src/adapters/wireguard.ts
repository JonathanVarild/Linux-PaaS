import { execFileSync } from "child_process";
import { FailedToGenerateWireguardKeysError } from "../errors/adapterErrors";

export function generateWireguardKeys(): string {
	if (process.env.NODE_ENV !== "production") {
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
