import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { CLUSTER_HEALTHCHECK_INTERVAL_MS, CONFIG_PATH_SERVICES_DIR, ETCD_PATH_DIR, ETCD_SERVICE_NAME, HAPROXY_PATH_DIR, HAPROXY_SERVICE_NAME } from "../constants";
import { getClusterConfig, hasClusterConfig } from "./config";
import { getComposeState, runComposeCommand, runComposeUp } from "./serviceDeployment";

const execFileAsync = promisify(execFile);

// Type for representing an detected issue.
type Issue = {
	reason: string;
	forceRecreate: boolean;
};

// Type for storing Docker container state and docker healthcheck status.
type ContainerState = {
	status: string;
	healthStatus?: string;
};

// Promise state to ensure that we don't run multiple parallel health checks
let healthCheckPromise: Promise<void> | null = null;

/**
 * Function to check the current health of the cluster and attempt to heal any potentially damaged services.
 * @returns Promise that resolves when the health check and any necessary healing is complete.
 */
async function checkClusterHealth(): Promise<void> {
	if (!hasClusterConfig()) return;
	const clusterConfig = getClusterConfig();

	// Check and heal the etcd service.
	let issue = await checkService(ETCD_PATH_DIR, ETCD_SERVICE_NAME);
	if (issue) {
		await repairDeployment("etcd", ETCD_PATH_DIR, issue);
	}

	// If we are the coordinator, check and heal haproxy too.
	if (clusterConfig.isCoordinatorNode(clusterConfig.getLocalNode())) {
		issue = await checkService(HAPROXY_PATH_DIR, HAPROXY_SERVICE_NAME);
		if (issue) {
			await repairDeployment("haproxy", HAPROXY_PATH_DIR, issue);
		}
	}

	// Loop through all services, check health, and heal them if needed.
	for (const [serviceId, service] of clusterConfig.getSortedServices()) {
		const directoryPath = path.join(CONFIG_PATH_SERVICES_DIR, serviceId);

		// If we find any issue, try to repair the deployment.
		issue = await checkService(directoryPath, service.type);
		if (issue) {
			await repairDeployment(serviceId, directoryPath, issue);
		}
	}
}

/**
 * Function to attempt to repair a service deployment.
 * @param serviceId The ID of the service to repair.
 * @param directoryPath The path to the service's directory.
 * @param issue The detected issue.
 */
async function repairDeployment(serviceId: string, directoryPath: string, issue: Issue): Promise<void> {
	try {
		await runComposeUp(directoryPath, issue.forceRecreate);
		console.warn(`Recovered '${serviceId}': ${issue.reason}`);
	} catch (error) {
		console.warn(`Failed recovery for '${serviceId}': ${error instanceof Error ? error.message : "Unknown error."}`);
	}
}

/**
 * Function used to check the health of a service.
 * @param directoryPath The path to the service's directory.
 * @param composeServiceName The name of the docker service.
 * @returns An issue if the service is unhealthy or null if its healthy.
 */
async function checkService(directoryPath: string, composeServiceName: string): Promise<Issue | null> {
	try {
		if (!fs.existsSync(path.join(directoryPath, "docker-compose.yml"))) return null;
		if (getComposeState(directoryPath) !== null) return null;

		// Get the container IDs for the service compose file.
		const containerIds = await getServiceContainerIds(directoryPath, composeServiceName);

		// Check if the container is missing.
		if (containerIds.length === 0) return { reason: "Missing container", forceRecreate: false };

		// Inspect the state of the containers and look for runtime or Docker healthcheck failures.
		const states = await Promise.all(containerIds.map((containerId) => checkContainerState(containerId)));

		// Find any containers that are not running and return a issue if we find any.
		const stoppedState = states.find((state) => state.status !== "running");
		if (stoppedState) {
			return { reason: `Container status is '${stoppedState.status}'`, forceRecreate: true };
		}

		// Find any containers that are unhealthy and return an issue if we find any.
		const unhealthyState = states.find((state) => state.healthStatus && state.healthStatus !== "healthy" && state.healthStatus !== "starting");
		if (unhealthyState) {
			return { reason: `Container health is '${unhealthyState.healthStatus}'`, forceRecreate: true };
		}

		// Return null if we didn't find any issues.
		return null;
	} catch (error) {
		return { reason: `Health check failed: ${error instanceof Error ? error.message : "Unknown error."}`, forceRecreate: false };
	}
}

/**
 * Function used to get container IDs for a specific service.
 * @param directoryPath The path to the service's directory.
 * @param composeServiceName The name of the docker service.
 * @returns A promise resolving to an array of container IDs.
 */
async function getServiceContainerIds(directoryPath: string, composeServiceName: string): Promise<string[]> {
	return (await runComposeCommand(directoryPath, ["ps", "-q", composeServiceName]))
		.split(/\s+/)
		.map((value) => value.trim())
		.filter(Boolean);
}

/**
 * Function used to check dockers' view of a container's state.
 * @param containerId The container ID to check the state of.
 * @returns The container runtime status and optional Docker healthcheck status.
 */
export async function checkContainerState(containerId: string): Promise<ContainerState> {
	const { stdout } = await execFileAsync("docker", ["inspect", "--format", "{{json .State}}", containerId], {
		encoding: "utf8",
	});
	const parsed = JSON.parse(stdout.trim()) as { Status?: string; Health?: { Status?: string } };

	return {
		status: parsed.Status ?? "unknown",
		healthStatus: parsed.Health?.Status,
	};
}

// Run health checks at regular intervals.
setInterval(() => {
	if (healthCheckPromise) return;

	healthCheckPromise = checkClusterHealth()
		.catch((error) => {
			console.warn(`Health manager failed: ${error instanceof Error ? error.message : "Unknown error."}`);
		})
		.finally(() => {
			healthCheckPromise = null;
		});
}, CLUSTER_HEALTHCHECK_INTERVAL_MS);
