import { viewIsVisible } from "../../view";
import { Plus, X } from "lucide-react";
import { createPortal } from "react-dom";
import { dailyHost, localizeHostText } from "../../host";
import { observeTasks, taskIsActive, type TaskSnapshot } from "@daily/plugin-sdk";
import { submitWriterTask } from "../../worker/taskClient";
import type { AssistantTaskInput } from "../../worker/jobs";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { abandonRun, listPendingRuns, pendingInteraction, type AgentInteraction, type AgentRunResult, type PendingRunSummary } from "../../ai/agent";
import { friendlyAiError } from "../../ai/client";
import { looksLikeSettingMaterial } from "../../ai/pipelines/organizeSettings";
import { createSession, getSession, listSessions, removeAgentTool, stopSession } from "../../ai/sessions";
import { orderedChapters } from "../../domain/documents";
import { listSamples } from "../../storage/sampleStore";
import type { AgentEventView, AgentSession, AgentSessionSummary, WriterProposal } from "../../types";
import { Spinner } from "../common";
import type { EditorApi, EditorSelection } from "../editor/ManuscriptEditor";
import { ChapterPane } from "../margin/ChapterPane";
import { MarginNotes } from "../margin/MarginNotes";
import { ConflictNotes, HealthNotes } from "../margin/RoomNotes";
import type { MarginNotesApi } from "../margin/useMarginNotes";
import { StudioPlan } from "../studio/StudioPlan";
import { useWriter, type AssistTab, type ViewMode } from "../useWriter";
import { starterCommands, type AssistCommand } from "./commands";
import { Composer, type Mode, type Scope } from "./Composer";
import { EventList } from "./EventList";
import { InteractionCard } from "./InteractionCard";
import { Message, proposalOf } from "./Message";

let handledMessageNonce = 0;

type Props = {
  onClose: () => void;
  selection: EditorSelection;
  editorSelection: () => EditorSelection;
  onReveal: (key: string, quote?: string) => void;
  overlay?: boolean;
  /** Hiding or unmounting the panel only detaches it from background execution. */
  hidden?: boolean;
  room: ViewMode;
  planHost: HTMLElement | null;
  tab: AssistTab;
  onTab: (tab: AssistTab) => void;
  notesApi: MarginNotesApi;
  editorRef: React.RefObject<EditorApi | null>;
  pageScrollRef: React.RefObject<HTMLDivElement | null>;
  activeNote: string | null;
  onActiveNote: (id: string | null) => void;
  alignNotes: boolean;
  selectionPanel: ReactNode;
};

