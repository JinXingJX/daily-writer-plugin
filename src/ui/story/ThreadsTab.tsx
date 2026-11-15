import { Plus, Sparkles, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { chapterLabel, orderedChapters } from "../../domain/documents";
import { uniqueId } from "../../domain/ids";
import { newThread, removeThread, saveThread } from "../../memory/operations";
import { THREAD_KIND_LABELS, THREAD_KINDS, THREAD_TIER_LABELS, THREAD_TIERS, type StoryThread, type ThreadKind } from "../../memory/schema";
import { positionedThreads } from "../../story/selectors";
import { CommitTextarea, Tabs, useDialogs } from "../common";
import { InspireButton } from "../inspire/InspireButton";
import { useWriter } from "../useWriter";
import type { NotebookApi, OpenChapter } from "./useNotebook";

/** Foreshadowing, reader expectations and mysteries in one ledger; the author's edits are saved at once. */
export function ThreadsTab({ notebook, onOpenChapter }: Pick<NotebookApi, "notebook"> & { onOpenChapter: OpenChapter }) {
  const writer = useWriter();
  const dialogs = useDialogs();
  const { project, memory } = writer;
  const [kind, setKind] = useState<ThreadKind | "all">("all");
  const [showClosed, setShowClosed] = useState(false);
  const chapters = useMemo(() => (project ? orderedChapters(project) : []), [project]);
  const threads = useMemo(() => (memory ? positionedThreads(memory) : []), [memory]);
  if (!project) return null;
  const suggestions = new Map((notebook.briefing?.threads ?? []).flatMap((thread) => (thread.threadId ? [[thread.threadId, thread.plan] as const] : [])));
  const save = async (thread: StoryThread) => { await saveThread(project.id, thread); await writer.refreshMemory(true); };
  const edit = (thread: StoryThread, patch: Partial<StoryThread>) => {
    const { plantedAt: _p, lastAt: _l, paidAt: _d, age: _a, ...plain } = thread as StoryThread & { plantedAt?: number; lastAt?: number; paidAt?: number | null; age?: number };
    void save({ ...plain, ...patch });
  };
  const add = () => void save(newThread({ id: uniqueId("thread"), title: "新线索", kind: kind === "all" ? "expectation" : kind, events: writer.active.kind === "chapter" ? [{ chapterId: writer.active.id, type: "plant", description: "作者登记" }] : [] }));
  const remove = async (thread: StoryThread) => {
    if (!(await dialogs.confirm("删除线索", `删除「${thread.title}」？`, { danger: true, confirmLabel: "删除" }))) return;
    await removeThread(project.id, thread.id);
    await writer.refreshMemory(true);
  };
  const list = threads.filter((thread) => (kind === "all" || thread.kind === kind) && (showClosed || thread.status === "open")).sort((left, right) => (left.status === right.status ? right.age - left.age : left.status === "open" ? -1 : 1));
  const titleOf = (id: string) => threads.find((thread) => thread.id === id)?.title ?? id;
  return (
    <section className="w-card">
      <div className="w-row">
        <h3>期待与伏笔</h3>
        <Tabs size="sm" value={kind} onChange={setKind} items={[{ value: "all", label: "全部" }, ...THREAD_KINDS.map((item) => ({ value: item, label: THREAD_KIND_LABELS[item], badge: threads.filter((thread) => thread.kind === item && thread.status === "open").length }))]} />
        <span className="w-spacer" />
        <label className="w-row small"><input type="checkbox" checked={showClosed} onChange={(event) => setShowClosed(event.currentTarget.checked)} />显示已兑现/放弃</label>
        <button type="button" className="w-btn small" onClick={add}><Plus size={12} />登记</button>
      </div>
      <p className="w-muted">伏笔是埋下的物件或话；期待是读者等着看的事；悬念是没有答案的谜。一个期待推进过半，就该安排接棒的下一个。</p>
      {!memory || memory.isEmpty ? <p className="w-muted">建立故事记忆后，这里会列出从正文中识别出的线索；也可以手动登记。</p> : null}
      {list.map((thread) => {
        const suggestion = suggestions.get(thread.id);
        return (
          <article key={thread.id} className={`w-thread-card ${thread.status}`}>
            <div className="w-row">
              <input className="w-input grow" value={thread.title} onChange={(event) => edit(thread, { title: event.currentTarget.value })} />
              <select className="w-select small" value={thread.kind} onChange={(event) => edit(thread, { kind: event.currentTarget.value as ThreadKind })}>{THREAD_KINDS.map((item) => <option key={item} value={item}>{THREAD_KIND_LABELS[item]}</option>)}</select>
              <select className="w-select small" value={thread.tier} onChange={(event) => edit(thread, { tier: event.currentTarget.value as StoryThread["tier"] })}>{THREAD_TIERS.map((item) => <option key={item} value={item}>{THREAD_TIER_LABELS[item]}</option>)}</select>
              <select className="w-select small" value={thread.status} onChange={(event) => edit(thread, { status: event.currentTarget.value as StoryThread["status"], progress: event.currentTarget.value === "paid" ? 1 : thread.progress })}><option value="open">未兑现</option><option value="paid">已兑现</option><option value="abandoned">放弃</option></select>
              <InspireButton className="w-icon-btn small" label="" title="这条线索可以怎么兑现" options={() => ({ target: "thread", focus: `[${thread.id}] ${thread.title}：${thread.description}${thread.plan ? `\n作者的计划：${thread.plan}` : ""}` })} />
              <button type="button" className="w-icon-btn small" aria-label="删除" onClick={() => void remove(thread)}><Trash2 size={12} /></button>
            </div>
            <div className="w-row small">
              {thread.plantedAt >= 0 ? <button type="button" className="w-link" onClick={() => onOpenChapter(memory?.orderedIds[thread.plantedAt] ?? "")}>{chapterLabel(thread.plantedAt)}引入</button> : <span className="w-muted">未关联章节</span>}
              <span className={thread.status === "open" && memory && memory.orderedIds.length - 1 - thread.lastAt > (writer.story?.thresholds.foreshadowStaleChapters ?? 50) ? "w-pill warn" : "w-muted"}>已 {thread.age} 章</span>
              <label className="w-row small">进度<input type="range" min={0} max={1} step={0.1} value={thread.progress} onChange={(event) => edit(thread, { progress: Number(event.currentTarget.value) })} />{Math.round(thread.progress * 100)}%</label>
              <select className="w-select small" title="计划兑现的章节" value={thread.targetChapterId ?? ""} onChange={(event) => edit(thread, { targetChapterId: event.currentTarget.value || null })}>
                <option value="">兑现章节未定</option>
                {chapters.map((chapter, position) => <option key={chapter.id} value={chapter.id}>{chapterLabel(position)} {chapter.title.slice(0, 12)}</option>)}
              </select>
            </div>
            <CommitTextarea className="w-note-text" rows={1} value={thread.description} placeholder="内容" onCommit={(value) => edit(thread, { description: value })} />
            <CommitTextarea className="w-note-plan" rows={1} placeholder="兑现计划：在哪一段、借谁的手、读者回看会发现什么" value={thread.plan} onCommit={(value) => edit(thread, { plan: value })} />
            {thread.kind !== "foreshadow" ? (
              <div className="w-row small">
                <span className="w-muted">接棒：</span>
                {thread.successorIds.map((id) => <span key={id} className="w-pill">{titleOf(id)}<button type="button" className="w-link" aria-label="移除" onClick={() => edit(thread, { successorIds: thread.successorIds.filter((item) => item !== id) })}>×</button></span>)}
                <select className="w-select small" value="" onChange={(event) => { if (event.currentTarget.value) edit(thread, { successorIds: [...thread.successorIds, event.currentTarget.value] }); }}>
                  <option value="">添加接棒的期待…</option>
                  {threads.filter((other) => other.id !== thread.id && other.status === "open" && !thread.successorIds.includes(other.id)).map((other) => <option key={other.id} value={other.id}>{other.title}</option>)}
                </select>
                {thread.progress >= (writer.story?.thresholds.expectationHandoffProgress ?? 0.5) && !thread.successorIds.length && thread.status === "open" ? <span className="w-pill warn">快兑现了，还没有接棒</span> : null}
              </div>
            ) : null}
            {suggestion && suggestion !== thread.plan ? <div className="w-notebook-suggest"><Sparkles size={12} /><span>{suggestion}</span><button type="button" className="w-link" onClick={() => edit(thread, { plan: thread.plan ? `${thread.plan}\n${suggestion}` : suggestion })}>采用</button></div> : null}
          </article>
        );
      })}
      {memory && !list.length ? <p className="w-muted">这一类没有线索。</p> : null}
    </section>
  );
}
