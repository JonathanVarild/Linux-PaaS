import fetch from "node-fetch";
import { getPatroniHealth, promoteToPatroniLeader } from "../adapters/patroni";
import { CLUSTER_HEALTHCHECK_INTERVAL_MS, HTTP_DAEMON_PORT, COORDINATOR_REBOOT_HOUR, COORDINATOR_REBOOT_MAX_LOAD, NODE_REPORT_REQUEST_TIMEOUT_MS } from "../constants";
import { NodeReportResponseSchema } from "../models/networking";
import { ClusterNode, getClusterConfig, hasClusterConfig } from "./config";
import os from "os";

// Type for representing a report fetched from a node about its health, load, and patroni leaderships.
type ClusterNodeReport = {
	node: ClusterNode;
	requiresRestart: boolean;
	averageLoad: number;
	patroniLeaderships: string[];
};

/**
 * Function to fetch a report from a node inlcuding its load, patroni leaderships, and if it requires a reboot.
 * @param node The node to fetch the report from.
 * @returns A promise that resolves to the node report, or null if the request failed or the response was invalid.
 */
async function fetchNodeReport(node: ClusterNode): Promise<ClusterNodeReport | null> {
	const clusterConfig = getClusterConfig();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), NODE_REPORT_REQUEST_TIMEOUT_MS);

	try {
		const response = await fetch(`http://${node.wireguardIp}:${HTTP_DAEMON_PORT}/get_node_report`, {
			method: "POST",
			headers: {
				"x-access-key": clusterConfig.accessKey,
			},
			signal: controller.signal,
		});

		const responseBody = await response.text();
		if (!response.ok) {
			console.warn(`Failed to fetch node report from ${node.hostname} (${response.status}): ${responseBody}`);
			return null;
		}

		const responseResult = NodeReportResponseSchema.safeParse(JSON.parse(responseBody));
		if (!responseResult.success) {
			console.warn(`Node report response from ${node.hostname} is invalid.`);
			return null;
		}

		return {
			node,
			requiresRestart: responseResult.data.requires_restart,
			averageLoad: responseResult.data.average_load,
			patroniLeaderships: responseResult.data.patroni_leaderships,
		};
	} catch (error) {
		console.warn(`Failed to fetch node report from ${node.hostname}: ${error instanceof Error ? error.message : "Unknown error."}`);
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Function to request a reboot of a specific node.
 * @param node The node to reboot.
 * @returns A promise that resolves to true if the reboot request was accepted, false otherwise.
 */
async function requestNodeReboot(node: ClusterNode): Promise<boolean> {
	const clusterConfig = getClusterConfig();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 20000);

	try {
		const response = await fetch(`http://${node.wireguardIp}:${HTTP_DAEMON_PORT}/reboot`, {
			method: "POST",
			headers: {
				"x-access-key": clusterConfig.accessKey,
			},
			signal: controller.signal,
		});

		if (response.ok) return true;

		const responseBody = await response.text();
		console.warn(`Failed to request reboot for ${node.hostname} (${response.status}): ${responseBody}`);
		return false;
	} catch (error) {
		console.warn(`Failed to request reboot for ${node.hostname}: ${error instanceof Error ? error.message : "Unknown error."}`);
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

// GLobal variable to keep track of whether we are currently running a health check to avoid overlapping checks.
let isCheckingCluster = false;

/**
 * Function to check and handle the health of the cluster.
 * We handle one problem each round to ensure that cluster is kept as stable as possible.
 * @returns Promise that resolves when the check is complete.
 */
async function checkCluster(): Promise<void> {
	if (!hasClusterConfig()) return;
	const clusterConfig = getClusterConfig();

	if (clusterConfig.leaderNode.hostname !== os.hostname()) return;

	// Get the reports from all nodes in the cluster, and filter out any that failed.
	const nodeReports = (await Promise.all(clusterConfig.nodes.map((node) => fetchNodeReport(node)))).filter((report): report is ClusterNodeReport => report !== null);

	// Check if any nodes require loadBalancing if load would be unevenly distributed.
	//if (await handlePatroniLoadBalancing(nodeReports)) return;
	// Disabled until I find a better way to get these two to stop fighting each other.

	// CHeck if any nodes require loadBalancing based on number of patroni leaderships.
	if (await handlePatroniBalancing(nodeReports)) return;

	// Check if any nodes require rebooting, and if so, reboot them.
	if (await handleRequiredReboots(nodeReports)) return;

	console.log("Cluster check completed without actions.");
}

/**
 * Function that tries to balance load in the cluster by promoting a new patroni leader away from a overloaded node.
 * @param nodeReports The reports from the nodes in the cluster.
 * @returns A promise that resolves to true if we successfully promoted a new leader, false otherwise.
 */
async function handlePatroniLoadBalancing(nodeReports: ClusterNodeReport[]): Promise<boolean> {
	// Return if there are no node that reported.
	if (nodeReports.length === 0) return false;

	// Calculate the average load and find any node that has more than 100% higher load than average.
	const averageNodeLoad = nodeReports.reduce((sum, report) => sum + report.averageLoad, 0) / nodeReports.length;
	const overloadedReport = nodeReports.find((report) => report.patroniLeaderships.length > 0 && report.averageLoad > averageNodeLoad * 2);

	// Return if no nodes are overloaded.
	if (!overloadedReport) return false;

	// Find node candidates that have less than 50% of the average load.
	const potentialCandidate = nodeReports.find((report) => report.node.id !== overloadedReport.node.id && report.averageLoad < averageNodeLoad * 0.5);
	if (!potentialCandidate) return false;

	// Get the cluster config once for service lookup.
	const clusterConfig = getClusterConfig();

	// Loop through the patroni services on the overloaded node.
	for (const serviceId of overloadedReport.patroniLeaderships) {
		// Get the service running on the overloaded node, make sure its a patroni service, and check if its healthy.
		const service = clusterConfig.getService(serviceId);
		if (!service || service.type !== "patroni") continue;
		if (!(await getPatroniHealth(service))) continue;

		// Log the action.
		console.log(
			`Promoting node #${potentialCandidate.node.id} to leader of service '${serviceId}' to balance load from node #${overloadedReport.node.id} (${overloadedReport.averageLoad} -> ${potentialCandidate.averageLoad}).`,
		);

		// Promote the candidate we found.
		if (!(await promoteToPatroniLeader(service, potentialCandidate.node))) return false;
		return true;
	}

	// Return false if we weren't able to find a suitable service to promote.
	return false;
}

/**
 * Function that tries to balance the patroni leaderships in the cluster by promoting suitable candidate.
 * @param nodeReports The reports from the nodes in the cluster.
 * @returns A promise that resolves to true if we successfully promoted a new leader, false otherwise.
 */
async function handlePatroniBalancing(nodeReports: ClusterNodeReport[]): Promise<boolean> {
	// Return if there are no node that reported.
	if (nodeReports.length === 0) return false;

	// Get cluster config and services.
	const clusterConfig = getClusterConfig();
	const patroniServices = clusterConfig.getSortedServices().filter(([, service]) => service.type === "patroni");

	// Return if the number of patroni services are 0
	if (patroniServices.length === 0) return false;

	// Calculate the optimal number of patroni leaderships per node and find any node that has more than this.
	const optimalLeadershipsPerNode = Math.ceil(patroniServices.length / nodeReports.length);
	const overloadedReport = nodeReports.find((report) => report.patroniLeaderships.length > optimalLeadershipsPerNode);

	// Return if no nodes are overloaded.
	if (!overloadedReport) return false;

	// Find node candidates that have less patroni leaderships than the optimal.
	const potentialCandidate = nodeReports.find((report) => report.node.id !== overloadedReport.node.id && report.patroniLeaderships.length < optimalLeadershipsPerNode);
	if (!potentialCandidate) return false;

	// Loop through the patroni services on the overloaded node.
	for (const serviceId of overloadedReport.patroniLeaderships) {
		// Get the service running on the overloaded node, make sure its a patroni service, and check if its healthy.
		const service = clusterConfig.getService(serviceId);
		if (!service || service.type !== "patroni") continue;
		if (!(await getPatroniHealth(service))) continue;

		// Log the action.
		console.log(`Promoting node #${potentialCandidate.node.id} to leader of service '${serviceId}' to balance load from overloaded node #${overloadedReport.node.id}.`);

		// Promote the candidate we found.
		if (!(await promoteToPatroniLeader(service, potentialCandidate.node))) return false;
		return true;
	}

	// Return false if we weren't able to find a suitable service to promote.
	return false;
}

/**
 * Function that check if any nodes require reboots and if so, selects one, drains its patroni leaderships to other nodes, and reboots it.
 * @param nodeReports The reports from the nodes in the cluster.
 * @returns True if we handled a required reboot, false otherwise.
 */
async function handleRequiredReboots(nodeReports: ClusterNodeReport[]): Promise<boolean> {
	// Return if there are less than 2 nodes.
	if (nodeReports.length < 2) return false;

	const clusterConfig = getClusterConfig();
	const isCoordinatorRebootWindow = new Date().getHours() === COORDINATOR_REBOOT_HOUR;

	// Find first node that requires a reboot, but only allow rebooting the coordinator when load is near idle around 3 AM.
	const rebootReport = nodeReports.find(
		(report) =>
			report.requiresRestart &&
			(!clusterConfig.isCoordinatorNode(report.node) || (report.averageLoad <= COORDINATOR_REBOOT_MAX_LOAD && isCoordinatorRebootWindow)) &&
			!clusterConfig.isLeaderNode(report.node),
	);
	if (!rebootReport) return false;

	// Find nodes that dont require reboots.
	const candidateReports = nodeReports.filter((report) => report.node.id !== rebootReport.node.id && !report.requiresRestart);

	// First check that all patroni services are ready for a leadership change, and if not, abort the reboot to avoid instability.
	for (const serviceId of rebootReport.patroniLeaderships) {
		const service = clusterConfig.getService(serviceId);
		if (!service || service.type !== "patroni") continue;
		if (!(await getPatroniHealth(service))) return false;
	}

	//
	for (const serviceId of rebootReport.patroniLeaderships) {
		const service = clusterConfig.getService(serviceId);
		if (!service || service.type !== "patroni") continue;

		// Sort the candidate reports based on number of patroni leaderships and secondary on load, and select the best candidate.
		const candidateReport = [...candidateReports].sort((left, right) => {
			if (left.patroniLeaderships.length !== right.patroniLeaderships.length) {
				return left.patroniLeaderships.length - right.patroniLeaderships.length;
			}

			return left.averageLoad - right.averageLoad;
		})[0];

		// Return false if we don't find any candidates.
		if (!candidateReport) return false;

		// Promote the candidate to leader for the service and log the action.
		console.log(`Promoting node #${candidateReport.node.id} to leader of service '${serviceId}' to drain node #${rebootReport.node.id} before reboot.`);
		if (!(await promoteToPatroniLeader(service, candidateReport.node))) return false;

		// Add the service to the candidates' report to avoid overloading it.
		candidateReport.patroniLeaderships.push(serviceId);
	}

	// Finally, request the reboot.
	console.log(`Requesting reboot for node #${rebootReport.node.id}.`);
	return await requestNodeReboot(rebootReport.node);
}

setInterval(() => {
	if (isCheckingCluster) return;

	isCheckingCluster = true;
	checkCluster()
		.catch((error) => {
			console.warn(`Leader manager failed: ${error instanceof Error ? error.message : "Unknown error."}`);
		})
		.finally(() => {
			isCheckingCluster = false;
		});
}, CLUSTER_HEALTHCHECK_INTERVAL_MS);
