import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const taskSchema = z.object({
  id: z.number().int().positive(),
  subject: z.string().max(16384),
  status: z.enum(["pending", "in_progress", "completed", "deleted"]),
  activeForm: z.string().max(16384).optional(),
  description: z.string().max(65536).optional(),
  blockedBy: z.array(z.number().int()).optional(),
});
export type Task = z.infer<typeof taskSchema>;
export const resultSchema = z.object({
  tasks: z.array(taskSchema).max(1000),
  error: z.string().nullable(),
});
export type Result = z.infer<typeof resultSchema>;
export const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const hostContract = defineRpcContract({
  readTasks: {
    input: z.object({ sessionId: sessionIdSchema }).strict(),
    output: resultSchema,
  },
});
export const rpcContract = defineRpcContract({
  tasks: {
    input: z.object({ threadId: z.string().min(1).max(128) }).strict(),
    output: resultSchema,
  },
});
