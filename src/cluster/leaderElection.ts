import fetch from "node-fetch";
import os from "os";
import { HTTP_DAEMON_PORT, LEADER_ELECTION_HARD_COOLDOWN_MS, LEADER_ELECTION_INTERVAL_MS, LEADER_ELECTION_REQUEST_TIMEOUT_MS } from "../constants";
import { NodeStatusResponseSchema } from "../models/networking";
import { getClusterConfig, getClusterConfigHash, syncConfigToCluster } from "./config";

import type { ClusterNode } from "./config";

type NodeStatus = {
	loadValue: number;
	offlineNodeIds: number[];
};

let leaderElectionPromise: Promise<void> | null = null;
let lastLeaderElectionTime = 0;

/**
 * Function used to attempt a new leader election, which will succeed if there are no elections in progress and no cooldowns.
 * @param force If the election is absolutely necessary, a shorter cooldown will be considered.
 */
export function attemptLeaderElection(force = false): void {
	const clusterConfig = getClusterConfig();

	// Ensure that we are the coordinator and that there is no election already in progress
	if (!clusterConfig.isCoordinatorNode(clusterConfig.getLocalNode())) return;
	if (leaderElectionPromise) return;

	// Check the time since last election, if we pass the hard cooldown, and finally if we pass the regular cooldown or if the election is forced.
	const elapsedMs = Date.now() - lastLeaderElectionTime;
	if (elapsedMs < LEADER_ELECTION_HARD_COOLDOWN_MS) return;
	if (!force && elapsedMs < LEADER_ELECTION_INTERVAL_MS) return;

	// Set last election time.
	lastLeaderElectionTime = Date.now();

	// Start a new election, catch any errors and finally reset the promise state.
	leaderElectionPromise = runLeaderElection()
		.catch((error) => {
			console.warn(`Leader election failed: ${error instanceof Error ? error.message : "Unknown error."}`);
		})
		.finally(() => {
			leaderElectionPromise = null;
		});
}

/**
 * Function used by any node to request the coordinator to perform a leader change.
 * @returns A promise that resolves when the request is complete.
 */
