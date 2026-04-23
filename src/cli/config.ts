import { getClusterConfig, hasClusterConfig } from "../cluster/config";
import { OutputStream } from "../app/daemon";

export async function configServerHandler(_args: unknown, stream: OutputStream): Promise<void> {
	if (!hasClusterConfig()) {
		throw new Error("Create a new cluster before viewing configuration.");
	}

	stream.sendOutput(JSON.stringify(getClusterConfig().getCopy(), null, 2));
}
