import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const MARKER = "<!-- pi-next-steps";
export const SETTINGS_TYPE = "next-steps-settings-v1";
export const MAX_STEPS = 3;
export const MAX_STEP_CHARS = 180;
const MAX_PAYLOAD_CHARS = 8_192;

export const NEXT_STEPS_GUIDANCE = `For interactive next-step suggestions, you may append a hidden block to your final answer only when there are useful, concrete follow-ups the user could send to this same chat. Use 1-${MAX_STEPS} short natural-language prompts, each at most ${MAX_STEP_CHARS} characters, in a JSON array exactly like this:
${MARKER}
["Review the diff for edge cases","Add coverage for the retry path"]
-->
Put the block on separate lines at the very end, outside code fences. Omit it when the task is naturally finished, the answer needs no follow-up, the user requests an exact output format, or a question/approval is already pending. Do not suggest work already done or generic filler. Never execute suggestions automatically, make extra model/tool calls to generate them, or put slash commands or ! shell shortcuts in them.`;

export interface ParsedNextSteps {
  content: string;
  steps: string[];
}

export interface NextStepsState {
  enabled: boolean;
  sourceId?: string;
  steps: string[];
}

/** Find an explicit payload opener, never a marker shown inside a Markdown code fence. */
function tailStart(text: string, partial: boolean): number | undefined {
  if (!text.includes("<!--")) return undefined;
  let fence: { char: string; length: number } | undefined;
  let candidate: number | undefined;
  let offset = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(trimmed);
    if (delimiter) {
      const run = delimiter[1]!;
      if (!fence) fence = { char: run[0]!, length: run.length };
      else if (run[0] === fence.char && run.length >= fence.length && !delimiter[2]!.trim()) fence = undefined;
    } else if (!fence && !/^ {4}|^\t/.test(trimmed)) {
      const value = trimmed.trimStart();
      if (value.trimEnd() === MARKER || (partial && offset + line.length === text.length &&
        value.length >= 4 && MARKER.startsWith(value))) candidate = offset;
    }
    offset += line.length + 1;
  }
  return candidate;
}

function normalizeSteps(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const steps: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(item)) continue;
    const step = item.replace(/\s+/g, " ").trim();
    // Dropping (rather than truncating) an overlong prompt cannot cut off a qualification.
    if (!step || step.length > MAX_STEP_CHARS || /^[!/]/.test(step) || seen.has(step.toLowerCase())) continue;
    seen.add(step.toLowerCase());
    steps.push(step);
    if (steps.length === MAX_STEPS) break;
  }
  return steps;
}

/** Strict, trailing JSON payload only; malformed payloads never become actionable prompts. */
export function parseNextSteps(text: string): ParsedNextSteps {
  const start = tailStart(text, false);
  if (start === undefined) return { content: text, steps: [] };
  const match = /^ {0,3}<!-- pi-next-steps[\t ]*\r?\n([\s\S]*?)\r?\n[\t ]*-->\s*$/.exec(text.slice(start));
  if (!match || match[1]!.includes("-->")) return { content: text, steps: [] };
  const content = text.slice(0, start).trimEnd();
  if (match[1]!.length > MAX_PAYLOAD_CHARS) return { content, steps: [] };
  try {
    return { content, steps: normalizeSteps(JSON.parse(match[1]!)) };
  } catch {
    return { content, steps: [] };
  }
}

/** Display-only: hide complete metadata and a streaming/aborted trailing partial block. */
export function visibleReply(text: string, streaming: boolean): string {
  const parsed = parseNextSteps(text);
  if (parsed.content !== text) return parsed.content;
  const start = tailStart(text, streaming);
  if (start !== undefined && !text.slice(start).includes("-->")) return text.slice(0, start).trimEnd();
  return text;
}

/** Branch-local state. A newer user/assistant message must never revive old suggestions. */
export function stateFromBranch(entries: readonly SessionEntry[]): NextStepsState {
  let enabled = true;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === SETTINGS_TYPE && entry.data &&
      typeof (entry.data as { enabled?: unknown }).enabled === "boolean") {
      enabled = (entry.data as { enabled: boolean }).enabled;
    }
  }
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type !== "message") continue;
    if (entry.message.role === "user") break;
    if (entry.message.role !== "assistant") continue;
    const message = entry.message;
    if (message.stopReason !== "stop" || message.content.some((part) => part.type === "toolCall")) break;
    const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    return { enabled, sourceId: entry.id, steps: parseNextSteps(text).steps };
  }
  return { enabled, steps: [] };
}
