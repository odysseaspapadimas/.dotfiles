// Pure command planning; no shells, files, timers, or network access.
export function plan(action, state, previous) {
  const { spaces, panes, agents, focus } = state;
  const command = (name, args = {}) => [[name, args]];
  const space = spaces.find((s) => s.id === focus?.space);
  const tab = space?.tabs.find((t) => t.id === focus?.tab);
  if (action === "last" && previous && panes.some((p) => p.pane === previous)) {
    return command("pane.focus", { pane: previous });
  }
  if (action === "cycle-next" || action === "cycle-prev") {
    const mine = panes.filter((p) => p.tab === focus?.tab);
    const i = mine.findIndex((p) => p.pane === focus?.pane);
    if (i >= 0 && mine.length > 1) {
      const step = action === "cycle-next" ? 1 : -1;
      return command("pane.focus", { pane: mine[(i + step + mine.length) % mine.length].pane });
    }
  }
  if ((action === "tab-left" || action === "tab-right") && tab) {
    const i = space.tabs.findIndex((t) => t.id === tab.id);
    const index = i + (action === "tab-left" ? -1 : 1);
    if (index >= 0 && index < space.tabs.length) return command("tab.move", { id: tab.id, index: index + 1 });
  }
  if ((action === "space-up" || action === "space-down") && space) {
    const i = spaces.findIndex((s) => s.id === space.id);
    const index = i + (action === "space-up" ? -1 : 1);
    if (index >= 0 && index < spaces.length) return command("space.move", { id: space.id, index: index + 1 });
  }
  if (action.startsWith("agent-")) {
    const index = Number(action.slice(6)) - 1;
    if (agents[index]) return command("agent.focus", { terminal: agents[index].address });
  }
  if (action === "files" || action === "changes") {
    return [["layout.select", { stack: "panel-body", child: action }], ["layout.show", { id: "panel" }]];
  }
  if (action === "ports") return command("mod.open", { name: "odysseas-ports" });
  const programs = {
    editor: ["Editor", ["nvim"]],
    "editor-split": ["Editor", ["nvim"]],
    git: ["Git repositories", ["workspace-git"]],
    scratch: ["Project scratch", ["project-scratch"]],
  };
  if (programs[action] && focus?.terminal) {
    const [name, argv] = programs[action];
    const tabs = new Set(space?.tabs.map((t) => t.id) ?? []);
    const existing = panes.find((p) => tabs.has(p.tab) && p.cwd === focus.cwd &&
      (action === "editor" ? p.program?.key === "nvim" : space?.tabs.some((t) => t.id === p.tab && t.name === name)));
    if (action !== "editor-split" && existing) return command("pane.focus", { pane: existing.pane });
    return command("terminal.open", { name, argv, folder: focus.cwd, place: action === "editor-split" ? "right" : "tab" });
  }
  return [];
}
