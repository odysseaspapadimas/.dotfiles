import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "@tiptap/markdown";
import { Button } from "@/components/ui/button";
import { formatSelection } from "./editing.ts";
import "./scratch.css";

export type ScratchInput = {
  format: (kind: "todo" | "strike") => void;
  selectedMarkdown: () => string | null;
};
type Props = { text: string; disabled: boolean; onChange: (text: string) => void; onBlur: () => void };

export const ScratchInputEditor = forwardRef<ScratchInput, Props>(function ScratchInputEditor({ text, disabled, onChange, onBlur }, ref) {
  const [source, setSource] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const lastText = useRef(text);
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false } }), TaskList, TaskItem.configure({ nested: true, HTMLAttributes: { "data-type": "taskItem" } }), Markdown],
    content: text,
    contentType: "markdown",
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: { role: "textbox", "aria-label": "Private scratch notes", "aria-multiline": "true", class: "scratch-rich-input" },
      handlePaste(view, event) {
        // Plain-text Markdown paste gets the same rendering as loaded notes.
        if (event.clipboardData?.getData("text/html")) return false;
        const markdown = event.clipboardData?.getData("text/plain");
        if (!markdown) return false;
        const instance = editor;
        if (!instance) return false;
        event.preventDefault();
        instance.commands.insertContentAt({ from: view.state.selection.from, to: view.state.selection.to }, markdown, { contentType: "markdown" });
        return true;
      },
    },
    onUpdate({ editor }) {
      lastText.current = editor.getMarkdown();
      onChange(lastText.current);
    },
    onBlur() { onBlur(); },
  });

  useEffect(() => {
    if (!editor || lastText.current === text) return;
    // Loading or switching modes must never normalize and autosave untouched notes.
    editor.commands.setContent(text, { contentType: "markdown", emitUpdate: false });
    lastText.current = text;
  }, [editor, text]);
  useEffect(() => { editor?.setEditable(!disabled, false); }, [editor, disabled]);

  const sourceOnly = useMemo(() => {
    if (!editor?.markdown) return false;
    let unsupported = false;
    editor.markdown.instance.walkTokens(editor.markdown.instance.lexer(text), token => {
      if (["table", "image", "html"].includes(token.type)) unsupported = true;
    });
    return unsupported;
  }, [editor, text]);
  const showSource = source || sourceOnly;

  useImperativeHandle(ref, () => ({
    format(kind) {
      if (disabled) return;
      if (showSource) {
        const field = textarea.current;
        if (!field) return;
        const result = formatSelection(text, field.selectionStart, field.selectionEnd, kind);
        onChange(result.text);
        requestAnimationFrame(() => { field.focus(); field.setSelectionRange(result.start, result.end); });
      } else if (editor) {
        if (kind === "todo") editor.chain().focus().toggleTaskList().run();
        else {
          const chain = editor.chain().focus();
          // Without a selection, cross out the current line rather than future typing.
          if (editor.state.selection.empty) {
            const { $from } = editor.state.selection;
            chain.setTextSelection({ from: $from.start(), to: $from.end() });
          }
          chain.toggleStrike().run();
        }
      }
    },
    selectedMarkdown() {
      if (showSource) {
        const field = textarea.current;
        return field && field.selectionStart !== field.selectionEnd ? text.slice(field.selectionStart, field.selectionEnd) : null;
      }
      if (!editor || editor.state.selection.empty) return null;
      const { from, to } = editor.state.selection;
      return editor.markdown!.serialize({ type: "doc", content: editor.state.doc.slice(from, to).content.toJSON() });
    },
  }), [disabled, editor, showSource, text, onChange]);

  const toggleDone = () => {
    if (disabled) return;
    if (showSource) {
      const field = textarea.current;
      if (!field) return;
      const { selectionStart: start, selectionEnd: end } = field;
      const lineStart = text.slice(0, start).lastIndexOf("\n") + 1;
      const task = /^[ \t]*-[ \t]+\[([ xX])\]/.exec(text.slice(lineStart));
      if (!task) return;
      const at = lineStart + task[0].lastIndexOf("[") + 1;
      onChange(text.slice(0, at) + (task[1] === " " ? "x" : " ") + text.slice(at + 1));
      requestAnimationFrame(() => field.setSelectionRange(start, end));
    } else if (editor) {
      const { $from } = editor.state.selection;
      // Only the nearest task changes, including when it is nested in another task.
      for (let depth = $from.depth; depth > 0; depth--) {
        const node = $from.node(depth);
        if (node.type.name !== "taskItem") continue;
        editor.view.dispatch(editor.state.tr.setNodeMarkup($from.before(depth), undefined, { ...node.attrs, checked: !node.attrs.checked }));
        break;
      }
    }
  };

  return <div className="scratch-input flex min-h-48 flex-1 flex-col gap-2" onKeyDownCapture={event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggleDone();
    }
  }}>
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{sourceOnly ? "Markdown mode preserves tables, images, and HTML." : showSource ? "Markdown source" : "Rich text · type - [ ] for a todo, or ~~text~~ to strike"}</span>
      <Button size="sm" variant="ghost" disabled={disabled || sourceOnly} aria-pressed={showSource} onClick={() => setSource(value => !value)}>{showSource ? "Rich text" : "Markdown"}</Button>
    </div>
    <p className="text-xs text-muted-foreground">Ctrl/⌘+Enter toggles the current todo done.</p>
    {showSource ? <textarea
      ref={textarea} aria-label="Private scratch notes" value={text} disabled={disabled} spellCheck={false}
      className="min-h-48 w-full flex-1 resize-none rounded-md border border-input bg-background p-3 font-mono text-sm leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onChange={event => onChange(event.target.value)} onBlur={onBlur}
    /> : <EditorContent editor={editor} className="scratch-rich flex min-h-48 flex-1 flex-col rounded-md border border-input bg-background text-sm text-foreground" />}
  </div>;
});