/** The margin: AI notes on the page, the conversation, and the chapter's own details, above one composer. */
export function AssistPanel({ onClose, selection, editorSelection, onReveal, overlay = false, hidden = false, room, planHost, tab, onTab, notesApi, editorRef, pageScrollRef, activeNote, onActiveNote, alignNotes, selectionPanel }: Props) {
  const writer = useWriter();
  const { project, memory, active } = writer;
  // `null` is a new conversation; the host session is created on the first message.
  const [session, setSession] = useState<AgentSession | null>(null);
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("agent");
  const [scopeOverride, setScopeOverride] = useState<Scope | null>(null);
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<AgentEventView[]>([]);
  const [refining, setRefining] = useState<WriterProposal | null>(null);
  const [pending, setPending] = useState<{ runId: string; interaction: AgentInteraction } | null>(null);
  const [orphanRuns, setOrphanRuns] = useState<PendingRunSummary[]>([]);
  const [sampleCount, setSampleCount] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const [task, setTask] = useState<TaskSnapshot | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const writerRef = useRef(writer);
  writerRef.current = writer;
  const projectId = project?.id;
  const studio = room === "studio";
  const inChapter = active.kind === "chapter";

  const hasSelection = Boolean(selection.text.trim());
  const defaultScope: Scope = room === "write" || studio ? (hasSelection && !studio ? "selection" : "chapter") : "book";
  const wanted = scopeOverride ?? defaultScope;
  const scope: Scope = wanted === "selection" && !hasSelection ? defaultScope === "selection" ? "chapter" : defaultScope : wanted;
  useEffect(() => { setScopeOverride(null); }, [hasSelection, room]);

  const request = writer.assistRequest;
  const sendRef = useRef<(text: string, forceMode?: Mode) => Promise<void>>(async () => undefined);
  const proposalsRef = useRef(writer.proposals);
  proposalsRef.current = writer.proposals;
  useEffect(() => {
    if (!request) return;
    onTab(request.tab);
    if (request.focus) globalThis.setTimeout(() => inputRef.current?.focus(), 0);
    // The panel may mount after the request was made; a message is delivered once per request.
    if (handledMessageNonce === request.nonce) return;
    handledMessageNonce = request.nonce;
    if (request.refineId) setRefining(proposalsRef.current.find((proposal) => proposal.id === request.refineId) ?? null);
    if (request.message) {
      const message = request.message;
      if (request.send) { setMode("agent"); globalThis.setTimeout(() => void sendRef.current(message, "agent"), 0); }
      else setInput(message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  useEffect(() => {
    if (!projectId) return;
    void (async () => {
      const list = await listSessions(projectId);
      setSessions(list);
      setSession(list[0] ? await getSession(list[0].id) : null);
      setOrphanRuns(await listPendingRuns(projectId));
    })();
    void listSamples(projectId).then((samples) => setSampleCount(samples.length)).catch(() => setSampleCount(0));
  }, [projectId]);

  useEffect(() => { if (followBottom.current) bottomRef.current?.scrollIntoView({ block: "end" }); }, [session?.entries.length, events.length, running, tab]);

  /** Re-reads the session (and the conversation list) after the host or Writer changed it. */
  const refresh = useCallback(async (sessionId: string) => {
    const next = await getSession(sessionId);
    setSession(next);
    if (projectId) setSessions(await listSessions(projectId));
    return next;
  }, [projectId]);

  const ensureSession = useCallback(async () => {
    if (session) return session;
    if (!projectId) throw new Error("没有打开的作品。");
    const created = await createSession(projectId);
    setSession(created);
    return created;
  }, [projectId, session]);

  useEffect(() => {
    if (!projectId) return;
    setTask(null); setPending(null); setEvents([]);
    let stopped = false;
    let lastState = "";
    const off = observeTasks({ scope: projectId, kind: "writer.assistant" }, (tasks) => {
      const selected = sessionRef.current?.id;
      const latest = [...tasks].sort((a, b) => b.cursor - a.cursor).find((item) => item.exclusiveKey === `assistant:${selected}`);
      if (!latest || stopped) return;
      setTask(latest);
      const progress = latest.progress as { eventViews?: AgentEventView[] } | null;
      if (progress?.eventViews) setEvents(progress.eventViews);
      const result = latest.result as AgentRunResult | null;
      setPending(latest.status === "waiting_input" && result?.status === "pending_interaction" ? { runId: result.runId, interaction: result.interaction } : null);
      const state = `${latest.id}:${latest.status}`;
      if (state !== lastState) {
        lastState = state;
        if (selected) void refresh(selected).catch(() => undefined);
        if (latest.status === "completed") {
          void writerRef.current.reloadProposals();
          void writerRef.current.refreshBackgroundResults();
          void writerRef.current.refreshMemory(true);
        }
      }
    }, (error) => writerRef.current.notify("error", friendlyAiError(error)));
    return () => { stopped = true; off(); };
  }, [projectId, refresh, session?.id]);

  const send = useCallback(async (text: string, forceMode?: Mode) => {
    if (!project || running || (task && taskIsActive(task))) return;
    const instruction = text.trim();
    if (!instruction) return;
    setRunning(true);
    try {
      await writer.flush();
      const draft = writer.getDraft();
      if (!draft) return;
      const current = await ensureSession();
      if (task?.status === "waiting_input") await dailyHost().tasks.cancel(task.id);
      if (pending) { await abandonRun(pending.runId); setPending(null); }
      let useMode = forceMode ?? mode;
      if (useMode === "agent" && looksLikeSettingMaterial(instruction)) useMode = "organize";
      const material = instruction.length >= 200 ? instruction : [...current.entries].reverse().find((entry) => entry.role === "user" && entry.content.length >= 400)?.content;
      if (useMode === "organize" && !material) throw new Error("请把设定稿粘贴到输入框，在“整理设定稿”模式下发送。");
      if (useMode === "qa" && (!memory || memory.isEmpty)) throw new Error("问全书需要先在“档案”里建立故事记忆。");
      const selected = scope === "selection" ? editorSelection() : null;
      const input: AssistantTaskInput = {
        project: draft.project, texts: draft.texts, sessionId: current.id, mode: useMode,
        instruction: scope === "book" ? `（全书范围）${instruction}` : instruction,
        material, activeDoc: active,
        selection: selected?.text ? { doc: active, start: selected.from, end: selected.to, text: selected.text } : null,
        supersedes: refining,
      };
      const submitted = await submitWriterTask("writer.assistant", project.id, input, `assistant:${current.id}`);
      setTask(submitted); setInput(""); setEvents([]); setRefining(null);
      if (!studio) onTab("chat");
      if (mode === "organize") setMode("agent");
    } catch (error) { writer.notify("error", friendlyAiError(error)); }
    finally { setRunning(false); }
  }, [active, editorSelection, ensureSession, memory, mode, onTab, pending, project, refining, running, scope, studio, task, writer]);
  sendRef.current = send;

  const answer = useCallback(async (result: unknown, ok: boolean) => {
    if (!task || task.status !== "waiting_input") return;
    try { setTask(await dailyHost().tasks.resume(task.id, { result, ok })); setPending(null); }
    catch (error) { writer.notify("error", friendlyAiError(error)); }
  }, [task, writer]);

  const continueRun = useCallback(async (runId: string) => {
    try {
      if (task && ["failed", "interrupted", "cancelled"].includes(task.status)) {
        setTask(await dailyHost().tasks.retry(task.id));
      } else if (project && session) {
        await writer.flush();
        const draft = writer.getDraft();
        if (!draft) return;
        setTask(await submitWriterTask("writer.assistant", project.id, { project: draft.project, texts: draft.texts, sessionId: session.id, instruction: "继续", activeDoc: active, selection: null, mode: "agent", runId } satisfies AssistantTaskInput, `assistant:${session.id}`));
      }
    } catch (error) { writer.notify("error", friendlyAiError(error)); }
  }, [active, project, session, task, writer]);

  const dismiss = useCallback(async (runId: string) => {
    if (task?.status === "waiting_input") await dailyHost().tasks.cancel(task.id);
    await abandonRun(runId);
    setPending(null);
    if (session) await refresh(session.id).catch(() => undefined);
  }, [refresh, session, task]);

  const background = Boolean(session?.running) && !(task && taskIsActive(task));
  const busy = running || background || Boolean(task && taskIsActive(task));
  const sessionId = session?.id;
  useEffect(() => {
    if (!background || !sessionId) return;
    const timer = globalThis.setInterval(() => { if (viewIsVisible()) void refresh(sessionId).catch(() => undefined); }, 2_000);
    return () => globalThis.clearInterval(timer);
  }, [background, refresh, sessionId]);

  const stop = useCallback(() => {
    if (task && taskIsActive(task)) void dailyHost().tasks.cancel(task.id).then(setTask).catch((error) => writer.notify("error", friendlyAiError(error)));
    if (sessionId) void stopSession(sessionId).catch(() => undefined);
  }, [sessionId, task, writer]);

  /** The author message an error reply answered, so "retry" resends the real request. */
  const retryTextFor = useCallback((entryId: string) => {
    const entries = session?.entries ?? [];
    for (let index = entries.findIndex((entry) => entry.id === entryId) - 1; index >= 0; index -= 1) if (entries[index].role === "user") return entries[index].content;
    return "";
  }, [session]);

  const proposals = useMemo(() => new Map(writer.proposals.map((proposal) => [proposal.id, proposal])), [writer.proposals]);
  const pendingCount = useMemo(() => writer.proposals.filter((proposal) => proposal.status === "pending").length, [writer.proposals]);
  if (!project) return null;

  const applyCommand = (command: AssistCommand) => {
    if (command.mode === "qa" || command.mode === "organize") { setMode(command.mode); setInput(""); }
    else { setMode("agent"); setInput(command.instruction); }
    if (command.label === "写下一章") writer.setView("studio");
    if (!studio) onTab("chat");
    globalThis.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const reveal = (key: string) => onReveal(key);
  const lastEntryId = session?.entries[session.entries.length - 1]?.id;
  const coverage = memory && !memory.isEmpty ? memory.coverage() : null;
  const memoryText = coverage ? `记忆 ${coverage.fresh}/${coverage.total} 章` : "未建立记忆";
  const samples = sampleCount ? ` · 样章 ${sampleCount}` : "";
  const reading = mode === "qa" ? memoryText : scope === "selection" ? `读着 选区 ${selection.text.length} 字${samples}` : scope === "chapter" ? `读着 ${inChapter ? "本章" : "本文"}${samples} · ${memoryText}` : `读着 全书 · ${memoryText}`;
  const notesCount = room === "write" ? notesApi.notes.length + pendingCount : room === "archive" ? memory?.conflicts.filter((conflict) => conflict.status === "open").length ?? 0 : notesApi.health.length;
  const tabs: { value: AssistTab; label: string }[] = [
    { value: "notes", label: `${room === "story" ? "体检" : room === "archive" ? "矛盾" : "朱批"}${notesCount ? ` ${notesCount}` : ""}` },
    { value: "chat", label: "对谈" },
    ...(room === "write" ? [{ value: "chapter" as const, label: inChapter ? "本章" : "本文" }] : []),
  ];
  const showTab = studio ? "chat" : tab === "chapter" && room !== "write" ? "notes" : tab;
  const chapterCount = orderedChapters(project).length;

  const thread = (
    <>
      <div className="w-thread-bar">
        <select className="w-select small" aria-label="对话" value={session?.id ?? ""} disabled={busy} onChange={async (event) => { const id = event.currentTarget.value; if (id) { setPending(null); setSession(await getSession(id)); } }}>
          {!session ? <option value="">新对话</option> : null}
          {sessions.map((item) => <option key={item.id} value={item.id}>{localizeHostText(item.title, "zh-CN")}</option>)}
        </select>
        <button type="button" className="w-icon-btn small" title="新对话" aria-label="新对话" disabled={busy} onClick={() => { setSession(null); setPending(null); }}><Plus size={14} /></button>
      </div>
      {session?.agentTools?.length ? (
        <div className="w-thread-bar small" title="写作助手在这个对话里创建的子 agent，后续消息可以继续调用">
          <span className="w-muted">子 agent：</span>
          {session.agentTools.map((agent) => (
            <span key={agent.id} className="w-pill tone" title={agent.description || agent.instructions}>
              {agent.name}
              <button type="button" className="w-link" aria-label={`删除子 agent ${agent.name}`} disabled={busy} onClick={async () => { await removeAgentTool(session.id, agent.id); await refresh(session.id); }} title={`删除子 agent ${agent.name}`}>×</button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="w-thread" ref={threadRef} onScroll={() => { const el = threadRef.current; if (el) followBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {orphanRuns.length && !pending ? orphanRuns.map((run) => (
          <div key={run.runId} className="w-callout">
            <span>有一个未完成的 AI 任务：{run.instruction.slice(0, 40)}</span>
            <button type="button" className="w-btn small" disabled={busy} onClick={async () => {
              if (run.sessionId && run.sessionId !== session?.id) setSession(await getSession(run.sessionId));
              if (run.kind === "checkpoint") { void continueRun(run.runId); return; }
              const interaction = await pendingInteraction(run.runId);
              if (interaction) setPending({ runId: run.runId, interaction });
              setOrphanRuns((list) => list.filter((item) => item.runId !== run.runId));
            }}>继续</button>
            <button type="button" className="w-btn small ghost" onClick={async () => { await dismiss(run.runId); setOrphanRuns((list) => list.filter((item) => item.runId !== run.runId)); }}>放弃</button>
          </div>
        )) : null}
        {!session?.entries.length ? (
          <div className="w-assist-intro">
            <p>它读过这部作品{coverage ? `（${coverage.fresh}/${chapterCount} 章）` : ""}，正文照样章的文风写。所有修改都先落在稿纸上，由你逐处决定。</p>
            <div className="w-chips">{starterCommands(inChapter).map((command) => <button key={command.label} type="button" className="w-chip-square" disabled={busy} onClick={() => applyCommand(command)}>{command.label}</button>)}</div>
          </div>
        ) : null}
        {session?.entries.map((entry) => (
          <Message key={entry.id} entry={entry} live={busy && entry.id === lastEntryId} proposal={proposalOf(entry, proposals)} onRefine={(proposal) => { setRefining(proposal); inputRef.current?.focus(); }} onReveal={reveal} onLink={(key) => onReveal(key)}
            onRetry={busy || !retryTextFor(entry.id) ? undefined : () => void send(retryTextFor(entry.id))}
            onContinue={busy || !entry.run?.runId || entry.id !== lastEntryId ? undefined : () => void continueRun(entry.run?.runId ?? "")}
            onAbandon={busy || !entry.run?.runId ? undefined : () => void dismiss(entry.run?.runId ?? "")} />
        ))}
        {pending ? <InteractionCard interaction={pending.interaction} busy={running} onAnswer={(result, ok) => void answer(result, ok)} onDismiss={() => void dismiss(pending.runId)} /> : null}
        {task && taskIsActive(task) ? <EventList events={events} /> : null}
        {task && ["failed", "interrupted", "cancelled"].includes(task.status) ? <div className="w-callout"><span>{localizeHostText(task.error ?? "Task interrupted.", "zh-CN")}</span><button type="button" className="w-btn small" disabled={busy} onClick={() => void continueRun("")}>从断点继续</button></div> : null}
        {background ? <div className="w-events" role="status"><div className="w-events-head"><Spinner size={12} />AI 仍在后台处理上一条消息… <button type="button" className="w-link" onClick={stop}>停止</button></div></div> : null}
        <div ref={bottomRef} />
      </div>
    </>
  );

  return (
    <aside className={`w-assist ${overlay ? "overlay" : ""} ${studio ? "studio" : ""} ${hidden ? "w-hidden" : ""}`} aria-label={studio ? "对谈" : "页边"}>
      {studio ? null : (
        <div className="w-margin-tabs" role="tablist" aria-label="页边内容">
          {tabs.map((item) => <button key={item.value} type="button" role="tab" tabIndex={showTab === item.value ? 0 : -1} onKeyDown={event => { const index = tabs.indexOf(item); const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1; if (next < 0) return; event.preventDefault(); onTab(tabs[next].value); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus(); }} aria-selected={showTab === item.value} className={showTab === item.value ? "active" : ""} onClick={() => onTab(item.value)}>{item.label}</button>)}
          <button type="button" className="w-icon-btn" title="关闭页边 ⌘I" aria-label="关闭页边" onClick={onClose}><X size={16} /></button>
        </div>
      )}
      <div className="w-margin-body">
        {showTab === "chat" ? thread : null}
        {showTab === "notes" && room === "write" ? <MarginNotes api={notesApi} editorRef={editorRef} pageScrollRef={pageScrollRef} activeNote={activeNote} onActiveNote={onActiveNote} aligned={alignNotes} onReveal={reveal} /> : null}
        {showTab === "notes" && room === "story" ? <HealthNotes onOpenChapter={(id, quote) => onReveal(`chapter:${id}`, quote)} /> : null}
        {showTab === "notes" && room === "archive" ? <ConflictNotes onOpenChapter={(id, quote) => onReveal(`chapter:${id}`, quote)} /> : null}
        {showTab === "chapter" && room === "write" ? <ChapterPane editorRef={editorRef} /> : null}
        {selectionPanel}
      </div>
      <div className="w-composer-wrap">
        {refining ? <div className="w-composer-note">正在改进「{refining.title}」<button type="button" className="w-link" onClick={() => setRefining(null)}>取消</button></div> : null}
        {mode !== "agent" ? <div className="w-composer-note">{mode === "qa" ? "问全书" : "整理设定稿"}<button type="button" className="w-link" onClick={() => setMode("agent")}>退出</button></div> : null}
        {showTab === "chat" && hasSelection && room === "write" && mode === "agent" ? <div className="w-composer-note">针对选中的 {selection.text.length} 字<button type="button" className="w-link" onClick={() => onTab("notes")}>快捷改写</button></div> : null}
        <Composer inputRef={inputRef} value={input} onChange={setInput} running={busy} mode={mode} scope={scope} onScope={setScopeOverride} hasSelection={hasSelection} inChapter={inChapter} reading={reading} onCommand={applyCommand} onSubmit={() => { followBottom.current = true; void send(input); }} onStop={stop}
          placeholder={mode === "organize" ? "把设定稿粘贴到这里（可以很长），可在末尾写上整理要求，然后发送" : mode === "qa" ? "问关于全书的问题，答案带章节出处" : refining ? "说说哪里需要调整，例如：再短一点，保留第二段" : "问一句，或让它动笔"} />
      </div>
      {studio && planHost ? createPortal(<StudioPlan session={session} running={busy} events={events} waiting={Boolean(pending)} onSend={(text) => void send(text, "agent")} />, planHost) : null}
    </aside>
  );
}
