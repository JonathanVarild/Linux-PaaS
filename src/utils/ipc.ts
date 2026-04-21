import ipc from "node-ipc";

export const DAEMON_ID = "linux-paas-daemon";
export const DAEMON_SOCKET_PATH = "/tmp/linux-paas.sock";

export async function sendIpcCommand(command: string, args: unknown): Promise<void> {
	ipc.config.silent = true;

	// Wrap in promise to allow asynchronous handling.
	await new Promise<void>((resolve) => {
		let finished = false;

		// Create function to close the connection
		const closeConnection = (error?: string) => {
			if (finished) return;
			finished = true;

			if (error) {
				console.error(error);
				process.exitCode = 1;
			}

			try {
				ipc.disconnect(DAEMON_ID);
			} catch {}

			resolve();
		};

		// Connect to daemon on socket path and send command and arguments.
		ipc.connectTo(DAEMON_ID, DAEMON_SOCKET_PATH, () => {
			const daemon = ipc.of[DAEMON_ID];

			// Listen for "connect" event before sending command to ensure connection is up.
			daemon.on("connect", () => {
				daemon.emit("command", { command, args });
			});

			// Listen for "output" events and print data.
			daemon.on("output", (data: string) => {
				console.log(data);
			});

			// Listen for "complete" event and exit.
			daemon.on("complete", () => {
				closeConnection();
			});

			// Listen for "error" events.
			daemon.on("error", (payload: { message?: string } | string) => {
				const message = typeof payload === "string" ? payload : payload?.message || "An unknown error occurred.";
				closeConnection(message);
			});

			// Listen for "disconnect" event if daemon disconnects.
			daemon.on("disconnect", () => {
				if (!finished) {
					closeConnection("Lost connection to daemon...");
				}
			});
		});
	});
}
