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

export const StartupPingRequestSchema = z.object({
	config_hash: z.string().trim().length(64),
});

export const StartupPingResponseSchema = z.object({
	up_to_date: z.boolean(),
	cluster: z.unknown().optional(),
	nodes: z.unknown().optional(),
	services: z.unknown().optional(),
});
