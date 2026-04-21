import fs from "fs";
import ipc from "node-ipc";
import { acceptServerHandler } from "./cli/accept";
import { createServerHandler } from "./cli/create";
import { joinServerHandler } from "./cli/join";

import type { Socket } from "net";
import { DAEMON_ID, DAEMON_SOCKET_PATH } from "./utils/ipc";

export type OutputStream = {
	sendOutput: (data: string) => void;
	waitForSocketClose: () => Promise<void>;
};
type CommandHandler = (args: unknown, stream: OutputStream) => Promise<unknown> | unknown;
type IPCPayload = {
	command: string;
	args: unknown;
};

// Create mapping of command names and their handlers.
const commandHandlers: Record<string, CommandHandler> = {
	accept: acceptServerHandler,
	create: createServerHandler,
	join: joinServerHandler,
};

// Function to remove the socket file if it exists.
function removeSocketFile() {
	try {
		fs.unlinkSync(DAEMON_SOCKET_PATH);
	} catch (error) {
		const fsError = error as NodeJS.ErrnoException;
		if (fsError.code !== "ENOENT") throw error;
	}
}

// Function to start the IPC daemon.
async function startDaemon(): Promise<void> {
	removeSocketFile();

	// Set IPC ID and logging configuration.
	ipc.config.id = DAEMON_ID;
	ipc.config.silent = true;

	// Define IPC server behavior.
	ipc.serve(DAEMON_SOCKET_PATH, () => {
		// Listen for command events from clients.
		ipc.server.on("command", async (payload: IPCPayload, socket: Socket) => {
			// Ensure that the command is valid, and send an error if not.
			if (!commandHandlers[payload.command]) {
				ipc.server.emit(socket, "error", { message: "Invalid command." });
				return;
			}

			// Create stream to send output back to the client.
			const stream: OutputStream = {
				sendOutput(data: string) {
					if (!socket.destroyed) {
						ipc.server.emit(socket, "output", data);
					}
				},
				waitForSocketClose() {
					return new Promise<void>((resolve) => {
						if (socket.destroyed) {
							resolve();
							return;
						}

						socket.once("close", () => {
							resolve();
						});
					});
				},
			};

			// Asynchronously invoke command handler and send completion event or error based on the result.
			try {
				const result = await commandHandlers[payload.command](payload.args, stream);
				if (!socket.destroyed) {
					ipc.server.emit(socket, "complete", result);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : "Failed to execute command due to an unknown error.";
				if (!socket.destroyed) {
					ipc.server.emit(socket, "error", { message });
				}
			}
		});
	});

	// Start listening for IPC messages.
	ipc.server.start();
	console.log(`Daemon listening for IPC messages on ${DAEMON_SOCKET_PATH}`);
}

// Trigger for when process receives interrupt signal.
process.on("SIGINT", () => {
	removeSocketFile();
	ipc.server.stop();
	process.exit(0);
});

// Trigger for when process receives termination signal.
process.on("SIGTERM", () => {
	removeSocketFile();
	ipc.server.stop();
	process.exit(0);
});

void startDaemon();
