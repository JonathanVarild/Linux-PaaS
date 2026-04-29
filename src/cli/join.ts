import https from "https";
import os from "os";
import fetch from "node-fetch";
import { applyClusterConfig, hasClusterConfig } from "../cluster/config";
import { type NodeJoinRequest } from "../models/networking";
import { z } from "zod";
import { generateWireguardKeys } from "../adapters/wireguard";
import { OutputStream } from "../app/daemon";
import { parseOrThrowWithMessage } from "../utils/zod";

// Schema for validating the join bundle.
const JoinBundleSchema = z.object({
	url: z.string(),
	token: z.string(),
	cert_pem: z.string(),
});

// Schema for validating the returned data from the coordinator after successfull join.
const JoinResponseSchema = z.object({
	cluster: z.unknown(),
	nodes: z.unknown(),
	services: z.unknown().optional(),
});

// Command handler for joining a node to a cluster.
export async function joinServerHandler(args: unknown, stream: OutputStream): Promise<string> {
	if (hasClusterConfig()) {
		throw new Error("Cluster configuration already exists.");
	}

	// Parse and validate join bundle passed from command args.
	let bundleValue: unknown;
	try {
		bundleValue = JSON.parse(args as string);
	} catch {
		throw new Error("bundle-json must be valid JSON.");
	}

	// Validate the provided bundle JSON.
	const bundle = parseOrThrowWithMessage(JoinBundleSchema, bundleValue);

	// Generate a wireguard key pair for the local node used for joining the Wireguard network.
	const wgPublicKey = generateWireguardKeys();

	// Prepare join request.
	const joinRequest: NodeJoinRequest = {
		hostname: os.hostname(),
		wg_public_key: wgPublicKey,
	};
	const body = JSON.stringify(joinRequest);

	// Make join HTTPS request using self-signed certificate public key.
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

		// Parse and validate the response and then apply config to local node.
		const joinResponseValue = parseOrThrowWithMessage(JoinResponseSchema, JSON.parse(responseBody));
		const joinedClusterConfig = applyClusterConfig(joinResponseValue.cluster, joinResponseValue.nodes, joinResponseValue.services);

		stream.sendOutput(`Successfully joined cluster as node #${joinedClusterConfig.getLocalNode().id}.\n`);
		return responseBody;
	} catch (error) {
		throw new Error(`Failed to join cluster network: ${error instanceof Error ? error.message : "Unknown error"}`);
	}
}
