import express from "express";
import { getClusterConfig } from "../cluster/config";

export const expressApp = express();

expressApp.use(express.json());

expressApp.use((err: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
	if (err instanceof SyntaxError) {
		res.status(400).send("JSON is invalid, please try again.");
		return;
	}
	next(err);
});

expressApp.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
	if (req.headers["x-access-key"] !== getClusterConfig()?.accessKey) {
		res.status(401).send("Access key is invalid, please try again.");
		return;
	}
	next();
});

expressApp.listen(8080, () => {
	console.log("HTTP server is listening on port 8080");
});
