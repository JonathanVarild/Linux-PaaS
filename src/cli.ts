import { Command } from "commander";
import { sendIpcCommand } from "./utils/ipc";
import { getPublicIP } from "./utils/ip";

const program = new Command();

program
	.command("create")
	.option("--node-ip <ip>", "The IP that other nodes can reach this node at.")
	.action(async (options: { nodeIp?: string }) => {
		await sendIpcCommand("create", { nodeIp: options.nodeIp ?? (await getPublicIP()) });
	});

program.command("accept").action(async () => {
	await sendIpcCommand("accept", {});
});

program
	.command("join")
	.argument("<bundle-json>")
	.action(async (bundleJson: string) => {
		await sendIpcCommand("join", bundleJson);
	});

void program.parseAsync();
