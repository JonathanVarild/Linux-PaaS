export class InvalidNodeConfigError extends Error {
	constructor() {
		super("The provided node configuration is invalid.");
		this.name = "InvalidNodeConfigError";
	}
}

export class ClusterConfigError extends Error {
	constructor() {
		super("The provided cluster configuration is invalid.");
		this.name = "ClusterConfigError";
	}
}

export class NodeAlreadyExistsError extends Error {
	constructor() {
		super("A node with the same WireGuard public key or public IP already exists in the cluster.");
		this.name = "NodeAlreadyExistsError";
	}
}

export class MaximumNodesReachedError extends Error {
	constructor() {
		super("The cluster has reached the maximum number of nodes (255).");
		this.name = "MaximumNodesReachedError";
	}
}

export class NoClusterConfigError extends Error {
	constructor() {
		super("No cluster configuration is currently loaded.");
		this.name = "NoClusterConfigError";
	}
}
