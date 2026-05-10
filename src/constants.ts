import path from "path";

export const CONFIG_PATH_DIR = "/etc/linux-paas";
export const CONFIG_PATH_CONFIG = path.join(CONFIG_PATH_DIR, "config.json");
export const CONFIG_PATH_NODES = path.join(CONFIG_PATH_DIR, "nodes.json");
export const CONFIG_PATH_SERVICES = path.join(CONFIG_PATH_DIR, "services.json");
export const CONFIG_PATH_SERVICES_DIR = path.join(CONFIG_PATH_DIR, "services");

export const CONFIG_VERSION = 1;
export const CONFIG_HASH_FILENAME = ".config-hash";

export const ETCD_PATH_DIR = path.join(CONFIG_PATH_SERVICES_DIR, "_etcd");
export const HAPROXY_PATH_DIR = path.join(CONFIG_PATH_SERVICES_DIR, "_haproxy");
export const ETCD_SERVICE_NAME = "etcd";
export const HAPROXY_SERVICE_NAME = "haproxy";

export const SERVICE_TEMPLATES_PATH = path.resolve(process.cwd(), "service_templates");

export const HTTP_DAEMON_PORT = 8080;
export const JOIN_SERVER_PORT = 8443;
export const CONFIG_CHECK_INTERVAL_MS = 60 * 1000;
export const NODE_PING_INTERVAL_MS = 1000;
export const LEADER_ELECTION_INTERVAL_MS = 5 * 60 * 1000;
export const LEADER_ELECTION_HARD_COOLDOWN_MS = 15 * 1000;
export const LEADER_ELECTION_REQUEST_TIMEOUT_MS = 5000;
export const NODE_REPORT_REQUEST_TIMEOUT_MS = 10 * 1000;
export const LEADER_ELECTION_MAX_RETRIES = 3;
export const NODE_HEALTHCHECK_INTERVAL_MS = 30 * 1000;
export const CLUSTER_HEALTHCHECK_INTERVAL_MS = 60 * 1000;
export const REBOOT_REQUIRED_LOAD_VALUE = 1000000;
export const COORDINATOR_REBOOT_MAX_LOAD = 0.2;
export const COORDINATOR_REBOOT_HOUR = 3;

export const WIREGUARD_NETWORK_PREFIX = "10.0.0";
export const WIREGUARD_CIDR = 24;
export const WIREGUARD_LISTEN_PORT = 51820;
export const WIREGUARD_INTERFACE = "wg0";
export const WIREGUARD_PRIVATE_KEY_PATH = path.join(CONFIG_PATH_DIR, "private.key");

export const WEB_EXPOSED_PORT_START = 15000;
export const PATRONI_PORT_START = 5432;
export const PATRONI_PORT_END = PATRONI_PORT_START + 2048;
export const PATRONI_POSTGRES_PORT_START = PATRONI_PORT_END + 1;
export const PATRONI_REST_PORT_START = 8008;
export const PATRONI_UID = 101;
export const PATRONI_GID = 103;
export const PATRONI_SYNC_LAG_LIMIT = 0;
export const PATRONI_ASYNC_LAG_LIMIT = 1024 * 1024;

export const ETCD_CLIENT_PORT = 2379;
export const ETCD_PEER_PORT = 2380;
export const ETCD_READY_RETRY_COUNT = 10;
export const ETCD_READY_RETRY_DELAY_MS = 1000;