export async function requestLeaderElection(): Promise<void> {
	const clusterConfig = getClusterConfig();
	const localNode = clusterConfig.getLocalNode();

	// If we are the coordinator, request the election instantly.
	if (clusterConfig.isCoordinatorNode(localNode)) {
		attemptLeaderElection(true);
		return;
	}

	// SEt a request timeout.
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), LEADER_ELECTION_REQUEST_TIMEOUT_MS);

	try {
		// Make request to the coordinator node.
		const response = await fetch(`http://${clusterConfig.coordinatorNode.wireguardIp}:${HTTP_DAEMON_PORT}/request_leader_election`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-access-key": clusterConfig.accessKey,
			},
			body: JSON.stringify({
				config_hash: getClusterConfigHash(),
			}),
			signal: controller.signal,
		});

		// Check if we succeeded.
		if (response.ok) return;
		console.warn(`Failed leader checkup request (${response.status}): ${response.text()}`);
	} catch (error) {
		console.warn(`Failed leader checkup request: ${error instanceof Error ? error.message : "Unknown error."}`);
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Function to elect a new leader for the cluster.
 * @returns A promise that resolves when the cluster election is over.
 */
async function runLeaderElection(): Promise<void> {
	const clusterConfig = getClusterConfig();
	const nodeStatuses: Record<number, NodeStatus> = {};

	// Get the status of each node in parallel and ignore failures, since its a effort to find the best candidate.
	await Promise.all(
		clusterConfig.nodes.map(async (node) => {
			const nodeStatus = await fetchNodeStatus(node);
			if (nodeStatus !== null) nodeStatuses[node.id] = nodeStatus;
		}),
	);

	// Process the status information provided by all nodes to determine the best leader candidate.
	const leaderCandidateId = findOptimalLeader(nodeStatuses);

	// Ensure that the leader candidate isn't already the leader.
	if (clusterConfig.leaderNode.id === leaderCandidateId) return;

	// Set the leader and sync the new config to the cluster.
	clusterConfig.setLeaderNode(leaderCandidateId);
	await syncConfigToCluster(clusterConfig);
	console.log(`Leader changed to node #${leaderCandidateId}}.`);
}

/**
 * Function to fetch the status of a specific node, including its load value and which nodes it considers offline.
 * @param node The cluster node to fetch the status for.
 * @returns The node status, or null if the status could not be fetched.
 */
async function fetchNodeStatus(node: ClusterNode): Promise<NodeStatus | null> {
	// Check if we are the local node and return status directly.
	if (node.hostname === os.hostname()) {
		return {
			loadValue: os.loadavg()[1] ?? 0,
			offlineNodeIds: getClusterConfig()
				.nodes.filter((clusterNode) => !clusterNode.status)
				.map((clusterNode) => clusterNode.id),
		};
	}

	// Get clusterconfig, setup controller, and timeout for the request.
	const clusterConfig = getClusterConfig();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), LEADER_ELECTION_REQUEST_TIMEOUT_MS);

	try {
		// Make request to the specificed node.
		const response = await fetch(`http://${node.wireguardIp}:${HTTP_DAEMON_PORT}/get_node_status`, {
			headers: {
				"x-access-key": clusterConfig.accessKey,
			},
			signal: controller.signal,
		});

		// Return null and log a warning if the reponse fails.
		const responseBody = await response.text();
		if (!response.ok) {
			console.warn(`Failed to fetch leader status from ${node.hostname} (${response.status}): ${responseBody}`);
			return null;
		}

		// Try to parse the request data.
		let responseJson: unknown;
		responseJson = JSON.parse(responseBody);

		// Validate the response data.
		const nodeStatusResult = NodeStatusResponseSchema.safeParse(responseJson);
		if (!nodeStatusResult.success) {
			console.warn(`Leader status response from ${node.hostname} is invalid.`);
			return null;
		}

		// Return the load value and offline node IDs.
		return {
			loadValue: nodeStatusResult.data.load_value,
			offlineNodeIds: nodeStatusResult.data.offline_node_ids,
		};
	} catch (error) {
		console.warn(`Failed to fetch leader status from ${node.hostname}: ${error instanceof Error ? error.message : "Unknown error."}`);
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Function to determine the most optimal leader node based on the provided node statuses.
 * @param nodeStatuses Record mapping node IDs to their node status.
 * @returns The node ID of the most optimal leader candidate.
 */
function findOptimalLeader(nodeStatuses: Record<number, NodeStatus>): number {
	const clusterConfig = getClusterConfig();
	const currentLeaderId = clusterConfig.leaderNode.id;
	const offlineVotesById: Record<number, number> = {};

	// Count the number of offline votes each node received from other nodes.
	for (const nodeId of Object.keys(nodeStatuses).map(Number)) {
		offlineVotesById[nodeId] = Object.values(nodeStatuses).filter((status) => status.offlineNodeIds.includes(nodeId)).length;
	}

	// Turn the node statuses into a sorted list of candidate IDs, sorted by load value and offline votes.
	const sortedCandidates = Object.keys(nodeStatuses)
		.map(Number)
		.sort((leftNodeId, rightNodeId) => {
			const leftNodeStatus = nodeStatuses[leftNodeId]!;
			const rightNodeStatus = nodeStatuses[rightNodeId]!;

			// First, sort by load value (lower is better)
			if (leftNodeStatus.loadValue !== rightNodeStatus.loadValue) {
				return leftNodeStatus.loadValue - rightNodeStatus.loadValue;
			}

			const leftOfflineVotes = offlineVotesById[leftNodeId] ?? 0;
			const rightOfflineVotes = offlineVotesById[rightNodeId] ?? 0;

			// Second, sort by offline votes (lower is better)
			if (leftOfflineVotes !== rightOfflineVotes) {
				return leftOfflineVotes - rightOfflineVotes;
			}

			// Third, prefer current leader if its a tie to aovid unnecessary leader changes
			if (leftNodeId === currentLeaderId) return -1;
			if (rightNodeId === currentLeaderId) return 1;

			// Finally, sort by node ID to ensure determinism (lower is better)
			return leftNodeId - rightNodeId;
		});

	// Return top candidate.
	return sortedCandidates[0];
}
