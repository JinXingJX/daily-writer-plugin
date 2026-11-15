import { cancelWriterTask } from "../../worker/taskClient";
import { MessagesSquare, PenLine, Plus, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { friendlyAiError } from "../../ai/client";
import { generateBriefing } from "../../ai/pipelines/notebook";
import { chapterLabel, orderedChapters } from "../../domain/documents";
import { chapterStatusLabel } from "../../domain/markdown";
import { uniqueId } from "../../domain/ids";
import { formatWordCount } from "../../domain/words";
import { THREAD_KIND_LABELS } from "../../memory/schema";
import { chaptersBasis, writingProgress } from "../../notes/derive";
import { NOTE_KIND_LABELS, type AuthorNote, type NoteKind } from "../../notes/schema";
import { wordsWrittenOn } from "../../storage/stats";
import { diagnoseStory, HEALTH_RULE_LABELS } from "../../story/health";
import { THRESHOLD_LABELS, type StoryThresholds } from "../../story/schema";
import { positionedThreads } from "../../story/selectors";
import { NumberInput, Spinner } from "../common";
import { useWriter } from "../useWriter";
import type { NotebookApi, OpenChapter } from "./useNotebook";

export function OverviewTab({ notebook, update, onOpenChapter }: NotebookApi & { onOpenChapter: OpenChapter }) {
  const writer = useWriter();
  const { project, memory } = writer;
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  if (!project) return null;
  const chapters = orderedChapters(project);
  const progress = writingProgress(project);
  const briefing = notebook.briefing;
  const stale = briefing ? briefing.basis !== chaptersBasis(project, progress.frontierPosition + 1) : false;
  const coverage = memory?.coverage();

  const generate = async () => {
    await writer.flush();
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    try {
      const next = await generateBriefing({ project, memory, notebook, story: writer.story, signal: controller.signal });
      await update((draft) => { draft.briefing = next; });
    } catch (error) { if (!controller.signal.aborted) writer.notify("error", friendlyAiError(error)); }
    finally { setBusy(false); }
  };

  const addNote = (kind: NoteKind, text: string, extra: Partial<AuthorNote> = {}) => update((draft) => {
    const now = Date.now();
    draft.notes.unshift({ id: uniqueId("note"), kind, text, plan: "", chapterId: null, done: false, origin: "user", createdAt: now, updatedAt: now, ...extra });
  });

  const discuss = () => {
    const open = notebook.notes.filter((note) => !note.done).slice(0, 12).map((note) => `- 〔${NOTE_KIND_LABELS[note.kind]}〕${note.text}`).join("\n");
    const text = `我写到${progress.frontier ? `${chapterLabel(progress.frontierPosition)}「${progress.frontier.title}」` : "开头"}了。${briefing?.progress ?? ""}\n${open ? `我的笔记：\n${open}\n` : ""}帮我想想下一步该写什么、哪些地方需要回头改。`;
    writer.openAssist("chat", true, { text });
  };

  return (
    <div className="w-notebook">
      <div className="w-notebook-col">
        <section className="w-card">
          <div className="w-row"><h3>写到哪里了</h3><span className="w-spacer" />{progress.frontier ? <button type="button" className="w-btn small primary" onClick={() => onOpenChapter(progress.frontier?.id ?? "")}><PenLine size={12} />继续写</button> : null}</div>
          {progress.frontier ? (
            <p className="w-notebook-lead">{progress.volumeTitle ? `${progress.volumeTitle} · ` : ""}{chapterLabel(progress.frontierPosition)}「{progress.frontier.title}」<span className="w-pill">{chapterStatusLabel(progress.frontier.status)}</span></p>
          ) : <p className="w-muted">还没有写下正文。</p>}
          <div className="w-stat-row">
            <Stat value={formatWordCount(progress.totalWords)} label="全书" />
            <Stat value={`${progress.writtenCount} / ${progress.chapterCount}`} label="已写章节" />
            <Stat value={`+${wordsWrittenOn(writer.stats)}`} label="今日" />
            <Stat value={String(progress.statusCounts.final)} label="定稿" />
          </div>
          <p className="w-muted">
            {progress.statusCounts.review ? `${progress.statusCounts.review} 章待修改 · ` : ""}
            {progress.plannedAhead > 0 ? `后面还有 ${progress.plannedAhead} 章已建好未写 · ` : ""}
            {project.targetLength ? `目标篇幅 ${project.targetLength}` : ""}
            {coverage && coverage.fresh < coverage.total ? ` · 记忆覆盖 ${coverage.fresh}/${coverage.total} 章` : ""}
          </p>
          {briefing?.progress ? <p>{briefing.progress}</p> : null}
        </section>

        <section className="w-card">
          <div className="w-row">
            <h3>AI 整理</h3>
            {briefing ? <span className="w-muted">{new Date(briefing.generatedAt).toLocaleString()}</span> : null}
            {stale ? <span className="w-pill warn">正文已更新</span> : null}
            <span className="w-spacer" />
            <button type="button" className="w-btn small" onClick={discuss}><MessagesSquare size={12} />和助手讨论</button>
            {busy ? <button type="button" className="w-btn small" onClick={() => { cancelWriterTask(abortRef.current?.signal); abortRef.current?.abort(); }}><Spinner size={12} />停止</button> : <button type="button" className="w-btn small primary" disabled={!progress.writtenCount} onClick={() => void generate()}>{briefing ? <RefreshCw size={12} /> : <Sparkles size={12} />}{briefing ? "重新整理" : "AI 整理笔记"}</button>}
          </div>
          {!briefing ? <p className="w-muted">让 AI 读一遍已写章节摘要、线索、故事体检和你的笔记，整理出：已写内容概要、接下来的重点、下一步要写或要改的事、线索怎么兑现、有没有偏离核心承诺。{memory?.isEmpty !== false ? "先在“记忆”里建立故事记忆，整理会更准确。" : ""}</p> : (
            <>
              {briefing.storySoFar ? <><h4>已写内容</h4><p className="w-notebook-prose">{briefing.storySoFar}</p></> : null}
              {briefing.focus.length ? <><h4>重点关注</h4><ul className="w-notebook-list">{briefing.focus.map((item, index) => <li key={index}><span>{item}</span><AdoptButton exists={notebook.notes.some((note) => note.text === item)} onAdopt={() => void addNote("focus", item, { origin: "ai" })} /></li>)}</ul></> : null}
              {briefing.next.length ? <><h4>下一步</h4><ul className="w-notebook-list">{briefing.next.map((step, index) => (
                <li key={index}>
                  <span><b>{step.title}</b>{step.detail ? `：${step.detail}` : ""}{step.chapterId ? <> <button type="button" className="w-link" onClick={() => onOpenChapter(step.chapterId ?? "")}>{chapterLabel(chapters.findIndex((chapter) => chapter.id === step.chapterId))}</button></> : null}</span>
                  <AdoptButton exists={notebook.notes.some((note) => note.text === step.title)} onAdopt={() => void addNote("todo", step.title, { plan: step.detail, chapterId: step.chapterId, origin: "ai" })} />
                </li>
              ))}</ul></> : null}
              {briefing.promiseDrift ? <><h4>偏离核心承诺</h4><p className="w-notebook-prose warn">{briefing.promiseDrift}</p></> : null}
              {briefing.gaps.length ? <><h4>期待空档</h4><ul className="w-notebook-list warn">{briefing.gaps.map((item, index) => <li key={index}><span>{item}</span></li>)}</ul></> : null}
              {briefing.risks.length ? <><h4>风险</h4><ul className="w-notebook-list warn">{briefing.risks.map((item, index) => <li key={index}><span>{item}</span></li>)}</ul></> : null}
            </>
          )}
        </section>

        <RecentChapters onOpenChapter={onOpenChapter} upTo={progress.frontierPosition} />
      </div>

      <div className="w-notebook-col">
        <HealthCard onOpenChapter={onOpenChapter} />
        <ExpectationTimeline onOpenChapter={onOpenChapter} />
      </div>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return <div className="w-stat"><b>{value}</b><span>{label}</span></div>;
}

export function AdoptButton({ exists, onAdopt }: { exists: boolean; onAdopt: () => void }) {
  return exists ? <span className="w-pill ok">已记下</span> : <button type="button" className="w-link" onClick={onAdopt}><Plus size={11} />记下</button>;
}

function RecentChapters({ upTo, onOpenChapter }: { upTo: number; onOpenChapter: OpenChapter }) {
  const writer = useWriter();
  const { project, memory } = writer;
  if (!project || upTo < 0) return null;
  const chapters = orderedChapters(project);
  const from = Math.max(0, upTo - 5);
  const rows = chapters.slice(from, upTo + 1).map((chapter, offset) => ({ chapter, position: from + offset, card: memory?.cardAt(from + offset) ?? null })).reverse();
  return (
    <section className="w-card">
      <h3>最近写了什么</h3>
      {memory?.aggregates.book?.mainline ? <p className="w-muted">全书主线：{memory.aggregates.book.mainline}</p> : null}
      <ol className="w-notebook-chapters">
        {rows.map(({ chapter, position, card }) => (
          <li key={chapter.id}>
            <button type="button" className="w-link" onClick={() => onOpenChapter(chapter.id)}>{chapterLabel(position)}</button>
            <b>{chapter.title}</b>
            <span className="w-muted">{chapter.wordCount} 字 · {chapterStatusLabel(chapter.status)}</span>
            <p>{card?.summary || chapter.summary || <span className="w-muted">暂无摘要（建立故事记忆后自动生成）</span>}</p>
            {card?.hook ? <p className="w-muted">章末钩子：{card.hook}</p> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}


function HealthCard({ onOpenChapter }: { onOpenChapter: OpenChapter }) {
  const writer = useWriter();
  const { story, memory, project } = writer;
  const [showThresholds, setShowThresholds] = useState(false);
  const issues = useMemo(() => (story ? diagnoseStory(story, memory) : []), [story, memory]);
  if (!project || !story) return null;
  const setThreshold = (key: keyof StoryThresholds, value: number) => void writer.updateStory((plan) => { plan.thresholds = { ...plan.thresholds, [key]: value }; });
  return (
    <section className="w-card">
      <div className="w-row"><h3>故事体检</h3><span className="w-muted">{issues.length ? `${issues.length} 个提示` : "没有发现结构问题"}</span><span className="w-spacer" /><button type="button" className="w-link" onClick={() => setShowThresholds(!showThresholds)}>{showThresholds ? "收起阈值" : "调整阈值"}</button></div>
      {showThresholds ? (
        <div className="w-threshold-grid">
          {(Object.keys(THRESHOLD_LABELS) as (keyof StoryThresholds)[]).map((key) => (
            <label key={key}><span>{THRESHOLD_LABELS[key]}</span><NumberInput value={story.thresholds[key]} step={key === "expectationHandoffProgress" ? 0.1 : 1} onCommit={(value) => setThreshold(key, value)} /></label>
          ))}
          <p className="w-muted">这些数字只是参考，按题材和章长调整。</p>
        </div>
      ) : null}
      {!memory || memory.isEmpty ? <p className="w-muted">建立故事记忆后，体检会检查期待空档、伏笔沉寂、爽点重复、情绪积压等问题。</p> : null}
      <ul className="w-health-list">
        {issues.slice(0, 40).map((issue) => (
          <li key={issue.id} className={issue.severity}>
            <b>{HEALTH_RULE_LABELS[issue.rule]}</b>：{issue.message}
            {issue.chapterId ? <> <button type="button" className="w-link" onClick={() => onOpenChapter(issue.chapterId ?? "")}>打开</button></> : null}
          </li>
        ))}
      </ul>
      {issues.length ? <button type="button" className="w-btn small" onClick={() => writer.openAssist("chat", true, { text: "根据故事体检的结果，挑最要紧的三个结构问题，给出具体到人物和章节的补法。", send: false })}><MessagesSquare size={12} />和助手讨论</button> : null}
    </section>
  );
}

/** Reader-facing threads on a chapter axis: when each was raised, advanced and paid off; gaps stand out. */
function ExpectationTimeline({ onOpenChapter }: { onOpenChapter: OpenChapter }) {
  const writer = useWriter();
  const { memory } = writer;
  if (!memory || memory.isEmpty) return null;
  const total = Math.max(1, memory.orderedIds.length);
  const threads = positionedThreads(memory).filter((thread) => thread.kind !== "foreshadow" && thread.plantedAt >= 0).sort((left, right) => left.plantedAt - right.plantedAt).slice(-30);
  if (!threads.length) return <section className="w-card"><h3>期待时间线</h3><p className="w-muted">还没有识别出读者期待和悬念。可以在“期待与伏笔”里手动登记。</p></section>;
  const covered = new Array(total).fill(false);
  for (const thread of threads) for (let index = thread.plantedAt; index <= (thread.paidAt ?? total - 1); index += 1) covered[index] = true;
  const pct = (position: number) => `${(position / total) * 100}%`;
  return (
    <section className="w-card">
      <div className="w-row"><h3>期待时间线</h3><span className="w-muted">横轴是章节，红色是没有期待的空档</span></div>
      <div className="w-timeline">
        <div className="w-timeline-gaps">{covered.map((value, index) => (value ? null : <span key={index} style={{ left: pct(index), width: pct(1) }} />))}</div>
        {threads.map((thread) => {
          const end = thread.paidAt ?? (thread.status === "open" ? total - 1 : thread.lastAt);
          return (
            <button key={thread.id} type="button" className={`w-timeline-bar ${thread.kind} ${thread.status}`} title={`${THREAD_KIND_LABELS[thread.kind]}：${thread.title}（${chapterLabel(thread.plantedAt)} → ${thread.paidAt !== null ? chapterLabel(thread.paidAt) : "未兑现"}）`} style={{ marginLeft: pct(thread.plantedAt), width: `max(6px, ${pct(Math.max(1, end - thread.plantedAt + 1))})` }} onClick={() => onOpenChapter(memory.orderedIds[thread.plantedAt])}>
              <span>{thread.title}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
