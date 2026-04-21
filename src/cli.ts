import { Command } from "commander";
import { sendIpcCommand } from "./utils/ipc";

const program = new Command();

program
	.command("create")
	.argument("<publicIp>")
	.action(async (publicIp: string) => {
		await sendIpcCommand("create", { publicIp });
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
