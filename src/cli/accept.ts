import https from "https";
import express from "express";
import crypto from "crypto";
import os from "os";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { getClusterConfig, hasClusterConfig, syncConfigToCluster } from "../cluster/config";
import { NodeJoinRequestSchema } from "../models/networking";
import { ClusterConfigError } from "../errors/configErrors";
import { OutputStream } from "../app/daemon";
import { JOIN_SERVER_PORT } from "../constants";

// Command handler for accepting join requests from other nodes.
export async function acceptServerHandler(_args: unknown, stream: OutputStream): Promise<{ url: string; token: string }> {
	if (!hasClusterConfig()) {
		throw new Error("Create a new cluster before accepting join requests.");
	}

	const clusterConfig = getClusterConfig();

	if (clusterConfig.coordinatorNode.hostname !== os.hostname()) {
		throw new Error("Only the coordinator node can accept join requests.");
	}

	// Get the coordinator IP, generate a self-signed certificate for secure communication, and generate a random auth token.
	const coordinatorIp = clusterConfig.coordinatorNode.publicIp;
	const { cert, key } = makeCert(coordinatorIp);
	const token = randomString(32);
	const bundle = {
		url: `https://${coordinatorIp}:${JOIN_SERVER_PORT}/join`,
		token,
		cert_pem: cert,
	};

	// Send the join bundle with connection and authentication details to the output so user can copy it.
	stream.sendOutput(JSON.stringify(bundle));

	// Set up a temporary HTTPS express server for listening for join requests.
	const app = express();
	app.use(express.json());

	// Middleware to handle JSON parsing errors.
	app.use((err: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
		if (err instanceof SyntaxError) {
			return res.status(400).send("JSON is invalid, please try again.");
		}
		next(err);
	});

	// Set up endpoint for receiving the join request.
	app.post("/join", async (req: express.Request, res: express.Response) => {
		if (req.headers["x-auth-token"] !== token) {
			return res.status(401).send("Authentication token is invalid, please try again.");
		}

		// REceive and validate the join request.
		const joinRequestResult = NodeJoinRequestSchema.safeParse(req.body);
		if (!joinRequestResult.success) {
			return res.status(400).send("Join request is invalid.");
		}

		// Ensure the ip is correct IPV4 format.
		const normalizedIp = normalizeIp(req.ip as string);

		try {
			clusterConfig.joinNode(joinRequestResult.data.hostname, normalizedIp, joinRequestResult.data.wg_public_key);
			await syncConfigToCluster(clusterConfig, [clusterConfig.getLocalNode().id]);

			stream.sendOutput(`Successfully joined node ${req.body.hostname} (${normalizedIp}).`);

			return res.json({
				cluster: clusterConfig.getCopy(),
				nodes: clusterConfig.getNodesCopy(),
				services: clusterConfig.getServicesCopy(),
			});
		} catch (error) {
			console.error("Error processing join request:", error);
			if (error instanceof ClusterConfigError) {
				return res.status(409).send(error.message);
			}

			throw error;
		}
	});

	// Enable the server to accept connections using our self signed certificate.
	const server = https.createServer({ cert, key }, app);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(JOIN_SERVER_PORT, resolve);
	});

	// Wait for CLI termination and close the server.
	stream.sendOutput(`Listening for join requests on port ${JOIN_SERVER_PORT}... Press Ctrl+C to exit.`);
	await stream.waitForSocketClose();
	await new Promise<void>((resolve, reject) => {
		server.close((error?: Error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});

	return { url: bundle.url, token };
}

/**
 * Function used to generate a private key and derive a public key certificate for the WireGuard interface.
 * @param ip The IP address to include in the certificate.
 * @returns { cert: string; key: string } The generated certificate and private key.
 * @throws {FailedToGenerateWireguardKeysError} If key generation fails.
 */
function makeCert(ip: string): { cert: string; key: string } {
	const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
	const key = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
	const cert = selfSignCert(ip, key);
	return { cert, key };
}

/**
 * Function to generate the self-signed certificate using openSSL CLI.
 * @param ip The Ip to include in the certificate.
 * @param keyPem The private key to use for generating the certificate.
 * @returns PEM-formatted self-signed certificate.
 */
function selfSignCert(ip: string, keyPem: string): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "join-"));
	const keyPath = path.join(tmp, "key.pem");
	const certPath = path.join(tmp, "cert.pem");
	const confPath = path.join(tmp, "openssl.cnf");

	fs.writeFileSync(keyPath, keyPem);
	fs.writeFileSync(
		confPath,
		`[req]
		distinguished_name=dn
		x509_extensions=v3
		prompt=no
		[dn]
		CN=${ip}
		[v3]
		subjectAltName=IP:${ip}
		keyUsage=digitalSignature,keyEncipherment
		extendedKeyUsage=serverAuth`,
	);

	execFileSync("openssl", ["req", "-x509", "-key", keyPath, "-out", certPath, "-days", "1", "-config", confPath]);

	return fs.readFileSync(certPath, "utf8");
}

/**
 * Function used to generate a random string of n characters.
 * @param n The number of characters.
 * @returns A random string of n characters.
 */
function randomString(n: number): string {
	return crypto.randomBytes(n).toString("base64url").slice(0, n);
}

/**
 * Function used to remove the IPV6 prefix from a IPV4-mapped IPV6 address.
 * @param ip The IPV4-mapped IPV6 address to normalize.
 * @returns A normal IPV4 address without the IPV6 prefix.
 */
function normalizeIp(ip: string): string {
	return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}
