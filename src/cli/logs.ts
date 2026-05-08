import fs from "fs";
import path from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { CONFIG_PATH_SERVICES_DIR } from "../constants";
import { ServiceIdSchema } from "../models/config";
import { parseOrThrowWithMessage } from "../utils/zod";

const execFileAsync = promisify(execFile);

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

export async function serviceLogsCommandHandler(serviceId: string): Promise<void> {
	const parsedServiceId = parseOrThrowWithMessage(ServiceIdSchema, serviceId);
	const serviceDirectory = path.join(CONFIG_PATH_SERVICES_DIR, parsedServiceId);
	if (!fs.existsSync(path.join(serviceDirectory, "docker-compose.yml"))) {
		throw new Error(`Service '${parsedServiceId}' is not deployed on this node.`);
	}

	const { stdout } = await execFileAsync("docker-compose", ["ps", "-q"], {
		cwd: serviceDirectory,
		encoding: "utf8",
	});
	const containerId = stdout.trim().split(/\s+/)[0];
	if (!containerId) {
		throw new Error(`Service '${parsedServiceId}' is not running on this node.`);
	}

	await new Promise<void>((resolve) => {
		// Spawn a new process that runs "docker logs -f" to stream the logs from the service.
		const child = spawn("docker", ["logs", "-f", containerId], {
			stdio: "inherit",
		});

		// Create a listener for errors. If one occurs, log it and exit with an error code.
		child.on("error", (error) => {
			console.error(error instanceof Error ? error.message : "Failed to run docker logs.");
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
