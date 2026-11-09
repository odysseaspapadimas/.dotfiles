// A small personal status bar and compatibility actions, not a terminal runtime.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, agents, focused, machines, run, theme, nextCommand, window, exec, home, notify, keys, props } from "herdr";
import { plan } from "./actions.js";

export default class Navigation extends View {
  init(_props, cx) {
    this.current = null;
    this.previous = null;
    this.prefix = null;
    this.prefixTimer = null;
    this.prefixFocus = cx.focus_handle();
    cx.spawn(async (cx) => {
      for (;;) this.command(await nextCommand(), cx);
    });
  }

  command(action, cx) {
    if (action === "prefix") {
      this.prefix = focused() ?? {};
      this.prefixFocus.focus();
      this.prefixTimer?.cancel();
      // No redraw/polling while idle. Only watch for focus loss during prefix mode.
      this.prefixTimer = cx.timer.every(100, (cx) => {
        if (!this.prefixFocus.is_focused()) this.endPrefix(cx, false);
      });
      cx.notify();
      return;
    }
    if (action.startsWith("key:")) {
      if (!this.prefix || !this.prefixFocus.is_focused()) return;
      const origin = this.endPrefix(cx);
      // Personal layouts may reinterpret a view shortcut without changing the
      // global prefix map used by T3 and other layouts.
      const original = action.slice(4);
      const binding = props()?.prefixActions?.[original] ?? original;
      if (binding === "literal-prefix") {
        if (origin.terminal) cx.spawn(async (cx) => {
          // pane.focus is queued. Wait for it, then use the terminal's native
          // send action, not hc keys (agent input waits for a typing pause).
          await cx.sleep(0);
          if (!this.prefixFocus.is_focused() && focused()?.terminal === origin.terminal) {
            globalThis.window.dispatch_action("send:\u0000");
          }
        });
      } else if (binding.startsWith("odysseas-nav.")) {
        this.command(binding.slice("odysseas-nav.".length), cx);
      } else run(binding);
      return;
    }
    if (action === "reload") {
      // Sync must not block the prefix command queue while SSH is connecting.
      cx.spawn(async () => this.reload());
      return;
    }
    const state = { spaces: spaces(), panes: panes(), agents: agents(), focus: focused() };
    for (const [name, args] of plan(action, state, this.previous)) run(name, args);
    cx.notify();
  }

  endPrefix(cx, restore = true) {
    const origin = this.prefix;
    this.prefix = null;
    this.prefixTimer?.cancel();
    this.prefixTimer = null;
    if (restore && origin) this.restoreFocus();
    cx.notify();
    return origin;
  }

  outsidePrefix(cx) {
    if (!this.prefix) return;
    this.endPrefix(cx, false);
    // Let the clicked control take focus first; never steal it back from an input.
    cx.spawn(async (cx) => {
      await cx.sleep(0);
      if (!this.prefix && this.prefixFocus.is_focused()) this.restoreFocus();
    });
  }

  restoreFocus() {
    const f = focused();
    // Native dispatch is applied before the next input event; a queued mod run
    // can otherwise swallow the first character typed immediately after an action.
    if (f?.pane) globalThis.window.dispatch_action(`pane.focus:${f.pane}`);
    else if (f?.terminal) run("pane.focus", { terminal: f.terminal });
  }

  async reload() {
    try {
      const win = window()?.platform === "windows";
      const result = win
        ? await exec("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${home()}\\AppData\\Local\\Programs\\herdr-profile\\herdr-start.ps1`, "-SyncOnly"])
        : await exec("python3", [`${home()}/.local/share/herdr-profile/profile.py`, "sync"]);
      notify({ title: result.code === 0 ? "Herdr profile synced" : "Profile sync failed", body: result.code === 0 ? "Preferences refreshed from Debina." : result.stderr });
    } catch (error) { notify({ title: "Profile sync failed", body: String(error) }); }
  }

  close() {
    this.prefixTimer?.cancel();
  }

  render() {
    const t = theme();
    const f = focused();
    if (f?.pane && f.pane !== this.current) {
      this.previous = this.current;
      this.current = f.pane;
    }
    const space = spaces().find((s) => s.active);
    const needs = agents().filter((a) => a.status === "blocked").length;
    const host = space?.machine ?? (window()?.platform === "windows" ? "Windows (local)" : "This computer");
    const remote = machines().find((m) => m.name === "debina");
    const prefix = Boolean(this.prefix && this.prefixFocus.is_focused());
    const root = h_flex().id("navigation").size_full().px(12).gap(14).items_center()
      .track_focus(this.prefixFocus)
      .on_key_down((_event, cx) => {
        // Bound second strokes dispatch key:<action> first. Unbound strokes cancel,
        // without attempting lossy replay of Unicode/shifted terminal input.
        cx.stop_propagation();
        this.endPrefix(cx);
      })
      .on_mouse_down_out((_event, cx) => this.outsidePrefix(cx))
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.5).text_color(t.muted)
      .child(div().font_semibold().text_color(space?.machine === "debina" ? t.accent : t.muted).child(host))
      .child(div().truncate().child(space?.branch ?? ""))
      .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`${needs} needs you`)))
      .when(Boolean(remote && remote.layout !== "ready"), (el) => el.child(div().text_color(t.blocked).child(`Debina: ${remote?.layout}`)))
      .child(div().flex_1())
      .child(div().id("prefix-help").px(8).py(2).rounded(4)
        .bg(prefix ? t.accent : t.chrome).text_color(prefix ? t.accent_foreground : t.muted)
        .font_semibold()
        .on_click((_event, cx) => prefix ? this.endPrefix(cx) : run("app.help"))
        .child(prefix ? "PREFIX · Esc cancels" : "Ctrl+Space → ?  keys"))
      .child(div().id("command-palette").on_click(() => run("app.palette")).child("Ctrl+Shift+P  commands"));
    for (const binding of keys()) {
      if (binding.section === "mod:odysseas-nav" && binding.action.startsWith("odysseas-nav.key:")) {
        // Handle the second stroke on the focus path, synchronously, instead of
        // round-tripping through nextCommand while more typing arrives.
        root.on_action(binding.action, (_event, cx) => {
          cx.stop_propagation();
          this.command(binding.action.slice("odysseas-nav.".length), cx);
        });
      } else if (binding.section === "global" && !binding.keys.includes(" ")) {
        root.on_action(binding.action, (_event, cx) => {
          this.outsidePrefix(cx);
          cx.propagate();
        });
      }
    }
    return root;
  }
}
