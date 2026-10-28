import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract } from "./contract.ts";
import { ScratchStore } from "./store.ts";

let store: ScratchStore | undefined;
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    load: ({ cwd }, ctx) => (store ??= new ScratchStore(ctx.experimental_paths.dataDir)).load(cwd),
    save: ({ cwd, text, expectedRevision, expectedRoot }, ctx) =>
      (store ??= new ScratchStore(ctx.experimental_paths.dataDir)).save(cwd, text, expectedRevision, expectedRoot),
    preview: ({ cwd, text }, ctx) =>
      (store ??= new ScratchStore(ctx.experimental_paths.dataDir)).preview(cwd, text),
    promote: ({ cwd, token }, ctx) =>
      (store ??= new ScratchStore(ctx.experimental_paths.dataDir)).promote(cwd, token),
  },
});
