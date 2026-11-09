// Portd's loopback API; no terminal runtime, shell interpolation or daemon ownership.
export const API_PORT = 43117;
const states = new Set(["active", "available", "disabled", "error"]);
const text = (value) => typeof value === "string" ? value : "";
const validPort = (value) => Number.isInteger(value) && value >= 1024 && value <= 65535;

export function parseStatus(value) {
  if (!value || typeof value.host !== "string" || !value.host || typeof value.connected !== "boolean" ||
      !Array.isArray(value.tunnels) || (value.reverse_tunnels != null && !Array.isArray(value.reverse_tunnels))) {
    throw new Error("Portd returned an invalid status response.");
  }
  const tunnels = (items, reverse) => items.map((row) => {
    if (!row || !validPort(row.remote_port) || !(row.local_port == null && !reverse || validPort(row.local_port)) ||
        !states.has(row.state) || (row.state === "active" && !validPort(row.local_port))) {
      throw new Error("Portd returned an invalid port mapping.");
    }
    return { remote_port: row.remote_port, local_port: row.local_port ?? null,
      label: text(row.label), group: text(row.group), process: text(row.process), state: row.state };
  });
  return { host: value.host, connected: value.connected, last_error: text(value.last_error),
    last_scan_ms: Number.isFinite(value.last_scan_ms) ? value.last_scan_ms : null,
    tunnels: tunnels(value.tunnels, false), reverse_tunnels: tunnels(value.reverse_tunnels ?? [], true) };
}

export function rowsFor(status, mode, query = "") {
  const rows = (mode === "reverse" ? status?.reverse_tunnels : status?.tunnels) ?? [];
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter((row) => !needle || [row.remote_port, row.local_port, row.label, row.group, row.process, row.state]
    .join(" ").toLocaleLowerCase().includes(needle));
}

export const rowKey = (row) => `${row.remote_port}:${row.local_port ?? ""}`;
export const enabled = (row, mode) => mode === "reverse" ? row.state !== "available" : row.local_port != null;
export const togglePath = (row, mode) => mode === "reverse"
  ? `/api/reverse/${row.remote_port}/${row.local_port}/toggle` : `/api/tunnels/${row.remote_port}/toggle`;
export const localUrl = (row) => validPort(row.local_port) ? `http://127.0.0.1:${row.local_port}` : null;

export function manualPath(input, mode, status, apiPort = API_PORT) {
  const match = input.trim().match(mode === "reverse" ? /^(\d{1,5})(?::(\d{1,5}))?$/ : /^(\d{1,5})$/);
  if (!match) throw new Error(mode === "reverse" ? "Enter REMOTE_PORT:LOCAL_PORT, or one port for both." : "Enter a port from 1024 to 65535.");
  const remote = Number(match[1]), local = Number(match[2] ?? match[1]);
  if (!validPort(remote) || !validPort(local)) throw new Error("Ports must be between 1024 and 65535.");
  if (remote === apiPort) throw new Error("The portd control port cannot be forwarded as a service.");
  const existing = (mode === "reverse" ? status.reverse_tunnels : status.tunnels).find((r) => r.remote_port === remote);
  if (existing && enabled(existing, mode)) throw new Error(`Port ${remote} already has an enabled mapping. Use its row to disable it first.`);
  return mode === "reverse" ? `/api/reverse/${remote}/${local}/toggle` : `/api/tunnels/${remote}/toggle`;
}

export function metadataBody(kind, value) {
  const limit = kind === "label" ? 48 : kind === "group" ? 32 : 0;
  if (!limit) throw new Error("Unknown port metadata field.");
  value = value.trim();
  if ([...value].length > limit) throw new Error(`${kind === "label" ? "Labels" : "Groups"} must be ${limit} characters or fewer.`);
  return { [kind]: value };
}

export function editPath(port, kind) {
  if (!validPort(port) || !["label", "group", "move"].includes(kind)) throw new Error("Invalid port action.");
  return `/api/tunnels/${port}/${kind}`;
}

export async function request(exec, { on = null, apiPort = API_PORT, platform = "linux" }, path, body, method = "POST") {
  if (!validPort(apiPort) || !/^\/api\/(?:status|refresh|tunnels\/\d{1,5}\/(?:toggle|label|group|move|open)|reverse\/\d{1,5}\/\d{1,5}\/toggle)$/.test(path) ||
      !["GET", "POST"].includes(method)) throw new Error("Invalid portd API request.");
  // exec runs off the UI thread. curl gives both local and SSH requests a real
  // timeout; arguments are passed separately, never through a shell. No public API.
  const args = ["--silent", "--show-error", "--noproxy", "*", "--connect-timeout", "2", "--max-time", "8",
    "--request", method, "--header", "Accept: application/json", "--write-out", "\n%{http_code}"];
  if (body !== undefined) args.push("--header", "Content-Type: application/json", "--data-binary", JSON.stringify(body));
  args.push("--url", `http://127.0.0.1:${apiPort}${path}`);
  const result = await exec(!on && platform === "windows" ? "curl.exe" : "curl", args, { on });
  if (result.code !== 0) throw new Error((result.stderr || "Cannot reach portd. Is the daemon running?").trim().slice(0, 600));
  const split = result.stdout.lastIndexOf("\n");
  const code = Number(result.stdout.slice(split + 1));
  const response = result.stdout.slice(0, split);
  if (split < 0 || code < 200 || code >= 300 || !Number.isInteger(code)) throw new Error(`Portd HTTP ${code || "error"}: ${response.slice(0, 500)}`);
  if (method === "GET") {
    try { return parseStatus(JSON.parse(response)); }
    catch (error) { throw new Error(`Could not read portd status: ${error.message}`); }
  }
  return null;
}
