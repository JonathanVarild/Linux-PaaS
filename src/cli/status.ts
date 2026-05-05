import fs from "fs";
import path from "path";
import { OutputStream } from "../app/daemon";
import { getClusterConfig, hasClusterConfig } from "../cluster/config";
import { checkContainerState } from "../cluster/healthManager";
import { getComposeState, runComposeCommand } from "../cluster/serviceDeployment";
import { CONFIG_PATH_SERVICES_DIR, ETCD_PATH_DIR, ETCD_SERVICE_NAME, HAPROXY_PATH_DIR, HAPROXY_SERVICE_NAME } from "../constants";

export async function statusServerHandler(_args: unknown, stream: OutputStream): Promise<void> {
	if (!hasClusterConfig()) {
		throw new Error("Create a new cluster before viewing status.");
	}

	const clusterConfig = getClusterConfig();

	// Create an array of promises for getting the status of all services.
	const serviceStatusPromises: Array<Promise<{ serviceId: string; status: string }>> = [];

	// Add the etcd service.
	serviceStatusPromises.push(getServiceStatus("etcd", ETCD_PATH_DIR, ETCD_SERVICE_NAME));

	// Add the haproxy service if we are the coordinator.
	if (clusterConfig.isCoordinatorNode(clusterConfig.getLocalNode())) {
		serviceStatusPromises.push(getServiceStatus("haproxy", HAPROXY_PATH_DIR, HAPROXY_SERVICE_NAME));
	}

	// Add all other services.
	for (const [serviceId, service] of clusterConfig.getSortedServices()) {
		serviceStatusPromises.push(getServiceStatus(serviceId, path.join(CONFIG_PATH_SERVICES_DIR, serviceId), service.type));
	}

	// Await the status of all services.
	const serviceStatuses = await Promise.all(serviceStatusPromises);

	// Print output.
	stream.sendOutput(
		[
			"NODES:",
			...clusterConfig.nodes.map((node) => `${node.hostname} (${node.publicIp} -> ${node.wireguardIp}): ${node.status ? "up" : `down (${node.failedPingCount})`}`),
			"",
			"SERVICES:",
			...serviceStatuses.map((service) => `${service.serviceId}: ${service.status}`),
		].join("\n"),
	);
}

/**
 * Function to get the status of a service by checking its compose state and container health.
 * @param serviceId The id of the service to check.
 * @param directoryPath The path of the service's compose file directory.
 * @param composeServiceName The name of the service in the compose file.
 * @returns An object containing the service ID and its status.
 */
async function getServiceStatus(serviceId: string, directoryPath: string, composeServiceName: string): Promise<{ serviceId: string; status: string }> {
	// Get the compose state for the service's dir.
	const composeState = getComposeState(directoryPath);

	// Show status as "deploying" if we are currently running compose up and "stopping" if we are running compose down.
	if (composeState === "up" || composeState === "down") return { serviceId, status: composeState === "up" ? "deploying" : "stopping" };

	// Check if the compose file exists, if not the service is not deployed.
	if (!fs.existsSync(path.join(directoryPath, "docker-compose.yml"))) return { serviceId, status: "not deployed" };

	// Get the container ID for the service.
	const containerId = (await runComposeCommand(directoryPath, ["ps", "-q", composeServiceName], true)).trim();

	// If we dont get a container ID, the service is stopped.
	if (!containerId) return { serviceId, status: "stopped" };

	// Get the running container state and health status.
	const containerState = await checkContainerState(containerId);

	// Return the status of the service and its health.
	return {
		serviceId,
		status: `${containerState.status}${containerState.healthStatus ? ` (${containerState.healthStatus})` : ""}`,
	};
}
