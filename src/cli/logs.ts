import { spawn } from "child_process";

export async function logsCommandHandler(): Promise<void> {
	await new Promise<void>((resolve) => {
		// Spawn a new process that runs "journalctl -fu linux-paas.service" to stream the logs from systemd.
		const child = spawn("journalctl", ["-fu", "linux-paas.service"], {
			stdio: "inherit",
		});

		// Create a listener for errors. If one occurs, log it and exit with an error code.
		child.on("error", (error) => {
			console.error(error instanceof Error ? error.message : "Failed to run journalctl.");
			process.exitCode = 1;
			resolve();
		});

		// Create a listener for process exit.
		child.on("exit", (code, signal) => {
			// Give a non-zero exit code if the process was stopped by a signal other than SIGINT or SIGTERM.
			if (signal && signal !== "SIGINT" && signal !== "SIGTERM") process.exitCode = 1;

			// If the process exited with a non-zero code, set it.
			if (code && code !== 0) process.exitCode = code;

			// Resolve the promise.
			resolve();
		});
	});
}
