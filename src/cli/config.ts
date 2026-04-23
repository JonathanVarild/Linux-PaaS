import { getClusterConfig, hasClusterConfig } from "../cluster/config";
import { OutputStream } from "../app/daemon";

export async function configServerHandler(_args: unknown, stream: OutputStream): Promise<void> {
	if (!hasClusterConfig()) {
		throw new Error("Create a new cluster before viewing configuration.");
	}

	const clusterConfig = getClusterConfig();
	stream.sendOutput(
		JSON.stringify(
			{
				cluster: clusterConfig.getCopy(),
				nodes: clusterConfig.getNodesCopy(),
			},
			null,
			2,
		),
	);
}
