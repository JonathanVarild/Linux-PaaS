import { z } from "zod";
import { Ipv4Schema } from "./networking";
import { PATRONI_PORT_END, PATRONI_PORT_START, PATRONI_REST_PORT_START, WEB_EXPOSED_PORT_START } from "../constants";

export const ServiceIdSchema = z
	.string()
	.trim()
	.regex(/^[a-z0-9][a-z0-9-]*$/, "The service id can only contain lowercase letters, numbers, and hyphens.");

export const NodeInfoSchema = z.object({
	node_id: z.number().int().min(1).max(255),
	hostname: z.string().trim().min(1),
	public_ip: Ipv4Schema,
	wireguard_public_key: z.string().trim().min(1),
});
export type NodeInfo = z.infer<typeof NodeInfoSchema>;

export const ClusterInfoSchema = z.object({
	cluster_id: z.string(),
	access_key: z.string().trim().min(1),
	version: z.number().int(),
	created_at: z.string(),
	updated_at: z.string(),
	coordinator_node_id: z.number().int().min(1).max(255),
	leader_node_id: z.number().int().min(1).max(255),
});
export type ClusterInfo = z.infer<typeof ClusterInfoSchema>;

const WebServiceInfoSchema = z.object({
	service_id: ServiceIdSchema,
	type: z.literal("web"),
	image: z.string().trim().min(1),
	domain: z.string().trim().min(1),
	internal_port: z.number().int().min(1).max(65535),
	exposed_port: z.number().int().min(WEB_EXPOSED_PORT_START).max(65535),
});
export type WebService = z.infer<typeof WebServiceInfoSchema>;

const PatroniServiceInfoSchema = z.object({
	service_id: ServiceIdSchema,
	type: z.literal("patroni"),
	sync_mode: z.enum(["async", "sync"]),
	read_write_port: z.number().int().min(PATRONI_PORT_START).max(PATRONI_PORT_END),
	read_only_port: z.number().int().min(PATRONI_PORT_START).max(PATRONI_PORT_END),
	patroni_rest_port: z.number().int().min(PATRONI_REST_PORT_START).max(65535),
	postgres_port: z.number().int().min(1).max(65535),
});
export type PatroniService = z.infer<typeof PatroniServiceInfoSchema>;

export const ClusterServiceSchema = z.discriminatedUnion("type", [WebServiceInfoSchema, PatroniServiceInfoSchema]);
export type ClusterService = z.infer<typeof ClusterServiceSchema>;

export const ClusterServicesSchema = z.record(z.string(), ClusterServiceSchema).superRefine((services, context) => {
	for (const [key, service] of Object.entries(services)) {
		if (!ServiceIdSchema.safeParse(key).success) {
			context.addIssue({
				code: "custom",
				message: "ServiceID is not a valid id.",
				path: [key],
			});
		}

		if (service.service_id !== key) {
			context.addIssue({
				code: "custom",
				message: "Service key must match service_id.",
				path: [key],
			});
		}
	}
});
export type ClusterServices = Record<string, ClusterService>;
