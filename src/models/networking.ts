import { z } from "zod";

export const Ipv4Schema = z.string().regex(/^(?:\d{1,3}\.){3}\d{1,3}$/, "Invalid IPv4 address format.");

export const NodeJoinRequestSchema = z.object({
	hostname: z.string().trim().min(1),
	wg_public_key: z.string().trim().min(1),
});
export type NodeJoinRequest = z.infer<typeof NodeJoinRequestSchema>;

export const ClusterConfigRequestSchema = z.object({
	cluster: z.unknown(),
	nodes: z.unknown(),
	services: z.unknown().optional(),
});

export const ConfigCheckRequestSchema = z.object({
	config_hash: z.string().trim().length(64),
});

export const ConfigCheckResponseSchema = z.object({
	up_to_date: z.boolean(),
	cluster: z.unknown().optional(),
	nodes: z.unknown().optional(),
	services: z.unknown().optional(),
});

export const NodeStatusResponseSchema = z.object({
	load_value: z.number().min(0),
	offline_node_ids: z.array(z.number().int().min(1).max(255)),
});
export type NodeStatusResponse = z.infer<typeof NodeStatusResponseSchema>;

export const NodeReportResponseSchema = z.object({
	average_load: z.number().min(0),
	requires_restart: z.boolean(),
	patroni_leaderships: z.array(z.string().trim().min(1)),
});
export type NodeReportResponse = z.infer<typeof NodeReportResponseSchema>;

export const LeaderElectionRequestSchema = z.object({
	config_hash: z.string().trim().length(64),
});
