import { z } from "zod";
import { Ipv4Schema } from "./networking";

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
	leader_node_id: z.number().int().min(1).max(255).optional(),
});
export type ClusterInfo = z.infer<typeof ClusterInfoSchema>;

export const WebServiceInfoSchema = z.object({
	service_id: z.string().trim().min(1),
	type: z.literal("web"),
	image: z.string().trim().min(1),
	domain: z.string().trim().min(1),
	internal_port: z.number().int().min(1).max(65535),
});
export type WebServiceInfo = z.infer<typeof WebServiceInfoSchema>;

export const PatroniServiceInfoSchema = z.object({
	service_id: z.string().trim().min(1),
	type: z.literal("patroni"),
	sync_mode: z.enum(["async", "sync"]),
	read_write_port: z.number().int().min(1).max(65535),
	read_only_port: z.number().int().min(1).max(65535),
});
export type PatroniServiceInfo = z.infer<typeof PatroniServiceInfoSchema>;

export const ClusterServiceSchema = z.discriminatedUnion("type", [WebServiceInfoSchema, PatroniServiceInfoSchema]);
export type ClusterService = z.infer<typeof ClusterServiceSchema>;
