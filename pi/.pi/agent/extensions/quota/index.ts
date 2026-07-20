import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import openaiCodexQuota from "./openai-codex.ts";

export default function quotaExtension(pi: ExtensionAPI) {
  openaiCodexQuota(pi);
}
