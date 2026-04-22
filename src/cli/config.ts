import { getClusterConfig } from "../cluster/config";
import { OutputStream } from "../daemon";

export async function configServerHandler(_args: unknown, stream: OutputStream): Promise<void> {
	const clusterConfig = getClusterConfig();
	if (clusterConfig === null) {
		throw new Error("Create a new cluster before viewing configuration.");
	}

	stream.sendOutput(JSON.stringify(clusterConfig.getCopy(), null, 2));
}
