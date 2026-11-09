export const STATES = { blocked: "NEEDS YOU", working: "WORKING", done: "DONE", idle: "IDLE", settled: "SETTLED", empty: "TERMINALS" };
const rank = { blocked: 5, working: 4, done: 3, idle: 2, settled: 1, empty: 0 };

export const seed = (text) => [...text].reduce((n, char) => ((n * 31) + char.codePointAt(0)) >>> 0, 7);
export function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}
export const overview = (layout) => (findNode(layout, "sidebar")?.size?.px ?? 999) >= 280;
export const modeCommand = (large) => ["layout.resize", large ? { id: "sidebar", weight: 1.05 } : { id: "sidebar", px: 190 }];

// Shell-only spaces belong in the city too. Their first live pane locates the
// checkout; individual agents are resolved separately, never via another tab.
export function spaceSources(spaces, panes) {
  return spaces.map((space) => {
    const tabs = new Set(space.tabs.map((tab) => tab.id));
    const pane = panes.find((p) => tabs.has(p.tab) && p.terminal);
    return { address: `space:${space.id}`, space: space.id, space_name: space.name, pane: pane?.pane };
  });
}

export function agentState(agent, terminals) {
  const own = terminals.find((t) => t.address === agent.address);
  const children = [], seen = new Set([agent.address]), queue = [agent.address];
  while (queue.length) {
    const parent = queue.shift();
    for (const t of terminals) if (t.parent === parent && t.state === "live" && !seen.has(t.address)) {
      seen.add(t.address); children.push(t); queue.push(t.address);
    }
  }
  const state = [agent.status, ...children.map((t) => t.status === "error" ? "blocked" : t.status === "done" ? "idle" : t.status)]
    .reduce((a, b) => (rank[b] ?? 0) > (rank[a] ?? 0) ? b : a, "idle");
  const settled = own?.labels?.settled?.split(":").map(Number);
  if (settled?.length === 2 && settled.every(Number.isFinite) && settled[0] > 0 && (own.turn ?? 0) <= settled[1] && !["working", "blocked"].includes(state)) return "settled";
  return state;
}

export function cityModel(spaces, agents, panes, terminals, context) {
  const districts = new Map(), buildings = new Map();
  const get = (source, space) => {
    const at = context(source);
    const districtId = JSON.stringify([at.on, at.repo ?? "loose-terminals"]);
    const id = JSON.stringify([at.on, at.repo ? at.checkout : space.id]);
    if (!districts.has(districtId)) districts.set(districtId, { id: districtId, project: at.repo ? at.project : "Loose terminals", machine: at.machine, buildings: [] });
    if (!buildings.has(id)) {
      const building = { id, location: at, name: at.repo ? at.ref || (at.linked ? at.checkout.split(/[\\/]/).pop() : "main") : space.name || "Terminal",
        linked: at.linked, spaces: [], agents: [], selected: false, state: "empty" };
      buildings.set(id, building); districts.get(districtId).buildings.push(building);
    }
    const building = buildings.get(id);
    if (!building.spaces.some((s) => s.id === space.id)) building.spaces.push(space);
    building.selected ||= Boolean(space.active);
    return building;
  };
  for (const source of spaceSources(spaces, panes)) {
    const space = spaces.find((s) => s.id === source.space);
    get(source, space);
  }
  for (const agent of agents) {
    const space = spaces.find((s) => s.id === agent.space);
    if (!space) continue;
    const building = get(agent, space), cityStatus = agentState(agent, terminals);
    building.agents.push({ ...agent, cityStatus });
    if (rank[cityStatus] > rank[building.state]) building.state = cityStatus;
  }
  for (const district of districts.values()) district.buildings.sort((a, b) => Number(a.linked) - Number(b.linked));
  return [...districts.values()];
}

export function enterBuilding(building) {
  const current = building.agents.find((a) => a.focused);
  const tab = building.spaces.find((s) => s.active)?.tabs.find((t) => t.active)?.id;
  const agent = current ?? building.agents.find((a) => a.tab === tab) ?? building.agents.find((a) => a.cityStatus === "blocked") ?? building.agents[0];
  return agent ? ["agent.focus", { terminal: agent.address }] : ["space.select", { id: (building.spaces.find((s) => s.active) ?? building.spaces[0]).id }];
}
