import { cancelWriterTask } from "../../worker/taskClient";
import { BookOpen, ChevronLeft, ChevronRight, Eye, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { friendlyAiError } from "../../ai/client";
import { digestReaders, simulateReaders } from "../../ai/pipelines/notebook";
import { readerPanel } from "../../ai/promptRegistry";
import { chapterLabel, orderedChapters } from "../../domain/documents";
import { uniqueId } from "../../domain/ids";
import { previewText, unixTimestamp } from "../../domain/util";
import { newThread, saveThread } from "../../memory/operations";
import { chaptersBasis, readerKnowledge, unrevealedSecrets, type KnownEntity } from "../../notes/derive";
import { READER_VERDICT_LABELS, READER_VERDICTS, verdictTally, type ReaderAction, type ReaderItem, type ReaderMark, type ReaderVerdict, type ReaderVoice } from "../../notes/schema";
import { loadChapterText } from "../../storage/projectStore";
import { Empty, Spinner } from "../common";
import { useWriter } from "../useWriter";
import { AdoptButton } from "./OverviewTab";
import type { NotebookApi, OpenChapter } from "./useNotebook";

const VERDICT_TONES: Record<ReaderVerdict, string> = { keep: "ok", hesitate: "warn", drop: "danger" };
const SCOPE_LABELS: Record<ReaderAction["scope"], string> = { chapter: "改本章", next: "后面写" };

export function ReaderTab({ notebook, update, onOpenChapter }: NotebookApi & { onOpenChapter: OpenChapter }) {
  const writer = useWriter();
  const { project, memory, story } = writer;
  const chapters = useMemo(() => (project ? orderedChapters(project) : []), [project]);
  const written = useMemo(() => chapters.map((chapter, position) => ({ chapter, position })).filter((item) => item.chapter.wordCount > 0), [chapters]);
  const initial = writer.active.kind === "chapter" && written.some((item) => item.chapter.id === (writer.active as { id: string }).id) ? (writer.active as { id: string }).id : written[written.length - 1]?.chapter.id ?? "";
  const [chapterId, setChapterId] = useState(initial);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [digesting, setDigesting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  const position = chapters.findIndex((chapter) => chapter.id === chapterId);
  const knowledge = useMemo(() => (memory && position >= 0 ? readerKnowledge(memory, position) : null), [memory, position]);
  const secrets = useMemo(() => (memory && position >= 0 ? unrevealedSecrets(story, memory, position) : []), [story, memory, position]);
  const panel = useMemo(() => (project ? readerPanel(project) : []), [project]);
  if (!project) return null;
  if (!written.length) return <Empty icon={<Eye size={20} />} title="还没有正文">写下第一章后，可以请读者小组读到任意一章，看他们追不追、在哪里停下。</Empty>;
  if (!memory || memory.isEmpty) return <Empty icon={<Eye size={20} />} title="需要先建立故事记忆">读者靠逐章抽取的摘要和人物记住前情。请先在“记忆”中建立故事记忆。<div className="w-row" style={{ justifyContent: "center", marginTop: 10 }}><button type="button" className="w-btn primary" onClick={() => writer.openArchive("memory")}>去建立记忆</button></div></Empty>;

  const snapshot = notebook.readers[chapterId] ?? null;
  const stale = snapshot ? snapshot.basis !== chaptersBasis(project, position + 1) : false;
  const index = written.findIndex((item) => item.chapter.id === chapterId);
  const step = (delta: number) => { const next = written[index + delta]; if (next) setChapterId(next.chapter.id); };
  const missing = knowledge ? position + 1 - knowledge.coveredChapters : 0;
  const tally = snapshot ? verdictTally(snapshot) : null;
  const digest = snapshot?.digest ?? null;
  const jump = (quote: string) => onOpenChapter(chapterId, quote);

  const adoptExpectation = async (item: ReaderItem) => {
    await saveThread(project.id, newThread({ id: uniqueId("thread"), title: item.title, description: item.detail || item.title, kind: "expectation", events: [{ chapterId, type: "plant", description: "模拟读者在这里产生的期待" }] }));
    void writer.refreshMemory(true);
    writer.notify("success", `已登记期待「${item.title}」。`);
  };

  const addNote = async (action: ReaderAction) => {
    const now = Date.now();
    await update((draft) => { draft.notes.unshift({ id: uniqueId("note"), kind: action.scope === "chapter" ? "todo" : "focus", text: action.title, plan: action.detail, chapterId: action.scope === "chapter" ? chapterId : null, done: false, origin: "ai", createdAt: now, updatedAt: now }); });
  };

  const addComment = async (persona: string, mark: ReaderMark) => {
    const text = writer.getDraft()?.texts[chapterId] ?? await loadChapterText(project.id, chapterId);
    const start = text.indexOf(mark.quote);
    if (start < 0) { writer.notify("error", "正文已经改过，找不到这一句了。"); return; }
    writer.mutateProject((draft) => { draft.comments.push({ id: uniqueId("comment"), doc: { kind: "chapter", id: chapterId }, quote: mark.quote, start, comment: `〔读者·${persona}〕${mark.reaction}`, severity: "warning", author: "ai", resolved: false, createdAt: unixTimestamp() }); });
    writer.notify("success", "已加为批注。", { label: "看批注", run: () => writer.openAssist("notes") });
  };

  const begin = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    return controller;
  };

  const simulate = async () => {
    await writer.flush();
    const controller = begin();
    setProgress({ done: 0, total: panel.length });
    try {
      const result = await simulateReaders({ project, memory, chapterId, story, signal: controller.signal, onProgress: (done, total) => setProgress({ done, total }) });
      await update((draft) => { draft.readers[result.chapterId] = result; });
      if (result.failed.length) writer.notify("info", `${result.failed.join("、")}没有读完，可以重新试读。`);
    } catch (error) { if (!controller.signal.aborted) writer.notify("error", friendlyAiError(error)); }
    finally { setProgress(null); }
  };

  const redigest = async () => {
    if (!snapshot) return;
    const controller = begin();
    setDigesting(true);
    try {
      const result = await digestReaders({ project, memory, chapterId, voices: snapshot.voices, story, signal: controller.signal });
      await update((draft) => { const current = draft.readers[chapterId]; if (current?.generatedAt === snapshot.generatedAt) current.digest = result; });
    } catch (error) { if (!controller.signal.aborted) writer.notify("error", friendlyAiError(error)); }
    finally { setDigesting(false); }
  };

  return (
    <div className="w-reader">
      <div className="w-row w-reader-bar">
        <BookOpen size={14} className="w-tone" />
        <span>读者读完</span>
        <button type="button" className="w-icon-btn small" aria-label="上一章" disabled={index <= 0} onClick={() => step(-1)} title="上一章"><ChevronLeft size={13} /></button>
        <select className="w-select small" value={chapterId} onChange={(event) => setChapterId(event.currentTarget.value)}>
          {written.map((item) => <option key={item.chapter.id} value={item.chapter.id}>{chapterLabel(item.position)} {previewText(item.chapter.title, 16)}</option>)}
        </select>
        <button type="button" className="w-icon-btn small" aria-label="下一章" disabled={index < 0 || index >= written.length - 1} onClick={() => step(1)} title="下一章"><ChevronRight size={13} /></button>
        <span>之后</span>
        <span className="w-spacer" />
        {missing > 0 ? <span className="w-pill warn">{missing} 章还没有记忆，读者记得的前情可能不全</span> : null}
      </div>

      <section className="w-card">
        <div className="w-row">
          <h3>读者小组试读</h3>
          {snapshot ? <span className="w-muted">{new Date(snapshot.generatedAt).toLocaleString()}</span> : null}
          {stale ? <span className="w-pill warn">正文已更新</span> : null}
          <span className="w-spacer" />
          {progress ? <button type="button" className="w-btn small" onClick={() => { cancelWriterTask(abortRef.current?.signal); abortRef.current?.abort(); }}><Spinner size={12} />{progress.done}/{progress.total} 位读完 · 停止</button>
            : <button type="button" className="w-btn small primary" disabled={digesting} onClick={() => void simulate()}>{snapshot ? <RefreshCw size={12} /> : <Sparkles size={12} />}{snapshot ? "重新试读" : `请 ${panel.length} 位读者读到这里`}</button>}
        </div>
        {snapshot && tally ? (
          <>
            <div className="w-row small">
              {READER_VERDICTS.map((verdict) => (tally[verdict] ? <span key={verdict} className={`w-pill ${VERDICT_TONES[verdict]}`}>{READER_VERDICT_LABELS[verdict]} {tally[verdict]}</span> : null))}
              {snapshot.failed.length ? <span className="w-muted">{snapshot.failed.join("、")}没有读完</span> : null}
            </div>
            {digest ? (
              <div className="w-reader-grid">
                <ReaderList title="读者买账的地方" items={digest.worked} tone="ok" onQuote={jump} />
                <ReaderList title="真问题" items={digest.problems} tone="warn" onQuote={jump} />
                <ReaderList title="意见分歧" items={digest.splits} />
                <ReaderList title="和你的意图有落差" items={digest.intentGaps} tone="tone" />
                {digest.actions.length ? (
                  <div className="w-reader-list">
                    <h4>建议动作</h4>
                    <ul>{digest.actions.map((action, actionIndex) => <li key={actionIndex}><span className="w-pill">{SCOPE_LABELS[action.scope]}</span> <b>{action.title}</b>{action.detail ? <span className="w-muted"> {action.detail}</span> : null} <AdoptButton exists={notebook.notes.some((note) => note.text === action.title)} onAdopt={() => void addNote(action)} /></li>)}</ul>
                  </div>
                ) : null}
              </div>
            ) : <p className="w-muted">这次没有生成汇总。<button type="button" className="w-link" disabled={digesting || progress !== null} onClick={() => void redigest()}>{digesting ? "正在汇总…" : "重新汇总"}</button></p>}
          </>
        ) : <p className="w-muted">读者小组里的每位读者（现在是{panel.map((item) => item.name).join("、")}）会单独读完这一章的正文，只带着读者该有的记忆：前情摘要和最近常出场的人物，看不到你的大纲和暗线。他们各自说还追不追，写段评，猜后面的剧情，说想看什么、哪里没看懂。最后由编辑对照你埋的线索、暗线和计划，汇总成问题和建议。读者小组在「设置 › 提示词 › 作家笔记 › 读者小组」里调整，每位读者一次模型调用，另加一次汇总。下面的内容直接从故事记忆推算，不调用模型。</p>}
      </section>

      {snapshot?.voices.length ? (
        <div className="w-reader-grid">
          {snapshot.voices.map((voice, voiceIndex) => <VoiceCard key={`${voice.persona}-${voiceIndex}`} voice={voice} onQuote={jump} onAdopt={(item) => void adoptExpectation(item)} onComment={(mark) => void addComment(voice.persona, mark)} />)}
        </div>
      ) : null}

      {knowledge ? (
        <div className="w-reader-grid">
          {knowledge.hook ? <section className="w-card"><h4>本章留给读者的钩子</h4><p>{knowledge.hook}</p></section> : null}
          {secrets.length ? (
            <section className="w-card">
              <h4>你知道、读者还不知道 · {secrets.length}</h4>
              <ul className="w-fact-list">
                {secrets.map(({ secret, partial }) => {
                  const revealAt = secret.readerRevealChapterId ? chapters.findIndex((chapter) => chapter.id === secret.readerRevealChapterId) : -1;
                  return <li key={secret.id}><b>{secret.title}</b>{partial ? <span className="w-muted">（已部分揭示）</span> : null}：{previewText(secret.truth, 120) || "（还没写下真相）"}{revealAt >= 0 ? <> · 计划在 <button type="button" className="w-link" onClick={() => onOpenChapter(chapters[revealAt].id)}>{chapterLabel(revealAt)}</button> 揭示</> : null}</li>;
                })}
              </ul>
            </section>
          ) : null}
          <section className="w-card">
            <h4>悬而未决 · {knowledge.openQuestions.length}</h4>
            {knowledge.openQuestions.length ? <ul className="w-fact-list">{knowledge.openQuestions.slice(0, 30).map((item) => <li key={item.thread.id}><b>{item.thread.title}</b>：{item.lastNote || item.thread.description} <button type="button" className="w-link" onClick={() => onOpenChapter(memory.orderedIds[item.plantedAt])}>{chapterLabel(item.plantedAt)}起</button></li>)}</ul> : <p className="w-muted">读者目前没有悬着的疑问。</p>}
          </section>
          {knowledge.resolved.length ? <section className="w-card"><h4>已经揭晓 · {knowledge.resolved.length}</h4><ul className="w-fact-list">{knowledge.resolved.slice(0, 20).map((item) => <li key={item.thread.id}><b>{item.thread.title}</b> <button type="button" className="w-link" onClick={() => onOpenChapter(memory.orderedIds[item.resolvedAt ?? item.lastAt])}>{chapterLabel(item.resolvedAt ?? item.lastAt)}</button></li>)}</ul></section> : null}
          <EntityCard title="读者认识的人物" items={knowledge.characters} onOpenChapter={onOpenChapter} orderedIds={memory.orderedIds} />
          {knowledge.fading.length ? <section className="w-card"><h4>可能已被淡忘</h4><p className="w-muted">这些人物或设定出场不少，但已经 30 章以上没出现；再登场时可能需要帮读者回忆一下。</p><ul className="w-fact-list">{knowledge.fading.map((item) => <li key={item.entity.id}><b>{item.entity.name}</b> 上次出现在 <button type="button" className="w-link" onClick={() => onOpenChapter(memory.orderedIds[item.lastSeen])}>{chapterLabel(item.lastSeen)}</button>（{knowledge.position - item.lastSeen} 章前）</li>)}</ul></section> : null}
          {knowledge.rules.length ? <section className="w-card"><h4>已交代的世界规则 · {knowledge.rules.length}</h4><ul className="w-fact-list">{knowledge.rules.slice(-30).map((fact, ruleIndex) => <li key={ruleIndex}><b>{fact.subject}</b>：{fact.value} <button type="button" className="w-link" onClick={() => onOpenChapter(memory.orderedIds[fact.position], fact.quote)}>{chapterLabel(fact.position)}</button></li>)}</ul></section> : null}
          <EntityCard title="读者见过的地点、势力与物品" items={knowledge.others} onOpenChapter={onOpenChapter} orderedIds={memory.orderedIds} />
          {knowledge.events.length ? <section className="w-card"><h4>近期关键事件</h4><ul className="w-fact-list">{knowledge.events.slice(-15).reverse().map((fact, eventIndex) => <li key={eventIndex}><button type="button" className="w-link" onClick={() => onOpenChapter(fact.chapterId, fact.quote)}>{chapterLabel(fact.position)}</button> {fact.subject}：{fact.value}</li>)}</ul></section> : null}
        </div>
      ) : null}
    </div>
  );
}

function VoiceCard({ voice, onQuote, onAdopt, onComment }: { voice: ReaderVoice; onQuote: (quote: string) => void; onAdopt: (item: ReaderItem) => void; onComment: (mark: ReaderMark) => void }) {
  return (
    <section className="w-card w-reader-voice">
      <div className="w-row"><h4>{voice.persona}</h4><span className={`w-pill ${VERDICT_TONES[voice.verdict]}`}>{READER_VERDICT_LABELS[voice.verdict]}</span></div>
      {voice.reason ? <p className="w-muted">{voice.reason}</p> : null}
      {voice.comment ? <p className="w-notebook-prose">{voice.comment}</p> : null}
      {voice.retell ? <p className="w-muted" title="凭记忆复述这一章；和本章实际对不上的地方，说明那里没写清楚">复述：{voice.retell}</p> : null}
      {voice.marks.length ? (
        <ul className="w-reader-marks">
          {voice.marks.map((mark, index) => (
            <li key={index} className={mark.tone}>
              {mark.quote ? <button type="button" className="w-reader-quote" title="在正文里找到这一句" onClick={() => onQuote(mark.quote)}>“{previewText(mark.quote, 30)}”</button> : null}
              <span>{mark.reaction}</span>
              {mark.tone === "down" && mark.quote ? <> <button type="button" className="w-link" title="把这条段评加为本章的批注" onClick={() => onComment(mark)}>加为批注</button></> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <ReaderList title="猜测" items={voice.guesses.map((title) => ({ title, detail: "" }))} />
      <ReaderList title="最想看到" items={voice.wants} onAdopt={onAdopt} />
      <ReaderList title="没看懂、记不清" items={voice.lost} tone="warn" />
    </section>
  );
}

function ReaderList({ title, items, tone, onQuote, onAdopt }: { title: string; items: (ReaderItem & { quote?: string })[]; tone?: "warn" | "tone" | "ok"; onQuote?: (quote: string) => void; onAdopt?: (item: ReaderItem) => void }) {
  if (!items.length) return null;
  return (
    <div className={`w-reader-list ${tone ?? ""}`}>
      <h4>{title}</h4>
      <ul>{items.map((item, index) => <li key={index}><b>{item.title}</b>{item.detail ? <span className="w-muted"> {item.detail}</span> : null}{item.quote && onQuote ? <> <button type="button" className="w-reader-quote" title="在正文里找到这一句" onClick={() => onQuote(item.quote as string)}>“{previewText(item.quote, 24)}”</button></> : null}{onAdopt ? <> <button type="button" className="w-link" title="登记为一条期待，之后的写作和体检会跟踪它" onClick={() => onAdopt(item)}>转为期待</button></> : null}</li>)}</ul>
    </div>
  );
}

function EntityCard({ title, items, orderedIds, onOpenChapter }: { title: string; items: KnownEntity[]; orderedIds: string[]; onOpenChapter: OpenChapter }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, 12);
  return (
    <section className="w-card">
      <h4>{title} · {items.length}</h4>
      <ul className="w-reader-entities">
        {shown.map((item) => (
          <li key={item.entity.id}>
            <div className="w-row small"><b>{item.entity.name}</b><span className="w-muted">{item.mentions} 次 · 最近</span><button type="button" className="w-link" onClick={() => onOpenChapter(orderedIds[item.lastSeen])}>{chapterLabel(item.lastSeen)}</button></div>
            {item.description ? <p>{item.description}</p> : null}
            {item.state.length ? <p className="w-muted">{item.state.slice(-6).map((fact) => `${fact.attribute}：${fact.value}`).join("；")}</p> : null}
          </li>
        ))}
      </ul>
      {items.length > 12 ? <button type="button" className="w-link" onClick={() => setAll(!all)}>{all ? "收起" : `展开全部 ${items.length} 个`}</button> : null}
    </section>
  );
}
