export function formatSelection(text: string, start: number, end: number, kind: "todo" | "strike") {
  if (kind === "strike" && start !== end) {
    const selected = text.slice(start, end);
    const replacement = selected.startsWith("~~") && selected.endsWith("~~") && selected.length >= 4
      ? selected.slice(2, -2) : `~~${selected}~~`;
    return { text: text.slice(0, start) + replacement + text.slice(end), start, end: start + replacement.length };
  }
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const boundary = text.indexOf("\n", end > start && text[end - 1] === "\n" ? end - 1 : end);
  const to = boundary < 0 ? text.length : boundary;
  const lines = text.slice(from, to).split("\n").map(line => {
    if (kind === "strike") return line.startsWith("~~") && line.endsWith("~~") ? line.slice(2, -2) : `~~${line}~~`;
    if (/^(\s*)- \[ \] /.test(line)) return line.replace(/^(\s*)- \[ \] /, "$1- [x] ");
    if (/^(\s*)- \[[xX]\] /.test(line)) return line.replace(/^(\s*)- \[[xX]\] /, "$1");
    return line.replace(/^(\s*)(.*)$/, "$1- [ ] $2");
  }).join("\n");
  return { text: text.slice(0, from) + lines + text.slice(to), start: from, end: from + lines.length };
}
