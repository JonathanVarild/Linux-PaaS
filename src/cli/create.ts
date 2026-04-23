import os from "os";
import { Cluster, hasClusterConfig, saveClusterConfigToDisk, setClusterConfig } from "../cluster/config";
import { OutputStream } from "../app/daemon";
import { z } from "zod";
import { Ipv4Schema } from "../models/networking";
import { parseOrThrowWithMessage } from "../utils/zod";
import { getPublicIP } from "../utils/ip";

const CreateOptionsSchema = z.object({
	nodeIp: Ipv4Schema.optional(),
});

export async function createServerHandler(options: unknown, stream: OutputStream): Promise<void> {
	const parsedOptions = parseOrThrowWithMessage(CreateOptionsSchema, options);
	const publicIp = parsedOptions.nodeIp ?? (await getPublicIP());

	if (hasClusterConfig()) {
		throw new Error("Cluster configuration already exists.");
	}

	const config = Cluster.create(os.hostname(), publicIp);
	setClusterConfig(config);
	saveClusterConfigToDisk(config);
	const result = config.getCopy();
	stream.sendOutput(JSON.stringify(result, null, 2));
}
