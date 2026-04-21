import os from "os";
import { Cluster, getClusterConfig, setClusterConfig } from "../cluster/config";
import { OutputStream } from "../daemon";
import { z } from "zod";
import { Ipv4Schema } from "../models/networking";
import { parseOrThrowWithMessage } from "../utils/zod";

const CreateOptionsSchema = z.object({
	publicIp: Ipv4Schema,
});

export function createServerHandler(options: unknown, stream: OutputStream): void {
	const parsedOptions = parseOrThrowWithMessage(CreateOptionsSchema, options);

	if (getClusterConfig() !== null) {
		throw new Error("Cluster configuration already exists.");
	}

	const config = Cluster.create(os.hostname(), parsedOptions.publicIp);
	setClusterConfig(config);
	const result = config.toJSON();
	stream.sendOutput(JSON.stringify(result, null, 2));
}
