export class FailedToGenerateWireguardKeysError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FailedToGenerateWireguardKeysError";
	}
}
