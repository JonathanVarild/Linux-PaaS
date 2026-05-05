import fs from "fs";
import path from "path";
import {
	HAPROXY_SERVICE_NAME,
	CONFIG_PATH_SERVICES_DIR,
	ETCD_PATH_DIR,
	HAPROXY_PATH_DIR,
	PATRONI_UID,
	PATRONI_GID,
	CONFIG_HASH_FILENAME,
	ETCD_READY_RETRY_COUNT,
	ETCD_READY_RETRY_DELAY_MS,
	ETCD_SERVICE_NAME,
} from "../constants";
import { PatroniService, WebService } from "../models/config";
import { generateEtcdFiles, getEtcdPeerUrl } from "./etcdConfigFiles";
import { generateHaproxyFiles } from "./haproxyConfigFiles";
import { generatePatroniServiceFiles } from "./patroniServiceConfigFiles";
import { generateWebServiceFiles } from "./webServiceConfigFiles";
import { getClusterConfig, hasClusterConfig, type Cluster, type ClusterNode } from "./config";
import { execFile } from "child_process";
import { promisify } from "util";
import { delay } from "../utils/misc";
import crypto from "crypto";

const execFileAsync = promisify(execFile);
let setupServicesSyncQueue: Promise<void> = Promise.resolve();
type ComposeCommand = {
	promise: Promise<unknown>;
	args: string[];
};
type ComposeCommandState = {
	mainPromise: Promise<unknown>;
	commands: ComposeCommand[];
};
const composeCommandStatesByDir = new Map<string, ComposeCommandState>();

/**
 * Function used to set up all services running on a node.
 * Such as static services like etcd and HAProxy, and user deployed services like web and Patroni services.
 * The function is queued to avoid conflicts and blocking, but promise resolves when all services have been triggered.
 * @param cluster The cluster configuration class.
 * @returns A promise that resolves once the setup process has been triggered.
 */
export function setupServices(cluster: Cluster): Promise<void> {
	const runSync = async (): Promise<void> => {
		// Print a console warning if the setup fails.
		try {
			// Ensure the services directory exists.
			fs.mkdirSync(CONFIG_PATH_SERVICES_DIR, { recursive: true });

			// Set up static services first.
			await setupEtcd(cluster);
			await setupHaproxy(cluster);

			// Loop through user defined services and set them up.
			for (const [id, service] of cluster.getSortedServices()) {
				if (service.type === "web") await setupWebService(id, service);
				else await setupPatroniService(cluster, id, service);
			}
		} catch (error) {
			console.warn(`Failed to set up managed services: ${error instanceof Error ? error.message : "Unknown error."}`);
		}
	};

	// Add the function to the queue.
	setupServicesSyncQueue = setupServicesSyncQueue.then(runSync, runSync);
	return setupServicesSyncQueue;
}

/**
 * Function used to set up the etcd service for the current node.
 * @param cluster The cluster configuration class.
 * @returns A promise that resolves once the setup process has been triggered.
 */
async function setupEtcd(cluster: Cluster): Promise<void> {
	// Create the etcd data directory with appropriate permissions.
	const dataDirectory = path.join(ETCD_PATH_DIR, "etcd-data");
	fs.mkdirSync(dataDirectory, { recursive: true });
	fs.chmodSync(dataDirectory, 0o700);

	// Check if we are the coordinator node, if we have more than 1 node in the cluster, and if the compose file exists (indicating etcd has been set up before).
	if (cluster.isCoordinatorNode(cluster.getLocalNode()) && cluster.nodes.length > 1 && fs.existsSync(path.join(ETCD_PATH_DIR, "docker-compose.yml"))) {
		// Add missing etcd members if any new nodes were added during operation so that we don't need to restart etcd.
		await addMissingEtcdMembers(cluster.nodes);
	}

	// Write etcd config files from templates and deploy the service if there were any changes.
	if (writeServiceConfigs(ETCD_PATH_DIR, generateEtcdFiles(cluster))) {
		await runComposeUp(ETCD_PATH_DIR, false);
	}
}

