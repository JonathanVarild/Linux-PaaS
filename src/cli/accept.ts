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

export async function acceptServerHandler(_args: unknown, stream: OutputStream): Promise<{ url: string; token: string }> {
	if (!hasClusterConfig()) {
		throw new Error("Create a new cluster before accepting join requests.");
	}

	const clusterConfig = getClusterConfig();

	if (clusterConfig.coordinatorNode.hostname !== os.hostname()) {
		throw new Error("Only the coordinator node can accept join requests.");
	}

	const coordinatorIp = clusterConfig.coordinatorNode.publicIp;
	const { cert, key } = makeCert(coordinatorIp);
	const token = randomString(32);
	const bundle = {
		url: `https://${coordinatorIp}:8443/join`,
		token,
		cert_pem: cert,
	};

	stream.sendOutput(JSON.stringify(bundle));

	const app = express();
	app.use(express.json());

	app.use((err: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
		if (err instanceof SyntaxError) {
			return res.status(400).send("JSON is invalid, please try again.");
		}
		next(err);
	});

	app.post("/join", async (req: express.Request, res: express.Response) => {
		if (req.headers["x-auth-token"] !== token) {
			return res.status(401).send("Authentication token is invalid, please try again.");
		}

		const joinRequestResult = NodeJoinRequestSchema.safeParse(req.body);
		if (!joinRequestResult.success) {
			return res.status(400).send("Join request is invalid.");
		}

		const normalizedIp = normalizeIp(req.ip as string);

		stream.sendOutput(`Received join request from ${req.body.hostname} (${normalizedIp})`);

		try {
			clusterConfig.joinNode(joinRequestResult.data.hostname, normalizedIp, joinRequestResult.data.wg_public_key);
			const joinedNode = clusterConfig.nodes.find((node) => node.wireguardPublicKey === joinRequestResult.data.wg_public_key);
			if (!joinedNode) {
				throw new Error("Could not find the joined node in updated cluster configuration.");
			}
			await syncConfigToCluster(clusterConfig, [joinedNode.id]);
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

	const server = https.createServer({ cert, key }, app);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(8443, resolve);
	});

	stream.sendOutput("Listening for join requests on port 8443... Press Ctrl+C to exit.");
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

function makeCert(ip: string): { cert: string; key: string } {
	const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
	const key = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
	const cert = selfSignCert(ip, key);
	return { cert, key };
}

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

function randomString(n: number): string {
	return crypto.randomBytes(n).toString("base64url").slice(0, n);
}

function normalizeIp(ip: string): string {
	return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}
