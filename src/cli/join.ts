import https from "https";
import os from "os";
import fetch from "node-fetch";
import { Cluster, hasClusterConfig, saveClusterConfigToDisk, setClusterConfig } from "../cluster/config";
import { type NodeJoinRequest } from "../models/networking";
import { z } from "zod";
import { generateWireguardKeys } from "../adapters/wireguard";
import { OutputStream } from "../app/daemon";
import { parseOrThrowWithMessage } from "../utils/zod";

const JoinBundleSchema = z.object({
	url: z.string(),
	token: z.string(),
	cert_pem: z.string(),
});

export async function joinServerHandler(args: unknown, stream: OutputStream): Promise<string> {
	if (hasClusterConfig()) {
		throw new Error("Cluster configuration already exists.");
	}

	let bundleValue: unknown;
	try {
		bundleValue = JSON.parse(args as string);
	} catch {
		throw new Error("bundle-json must be valid JSON.");
	}

	const bundle = parseOrThrowWithMessage(JoinBundleSchema, bundleValue);
	const wgPublicKey = generateWireguardKeys();

	const joinRequest: NodeJoinRequest = {
		hostname: os.hostname(),
		wg_public_key: wgPublicKey,
	};
	const body = JSON.stringify(joinRequest);

	const httpsAgent = new https.Agent({ ca: bundle.cert_pem });
	try {
		const result = await fetch(bundle.url, {
			method: "POST",
			body,
			headers: {
				"Content-Type": "application/json",
				"x-auth-token": bundle.token,
			},
			agent: httpsAgent,
		});

		const responseBody = await result.text();
		if (!result.ok) {
			throw new Error(`Failed to join cluster network (${result.status}): ${responseBody}`);
		}

		const joinedClusterConfig = Cluster.fromJSON(JSON.parse(responseBody));
		setClusterConfig(joinedClusterConfig);
		saveClusterConfigToDisk(joinedClusterConfig);

		const nodeId = joinedClusterConfig.nodes.findIndex((node) => node.wireguard_public_key === wgPublicKey);

		stream.sendOutput(`Successfully joined cluster as node #${joinedClusterConfig.nodes[nodeId].node_id}.\n`);
		return responseBody;
	} catch (error) {
		throw new Error(`Failed to join cluster network: ${error instanceof Error ? error.message : "Unknown error"}`);
	}
}