/**
 * Function used to set up the HAProxy service for the current node if it's a coordinator.
 * @param cluster The cluster configuration class.
 * @returns A promise that resolves once the setup process has been triggered.
 */
async function setupHaproxy(cluster: Cluster): Promise<void> {
	const localNode = cluster.getLocalNode();

	// If we are no longer the coordinator node, remove HAProxy deployment.
	if (!cluster.isCoordinatorNode(localNode)) {
		await runComposeDown(HAPROXY_PATH_DIR);
		return;
	}

	// Generate the HAProxy config files from templates.
	const files = generateHaproxyFiles(cluster);

	// Write the config files, and stop if there were no changes.
	if (!writeServiceConfigs(HAPROXY_PATH_DIR, files)) return;

	// Try to reload HAProxy with a HUP signal, and do a full compose if that fails or if HAProxy isn't running.
	if (!(await signalService(HAPROXY_PATH_DIR, HAPROXY_SERVICE_NAME, "HUP"))) {
		await runComposeUp(HAPROXY_PATH_DIR);
	}
}

/**
 * Function used to deploy a web service based on its configuration.
 * @param serviceId The ID of the service to deploy.
 * @param service The configuration for the web service.
 * @return A promise that resolves once the setup process has been triggered.
 */
async function setupWebService(serviceId: string, service: WebService): Promise<void> {
	// Create a path where to store the generated config files for this service.
	const serviceDirectory = path.join(CONFIG_PATH_SERVICES_DIR, serviceId);

	// Generate config files from template, wriet them to the service directory, and deploy the service.
	if (writeServiceConfigs(serviceDirectory, generateWebServiceFiles(service))) await runComposeUp(serviceDirectory);
}

/**
 * Function used to deploy a Patroni service based on its configuration.
 * @param cluster The cluster configuration class.
 * @param serviceId The ID of the service to deploy.
 * @param service The configuration for the Patroni service.
 * @return A promise that resolves once the setup process has been triggered.
 */
async function setupPatroniService(cluster: Cluster, serviceId: string, service: PatroniService): Promise<void> {
	// Create a path where to store the generated config files for this service, and a data directory to store Patroni data.
	const serviceDirectory = path.join(CONFIG_PATH_SERVICES_DIR, serviceId);
	const dataDirectory = path.join(serviceDirectory, "data");

	// Create the data directory with appropriate permissions.
	fs.mkdirSync(dataDirectory, { recursive: true });
	fs.chmodSync(dataDirectory, 0o700);
	fs.chownSync(dataDirectory, PATRONI_UID, PATRONI_GID);

	// Generate config files from template, wriet them to the service directory, and deploy the service.
	if (writeServiceConfigs(serviceDirectory, generatePatroniServiceFiles(cluster, service))) await runComposeUp(serviceDirectory);
}

/**
 * Function used to write generated config files for a service.
 * Keeps track of changes using a hash to only rewrite the files if necessary, and avoid unnecessary service restarts.
 * @param directoryPath The path directory where the files should be written.
 * @param files An object of filenames and their content to write to the directory.
 * @returns A boolean indiciating whether the files were changed or not.
 */
export function writeServiceConfigs(directoryPath: string, files: Record<string, string>): boolean {
	// Generate a sha256 hash of the config files object to compare with existing hash.
	const configHash = crypto
		.createHash("sha256")
		.update(JSON.stringify(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))))
		.digest("hex");

	// Get the path to the hash file and try to read the existing hash if it exists.
	const configHashPath = path.join(directoryPath, CONFIG_HASH_FILENAME);
	const existingConfigHash = fs.existsSync(configHashPath) ? fs.readFileSync(configHashPath, "utf8").trim() : "";

	// IF the read hash and new hash are the same, skip writing.
	if (existingConfigHash === configHash) return false;

	// Create the direcotry path if it doesn't exist.
	fs.mkdirSync(directoryPath, { recursive: true });

	// Loop through the files and write them in the service directory.
	for (const [file, content] of Object.entries(files)) {
		fs.writeFileSync(path.join(directoryPath, file), content);
	}

	// Write the new hash file to the directory.
	fs.writeFileSync(configHashPath, `${configHash}\n`);

	return true;
}

