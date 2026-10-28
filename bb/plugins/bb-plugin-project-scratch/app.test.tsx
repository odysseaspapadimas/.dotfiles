import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "./contract.ts";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk";

const note = { root: "/project", text: "", revision: "a".repeat(64), imported: false };
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function mount(rpc: Partial<PluginRpcTestHandlers<typeof rpcContract>> = {}, source = true) {
  const app = await loadPluginApp(() => import("./app.tsx"));
  const unexpected = () => { throw new Error("Unexpected RPC call"); };
  const slot = renderSlot<PluginThreadPanelProps, typeof rpcContract>(app.threadPanelActions[0]!, { threadId: "thread-test", params: null }, {
    rpc: { load: () => ({ ...note }), save: unexpected, preview: unexpected, promote: unexpected, ...rpc },
  });
  await slot.findByTitle("/project");
  if (source && slot.queryByRole("button", { name: "Markdown" })) fireEvent.click(slot.getByRole("button", { name: "Markdown" }));
  const field = await slot.findByRole("textbox", { name: "Private scratch notes" }) as HTMLTextAreaElement;
  await waitFor(() => expect(field.hasAttribute("disabled")).toBe(false));
  return { slot, field };
}

test("autosaves; an edit during an in-flight save is also persisted", async () => {
  let release: ((value: typeof note) => void) | undefined;
  const save = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockImplementation(({ text }) => ({ ...note, text, revision: "c".repeat(64) }));
  const { slot, field } = await mount({ save });
  fireEvent.change(field, { target: { value: "first" } });
  fireEvent.keyDown(field, { key: "s", ctrlKey: true });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  fireEvent.change(field, { target: { value: "second" } });
  release!({ ...note, text: "first", revision: "b".repeat(64) });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1]![0]).toMatchObject({ text: "second", expectedRevision: "b".repeat(64) });
  await waitFor(() => expect(slot.getByText("Saved")).toBeTruthy());
  expect(localStorage.length).toBe(0);
});

test("a save conflict preserves the draft and offers recovery without overwriting", async () => {
  const save = vi.fn().mockRejectedValue(new Error("Another window changed this scratchpad."));
  const { slot, field } = await mount({ save });
  fireEvent.change(field, { target: { value: "my draft" } });
  fireEvent.blur(field);
  await slot.findByText("Another window changed this scratchpad.");
  expect(field.value).toBe("my draft");
  expect(slot.getByRole("button", { name: "Download draft" })).toBeTruthy();
  expect(JSON.parse(localStorage.getItem("bb-project-scratch:thread-test:/project")!).text).toBe("my draft");
  expect(save).toHaveBeenCalledTimes(1);
});

test("autosave runs after the debounce without a keyboard command", async () => {
  const save = vi.fn().mockImplementation(({ text }) => ({ ...note, text }));
  const { slot, field } = await mount({ save });
  fireEvent.change(field, { target: { value: "remember this" } });
  expect(save).not.toHaveBeenCalled();
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 2000 });
  await waitFor(() => expect(slot.getByText("Saved")).toBeTruthy());
});

test("a recovered draft stays intact when the saved revision has moved on", async () => {
  localStorage.setItem("bb-project-scratch:thread-test:/project", JSON.stringify({ text: "unsent draft", revision: "old" }));
  const save = vi.fn();
  const { slot, field } = await mount({ save });
  expect(field.value).toBe("unsent draft");
  expect(slot.getByText(/Recovered a draft, but saved notes changed/)).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
});

