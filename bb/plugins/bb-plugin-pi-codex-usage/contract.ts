import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("environment"), environmentId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("host"), hostId: z.string().min(1) }).strict(),
]);
export type Target = z.infer<typeof targetSchema>;
const windowSchema = z.object({
  id: z.string(), label: z.string(), usedPercent: z.number().finite().nonnegative(),
  resetsAt: z.string().nullable(),
});
export const usageSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), accountEmail: z.string().nullable(), planLabel: z.string().nullable(), windows: z.array(windowSchema) }),
  ...(["not_installed", "unauthenticated", "expired"] as const).map(status => z.object({ status: z.literal(status) })),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export const inventorySchema = z.object({ resources: z.array(z.object({
  id: z.string(), providerId: z.string(), label: z.string(),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("shared") }),
    z.object({ kind: z.literal("host"), hostId: z.string(), hostName: z.string() }),
  ]),
})) });
export const observationSchema = z.object({ observedAt: z.number().nullable(), usage: usageSchema });
export const resultSchema = z.object({
  hostName: z.string().nullable(), observedAt: z.number().nullable(), usage: usageSchema,
});
export type Result = z.infer<typeof resultSchema>;
export const rpcContract = defineRpcContract({
  usage: { input: z.object({ target: targetSchema, refresh: z.boolean() }).strict(), output: resultSchema },
});
