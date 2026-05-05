import { validateEnvironment } from "./utils/misc";

validateEnvironment();

require("./cluster/config");
require("./cluster/healthManager");
require("./adapters/wireguard");
require("./app/daemon");
require("./app/httpServer");