test("promotion previews selected text and requires the explicit append action", async () => {
  const preview = vi.fn().mockResolvedValue({ token: "preview-1", path: "/project/.agents/project-journal.md", append: "\n## date\n\nselected\n" });
  const promote = vi.fn().mockResolvedValue({ path: "/project/.agents/project-journal.md" });
  const { slot, field } = await mount({ load: () => ({ ...note, text: "private selected" }), preview, promote });
  field.setSelectionRange(8, 16);
  fireEvent.click(slot.getByRole("button", { name: "Promote…" }));
  await slot.findByRole("region", { name: "Journal promotion preview" });
  expect(preview.mock.calls[0]![0]).toEqual({ threadId: "thread-test", text: "selected" });
  expect(promote).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "Append to journal" }));
  await waitFor(() => expect(promote).toHaveBeenCalledExactlyOnceWith({ threadId: "thread-test", token: "preview-1", confirmed: true }));
  expect(field.value).toBe("private selected");
});

test("rich text renders strike and clickable todos, saving Markdown when checked", async () => {
  const original = "~~crossed out~~\n\n- [ ] do this\n- [x] finished";
  const save = vi.fn().mockImplementation(({ text }) => ({ ...note, text }));
  const { slot, field } = await mount({ load: () => ({ ...note, text: original }), save }, false);
  expect(field.querySelector("s")?.textContent).toBe("crossed out");
  const boxes = slot.getAllByRole("checkbox") as HTMLInputElement[];
  expect(boxes.map(box => box.checked)).toEqual([false, true]);
  // Live node views must match the CSS row selector, not just serialized HTML.
  for (const box of boxes) {
    const row = box.closest('li[data-type="taskItem"]');
    expect(row).toBeTruthy();
    expect(row?.querySelector(":scope > label > input")).toBe(box);
    expect(row?.querySelector(":scope > div > p")).toBeTruthy();
  }
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(boxes[0]!);
  fireEvent.keyDown(field, { key: "s", ctrlKey: true });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0]![0].text).toContain("- [x] do this");
  expect(save.mock.calls[0]![0].text).toContain("~~crossed out~~");
  expect(field.querySelector('li[data-checked="true"]')).toBeTruthy();
});

test("opening notes and switching modes does not rewrite the original Markdown", async () => {
  const original = "~~old~~\n\n- [ ] first\n\n\nkeep this exactly\n";
  const save = vi.fn();
  const { slot } = await mount({ load: () => ({ ...note, text: original }), save }, false);
  fireEvent.click(slot.getByRole("button", { name: "Markdown" }));
  expect((slot.getByRole("textbox") as HTMLTextAreaElement).value).toBe(original);
  fireEvent.click(slot.getByRole("button", { name: "Rich text" }));
  fireEvent.click(slot.getByRole("button", { name: "Markdown" }));
  expect((slot.getByRole("textbox") as HTMLTextAreaElement).value).toBe(original);
  expect(save).not.toHaveBeenCalled();
});

test.each([{ ctrlKey: true }, { metaKey: true }])("completion shortcut toggles a rich todo without removing it (%j)", async modifier => {
  const save = vi.fn().mockImplementation(({ text }) => ({ ...note, text }));
  const { slot, field } = await mount({ load: () => ({ ...note, text: "- [ ] first\n- [ ] second" }), save }, false);
  field.focus();
  const range = document.createRange();
  range.setStart(field.querySelector('li[data-type="taskItem"] > div > p')!.firstChild!, 2);
  range.collapse(true);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  await new Promise(resolve => setTimeout(resolve, 30));
  fireEvent.keyDown(field, { key: "Enter", ...modifier });
  const boxes = slot.getAllByRole("checkbox") as HTMLInputElement[];
  expect(boxes.map(box => box.checked)).toEqual([true, false]);
  fireEvent.keyDown(field, { key: "s", ctrlKey: true });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0]![0].text).toContain("- [x] first");
  fireEvent.keyDown(field, { key: "Enter", ...modifier });
  expect(boxes.map(box => box.checked)).toEqual([false, false]);
});

test("completion shortcut toggles only the current Markdown task and keeps the caret", async () => {
  const save = vi.fn().mockImplementation(({ text }) => ({ ...note, text }));
  const original = "- [ ] first\n  - [X] second";
  const { field } = await mount({ load: () => ({ ...note, text: original }), save });
  field.setSelectionRange(22, 22);
  fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
  expect(field.value).toBe("- [ ] first\n  - [ ] second");
  await waitFor(() => expect(field.selectionStart).toBe(22));
  fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
  expect(field.value).toBe("- [ ] first\n  - [x] second");
});

