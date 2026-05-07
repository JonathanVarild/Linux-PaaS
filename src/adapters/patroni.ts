import fetch from "node-fetch";
import { PatroniService } from "../models/config";
import { ClusterNode, getClusterConfig } from "../cluster/config";
import { PATRONI_ASYNC_LAG_LIMIT, PATRONI_SYNC_LAG_LIMIT } from "../constants";
import os from "os";

type PatroniMember = {
	name?: string;
	role?: string;
	state?: string;
	host?: string;
	port?: number;
	lag?: number;
	receive_lag?: number;
	replay_lag?: number;
};

type PatroniClusterStatus = {
	members?: PatroniMember[];
};

function getPatroniNodeName(node: ClusterNode): string {
	return `node-${node.id}`;
}

/**
 * Function used to promote a node to the leader of a patroni cluster/service.
 * @param service The patroni service which will have its leader switched.
 * @param newLeader The node that should be promoted to the new leader.
 * @returns A promise that resolves to true if the promotion request succeeded, false otherwise.
 */
export async function promoteToPatroniLeader(service: PatroniService, newLeader: ClusterNode): Promise<boolean> {
	const clusterConfig = getClusterConfig();

	// Ensure the function only runs on the leader node.
	if (clusterConfig.leaderNode.hostname !== os.hostname()) return false;

	try {
		// Get the current leader node.
		const currentPatroniLeader = await getPatroniLeaderNode(service);

		// Send a request to the current leader to promote the new leader.
		await sendPatroniAPIRequest("POST", currentPatroniLeader, service, "/switchover", {
			leader: getPatroniNodeName(currentPatroniLeader),
			candidate: getPatroniNodeName(newLeader),
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Function used to check if the local node is the leader of a specific service.
 * @param service The patroni service to check.
 * @returns A promise that resolves to true if the local node is the leader, false otherwise.
 */
export async function isPatroniLeader(service: PatroniService): Promise<boolean> {
	try {
		await sendPatroniAPIRequest("GET", getClusterConfig().getLocalNode(), service, "/leader");
		return true;
	} catch {
		return false;
	}
}

/**
 * Function to send a request to the patroni API of a node.
 * @param method The HTTP method to use.
 * @param node The node to which the request should be sent.
 * @param service The patroni service to which the request should be sent.
 * @param endpoint The API endpoint to which the request should be sent.
 * @param body A object containing key-value pairs that should be sent to the API.
 * @returns A promise that resolves to the response JSON object, or an empty object if none was returned.
 */
export async function sendPatroniAPIRequest(
	method: string,
	node: ClusterNode,
	service: PatroniService,
	endpoint: string,
	body?: Record<string, string>,
): Promise<Record<string, unknown>> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);

	try {
		// Send the request.
		const response = await fetch(`http://${node.wireguardIp}:${service.patroni_rest_port}${endpoint}`, {
			method,
			headers: body ? { "Content-Type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});

		const responseBody = await response.text();
		if (response.ok) {
			if (!responseBody.trim()) return {};

			try {
				return JSON.parse(responseBody) as Record<string, unknown>;
			} catch {
				return {};
			}
		}

		// Throw an error if we were not successful.
		const failureBody = responseBody.trim();
		throw new Error(`Status: ${response.status}. Body: ${failureBody}`);
	} catch (error) {
		if (error instanceof Error) throw error;
		throw new Error(`Failed to send request on ${endpoint} to ${node.hostname}. ${error}`);
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Function used to get the current leader of a patroni cluster/service.
 * @param service The patroni service.
 * @returns A promise that resolves to the current leader node, or rejects if the leader could not be determined.
 */
async function getPatroniLeaderNode(service: PatroniService): Promise<ClusterNode> {
	const clusterConfig = getClusterConfig();
	const controllers = new Map<number, AbortController>();
	const timeouts: NodeJS.Timeout[] = [];

	try {
		// Run requests in parallel to all nodes.
		return await Promise.any(
			clusterConfig.nodes.map(async (node) => {
				// Create and save a controller for this request.
				const controller = new AbortController();
				controllers.set(node.id, controller);

				// Create a timeout for this request.
				const timeout = setTimeout(() => controller.abort(), 5000);
				timeouts.push(timeout);

				try {
					// Send the leader check to this node.
					const response = await fetch(`http://${node.wireguardIp}:${service.patroni_rest_port}/leader`, { signal: controller.signal });

					// Return this node if it is the leader.
					if (response.status === 200) return node;
					throw new Error(`Node ${node.hostname} responded with status ${response.status}.`);
				} finally {
					clearTimeout(timeout);
				}
			}),
		);
	} catch {
		throw new Error(`Could not determine Patroni leader for service "${service.service_id}".`);
	} finally {
		for (const timeout of timeouts) clearTimeout(timeout);
		for (const controller of controllers.values()) controller.abort();
	}
}

/**
 * Function to determine if a patroni cluster is healthy and not lagging excessively.
 * @param service The patroni service to check.
 * @returns A promise that resolves to true if the cluster is healthy, false otherwise.
 */
export async function getPatroniHealth(service: PatroniService): Promise<boolean> {
	const leaderNode = await getPatroniLeaderNode(service);
	const maxAllowedLag = service.sync_mode === "sync" ? PATRONI_SYNC_LAG_LIMIT : PATRONI_ASYNC_LAG_LIMIT;

	try {
		// Get the cluster status from the leader node.
		const clusterStatus = (await sendPatroniAPIRequest("GET", leaderNode, service, "/cluster")) as PatroniClusterStatus;
		if (!Array.isArray(clusterStatus.members)) return false;

		// Check so the cluster has a leader and that its healthy.
		const leaderMember = clusterStatus.members.find((member) => member.role === "leader");
		if (!leaderMember) return false;
		if (leaderMember.state !== "running") return false;

		// Variable to keep track if we have a replica that is healthy.
		let hasHealthyReplica = false;

		// Loop through all members.
		for (const member of clusterStatus.members) {
			// Skip leaders or replicas that aren't streaming since they are not deemed healthy.
			if (member.role === "leader") continue;
			if (member.state !== "streaming") continue;

			// Check if any lag value exceeds the max allowed.
			const lagValues = [member.lag, member.receive_lag, member.replay_lag].filter((lag): lag is number => typeof lag === "number");
			if (lagValues.length > 0 && Math.max(...lagValues) > maxAllowedLag) continue;

			// If we reached this far, at least one replica is healthy.
			hasHealthyReplica = true;
			break;
		}

		return hasHealthyReplica;
	} catch {
		return false;
	}
}
