import type { SessionSnapshot, SessionStore, TranscriptEntry, ManagedSession } from "./store.ts";

const STOP_WORDS = new Set("a an and are as at be been but by did do does for from had has have how i in is it me my of on or our should that the their then there these they this to us was we were what when where which who why will with work would you your".split(" "));
function terms(text: string): string[] {
  return text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}
export function excerpt(text: string, queryTerms: string[] = [], limit = 500): string {
  const folded = text.toLowerCase();
  const matches = queryTerms.map((term) => folded.indexOf(term)).filter((index) => index >= 0);
  const start = matches.length ? Math.max(0, Math.min(...matches) - 100) : 0;
  const body = text.slice(start, start + limit).replace(/\s+/gu, " ").trim();
  return `${start ? "…" : ""}${body}${start + limit < text.length ? "…" : ""}`;
}

export interface RecallOptions {
  query?: string;
  cwd?: string;
  after?: number;
  before?: number;
  limit: number;
  offset: number;
  excludePath?: string;
}
interface Evidence {
  entryId: string;
  role: TranscriptEntry["role"];
  timestamp: number;
  excerpt: string;
}
interface RecallHit {
  session: ManagedSession;
  score: number;
  evidence: Evidence[];
  matchedTerms: string[];
  lastActivity: number;
}

/** Lexical retrieval only. The calling agent synthesizes plans from cited evidence. */
export async function recall(store: SessionStore, options: RecallOptions, signal?: AbortSignal) {
  const queryTerms = [...new Set(terms(options.query ?? "").filter((term) => !STOP_WORDS.has(term)))].slice(0, 24);
  if (options.query?.trim() && !queryTerms.length) throw new Error("recall query needs topic keywords; omit query for recent activity");
  const hits: RecallHit[] = [];
  const cwd = options.cwd?.trim().toLowerCase();
  let scanned = 0;
  for await (const snapshot of store.scan(signal)) {
    const { session } = snapshot;
    if (session.sessionPath === options.excludePath || (cwd && !session.cwd.toLowerCase().includes(cwd))) continue;
    scanned++;
    const entries = snapshot.messages.filter((entry) => entry.text &&
      (options.after === undefined || entry.timestamp >= options.after) &&
      (options.before === undefined || entry.timestamp < options.before));
    if (!entries.length) continue;
    const metadataTerms = new Set(terms(`${session.name} ${session.cwd}`));
    const matched = new Set<string>();
    const ranked = entries.map((entry) => {
      if (!queryTerms.length) return { entry, score: 0 };
      const tokens = terms(entry.text);
      const counts = new Map<string, number>();
      for (const token of tokens) if (queryTerms.includes(token)) counts.set(token, (counts.get(token) ?? 0) + 1);
      let score = 0;
      for (const term of queryTerms) {
        const count = counts.get(term) ?? 0;
        if (count) { matched.add(term); score += 1 + Math.min(1, Math.log2(count) / 4); }
      }
      // Coverage beats repetition; short, focused messages beat huge pasted transcripts.
      score /= 1 + Math.log2(1 + tokens.length / 2000);
      return { entry, score };
    });
    const metadataMatches = queryTerms.filter((term) => metadataTerms.has(term));
    if (queryTerms.length && !matched.size && !metadataMatches.length) continue;
    const selected = queryTerms.length && matched.size
      ? ranked.filter((item) => item.score > 0).sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp).slice(0, 3)
      : ranked.slice(-3);
    const score = matched.size * 10 + metadataMatches.length * 2 + Math.max(0, ...selected.map((item) => item.score));
    hits.push({ session, score, matchedTerms: [...new Set([...matched, ...metadataMatches])],
      lastActivity: entries[entries.length - 1].timestamp,
      evidence: selected.map(({ entry }) => ({ entryId: entry.id, role: entry.role, timestamp: entry.timestamp,
        excerpt: excerpt(entry.text, queryTerms) })) });
  }
  hits.sort((a, b) => (queryTerms.length ? b.score - a.score : 0) || b.lastActivity - a.lastActivity || a.session.id.localeCompare(b.session.id));
  const page = hits.slice(options.offset, options.offset + options.limit);
  const nextOffset = options.offset + page.length < hits.length ? options.offset + page.length : undefined;
  return { hits: page, total: hits.length, scanned, nextOffset, queryTerms };
}

/** A stable entry ID plus character offset lets even one oversized message be read in full. */
export function conversationPage(snapshot: SessionSnapshot, limit: number, cursor?: string) {
  const entries = snapshot.messages.filter((entry) => entry.text);
  let index = Math.max(0, entries.length - limit);
  let offset = 0;
  if (cursor) {
    const match = cursor.match(/^([^:]+)(?::(\d+))?$/u);
    index = match ? entries.findIndex((entry) => entry.id === match[1]) : -1;
    offset = Number(match?.[2] ?? 0);
    if (index < 0 || !Number.isSafeInteger(offset) || offset > entries[index].text.length) {
      throw new Error("Unknown read cursor on the active branch; recall again or read without cursor");
    }
  }
  const lines: string[] = [];
  let remaining = 7000; // <= 28KB UTF-8, including headers; independent of message count.
  let remainingLines = 800;
  let nextCursor: string | undefined;
  for (let count = 0; index < entries.length && count < limit; index++, count++) {
    const entry = entries[index];
    const heading = `[${entry.id} ${new Date(entry.timestamp).toISOString()}]\n${entry.role === "user" ? "User" : entry.role === "assistant" ? "Assistant" : "Summary"}: `;
    const capacity = remaining - heading.length - 2;
    if (capacity <= 0 || remainingLines <= 3) { nextCursor = `${entry.id}:${offset}`; break; }
    let end = Math.min(entry.text.length, offset + capacity);
    let newline = offset - 1;
    for (let count = 0; count < remainingLines - 3; count++) {
      newline = entry.text.indexOf("\n", newline + 1);
      if (newline < 0 || newline >= end) break;
      if (count === remainingLines - 4) end = newline + 1;
    }
    if (end < entry.text.length && /[\uD800-\uDBFF]/u.test(entry.text[end - 1])) end--;
    const line = heading + entry.text.slice(offset, end);
    lines.push(line);
    remaining -= line.length + 2;
    remainingLines -= line.split("\n").length + 2;
    if (end < entry.text.length) { nextCursor = `${entry.id}:${end}`; break; }
    offset = 0;
  }
  if (!nextCursor && index < entries.length) nextCursor = `${entries[index].id}:0`;
  return { text: lines.join("\n\n") || "(No user/assistant messages yet.)", nextCursor, total: entries.length };
}
