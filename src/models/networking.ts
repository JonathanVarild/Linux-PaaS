import { z } from "zod";

export const Ipv4Schema = z.string().regex(/^(?:\d{1,3}\.){3}\d{1,3}$/, "Invalid IPv4 address format.");
export const Ipv4WithMaskSchema = z.string().regex(/^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/, "Invalid IPv4 address with mask format.");

export const NodeJoinRequestSchema = z.object({
	hostname: z.string().trim().min(1),
	wg_public_key: z.string().trim().min(1),
});
export type NodeJoinRequest = z.infer<typeof NodeJoinRequestSchema>;
