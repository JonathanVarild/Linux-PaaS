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
	version: z.number().int(),
	created_at: z.string(),
	updated_at: z.string(),
	coordinator_node: NodeInfoSchema,
	leader_node: NodeInfoSchema.optional(),
	nodes: z.array(NodeInfoSchema).min(1),
	services: z.record(z.string(), z.unknown()),
});
export type ClusterInfo = z.infer<typeof ClusterInfoSchema>;
