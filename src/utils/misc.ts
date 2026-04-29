export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export function validateEnvironment(): void {
	if (process.env.NODE_ENV === "production" || process.env.NODE_ENV === "docker_dev") {
		return;
	}

	throw new Error("Application must run in Docker or on a standalone server");
}
