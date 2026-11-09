// Mirrored in odysseas-t3-focus: project identity comes from Git, not a space's
// editable name or a guessed worktree directory. No timers or persistent state.
const normalize = (path) => (path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
const base = (path) => normalize(path).split("/").pop() || "";

export function parseRepo(output) {
  const [top, common] = output.trim().split(/\r?\n/).map(normalize);
  const absolute = (path) => /^(?:\/|[A-Za-z]:\/)/.test(path ?? "");
  if (!absolute(top) || !absolute(common)) return null;
  const main = common.endsWith("/.git") ? common.slice(0, -5) : common;
  return { project: base(main).replace(/\.git$/, ""), checkout: base(top), linked: common !== `${top}/.git` };
}

export function agentSource(agent, panes, spaces, terminals) {
  const pane = panes.find((p) => p.pane === agent.pane || p.terminal === agent.address);
  const space = spaces.find((s) => s.id === agent.space);
  const terminal = terminals.find((t) => t.address === agent.address);
  const on = space ? space.machine ?? null : agent.address.includes("/") ? agent.address.split("/")[0] : null;
  return { on, cwd: pane?.cwd || terminal?.cwd || space?.folder || "", branch: pane?.branch || null,
    space: space?.name || agent.space_name || "" };
}

export function describeProject(source, repo) {
  const project = repo?.project || base(source.cwd) || source.space || "Unknown project";
  const ref = source.branch || (repo?.linked ? repo.checkout : "");
  const path = [project, ref].filter(Boolean).join(" › ");
  const machine = source.on || "local";
  return { project, ref, path, machine, linked: Boolean(repo?.linked), label: `${path} · ${machine}`, cwd: source.cwd };
}

export class ProjectContext {
  constructor(exec) {
    this.exec = exec;
    this.cache = new Map();
    this.queue = [];
    this.running = false;
    this.closed = false;
  }

  snapshot(agents, panes, spaces, terminals, cx) {
    const sources = new Map(agents.map((a) => [a.address, agentSource(a, panes, spaces, terminals)]));
    const keyOf = (s) => JSON.stringify([s.on, s.cwd]);
    const used = new Set([...sources.values()].filter((s) => s.cwd).map(keyOf));
    // Keep only current agents' checkouts, not a history of every folder visited.
    for (const [key, entry] of this.cache) if (!used.has(key) && !entry.loading) this.cache.delete(key);
    for (const source of sources.values()) {
      if (!source.cwd || this.closed) continue;
      const key = keyOf(source), entry = this.cache.get(key);
      // Successful identities are stable for this cwd. Failures may retry on a
      // later live-data render, at most once a minute; never a redraw/poll loop.
      if (entry && (entry.loading || entry.repo || Date.now() - entry.at < 60000)) continue;
      const next = { loading: true, repo: null, at: Date.now() };
      this.cache.set(key, next);
      this.queue.push({ key, source, entry: next });
    }
    if (!this.running && this.queue.length && !this.closed) {
      this.running = true;
      cx.spawn(async (cx) => {
        while (this.queue.length && !this.closed) {
          const { source, entry } = this.queue.shift();
          try {
            const r = await this.exec("git", ["--no-optional-locks", "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { cwd: source.cwd, on: source.on });
            if (r.code === 0) entry.repo = parseRepo(r.stdout);
          } catch { /* Offline machines and non-Git folders keep a useful fallback. */ }
          entry.loading = false;
          entry.at = Date.now();
          if (!this.closed) cx.notify();
        }
        this.running = false;
      });
    }
    return (agent) => {
      const source = sources.get(agent.address) ?? agentSource(agent, panes, spaces, terminals);
      return describeProject(source, this.cache.get(keyOf(source))?.repo);
    };
  }

  close() { this.closed = true; this.queue.length = 0; }
}