/**
 * Sends a signal to a running service container.
 * @param directoryPath The path to the service directory.
 * @param serviceName The name of the service.
 * @param signal The signal to send.
 * @returns A promise resolving to a boolean whether the signal was sucessfully sent or not.
 */
export async function signalService(directoryPath: string, serviceName: string, signal: string): Promise<boolean> {
	try {
		// Get the container ID using the docker-compose ps -q command, and check so we received a valid ID back.
		const containerId = (await runComposeCommand(directoryPath, ["ps", "-q", serviceName])).trim();
		if (!containerId) return false;

		// Send the signal to the container using the docker kill command, and return true if it succeeds.
		await execFileAsync("docker", ["kill", "-s", signal, containerId]);
		return true;
	} catch {}

	// Return false if we never succeeded in sending the signal.
	return false;
}

/**
 * Function used to add missing etcd members from when new nodes are joined, so we don't need to restart etcd entirely.
 * @param nodes The list of nodes in the cluster.
 */
export async function addMissingEtcdMembers(nodes: ClusterNode[]): Promise<void> {
	if (nodes.length === 0) return;

	try {
		// Make a etcd health check to ensure that etcd is ready to accept commands.
		await waitForEtcd();

		// Create a set of peer URLs that are already part of the etcd cluster.
		const currentPeerURLs = new Set(await getEtcdMembers());

		// Loop through the nodes in the cluster.
		for (const node of nodes) {
			// Get the current node peer URL and check if it's already part of the etcd config, and skip if it is.
			const peerUrl = getEtcdPeerUrl(node);
			if (currentPeerURLs.has(peerUrl)) continue;

			// Add the new member to the etcd cluster using the member add command.
			await runEtcdctl(["member", "add", `node-${node.id}`, `--peer-urls=${peerUrl}`]);
		}
	} catch (error) {
		console.warn(`Failed to add missing etcd members: ${error instanceof Error ? error.message : "Unknown error."}`);
	}
}

/**
 * Helper function used to get an array of peer URLs for the current etcd members.
 * @returns A promise resolving to an array of peer URLs for the current etcd members.
 */
async function getEtcdMembers(): Promise<string[]> {
	const output = await runEtcdctl(["member", "list", "-w", "json"]);
	const parsed = JSON.parse(output) as { members?: Array<{ peerURLs?: string[] }> };
	return (parsed.members ?? []).flatMap((member) => member.peerURLs ?? []);
}

/**
 * Function used to wait for etcd to be ready by checking its health endpoint.
 * @returns A promise that resolves once etcd is deemed healthy, or rejects if we timeout.
 */
async function waitForEtcd(): Promise<void> {
	// Variable for storing the last error we received.
	let lastError: Error | null = null;

	// Loop and retry the health checks until we reach the retry limit.
	for (let i = 0; i < ETCD_READY_RETRY_COUNT; i++) {
		try {
			// Run the etcd health check command and return if it succeeds.
			await runEtcdctl(["endpoint", "health"]);
			return;
		} catch (error) {
			// Store the error and wait for the retry delay.
			lastError = error instanceof Error ? error : new Error("Etcd health check failed with unknown error.");
			await delay(ETCD_READY_RETRY_DELAY_MS);
		}
	}

	throw lastError;
}

/**
 * Helper function to exectute an internal etcdctl command in etcd container.
 * @param args Teh arguments to pass to etcdctl.
 * @returns A promise resolving to the stdout from the command execution.
 */
