import { z } from "zod";

export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, error: Error): T {
	const result = schema.safeParse(value);
	if (result.success) {
		return result.data;
	}

	throw error;
}

export function parseOrThrowWithMessage<T>(schema: z.ZodType<T>, value: unknown): T {
	const result = schema.safeParse(value);
	if (result.success) {
		return result.data;
	}
	throw new Error(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
}