test.each([true, false])("completion shortcut leaves ordinary text unchanged (source=%s)", async source => {
  const save = vi.fn();
  const { field } = await mount({ load: () => ({ ...note, text: "not a todo" }), save }, source);
  field.focus();
  fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
  expect(source ? field.value : field.textContent).toBe("not a todo");
  expect(save).not.toHaveBeenCalled();
});

test("notes with unsupported rich content stay in lossless Markdown mode", async () => {
  const original = "- [ ] keep\n\n![diagram](diagram.png)\n\n<!-- private -->";
  const save = vi.fn();
  const { slot, field } = await mount({ load: () => ({ ...note, text: original }), save });
  expect(field.tagName).toBe("TEXTAREA");
  expect(field.value).toBe(original);
  expect(slot.getByRole("button", { name: "Rich text" }).hasAttribute("disabled")).toBe(true);
  expect(save).not.toHaveBeenCalled();
});

test("rich-text toolbar strikes a line and converts it into a task", async () => {
  const save = vi.fn().mockImplementation(({ text }) => ({ ...note, text }));
  const { slot, field } = await mount({ load: () => ({ ...note, text: "remember" }), save }, false);
  fireEvent.click(slot.getByRole("button", { name: "Strike" }));
  await waitFor(() => expect(field.querySelector("s")?.textContent).toBe("remember"));
  fireEvent.click(slot.getByRole("button", { name: "Todo" }));
  await slot.findByRole("checkbox");
  fireEvent.keyDown(field, { key: "s", ctrlKey: true });
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls.at(-1)![0].text).toContain("- [ ] ~~remember~~");
});

test("rich-text promotion keeps selected formatting and still requires confirmation", async () => {
  const preview = vi.fn().mockResolvedValue({ token: "rich-preview", path: "/project/.agents/project-journal.md", append: "~~selected~~" });
  const { slot, field } = await mount({ load: () => ({ ...note, text: "private ~~selected~~" }), preview }, false);
  const text = field.querySelector("s")!.firstChild!;
  field.focus();
  const range = document.createRange();
  range.selectNodeContents(text);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  // ProseMirror reads the DOM selection before the editor shortcut is dispatched.
  await new Promise(resolve => setTimeout(resolve, 30));
  fireEvent.keyDown(field, { key: "F2" });
  await slot.findByRole("region", { name: "Journal promotion preview" });
  expect(preview).toHaveBeenCalledExactlyOnceWith({ threadId: "thread-test", text: "~~selected~~" });
});

test("pasted Markdown renders and saves as Markdown rather than HTML", async () => {
  const save = vi.fn().mockImplementation(({ text }) => ({ ...note, text }));
  const { slot, field } = await mount({ save }, false);
  fireEvent.paste(field, { clipboardData: { getData: (type: string) => type === "text/plain" ? "- [ ] pasted ~~task~~" : "" } });
  await slot.findByRole("checkbox");
  expect(field.querySelector("s")?.textContent).toBe("task");
  fireEvent.keyDown(field, { key: "s", ctrlKey: true });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0]![0].text).toContain("- [ ] pasted ~~task~~");
});

test("clear requires confirmation and leaves notes alone when cancelled", async () => {
  const save = vi.fn().mockImplementation(({ text }) => ({ ...note, text }));
  const { slot, field } = await mount({ load: () => ({ ...note, text: "keep" }), save });
  fireEvent.click(slot.getByRole("button", { name: "Clear…" }));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
  expect(field.value).toBe("keep");
  fireEvent.click(slot.getByRole("button", { name: "Clear…" }));
  fireEvent.click(slot.getByRole("button", { name: "Clear scratchpad" }));
  await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: "" })));
});