async function runEtcdctl(args: string[]): Promise<string> {
	return runComposeCommand(ETCD_PATH_DIR, ["exec", "-T", "-e", "ETCDCTL_API=3", ETCD_SERVICE_NAME, "etcdctl", ...args]);
}

/**
 * Function used to run a docker-compose command in a specific directory.
 * @param directoryPath THe path to the service directory where the docker-compose.yml is.
 * @param forceRecreate Attribute that force recreates the container to ensure config changes are applied.
 */
export async function runComposeUp(directoryPath: string, forceRecreate = true): Promise<void> {
	const args = ["up", "-d", "--remove-orphans"];
	if (forceRecreate) args.push("--force-recreate");
	await runComposeCommand(directoryPath, args);
}

/**
 * Runs a docker-compose down command on the specified directory to stop and remove the service deployment.
 * @param directoryPath The path to the service directory.
 * @returns A promise that resolves once the command has completed.
 */
export async function runComposeDown(directoryPath: string): Promise<void> {
	if (!fs.existsSync(directoryPath)) return;
	await runComposeCommand(directoryPath, ["down", "--remove-orphans"]);
}

/**
 * Function to get the current compose command that is running for a specific directory.
 * @param directoryPath
 * @returns
 */
export function getComposeState(directoryPath: string): string | null {
	const normalizedDirectoryPath = path.resolve(directoryPath);
	const state = composeCommandStatesByDir.get(normalizedDirectoryPath);
	return state?.commands[0]?.args[0] ?? null;
}

/**
 * Helper function used to run a docker-compose command on a specific directory and return the stdout.
 * @param directoryPath The path to the service directory where the docker-compose.yml is.
 * @param args The arguments to pass to docker-compose.
 * @param runInstantly If true, skips the per-directory compose queue.
 * @returns A promise resolving to the stdout from the command execution.
 */
export async function runComposeCommand(directoryPath: string, args: string[], runInstantly = false): Promise<string> {
	// Normalize the directory path so we don't get multiple entries for the same dir.
	const normalizedDirectoryPath = path.resolve(directoryPath);

	// Prepare the command function.
	const runCommand = async () => {
		const { stdout } = await execFileAsync("docker-compose", args, {
			cwd: normalizedDirectoryPath,
			encoding: "utf8",
		});
		return stdout;
	};

	// Instant commands skip queueing and command-state tracking.
	if (runInstantly) {
		return runCommand();
	}

	// Get or create the command state for this dir.
	const commandState = composeCommandStatesByDir.get(normalizedDirectoryPath) ?? {
		mainPromise: Promise.resolve(),
		commands: [],
	};

	// Chain the new command to the previous promise to ensure commands run sequentially for each directory.
	const commandPromise = commandState.mainPromise.catch(() => undefined).then(runCommand);

	// Set the new main promise and add the command to the state.
	commandState.mainPromise = commandPromise;
	commandState.commands.push({
		promise: commandPromise,
		args: [...args],
	});
	composeCommandStatesByDir.set(normalizedDirectoryPath, commandState);

	try {
		// Run the command and return the output.
		return await commandPromise;
	} finally {
		// Get the current command state.
		const currentCommandState = composeCommandStatesByDir.get(normalizedDirectoryPath);

		// Check if its still valid.
		if (currentCommandState) {
			// Filter out the completed command.
			currentCommandState.commands = currentCommandState.commands.filter((command) => command.promise !== commandPromise);

			// Remove the state for the dir if there are no more commands to run.
			if (currentCommandState.commands.length === 0) {
				composeCommandStatesByDir.delete(normalizedDirectoryPath);
			}
		}
	}
}

// Add missing etcd members if we failed at some point.
setInterval(() => {
	if (!hasClusterConfig()) return;
	addMissingEtcdMembers(getClusterConfig().nodes);
}, 60 * 1000);
