import dgram from "node:dgram";

export async function getPublicIP(): Promise<string> {
	return new Promise((resolve) => {
		const socket = dgram.createSocket("udp4");

		socket.connect(53, "1.1.1.1", () => {
			const address = socket.address().address;
			socket.close();
			resolve(address);
		});
	});
}
