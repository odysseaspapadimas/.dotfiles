// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { TaskList } from "./app.tsx";
import type { Result, rpcContract } from "./contract.ts";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const result: Result = { error: null, tasks: [
  { id: 1, subject: "Inspect", status: "completed" },
  { id: 2, subject: "Implement", activeForm: "Building banner", status: "in_progress" },
  { id: 3, subject: "Test", status: "pending" },
]};
test("compact current task and count expand to a read-only checklist", () => {
  const view = render(<TaskList result={result} />);
  const toggle = view.getByRole("button");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.textContent).toContain("Building banner");
  expect(toggle.textContent).toContain("1/3");
  expect(view.queryByRole("list")).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(view.getAllByRole("listitem")).toHaveLength(3);
  expect(view.queryByRole("checkbox")).toBeNull();
  fireEvent.click(toggle);
  expect(view.queryByRole("list")).toBeNull();
});
test("no tasks means no banner; completion remains inspectable", () => {
  const view = render(<TaskList result={{ tasks: [], error: null }} />);
  expect(view.queryByRole("button")).toBeNull();
  view.rerender(<TaskList result={{ tasks: [{ id: 1, subject: "Done", status: "completed" }], error: null }} />);
  expect(view.getByRole("button").textContent).toContain("All tasks completed");
});
test("untrusted task text is rendered as text, never HTML", () => {
  const view = render(<TaskList result={{ tasks: [{ id: 1, subject: "<img src=x onerror=alert(1)>", status: "pending" }], error: null }} />);
  expect(view.container.querySelector("img")).toBeNull();
});
async function mount(providerId = "pi", tasks = vi.fn().mockResolvedValue(result)) {
  const app = await loadPluginApp(() => import("./app.tsx"));
  expect(app.threadPanelActions).toHaveLength(0);
  const customization = app.composerCustomizations[0]!;
  expect(customization.scopes).toEqual(["thread"]);
  const slot = renderSlot<{}, typeof rpcContract>(customization.banners![0]!, {}, {
    composer: { scope: { kind: "thread", threadId: "t" }, selection: { providerId } },
    rpc: { tasks },
  });
  return { slot, tasks };
}
test("registers above composer and reads the bound thread's tasks", async () => {
  const { slot, tasks } = await mount();
  await slot.findByText("Building banner");
  expect(tasks.mock.calls[0]![0]).toEqual({ threadId: "t" });
});
test("non-Pi composers do not fetch or show Pi tasks", async () => {
  const { slot, tasks } = await mount("codex");
  expect(slot.queryByRole("button")).toBeNull();
  expect(tasks).not.toHaveBeenCalled();
});
test("failed refresh preserves visible tasks and marks them stale", async () => {
  const tasks = vi.fn().mockResolvedValueOnce(result).mockResolvedValue({ tasks: [], error: "Offline" });
  const { slot } = await mount("pi", tasks);
  await slot.findByText("Building banner");
  fireEvent.focus(window);
  await waitFor(() => expect(slot.getByRole("status").textContent).toContain("last known"));
  expect(slot.getByText("1/3")).toBeTruthy();
});
test("unmount removes polling and focus listeners", async () => {
  const { slot, tasks } = await mount();
  await slot.findByText("Building banner");
  slot.unmount();
  const count = tasks.mock.calls.length;
  fireEvent.focus(window);
  expect(tasks).toHaveBeenCalledTimes(count);
});
