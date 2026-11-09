import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, props, closeOverlay, exec, machines, window } from "herdr";
import { API_PORT, request, rowsFor, rowKey, enabled, togglePath, localUrl, manualPath, metadataBody, editPath } from "./model.js";

export default class DevelopmentPorts extends View {
  init(_props, cx) {
    this.on = null;
    this.apiPort = props()?.apiPort ?? API_PORT;
    this.mode = "forward";
    this.query = "";
    this.status = null;
    this.available = false;
    this.error = "";
    this.message = "";
    this.loading = false;
    this.busy = false;
    this.selected = null;
    this.form = null;
    this.generation = 0;
    this.closed = false;
    this.inputFocused = false;
    this.handle = cx.focus_handle();
    this.search = InputState.new({ placeholder: "Filter by port, label, process or group…" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); this.selected = null; cx.notify(); });
    this.search.on("focus", () => { this.inputFocused = true; });
    this.search.on("blur", () => { this.inputFocused = false; });
    this.search.on("submit", (_e, cx) => { this.handle.focus(); cx.notify(); });
    this.editor = InputState.new({ value: "" });
    this.editor.on("change", (_e, cx) => { this.formError = ""; cx.notify(); });
    this.editor.on("submit", (_e, cx) => this.submitForm(cx));
    // check loads this view too: never make API requests unless actually opened.
    if (!props()?.overlay) return;
    this.handle.focus();
    this.refresh(cx);
    this.poll = cx.timer.every(3000, (cx) => {
      if (window().active) this.refresh(cx);
    });
  }

  target() { return { on: this.on, apiPort: this.apiPort, platform: window().platform }; }
  canWrite() { return this.available && this.status?.connected && !this.busy && !this.loading; }
  rows() { return rowsFor(this.status, this.mode, this.query); }
  chosen() { const rows = this.rows(); return rows.find((row) => rowKey(row) === this.selected) ?? rows[0]; }

  refresh(cx, discover = false) {
    if (this.closed || this.loading || this.busy) return;
    const generation = this.generation, target = this.target();
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (discover) await request(exec, target, "/api/refresh");
        const status = await request(exec, target, "/api/status", undefined, "GET");
        if (this.closed || generation !== this.generation) return;
        this.status = status;
        this.available = true;
        this.error = "";
      } catch (error) {
        if (this.closed || generation !== this.generation) return;
        this.available = false; // Keep stale rows visible, but never act on them.
        this.error = String(error.message ?? error);
      }
      if (this.closed || generation !== this.generation) return;
      this.loading = false;
      cx.notify();
    });
  }

  changeSource(on, cx) {
    if (this.busy || this.on === on) return;
    this.generation++;
    this.on = on;
    this.status = null;
    this.available = false;
    this.loading = false;
    this.selected = null;
    this.form = null;
    this.message = this.error = "";
    this.handle.focus();
    this.refresh(cx);
  }

  changeMode(mode, cx) {
    if (this.busy) return;
    this.mode = mode;
    this.selected = null;
    this.form = null;
    this.message = "";
    this.handle.focus();
    cx.notify();
  }

  mutate(path, body, message, cx) {
    if (!this.canWrite()) return;
    const target = this.target(), generation = this.generation;
    // Toggle endpoints aren't idempotent. Lock before spawning, and never retry
    // a POST automatically, even on an ambiguous timeout.
    this.busy = true;
    this.message = this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      let applied = false;
      try {
        await request(exec, target, path, body);
        applied = true;
        const status = await request(exec, target, "/api/status", undefined, "GET");
        if (this.closed || generation !== this.generation) return;
        this.status = status;
        this.available = true;
        this.message = message;
        this.form = null;
      } catch (error) {
        if (this.closed || generation !== this.generation) return;
        this.available = false;
        this.error = `${applied ? "Saved, but status refresh failed. " : "Request failed; refresh before trying again. "}${error.message ?? error}`;
      }
      if (this.closed || generation !== this.generation) return;
      this.busy = false;
      this.handle.focus();
      cx.notify();
    });
  }

  toggle(row, cx) {
    if (!row) return;
    const turningOff = enabled(row, this.mode);
    this.mutate(togglePath(row, this.mode), undefined,
      turningOff ? "Forwarding disabled. The service is still running." : "Forwarding enabled. Portd will keep the mapping connected.", cx);
  }

  beginForm(kind, row, cx) {
    if (!this.canWrite()) return;
    this.form = { kind, row, mode: this.mode };
    this.formError = "";
    this.editor.set_value(kind === "manual" ? "" : row[kind] ?? "");
    this.editor.focus();
    cx.notify();
    cx.timer.after(100, () => { if (this.form && !this.closed) this.editor.focus(); });
  }

  cancelForm(cx) { this.form = null; this.handle.focus(); cx.notify(); }

  submitForm(cx) {
    if (!this.form || !this.canWrite()) return;
    const { kind, row, mode } = this.form;
    try {
      if (kind === "manual") {
        const path = manualPath(this.editor.value(), mode, this.status, this.apiPort);
        this.mutate(path, undefined, "Manual mapping enabled.", cx);
      } else {
        this.mutate(editPath(row.remote_port, kind), metadataBody(kind, this.editor.value()), `${kind === "label" ? "Label" : "Group"} saved.`, cx);
      }
    } catch (error) { this.formError = error.message; cx.notify(); }
  }

  open(row, cx) {
    if (!this.available || row.state !== "active") return;
    if (this.on) {
      this.mutate(`/api/tunnels/${row.remote_port}/open`, undefined, "Browser opened on the client that owns this controller.", cx);
    } else {
      const url = localUrl(row);
      if (url) cx.open_url(url);
    }
  }

  key(e, cx) {
    if (e.key === "escape") {
      if (this.form) this.cancelForm(cx);
      else closeOverlay(props().overlay);
      cx.stop_propagation();
      return;
    }
    if (this.form || this.inputFocused) return;
    const rows = this.rows(), index = Math.max(0, rows.indexOf(this.chosen()));
    if (e.key === "/") this.search.focus();
    else if (e.key === "1" || e.key === "2") this.changeMode(e.key === "1" ? "forward" : "reverse", cx);
    else if (e.key === "down" || e.key === "j") this.selected = rowKey(rows[Math.min(rows.length - 1, index + 1)] ?? { remote_port: "" });
    else if (e.key === "up" || e.key === "k") this.selected = rowKey(rows[Math.max(0, index - 1)] ?? { remote_port: "" });
    else if (e.key === "enter" || e.key === "x") this.toggle(this.chosen(), cx);
    else if (e.key === "r") this.refresh(cx, true);
    else if (e.key === "m") this.beginForm("manual", null, cx);
    else if (this.mode === "forward" && this.chosen() && (e.key === "l" || e.key === "g")) this.beginForm(e.key === "l" ? "label" : "group", this.chosen(), cx);
    else if (this.mode === "forward" && this.chosen() && ["[", "]", "{", "}"].includes(e.key)) {
      this.mutate(editPath(this.chosen().remote_port, "move"), { scope: e.key === "{" || e.key === "}" ? "group" : "port", direction: e.key === "[" || e.key === "{" ? -1 : 1 }, "Order updated.", cx);
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  close() { this.closed = true; this.generation++; this.poll?.cancel(); }

  render() {
    const t = theme(), reverse = this.mode === "reverse", status = this.status;
    const writable = this.canWrite(), chosen = this.chosen();
    const button = (id, label, click, { active = false, disabled = false, primary = false } = {}) =>
      h_flex().id(id).h(30).px(10).items_center().justify_center().flex_none().rounded(7)
        .border_1().border_color(active ? t.accent : primary ? t.solid : t.input)
        .bg(primary ? t.solid : active ? t.selected : t.raised)
        .text_color(primary ? t.solid_foreground : active ? t.accent : t.foreground)
        .text_size(12).font_medium().opacity(disabled ? 0.4 : 1)
        .role("button").accessibility_label(label)
        .when(!disabled, el => el.cursor_pointer().hover(s => s.opacity(0.8)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); if (!disabled) click(cx); }).child(label);
    const input = (state) => Input.new(state).h(34).px(10).rounded(8).border_1().border_color(t.input)
      .bg(t.background).text_color(t.foreground).text_size(12.5);
    const remote = status?.host ?? "Remote", client = this.on ? "Client" : "This computer";
    const list = this.rows();
    const content = [];
    let group = null;
    for (const row of list) {
      if (!reverse && row.group !== group) {
        group = row.group;
        const name = group || "Ungrouped", count = list.filter((r) => r.group === group).length;
        content.push(h_flex().id(`group-${row.remote_port}`).h(36).px(12).gap(8).items_center().flex_none()
          .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child(`${name} · ${count}`))
          .when(Boolean(group), el => el
            .child(button(`group-up-${row.remote_port}`, "Group ↑", cx => this.mutate(editPath(row.remote_port, "move"), { scope: "group", direction: -1 }, "Group moved.", cx), { disabled: !writable }))
            .child(button(`group-down-${row.remote_port}`, "Group ↓", cx => this.mutate(editPath(row.remote_port, "move"), { scope: "group", direction: 1 }, "Group moved.", cx), { disabled: !writable }))));
      }
      const selected = chosen && rowKey(chosen) === rowKey(row);
      const label = row.label || row.process || `Port ${row.remote_port}`;
      const isOn = enabled(row, this.mode), active = row.state === "active";
      const stateText = active ? (reverse ? "Exposed" : "Forwarded") : row.state === "error" ? "Retrying" : row.state === "disabled" ? "Disabled" : "Detected";
      content.push(h_flex().id(`port-${this.mode}-${row.remote_port}-${row.local_port ?? 0}`).min_h(66).px(12).py(8).gap(12).items_center().flex_none()
        .rounded(8).border_1().border_color(selected ? t.accent : t.border).bg(selected ? t.selected : t.background)
        .on_click((_e, cx) => { this.selected = rowKey(row); this.handle.focus(); cx.notify(); })
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(div().truncate().font_semibold().text_size(13).child(label))
          .child(div().truncate().text_color(t.muted).text_size(11).child(row.label && row.process ? row.process : reverse ? "Local service" : "Remote service")))
        .child(v_flex().w(170).flex_none().gap(4)
          .child(div().text_size(12.5).font_medium().child(reverse ? `:${row.local_port} → :${row.remote_port}` : `:${row.remote_port} → ${row.local_port ? `:${row.local_port}` : "—"}`))
          .child(div().text_size(10.5).text_color(t.dim).child(reverse ? `${client} → ${remote}` : `${remote} → ${client}`)))
        .child(h_flex().w(88).gap(5).items_center().flex_none()
          .child(div().size(6).rounded_full().bg(active ? t.done : row.state === "error" ? t.blocked : t.dim))
          .child(div().text_size(11).text_color(active ? t.done : t.muted).child(stateText)))
        .when(!reverse, el => el
          .child(button(`open-${row.remote_port}`, this.on ? "Open on client" : "Open", cx => this.open(row, cx), { disabled: !this.available || !active || this.busy }))
          .child(button(`copy-${row.remote_port}`, "Copy URL", cx => { const url = localUrl(row); if (url) cx.write_to_clipboard(url); }, { disabled: !this.available || !active })))
        .child(button(`toggle-${row.remote_port}`, isOn ? "Disable" : "Enable", cx => this.toggle(row, cx), { primary: !isOn, disabled: !writable })));
    }
    const count = (reverse ? status?.reverse_tunnels : status?.tunnels)?.length ?? 0;
    const activeCount = ((reverse ? status?.reverse_tunnels : status?.tunnels) ?? []).filter((r) => r.state === "active").length;
    const sourceLabel = this.on ? `${this.on} bridge` : "This computer";
    const root = v_flex().id("development-ports").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).p(20).gap(12).bg(t.popover).text_color(t.foreground)
      .child(h_flex().gap(12).items_center().flex_none()
        .child(div().flex_1().font_semibold().text_size(18).child("Development ports"))
        .child(h_flex().gap(5).items_center().text_size(11).text_color(this.available ? status?.connected ? t.done : t.blocked : t.muted)
          .child(div().size(6).rounded_full().bg(this.available && status?.connected ? t.done : t.blocked))
          .child(this.available ? status.connected ? `Connected to ${remote}` : "SSH reconnecting" : this.loading ? "Connecting…" : "Controller unavailable"))
        .child(button("ports-close", "Close · Esc", () => closeOverlay(props().overlay))))
      .child(h_flex().gap(6).items_center().flex_none()
        .child(div().text_size(11).text_color(t.dim).child("Controller"))
        .child(button("source-local", "This computer", cx => this.changeSource(null, cx), { active: !this.on, disabled: this.busy }))
        .children(machines().filter((m) => m.name && m.layout === "ready").map((m) =>
          button(`source-${m.name}`, `${m.name} bridge`, cx => this.changeSource(m.name, cx), { active: this.on === m.name, disabled: this.busy }))))
      .when(Boolean(this.on), el => el.child(div().text_size(11).text_color(t.blocked)
        .child("Bridge mode controls the client owning that machine’s portd reverse channel. Its local ports and browser may belong to a different computer.")))
      .child(h_flex().gap(8).items_center().flex_none()
        .child(button("mode-forward", "1 · Remote services", cx => this.changeMode("forward", cx), { active: !reverse, disabled: this.busy }))
        .child(button("mode-reverse", "2 · Local services", cx => this.changeMode("reverse", cx), { active: reverse, disabled: this.busy }))
        .child(div().flex_1())
        .child(button("ports-add", "Add mapping", cx => this.beginForm("manual", null, cx), { disabled: !writable }))
        .child(button("ports-refresh", this.loading ? "Refreshing…" : "Refresh", cx => this.refresh(cx, true), { disabled: this.loading || this.busy })))
      .child(div().text_size(12).text_color(t.muted).flex_none().child(reverse
        ? "Expose a service from this controller’s client on remote loopback. Nothing is exposed until you enable it."
        : "Remote services forwarded to this controller’s client. Open uses the actual local port, even when it differs."))
      .child(input(this.search).flex_none())
      .when(Boolean(this.error || status?.last_error || this.message), el => el.child(div().text_size(11.5).flex_none()
        .text_color(this.error || !status?.connected ? t.blocked : t.done).child(this.error || status?.last_error || this.message)));
    if (this.form) {
      const kind = this.form.kind;
      const title = kind === "manual" ? reverse ? "Remote port : local port" : "Remote port" : `${kind === "label" ? "Label" : "Group"} for port ${this.form.row.remote_port}`;
      root.child(v_flex().flex_none().p(12).gap(7).rounded(8).border_1().border_color(t.accent).bg(t.surface)
        .child(div().text_size(12).font_medium().child(title))
        .child(h_flex().gap(8).items_center()
          .child(input(this.editor).flex_1())
          .child(button("form-cancel", "Cancel", cx => this.cancelForm(cx), { disabled: this.busy }))
          .child(button("form-save", kind === "manual" ? "Enable mapping" : "Save", cx => this.submitForm(cx), { primary: true, disabled: !writable })))
        .child(div().text_size(11).text_color(this.formError ? t.blocked : t.dim)
          .child(this.formError || (kind === "manual" ? "Ports 1024–65535. Existing enabled mappings are never toggled off by this form." : "Leave empty to clear. Saved by portd and shared with the terminal client."))));
    } else if (!reverse && chosen) {
      root.child(h_flex().gap(6).items_center().flex_none()
        .child(div().text_size(11).text_color(t.dim).child(`Port ${chosen.remote_port}`))
        .child(button("edit-label", "Edit label", cx => this.beginForm("label", chosen, cx), { disabled: !writable }))
        .child(button("edit-group", "Set group", cx => this.beginForm("group", chosen, cx), { disabled: !writable }))
        .child(button("port-up", "Move ↑", cx => this.mutate(editPath(chosen.remote_port, "move"), { scope: "port", direction: -1 }, "Port moved.", cx), { disabled: !writable }))
        .child(button("port-down", "Move ↓", cx => this.mutate(editPath(chosen.remote_port, "move"), { scope: "port", direction: 1 }, "Port moved.", cx), { disabled: !writable })));
    }
    root.child(v_flex().id("ports-list").flex_1().min_h(0).gap(5).overflow_y_scrollbar()
      .children(content)
      .when(!list.length, el => el.child(v_flex().flex_1().min_h(90).items_center().justify_center().gap(8)
        .child(div().text_size(14).font_medium().child(!status ? this.loading ? "Reading portd…" : "Portd is not available" : this.query ? "No matching ports" : "No services discovered"))
        .child(div().text_size(12).text_color(t.muted).child(!status ? `Start portd on ${sourceLabel}, then refresh. No daemon is started automatically.` : reverse ? "Add a mapping now, or start a local service and refresh." : "Start a development server on the remote host, then refresh.")))))
      .child(h_flex().gap(10).pt(8).border_t(1).border_color(t.border).items_center().flex_none().text_size(10.5).text_color(t.dim)
        .child(div().flex_1().child(`${count} mappings · ${activeCount} active · ${sourceLabel} · 127.0.0.1:${this.apiPort}`))
        .child(div().child("/ filter · ↑↓ select · Enter toggle · Esc close")))
      .child(div().flex_none().text_size(10.5).text_color(t.muted).child("Closing this dialog leaves services and tunnels running. Disable changes SSH forwarding only."));
    return root;
  }
}
