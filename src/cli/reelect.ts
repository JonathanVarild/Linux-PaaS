import { OutputStream } from "../app/daemon";
import { requestLeaderElection } from "../cluster/leaderElection";
import { hasClusterConfig } from "../cluster/config";

export async function reelectLeaderHandler(_args: unknown, stream: OutputStream): Promise<void> {
	if (!hasClusterConfig()) {
		throw new Error("Create a new cluster before reelecting leader.");
	}

	await requestLeaderElection();
	stream.sendOutput("Leader reelection requested.");
}
