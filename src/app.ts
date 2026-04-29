import { validateEnvironment } from "./utils/misc";

validateEnvironment();

require("./cluster/config");
require("./adapters/wireguard");
require("./app/daemon");
require("./app/httpServer");
