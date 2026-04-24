import https from "https";
import os from "os";
import fetch from "node-fetch";
import { applyClusterConfig, hasClusterConfig } from "../cluster/config";
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

const JoinResponseSchema = z.object({
	cluster: z.unknown(),
	nodes: z.unknown(),
	services: z.unknown().optional(),
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

		const joinResponseValue = parseOrThrowWithMessage(JoinResponseSchema, JSON.parse(responseBody));
		const joinedClusterConfig = applyClusterConfig(joinResponseValue.cluster, joinResponseValue.nodes, joinResponseValue.services);

		const joinedNode = joinedClusterConfig.nodes.find((node) => node.wireguardPublicKey === wgPublicKey);
		if (!joinedNode) {
			throw new Error("Could not find local node in new cluster configuration after joining.");
		}

		stream.sendOutput(`Successfully joined cluster as node #${joinedNode.id}.\n`);
		return responseBody;
	} catch (error) {
		throw new Error(`Failed to join cluster network: ${error instanceof Error ? error.message : "Unknown error"}`);
	}
}
