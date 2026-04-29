export class ClusterConfigError extends Error {
	constructor() {
		super("The provided cluster configuration is invalid.");
		this.name = "ClusterConfigError";
	}
}

export class NodeAlreadyExistsError extends Error {
	constructor() {
		super("A node with the same hostname, WireGuard public key, or public IP already exists in the cluster.");
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

export class ServiceIdConflictError extends Error {
	constructor(serviceId: string) {
		super(`Service '${serviceId}' already exists.`);
		this.name = "ServiceIdConflictError";
	}
}

export class ServicePortAllocationError extends Error {
	constructor() {
		super("No available service ports are available to be allocated.");
		this.name = "ServicePortAllocationError";
	}
}

export class CouldNotFindNodeError extends Error {
	constructor() {
		super("Could not find the specified node in the cluster configuration.");
		this.name = "CouldNotFindNodeError";
	}
}

export class CouldNotAddEtcdMemberError extends Error {
	constructor() {
		super(`Failed to add etcd member.`);
		this.name = "CouldNotAddEtcdMemberError";
	}
}
