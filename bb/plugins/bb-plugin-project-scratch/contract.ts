import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const textSchema = z.string().max(524288);
const revision = z.string().length(64);
const scope = { cwd: z.string().min(1) };
const note = z.object({ root: z.string(), text: textSchema, revision, imported: z.boolean() });
const preview = z.object({ token: z.string(), path: z.string(), append: z.string() });
const promoted = z.object({ path: z.string() });
export type Note = z.infer<typeof note>;
export type Preview = z.infer<typeof preview>;

export const hostContract = defineRpcContract({
  load: { input: z.object(scope).strict(), output: note },
  save: {
    input: z.object({ ...scope, text: textSchema, expectedRevision: revision, expectedRoot: z.string().min(1) }).strict(), output: note,
  },
  preview: { input: z.object({ ...scope, text: textSchema.min(1) }).strict(), output: preview },
  promote: {
    input: z.object({ ...scope, token: z.string(), confirmed: z.literal(true) }).strict(), output: promoted,
  },
});
const thread = { threadId: z.string().min(1) };
export const rpcContract = defineRpcContract({
  load: { input: z.object(thread).strict(), output: note },
  save: {
    input: z.object({ ...thread, text: textSchema, expectedRevision: revision, expectedRoot: z.string().min(1) }).strict(), output: note,
  },
  preview: { input: z.object({ ...thread, text: textSchema.min(1) }).strict(), output: preview },
  promote: {
    input: z.object({ ...thread, token: z.string(), confirmed: z.literal(true) }).strict(), output: promoted,
  },
});
