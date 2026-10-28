import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, render } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract, Result } from "./contract.ts";
import { BesideModel } from "./placement.tsx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const result: Result = { hostName: "machine", observedAt: Date.now(), usage: {
  status: "ok", accountEmail: "codex@example.test", planLabel: "Pro",
  windows: [{ id: "weekly", label: "Weekly limit", usedPercent: 23, resetsAt: new Date(Date.now() + (5 * 24 + 10) * 3600000 + 30000).toISOString() }],
}};
async function mount(model = "openai/gpt-5.4", usage = vi.fn().mockResolvedValue(result)) {
  const app = await loadPluginApp(() => import("./app.tsx"));
  expect(app.composerCustomizations[0]!.banners ?? []).toHaveLength(0);
  const slot = renderSlot<{}, typeof rpcContract>(app.composerCustomizations[0]!.actions![0]!, {}, {
    composer: { scope: { kind: "thread", threadId: "t" }, selection: { providerId: "pi", model } },
    rpc: { usage },
  });
  return { slot, usage };
}
test("shows only compact used-percent/reset; details stay in tooltip", async () => {
  const { slot, usage } = await mount();
  const text = await slot.findByText("23%/5d10h");
  expect(text.title).toContain("may differ from Pi");
  expect(text.title).toContain("codex@example.test");
  expect(text.title).toContain("Weekly limit: 23% used.");
  expect(slot.queryByText("codex@example.test")).toBe(null);
  expect(slot.queryByText("Refresh")).toBe(null);
  await waitFor(() => expect(usage).toHaveBeenCalledTimes(1));
  fireEvent.click(text);
  await waitFor(() => expect(usage).toHaveBeenCalledTimes(2));
  expect(usage.mock.calls[1]![0]).toEqual({ target: { kind: "thread", threadId: "t" }, refresh: true });
});
test("hides for a non-OpenAI selection without fetching usage", async () => {
  const { slot, usage } = await mount("anthropic/claude");
  expect(slot.queryByRole("button")).toBe(null);
  expect(usage).not.toHaveBeenCalled();
});
test("authentication failures use a dash with recovery in tooltip", async () => {
  const { slot } = await mount(undefined, vi.fn().mockResolvedValue({ hostName: "machine", observedAt: null, usage: { status: "expired" } }));
  const text = await slot.findByText("—");
  expect(text.title).toContain("Codex login expired");
  expect(slot.queryByText(/%/)).toBe(null);
});
test("RPC failures show a compact retryable unavailable state", async () => {
  const { slot } = await mount(undefined, vi.fn().mockRejectedValue(new Error("offline")));
  const text = await slot.findByText("—");
  expect(text.title).toContain("Could not refresh Codex usage");
});
test("temporary refresh failures retain the observed value with a stale tooltip", async () => {
  const usage = vi.fn().mockResolvedValueOnce(result).mockRejectedValue(new Error("offline"));
  const { slot } = await mount(undefined, usage);
  fireEvent.click(await slot.findByText("23%/5d10h"));
  await waitFor(() => expect(slot.getByText("23%/5d10h").title).toContain("Showing cached usage"));
});
test("weekly total is preferred over current-session usage", async () => {
  const weekly = result.usage.status === "ok" ? result.usage.windows[0]! : null!;
  const { slot } = await mount(undefined, vi.fn().mockResolvedValue({ ...result, usage: { ...result.usage, windows: [
    { ...weekly, id: "session", label: "Current session", usedPercent: 5 }, weekly,
  ] } }));
  await slot.findByText("23%/5d10h");
  expect(slot.queryByText(/5%/)).toBe(null);
});
test("portals beside the local model picker and cleans up on unmount", async () => {
  const view = render(<div data-app-composer="">
    <button aria-label="Provider, model and reasoning">Model</button>
    <div><BesideModel><span>23%/5d10h</span></BesideModel></div>
  </div>);
  const model = view.getByRole("button", { name: "Provider, model and reasoning" });
  await waitFor(() => expect(model.nextElementSibling?.textContent).toBe("23%/5d10h"));
  expect(model.nextElementSibling?.hasAttribute("data-pi-codex-usage-accessory")).toBe(true);
  const accessory = model.nextElementSibling!;
  view.unmount();
  expect(accessory.isConnected).toBe(false);
});
test("independent composers keep usage next to their own selectors", async () => {
  const view = render(<div>
    <div data-app-composer=""><button aria-label="Provider, model and reasoning">A</button><BesideModel>23%/5d10h</BesideModel></div>
    <div data-app-composer=""><button aria-label="Provider, model and reasoning">B</button><BesideModel>70%/2d</BesideModel></div>
  </div>);
  expect(view.getByText("A").nextElementSibling?.textContent).toBe("23%/5d10h");
  expect(view.getByText("B").nextElementSibling?.textContent).toBe("70%/2d");
});
test("repositions when the model selector is replaced without duplicating accessories", async () => {
  const view = render(<div data-app-composer=""><button aria-label="Provider, model and reasoning">Old</button><BesideModel>23%/5d10h</BesideModel></div>);
  const old = view.getByText("Old");
  const fresh = old.cloneNode(true) as HTMLButtonElement;
  fresh.textContent = "New";
  old.replaceWith(fresh);
  await waitFor(() => expect(fresh.nextElementSibling?.textContent).toBe("23%/5d10h"));
  expect(view.container.querySelectorAll("[data-pi-codex-usage-accessory]")).toHaveLength(1);
});
