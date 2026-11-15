import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { NOTE_TEMPLATES } from "../../ai/craft/checklist";
import { chapterLabel, orderedChapters } from "../../domain/documents";
import { uniqueId } from "../../domain/ids";
import { previewText } from "../../domain/util";
import { NOTE_KIND_LABELS, NOTE_KINDS, type AuthorNote, type NoteKind } from "../../notes/schema";
import { CommitTextarea, isComposing, Tabs, useDialogs } from "../common";
import { useWriter } from "../useWriter";
import type { NotebookApi, OpenChapter } from "./useNotebook";

export function NotesTab({ notebook, update, onOpenChapter }: NotebookApi & { onOpenChapter: OpenChapter }) {
  const addNote = (kind: NoteKind, text: string, extra: Partial<AuthorNote> = {}) => update((draft) => {
    const now = Date.now();
    draft.notes.unshift({ id: uniqueId("note"), kind, text, plan: "", chapterId: null, done: false, origin: "user", createdAt: now, updatedAt: now, ...extra });
  });
  const writer = useWriter();
  const dialogs = useDialogs();
  const [filter, setFilter] = useState<NoteKind | "all">("all");
  const [kind, setKind] = useState<NoteKind>("focus");
  const [text, setText] = useState("");
  const [showDone, setShowDone] = useState(false);
  const chapters = useMemo(() => (writer.project ? orderedChapters(writer.project) : []), [writer.project]);
  const active = writer.active.kind === "chapter" ? writer.active.id : null;

  const submit = async () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    await addNote(kind, value);
  };
  const edit = (id: string, patch: Partial<AuthorNote>) => update((draft) => {
    const note = draft.notes.find((item) => item.id === id);
    if (note) Object.assign(note, patch, { updatedAt: Date.now() });
  });
  const remove = async (note: AuthorNote) => {
    if (!(await dialogs.confirm("删除笔记", `删除“${previewText(note.text, 30)}”？`, { danger: true, confirmLabel: "删除" }))) return;
    await update((draft) => { draft.notes = draft.notes.filter((item) => item.id !== note.id); });
  };

  const list = notebook.notes.filter((note) => (filter === "all" || note.kind === filter) && (showDone || !note.done));
  const doneCount = notebook.notes.filter((note) => note.done && (filter === "all" || note.kind === filter)).length;
  return (
    <section className="w-card">
      <div className="w-row"><h3>我的笔记</h3><span className="w-spacer" /><Tabs size="sm" value={filter} onChange={setFilter} items={[{ value: "all", label: "全部" }, ...NOTE_KINDS.map((item) => ({ value: item, label: NOTE_KIND_LABELS[item], badge: notebook.notes.filter((note) => note.kind === item && !note.done).length }))]} /></div>
      <div className="w-search-form">
        <select className="w-select small" value={kind} onChange={(event) => setKind(event.currentTarget.value as NoteKind)}>{NOTE_KINDS.map((item) => <option key={item} value={item}>{NOTE_KIND_LABELS[item]}</option>)}</select>
        <input className="w-input grow" placeholder={kind === "todo" ? "要写 / 要改的事" : kind === "focus" ? "接下来要盯住的事" : "随手记"} value={text} onChange={(event) => setText(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter" && !isComposing(event)) void submit(); }} />
        <button type="button" className="w-btn small" disabled={!text.trim()} onClick={() => void submit()}><Plus size={12} />记下</button>
      </div>
      <div className="w-row small"><span className="w-muted">用卡片模板：</span>{NOTE_TEMPLATES.map((template) => <button key={template.id} type="button" className="w-link" onClick={() => void addNote("memo", `${template.label}\n${template.text}`)}>{template.label}</button>)}</div>
      {list.map((note) => (
        <article key={note.id} className={`w-note ${note.kind} ${note.done ? "done" : ""}`}>
          <div className="w-row small">
            <input type="checkbox" title={note.done ? "标记为未完成" : "标记为已完成"} checked={note.done} onChange={(event) => void edit(note.id, { done: event.currentTarget.checked })} />
            <span className="w-pill">{NOTE_KIND_LABELS[note.kind]}</span>
            {note.origin === "ai" ? <span className="w-pill tone">AI</span> : null}
            {note.chapterId ? <button type="button" className="w-link" onClick={() => onOpenChapter(note.chapterId ?? "")}>{chapterLabel(chapters.findIndex((chapter) => chapter.id === note.chapterId))}</button> : null}
            <span className="w-spacer" />
            <select className="w-select small" title="关联章节" value={note.chapterId ?? ""} onChange={(event) => void edit(note.id, { chapterId: event.currentTarget.value || null })}>
              <option value="">不关联章节</option>
              {active && note.chapterId !== active ? <option value={active}>当前章节</option> : null}
              {chapters.map((chapter, position) => <option key={chapter.id} value={chapter.id}>{chapterLabel(position)} {previewText(chapter.title, 12)}</option>)}
            </select>
            <button type="button" className="w-icon-btn small" aria-label="删除" title="删除" onClick={() => void remove(note)}><Trash2 size={12} /></button>
          </div>
          <CommitTextarea className="w-note-text" rows={1} value={note.text} onCommit={(value) => void edit(note.id, { text: value })} />
          {note.kind === "todo" || note.kind === "craft" || note.plan ? <CommitTextarea className="w-note-plan" rows={1} placeholder="具体怎么做" value={note.plan} onCommit={(value) => void edit(note.id, { plan: value })} /> : null}
        </article>
      ))}
      {!list.length ? <p className="w-muted">{notebook.notes.length ? "这一类没有未完成的笔记。" : "记下写作时要盯住的事、要回头改的地方、商量好的写法。伏笔和期待请记在“期待与伏笔”里。AI 写作时会参考未完成的笔记。"}</p> : null}
      {doneCount ? <button type="button" className="w-link" onClick={() => setShowDone(!showDone)}>{showDone ? "隐藏已完成" : `显示已完成（${doneCount}）`}</button> : null}
    </section>
  );
}
