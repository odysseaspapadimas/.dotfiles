import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, spaces, panes, terminals, setAgentOrder, theme, layout, run, exec, props, nextCommand, shared, setShared, openOverlay, closeOverlay, window as appWindow } from "herdr";
import { ProjectContext } from "./context.js";
import { namer } from "./name.js";
import { STATES, seed, overview, modeCommand, spaceSources, cityModel, enterBuilding } from "./model.js";

const ASSETS = "mods/odysseas-city/";
// Headless `check` has no window; treat it as an inactive native screen.
const window = () => appWindow() ?? {};
const colors = (t) => ({ blocked: t.blocked, working: t.ansi6, done: t.done, idle: t.ansi5, settled: t.dim, empty: t.dim });

export default class NeonCity extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "skyline";
    this.width = 1400;
    this.height = 400;
    this.projects = new ProjectContext(exec);
    if (this.role === "bar") cx.spawn(async (cx) => {
      for (;;) {
        if (await nextCommand() === "mode") this.mode(!overview(layout()));
        cx.notify();
      }
    });
  }

  close() { this.projects.close(); }
  mode(large) { run("layout.show", { id: "sidebar" }); run(...modeCommand(large)); }
  directory(building = null) {
    openOverlay({ mod: "odysseas-city", kind: "dialog", width: 720, height: 580, props: { role: "directory", building } });
  }
  size(size, cx) {
    const compact = this.height < 280, narrow = this.width < 1080;
    this.width = size.width; this.height = size.height;
    if (compact !== (this.height < 280) || narrow !== (this.width < 1080)) cx.notify();
  }

  button(id, label, fn, { active = false, color = null, small = false } = {}) {
    const t = theme();
    return h_flex().id(id).h(small ? 24 : 30).px(small ? 8 : 10).gap(6).items_center().justify_center().flex_none().rounded(5)
      .border_1().border_color(active ? color ?? t.ansi6 : t.border).bg(active ? t.selected : t.background)
      .text_color(active ? color ?? t.ansi6 : t.muted).text_size(small ? 10 : 11).font_medium().cursor_pointer()
      .role("button").accessibility_label(label).tooltip(label)
      .hover(s => s.bg(t.raised).text_color(color ?? t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((e, cx) => { cx.stop_propagation(); fn(e, cx); }).child(label);
  }

  bar() {
    const t = theme(), list = agents(), large = overview(layout()), wide = this.width >= 1080;
    const needs = list.filter(a => a.status === "blocked").length;
    const root = h_flex().id("city-toolbar").size_full().px(14).gap(7).items_center().bg(t.chrome).border_b_1().border_color(t.border)
      .on_size_change((size, cx) => this.size(size, cx))
      .when(window().platform === "macos", el => el.pl(90))
      .child(v_flex().gap(1).mr(8).flex_none()
        .child(div().text_size(15).font_bold().text_color(t.ansi6).child("NEON // CITY"))
        .child(div().text_size(8).text_color(t.dim).child("A LIVING MAP OF YOUR WORK")))
      .when(wide, el => el.child(div().text_size(10).text_color(needs ? t.blocked : t.muted)
        .child(`${list.length} AGENTS ONLINE${needs ? ` / ${needs} NEED YOU` : " / ALL SIGNALS CLEAR"}`)))
      .child(div().flex_1())
      .child(this.button("city-overview", "Overview", () => this.mode(true), { active: large }))
      .child(this.button("city-work", "Work", () => this.mode(false), { active: !large }))
      .child(this.button("city-directory", wide ? "Agent directory" : "Agents", () => this.directory()))
      .child(this.button("city-ports", "Ports", () => run("mod.open", { name: "odysseas-ports" })))
      .when(wide, el => el.child(this.button("city-rain", shared("city.rain") === false ? "Rain off" : "Rain on", () => setShared("city.rain", shared("city.rain") === false))))
      .child(this.button("city-back", "Back to T3", () => run("layout.switch", { name: "odysseas-t3" })));
    if (window().buttons) root
      .child(this.button("city-minimize", "−", () => run("window.minimize"), { small: true }))
      .child(this.button("city-maximize", window().maximized ? "▣" : "□", () => run("window.maximize"), { small: true }))
      .child(this.button("city-window-close", "×", () => run("window.close"), { small: true, color: t.blocked }));
    return root;
  }

  office(agent, index, compact, color, title, building) {
    const t = theme(), state = agent?.cityStatus;
    const light = state ? colors(t)[state] : t.dim;
    const dark = !agent || state === "settled";
    const cell = h_flex().id(`office-${building.id}-${agent?.address ?? index}`).w(compact ? 25 : 32).h(compact ? 12 : 22).gap(3).p(3)
      .border_1().border_color(dark ? t.border : light + "88").bg(dark ? t.canvas : light + "16").rounded(2)
      .children([0, 1, 2].map(i => div().flex_1().h_full().bg(dark ? t.border + "55" : light).opacity(dark ? 0.35 : 0.75)))
      .when(state === "working" && window().active, el => el.loop("opacity", { from: 0.45, to: 1, period: 1800 }))
      .when(state === "blocked" && window().active, el => el.loop("opacity", { from: 0.25, to: 1, period: 850 }));
    if (!agent) return cell;
    const label = `${title(agent)} — ${building.location.path} · ${building.location.machine} · ${STATES[state]}`;
    return cell.role("button").accessibility_label(label).tooltip(label).cursor_pointer()
      .hover(s => s.border_color(color).bg(light + "33"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); run("agent.focus", { terminal: agent.address }); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); run("terminal.peek", { terminal: agent.address }); });
  }

  building(building, district, compact, title) {
    const t = theme(), palette = colors(t), signal = palette[building.state];
    const n = seed(building.id), tone = district.machine === "local" ? t.ansi6 : t.ansi5;
    const height = compact ? 106 : 216 + (n % 4) * 20;
    const width = compact ? 146 : 176, floors = compact ? 2 : 3, capacity = floors * 3;
    const label = `${district.project} › ${building.name} · ${district.machine} · ${building.agents.length} agents · ${STATES[building.state]}`;
    const root = v_flex().id(`building-${building.id}`).relative().w(width).h(height).flex_none().justify_end()
      .role("button").accessibility_label(label).tooltip(`${label}\n${building.location.cwd}\nClick to enter · right-click for the directory`)
      .cursor_pointer().on_click(() => run(...enterBuilding(building)))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.directory(building.id); })
      .child(h_flex().h(compact ? 10 : 22).gap(5).pl(12).items_end()
        .child(div().w(2).h_full().bg(tone + "77"))
        .child(div().size(6).mb(compact ? 1 : 8).rounded_full().bg(signal)
          .when(building.state === "blocked" && window().active, el => el.loop("opacity", { from: 0.2, to: 1, period: 850 })))
        .child(div().flex_1())
        .when(!compact, el => el.child(div().w(30).h(10).mr(10).border_1().border_color(tone + "55").bg(t.background))))
      .child(v_flex().flex_1().min_h(0).px(10).pt(compact ? 6 : 10).pb(8).gap(compact ? 5 : 9)
        .bg(t.background + "ee").border_1().border_color(building.selected ? tone : tone + "55").rounded_t(5)
        .when(building.selected, el => el.border_t(3))
        .child(h_flex().h(compact ? 13 : 18).gap(4).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(compact ? 10 : 12).font_semibold().text_color(building.selected ? tone : t.foreground).child(building.name))
          .child(div().text_size(8).text_color(t.dim).child(building.linked ? "WT" : building.location.repo ? "HQ" : "SH")))
        .children(Array.from({ length: floors }, (_, floor) => h_flex().gap(compact ? 7 : 8).justify_center()
          .children(Array.from({ length: 3 }, (_, col) => this.office(building.agents[floor * 3 + col], floor * 3 + col, compact, tone, title, building)))))
        .child(div().flex_1())
        .when(!compact, el => el.child(div().truncate().text_size(9).text_color(signal).child(STATES[building.state])))
        .child(h_flex().gap(4).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(9).text_color(t.muted).child(building.agents.length ? `${building.agents.length} AGENT${building.agents.length === 1 ? "" : "S"}` : "TERMINAL ONLY"))
          .when(building.agents.length > capacity, el => el.child(this.button(`more-${building.id}`, `+${building.agents.length - capacity}`, () => this.directory(building.id), { small: true })))
          .when(building.selected, el => el.child(div().text_size(8).font_bold().text_color(tone).child("HERE")))))
      .child(div().h(3).w_full().bg(building.selected ? tone : tone + "44"));
    return root;
  }

  skyline(districts, title) {
    const t = theme(), compact = this.height < 280, rain = shared("city.rain") !== false;
    const root = v_flex().id("city-skyline").relative().size_full().min_h(0).overflow_hidden().bg(t.canvas)
      .on_size_change((size, cx) => this.size(size, cx))
      .child(image(`${ASSETS}skyline.svg`).absolute().inset_0().size_full().opacity(compact ? 0.35 : 0.7));
    if (rain) for (let i = 0; i < 24; i++) root.child(svg(`${ASSETS}rain.svg`).id(`rain-${i}`).absolute()
      .left(18 + (i * 137) % Math.max(200, this.width)).top(12 + (i * 71) % Math.max(80, this.height - 60)).w(5).h(30).opacity(0.15)
      .when(window().active, el => el.loop("opacity", { from: 0.04, to: 0.25, period: 1900 + (i % 5) * 430 })));
    root.child(h_flex().h(compact ? 22 : 34).px(22).gap(12).items_center().flex_none()
      .child(div().text_size(compact ? 8 : 10).font_medium().text_color(t.ansi6).child(compact ? "CITY LINK // WORK MODE" : "DISTRICT NETWORK // EVERY WINDOW IS A LIVE AGENT"))
      .child(div().flex_1())
      .child(div().text_size(9).text_color(t.dim).child("SCROLL HORIZONTALLY →")));
    root.child(h_flex().id("city-districts").relative().flex_1().min_h(0).gap(compact ? 12 : 24).px(22).pt(4).pb(6).items_end().overflow_x_scroll()
      .children(districts.map(district => {
        const tone = district.machine === "local" ? t.ansi6 : t.ansi5;
        return v_flex().id(`district-${district.id}`).h_full().flex_none().justify_end().gap(compact ? 4 : 10)
          .child(h_flex().flex_1().min_h(0).gap(compact ? 8 : 12).items_end()
            .children(district.buildings.map(building => this.building(building, district, compact, title))))
          .child(h_flex().h(compact ? 22 : 30).px(8).gap(8).items_center().border_t_1().border_color(tone + "66").bg(t.canvas + "dd")
            .child(div().text_size(compact ? 10 : 13).font_bold().text_color(tone).child(district.project))
            .child(div().text_size(9).text_color(t.muted).child(`// ${district.machine}`))
            .child(div().flex_1())
            .child(div().text_size(9).text_color(t.dim).child(`${district.buildings.length} CHECKOUT${district.buildings.length === 1 ? "" : "S"}`)));
      })))
      .when(!districts.length, el => el.child(v_flex().flex_1().items_center().justify_center().gap(8)
        .child(div().text_size(22).text_color(t.ansi6).child("THE CITY IS QUIET"))
        .child(div().text_size(12).text_color(t.muted).child("Open a space or worktree. Its building will appear here."))))
      .child(h_flex().h(compact ? 18 : 28).px(22).gap(14).items_center().flex_none().bg(t.canvas + "cc").border_b_1().border_color(t.ansi6 + "44")
        .children([[t.ansi6, "WORKING"], [t.blocked, "NEEDS YOU"], [t.done, "DONE"], [t.ansi5, "IDLE"], [t.dim, "SETTLED / TERMINALS"]].map(([color, name]) =>
          h_flex().gap(4).items_center().child(div().size(4).rounded_full().bg(color)).child(div().text_size(8).text_color(t.dim).child(name))))
        .child(div().flex_1())
        .when(!compact, el => el.child(div().text_size(9).text_color(t.muted).child("Click building: enter · window: focus agent · right-click window: live peek · Prefix → a: overview/work"))));
    return root;
  }

  ledger(districts, title) {
    const t = theme(), buildingId = props()?.building;
    const groups = districts.map(d => ({ ...d, buildings: d.buildings.filter(b => !buildingId || b.id === buildingId) })).filter(d => d.buildings.length);
    return v_flex().id("city-directory-root").size_full().p(20).gap(12).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().gap(12).flex_none()
        .child(div().flex_1().text_size(19).font_semibold().text_color(t.ansi6).child("CITY // DIRECTORY"))
        .child(this.button("city-directory-close", "Close · Esc", () => closeOverlay(props().overlay))))
      .child(div().text_size(12).text_color(t.muted).child("Real projects, checkouts and agents. No processes are started or stopped here."))
      .child(v_flex().id("city-directory-list").flex_1().min_h(0).gap(18).overflow_y_scrollbar()
        .children(groups.map(d => v_flex().gap(8).flex_none()
          .child(div().text_size(13).font_semibold().text_color(t.ansi5).child(`${d.project} // ${d.machine}`))
          .children(d.buildings.map(b => v_flex().p(12).gap(7).flex_none().rounded(7).border_1().border_color(t.border).bg(t.background)
            .child(h_flex().gap(10).items_center()
              .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(13).child(b.name))
              .child(this.button(`enter-${b.id}`, "Enter checkout", () => { closeOverlay(props().overlay); run(...enterBuilding(b)); }, { small: true })))
            .child(div().text_size(10.5).text_color(t.dim).child(b.location.checkout))
            .children(b.agents.map(a => h_flex().id(`directory-agent-${a.address}`).gap(10).h(35).items_center().flex_none()
              .child(div().size(5).rounded_full().bg(colors(t)[a.cityStatus]))
              .child(div().flex_1().min_w(0).truncate().text_size(12).child(title(a)))
              .child(div().text_size(9).text_color(colors(t)[a.cityStatus]).child(STATES[a.cityStatus]))
              .child(this.button(`peek-${a.address}`, "Peek", () => run("terminal.peek", { terminal: a.address }), { small: true }))
              .child(this.button(`focus-${a.address}`, "Focus", () => { closeOverlay(props().overlay); run("agent.focus", { terminal: a.address }); }, { small: true }))))
            .when(!b.agents.length, el => el.child(div().text_size(11).text_color(t.muted).child("Terminal-only checkout. It stays visible even without an agent.")))))))
        .when(!groups.length, el => el.child(div().text_color(t.muted).child("Resolving the checkout…"))))
      .child(div().flex_none().text_size(10).text_color(t.dim).child("Closing this directory does not end any agents, terminals or services."));
  }

  render(cx) {
    if (this.role === "bar") return this.bar();
    const sp = spaces(), ps = panes(), list = agents(), all = terminals();
    const context = this.projects.snapshot([...list, ...spaceSources(sp, ps)], ps, sp, all, cx);
    const districts = cityModel(sp, list, ps, all, context), title = namer();
    if (this.role === "skyline") setAgentOrder(districts.flatMap(d => d.buildings.flatMap(b => b.agents.map(a => a.address))));
    return this.role === "directory" ? this.ledger(districts, title) : this.skyline(districts, title);
  }
}
