import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { Note, Preview, rpcContract } from "./contract.ts";
import { ScratchInputEditor, type ScratchInput } from "./rich-editor.tsx";
import { Button } from "@/components/ui/button";

type EditorState = { note: Note | null; text: string; key: string; blocked: boolean; saving: Promise<void> | null };
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

function ScratchEditor({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const model = useRef<EditorState>({ note: null, text: "", key: "", blocked: false, saving: null });
  const editor = useRef<ScratchInput>(null);
  const [, redraw] = useState(0);
  const update = useCallback(() => redraw(n => n + 1), []);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [clearPrompt, setClearPrompt] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = model.current;
  const dirty = current.note !== null && current.text !== current.note.text;

  const keepDraft = useCallback(() => {
    const state = model.current;
    if (!state.key || !state.note) return;
    try {
      if (state.text === state.note.text) localStorage.removeItem(state.key);
      else localStorage.setItem(state.key, JSON.stringify({ text: state.text, revision: state.note.revision }));
    } catch { setError("Browser draft recovery is unavailable. Keep this panel open until your notes are saved."); }
  }, []);

  const load = useCallback(async (recover = true) => {
    model.current.blocked = true;
    setBusy(true);
    update();
    try {
      const note = await rpc.call("load", { threadId });
      const key = `bb-project-scratch:${threadId}:${note.root}`;
      let text = note.text;
      let blocked = false;
      let problem = "";
      if (recover) {
        try {
          const raw = localStorage.getItem(key);
          if (raw) {
            const draft = JSON.parse(raw);
            if (typeof draft.text === "string" && draft.text !== note.text) {
              text = draft.text;
              blocked = draft.revision !== note.revision;
              problem = blocked ? "Recovered a draft, but saved notes changed. Download your draft before reloading saved notes." : "";
            }
          }
        } catch { problem = "Browser draft recovery is unavailable."; }
      } else {
        localStorage.removeItem(key);
      }
      model.current = { note, text, key, blocked, saving: null };
      setError(problem);
      setNotice(note.imported ? "Imported your existing notes. Herdr's original is unchanged." : text !== note.text ? "Recovered your unsaved draft." : "");
      update();
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }, [rpc, threadId, update]);

  const save = useCallback((): Promise<void> => {
    const state = model.current;
    if (state.saving) return state.saving;
    if (!state.note || state.blocked || state.text === state.note.text) return Promise.resolve();
    const run = async () => {
      try {
        while (state.note && state.text !== state.note.text) {
          const text = state.text;
          state.note = await rpc.call("save", { threadId, text, expectedRevision: state.note.revision, expectedRoot: state.note.root });
          keepDraft();
        }
        setError("");
      } catch (e) {
        state.blocked = true;
        setError(message(e));
      } finally { state.saving = null; update(); }
    };
    // Start in a microtask so saving is set before synchronous failures run.
    state.saving = Promise.resolve().then(run);
    update();
    return state.saving;
  }, [rpc, threadId, keepDraft, update]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!dirty || current.blocked) return;
    const timer = setTimeout(() => { void save(); }, 750);
    return () => clearTimeout(timer);
  }, [current.text, dirty, current.blocked, save]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const state = model.current;
      if (state.note && state.text !== state.note.text) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); void save(); };
  }, [save]);

  const edit = (text: string) => {
    model.current.text = text;
    setPreview(null); setClearPrompt(false); setNotice("");
    keepDraft(); update();
  };
  const format = (kind: "todo" | "strike") => editor.current?.format(kind);
  const previewPromotion = async () => {
    const selected = editor.current?.selectedMarkdown() ?? model.current.text;
    setBusy(true);
    try { setPreview(await rpc.call("preview", { threadId, text: selected })); setClearPrompt(false); setError(""); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };
  const promote = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await rpc.call("promote", { threadId, token: preview.token, confirmed: true });
      setPreview(null); setNotice("Added to the project journal. Your scratch notes are kept."); setError("");
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([model.current.text], { type: "text/markdown" }));
    const link = document.createElement("a"); link.href = url; link.download = "scratch-draft.md"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">Private workspace notes. Only journal promotion writes into your project.</p>
        {current.note && <p className="truncate text-xs text-muted-foreground" title={current.note.root}>{current.note.root}</p>}
      </div>
      {error && <div role="alert" className="space-y-2 text-sm text-destructive">
        <p>{error}</p>
        <div className="flex flex-wrap gap-2">
          {current.note && <Button size="sm" variant="outline" onClick={download}>Download draft</Button>}
          <Button size="sm" variant="outline" disabled={Boolean(current.saving)} onClick={() => {
            if (dirty && !window.confirm("Discard this draft and reload saved notes? Download a copy first if you want to keep it.")) return;
            void load(false);
          }}>Reload saved notes</Button>
          {current.blocked && <Button size="sm" variant="outline" onClick={() => { current.blocked = false; void save(); }}>Retry save</Button>}
        </div>
      </div>}
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
      <div className="flex flex-wrap gap-2" onMouseDown={event => event.preventDefault()}>
        <Button size="sm" variant="outline" disabled={!current.note || busy} onClick={() => format("todo")} aria-keyshortcuts="Alt+T">Todo</Button>
        <Button size="sm" variant="outline" disabled={!current.note || busy} onClick={() => format("strike")} aria-keyshortcuts="Alt+S">Strike</Button>
        <Button size="sm" variant="outline" disabled={!current.note || busy || !current.text.trim()} onClick={() => void previewPromotion()} aria-keyshortcuts="F2">Promote…</Button>
        <Button size="sm" variant="ghost" disabled={!current.note || busy || !current.text} onClick={() => { setClearPrompt(true); setPreview(null); }} aria-keyshortcuts="F8">Clear…</Button>
      </div>
      <div className="flex min-h-48 flex-1 flex-col" onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
          else if (event.altKey && event.key.toLowerCase() === "t") { event.preventDefault(); format("todo"); }
          else if (event.altKey && event.key.toLowerCase() === "s") { event.preventDefault(); format("strike"); }
          else if (event.key === "F2") { event.preventDefault(); void previewPromotion(); }
          else if (event.key === "F8") { event.preventDefault(); setClearPrompt(true); setPreview(null); }
        }}>
        <ScratchInputEditor ref={editor} text={current.text} disabled={!current.note || busy} onChange={edit} onBlur={() => { void save(); }} />
      </div>
      {preview && <section aria-label="Journal promotion preview" className="flex max-h-[50%] min-h-0 flex-col gap-2 rounded-md border border-border p-3">
        <p className="text-sm font-medium">Append to project journal</p>
        <p className="break-all text-xs text-muted-foreground">{preview.path}</p>
        <pre className="min-h-0 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{preview.append}</pre>
        <div className="flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => void promote()}>Append to journal</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setPreview(null)}>Cancel</Button>
        </div>
      </section>}
      {clearPrompt && <section aria-label="Confirm clear scratchpad" className="space-y-2 rounded-md border border-border p-3">
        <p className="text-sm">Clear these scratch notes? The project journal is kept.</p>
        <div className="flex gap-2">
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => { edit(""); void save(); }}>Clear scratchpad</Button>
          <Button size="sm" variant="outline" onClick={() => setClearPrompt(false)}>Cancel</Button>
        </div>
      </section>}
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span role="status" aria-live="polite">{!current.note ? "Loading…" : current.blocked ? "Save needs attention" : current.saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}</span>
        <Button size="sm" variant="ghost" disabled={!dirty || current.blocked || Boolean(current.saving)} onClick={() => void save()}>Save</Button>
      </div>
    </div>
  );
}

export default definePluginApp(app => {
  app.slots.threadPanelAction({
    id: "scratchpad", title: "Project scratch", icon: "NotebookPen", layout: "flush",
    component: ({ threadId }) => <ScratchEditor key={threadId} threadId={threadId} />,
  });
});
