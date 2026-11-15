// Deep channel: multi-step agent over host `agent.task`, editing a draft copy and producing a reviewable proposal.
import { applyAgentEventViewPatches, dailyHost, subscribeAgentProgress } from "../host";
import { docTitle, orderedChapters, readDoc } from "../domain/documents";
import { uniqueId } from "../domain/ids";
import { coalesceTextChanges } from "../domain/proposals";
import { arrayValue, asRecord, previewText, stringArray, stringValue, unixTimestamp } from "../domain/util";
import type { MemoryView } from "../memory/view";
import { readJson, removeFile, writeJson, listEntries } from "../storage/io";
import { RUNS_DIR } from "../storage/paths";
import type { AgentTaskResumeRequest, AgentTaskStartRequest } from "@daily/plugin-sdk";
import type { AgentEventView, AgentTaskResponse, ChapterTexts, DocRef, WriterComment, WriterProject, WriterProposal } from "../types";
import { READ_TOOL_IDS, TOOL_HANDLERS, type AgentSelection, type RunState, type ToolOutcome } from "./agentTools";
import { isTransientAiError } from "./client";
import { modelFor } from "./models";
import type { AgentDisplay, ConventionSuggestion } from "./sessions";
import { craftTopic } from "./craft";
import { agentSystem, writingGoal } from "./prompts";
import { prepareWritingContext } from "./contextPrep";
import { AGENT_SAMPLE_BUDGET, styleSamplesText } from "./styleSamples";
import { INTERACTION_TOOLS, writerTools } from "./tools";
import { taskContext, taskRpc, toolTaskSignal } from "../worker/taskClient";

export type AgentInput = {
  project: WriterProject;
  memory: MemoryView | null;
  texts: ChapterTexts;
  /** Host agent session; the host records this turn and replays earlier turns with their tool calls. */
  sessionId: string;
  instruction: string;
  activeDoc: DocRef;
  selection: AgentSelection;
  /** When refining, the proposal being replaced. */
  supersedes?: WriterProposal | null;
  /** Stops the run before the next step; the run keeps its checkpoint and can be continued. */
  signal?: AbortSignal;
};

export type { AgentSelection } from "./agentTools";

export type AskQuestion = { id: string; question: string; options: { id: string; label: string; description?: string }[] };
export type AgentInteraction = { type: "ask_user"; questions: AskQuestion[] };
export type AgentRunResult =
  | { status: "completed"; sessionId: string; entryId: string | null; reply: string; proposal: WriterProposal | null; comments: WriterComment[]; displays: AgentDisplay[]; conventions: ConventionSuggestion[]; eventViews: AgentEventView[]; supersedes: string | null; limitNotice?: string }
  | { status: "pending_interaction"; runId: string; projectId: string; sessionId: string; entryId: string | null; interaction: AgentInteraction; pendingMessage: string; displays: AgentDisplay[]; eventViews: AgentEventView[] }
  /** Stopped by the author; continue it with `continueFromCheckpoint`. */
  | { status: "paused"; runId: string; sessionId: string; eventViews: AgentEventView[] };

/** A run that failed after leaving a checkpoint; `continueFromCheckpoint(runId)` picks it up. */
export class ResumableRunError extends Error {
  constructor(readonly runId: string, readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original));
    this.name = "ResumableRunError";
  }
}

type Delivery = { ok: boolean; result: unknown; observation: string };
/**
 * Writer's half of a checkpoint, next to the host's: the draft as of the pending tool call.
 * `delivered` is set once that tool ran, so continuing never applies its edits twice.
 */
type Checkpoint = RunState & { runId: string; createdAt: number; interaction?: AgentInteraction; delivered?: Delivery };
type Listener = (views: AgentEventView[]) => void;

/** The host enforces the real cap and reports it back; this only asks for the maximum. */
const MAX_ITERATIONS = 1_000;
const RUN_TTL_SECONDS = 7 * 24 * 3600;
const MAX_SAME_FAILURES = 3;

export async function runAgent(input: AgentInput, onEvents: Listener, memory: MemoryView | null = input.memory): Promise<AgentRunResult> {
  const positions = orderedChapters(input.project).map((chapter) => chapter.id);
  const position = input.activeDoc.kind === "chapter" ? Math.max(0, positions.indexOf(input.activeDoc.id)) : positions.length;
  const focus = input.selection?.text || (input.activeDoc.kind === "chapter" ? input.texts[input.activeDoc.id] ?? "" : readDoc(input.project, input.texts, input.activeDoc) ?? "");
  const [context, samples, model] = await Promise.all([
    prepareWritingContext({ project: input.project, memory, position, focus: `${input.instruction}\n${previewText(focus, 4_000)}`, texts: input.texts, scope: "chapter", budget: Math.min(32_000, input.project.settings.contextBudgetChars) }),
    styleSamplesText(input.project, AGENT_SAMPLE_BUDGET),
    modelFor("assistant"),
  ]);
  let state: RunState = { projectId: input.project.id, sessionId: input.sessionId, instruction: input.instruction, supersedes: input.supersedes?.id ?? null, draft: structuredClone(input.project), base: { ...input.texts }, texts: { ...input.texts }, changes: [], comments: [], displays: [], eventViews: [], selection: input.selection, activeDoc: input.activeDoc };
  let payload: AgentTaskStartRequest = {
    systemPrompt: agentSystem(input.project),
    userPrompt: agentUserPrompt(input),
    finalInstructions: FINAL_INSTRUCTIONS,
    // Sub-agents see these context blocks too, so a drafting agent gets the goal and samples without being told.
    context: [{ title: "创作目标", content: writingGoal(input.project) }, { title: "写作上下文（记忆检索结果；供查证，不照搬进正文）", content: context.text }, ...(samples ? [{ title: "样章", content: samples }] : [])],
    tools: writerTools(),
    subAgents: { allowCreate: true },
    maxIterations: MAX_ITERATIONS,
    maxOutputTokens: 8_192,
    requireToolBeforeFinal: false,
    continueOnToolError: true,
    sessionId: input.sessionId,
    displayMessage: input.instruction,
    messageMeta: { kind: "text" },
    // The host keeps this model for resumes and retries of the task.
    ...(model ? { model } : {}),
  };
  const jobContext = taskContext(input.signal);
  const saved = asRecord(jobContext?.checkpoint);
  if (saved.stage === "start" && saved.payload && saved.state) {
    payload = saved.payload as AgentTaskStartRequest;
    state = saved.state as RunState;
  } else if (jobContext) {
    await jobContext.update({ checkpoint: { stage: "start", payload, state } });
  }
  return withProgress(state, onEvents, async (streamId) => {
    let response: AgentTaskResponse;
    try {
      response = await taskRpc<AgentTaskResponse>(input.signal, "agent.task.start", { ...payload, streamId }, "agent-start");
    } catch (error) {
      // A failed first request leaves a host checkpoint on the session run; keep the draft next to it.
      // Without one, the older checkpoints stay: they still carry the approved plan.
      const runId = await failedRunId(input.sessionId).catch(() => null);
      if (!runId) throw error;
      await dropSessionCheckpoints(input.project.id, input.sessionId);
      await saveCheckpoint(state, runId);
      await jobContext?.update({ checkpoint: { stage: "agent", runId } });
      throw new ResumableRunError(runId, error);
    }
    await dropSessionCheckpoints(input.project.id, input.sessionId);
    return continueRun(state, response, onEvents, memory, streamId, input.signal);
  }, input.signal);
}

/** Delivers the author's answer to a task waiting on askUser. */
export async function resumeAgent(runId: string, result: unknown, ok: boolean, onEvents: Listener, memory: MemoryView | null, signal?: AbortSignal): Promise<AgentRunResult> {
  const checkpoint = await loadCheckpoint(runId);
  if (!checkpoint) throw new Error("这个 AI 任务已过期或已被处理。");
  const state = stateOf(checkpoint);
  const delivery: Delivery = { ok, result, observation: answerObservation(result, ok) };
  await saveCheckpoint(state, runId, { delivered: delivery });
  return withProgress(state, onEvents, async (streamId) => {
    const response = await deliver(runId, delivery, streamId, signal);
    return continueRun(state, response, onEvents, memory, streamId, signal, runId);
  }, signal);
}

/**
 * Continues a failed, stopped or interrupted run from its last checkpoint: the host replays the
 * failed request or hands back the unanswered tool call, and the draft edits made so far are kept.
 */
export async function continueFromCheckpoint(runId: string, onEvents: Listener, memory: MemoryView | null, signal?: AbortSignal, sessionId?: string): Promise<AgentRunResult> {
  const checkpoint = await loadCheckpoint(runId) ?? (sessionId ? await adoptSessionCheckpoint(runId, sessionId) : null);
  if (!checkpoint) throw new Error("找不到这个任务的断点（可能已过期或已被新消息取代），请重新发送。");
  const state = stateOf(checkpoint);
  return withProgress(state, onEvents, async (streamId) => {
    let response = checkpoint.delivered && taskContext(signal)
      ? await deliver(runId, checkpoint.delivered, streamId, signal)
      : await taskRpc<AgentTaskResponse>(signal, "agent.task.retry", { runId, streamId }, `agent-retry-${runId}`);
    // The tool already ran before the interruption: send its result instead of running it again.
    if (response.status === "tool_call" && response.runId === runId && checkpoint.delivered && !taskContext(signal)) {
      response = await deliver(runId, checkpoint.delivered, streamId, signal);
    }
    return continueRun(state, response, onEvents, memory, streamId, signal, runId);
  }, signal);
}

/** Ends a run waiting on the author or a checkpoint; the host drops it too. */
export async function abandonRun(runId: string) {
  await dailyHost().agent.task.cancel(runId).catch(() => undefined);
  await removeFile(runPath(runId));
}

export type PendingRunSummary = { runId: string; sessionId: string; instruction: string; createdAt: number; kind: "interaction" | "checkpoint" };

export async function listPendingRuns(projectId: string): Promise<PendingRunSummary[]> {
  const runs: PendingRunSummary[] = [];
  const now = unixTimestamp();
  for (const entry of await listEntries(RUNS_DIR)) {
    if (entry.isDirectory || !entry.name.endsWith(".json")) continue;
    const run = asRecord(await readJson(`${RUNS_DIR}/${entry.name}`).catch(() => undefined));
    const createdAt = typeof run.createdAt === "number" ? run.createdAt : 0;
    if (now - createdAt > RUN_TTL_SECONDS) {
      if (typeof run.runId === "string") await dailyHost().agent.task.cancel(run.runId).catch(() => undefined);
      await removeFile(`${RUNS_DIR}/${entry.name}`);
      continue;
    }
    if (run.projectId === projectId && typeof run.runId === "string") runs.push({ runId: run.runId, sessionId: stringValue(run.sessionId), instruction: stringValue(run.instruction), createdAt, kind: run.interaction ? "interaction" : "checkpoint" });
  }
  return runs.sort((left, right) => right.createdAt - left.createdAt);
}

export async function pendingInteraction(runId: string): Promise<AgentInteraction | null> {
  return (await loadCheckpoint(runId))?.interaction ?? null;
}

/** Streams the host's live step updates into `state.eventViews` while `run` is in flight. */
async function withProgress(state: RunState, onEvents: Listener, run: (streamId: string) => Promise<AgentRunResult>, signal?: AbortSignal): Promise<AgentRunResult> {
  const streamId = taskContext(signal)?.task.id ?? uniqueId("stream");
  onEvents(state.eventViews);
  const unsubscribe = subscribeAgentProgress(streamId, (patches) => {
    state.eventViews = applyAgentEventViewPatches(state.eventViews, patches);
    onEvents(state.eventViews);
  });
  try {
    return await run(streamId);
  } finally {
    unsubscribe();
  }
}

async function continueRun(state: RunState, first: AgentTaskResponse, onEvents: Listener, memory: MemoryView | null, streamId: string, signal?: AbortSignal, previousRunId?: string): Promise<AgentRunResult> {
  let current = first;
  let checkpointId = previousRunId;
  const seen = new Map<string, number>();
  const failures = new Map<string, number>();
  const advance = async (next: AgentTaskResponse) => {
    current = next;
    mergeEvents(state, current.eventViews);
    onEvents(state.eventViews);
    // Each pause gets a new host run id; the older checkpoint is superseded.
    const nextId = current.status === "tool_call" ? current.runId : undefined;
    if (checkpointId && checkpointId !== nextId) await removeFile(runPath(checkpointId));
    checkpointId = nextId;
  };
  await advance(first);
  try {
    // The host caps model iterations (maxIterations) and forces a final answer at the limit.
    for (;;) {
      if (current.status === "completed") return finish(state, current, current.value ?? current.text);
      const runId = current.runId;
      if (INTERACTION_TOOLS.has(current.toolId)) {
        const interaction = toInteraction(current.input);
        await saveCheckpoint(state, runId, { interaction });
        return { status: "pending_interaction", runId, projectId: state.projectId, sessionId: state.sessionId, entryId: current.entryId ?? null, interaction, pendingMessage: current.pendingMessage, displays: state.displays, eventViews: state.eventViews };
      }
      await saveCheckpoint(state, runId);
      await taskContext(signal)?.update({ checkpoint: { stage: "agent", runId } });
      if (signal?.aborted) return { status: "paused", runId, sessionId: state.sessionId, eventViews: state.eventViews };
      let outcome: ToolOutcome;
      let ok = true;
      const signature = `${current.toolId}:${JSON.stringify(current.input)}`;
      const repeated = (seen.get(signature) ?? 0) + 1;
      seen.set(signature, repeated);
      if (repeated > 1 && READ_TOOL_IDS.has(current.toolId)) {
        outcome = { observation: `${current.toolId} 已用相同参数调用过 ${repeated - 1} 次，期间草稿没变，结果相同。直接用已有信息往下做。` };
      } else {
        try { outcome = await executeTool(state, current.toolId, asRecord(current.input), memory, toolTaskSignal(signal, runId)); }
        catch (error) {
          ok = false;
          const message = error instanceof Error ? error.message : String(error);
          const failed = (failures.get(`${current.toolId}:${message}`) ?? 0) + 1;
          failures.set(`${current.toolId}:${message}`, failed);
          // A model that keeps retrying a call the run state rejects would otherwise loop up to the host's cap.
          if (failed > MAX_SAME_FAILURES) throw new Error(`${current.toolId} 连续 ${failed} 次因同一原因失败，已停止：${message}`);
          outcome = { observation: `工具执行失败：${message}${failed > 1 ? `\n（同样的失败已出现 ${failed} 次，换一种做法，或在最终回复里向作者说明。）` : ""}` };
        }
      }
      // A change to the draft can make a repeated read or a failed call turn out differently.
      if (ok && !READ_TOOL_IDS.has(current.toolId)) { seen.clear(); failures.clear(); }
      const delivery: Delivery = { ok, result: outcome.result ?? {}, observation: outcome.observation };
      await saveCheckpoint(state, runId, { delivered: delivery });
      await taskContext(signal)?.update({ checkpoint: { stage: "agent", runId } });
      // Stopped while the tool ran: continuing later sends the saved result.
      if (signal?.aborted) return { status: "paused", runId, sessionId: state.sessionId, eventViews: state.eventViews };
      await advance(await deliver(runId, delivery, streamId, signal));
    }
  } catch (error) {
    // The checkpoint stays (host and Writer), so the author can continue from the failed step.
    if (checkpointId && !(error instanceof ResumableRunError)) throw new ResumableRunError(checkpointId, error);
    throw error;
  }
}

/** Sends a tool result; one transient failure is retried from the host's checkpoint. */
async function deliver(runId: string, delivery: Delivery, streamId: string, signal?: AbortSignal): Promise<AgentTaskResponse> {
  const request: AgentTaskResumeRequest = { runId, ok: delivery.ok, result: delivery.result, observation: delivery.observation, streamId };
  try { return await taskRpc<AgentTaskResponse>(signal, "agent.task.resume", request, `agent-resume-${runId}`); }
  catch (error) {
    if (!isTransientAiError(error)) throw error;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 2_000));
    // The host kept the failed resume; retry replays it.
    return taskRpc<AgentTaskResponse>(signal, "agent.task.retry", { runId, streamId }, `agent-retry-${runId}`);
  }
}

async function finish(state: RunState, response: Extract<AgentTaskResponse, { status: "completed" }>, value: unknown): Promise<AgentRunResult> {
  const record = asRecord(typeof value === "string" ? tryJson(value) : value);
  const reply = stringValue(record.reply) || stringValue(record.summary) || (typeof value === "string" && !record.reply ? value : "");
  const changes = coalesceTextChanges(state.changes);
  const proposal: WriterProposal | null = changes.length ? {
    id: uniqueId("proposal"),
    title: stringValue(record.title) || "AI 修改建议",
    instruction: state.instruction,
    summary: stringValue(record.summary) || reply,
    previewMarkdown: stringValue(record.previewMarkdown),
    risks: stringArray(record.risks, 20),
    changes,
    status: "pending",
    createdAt: unixTimestamp(),
    appliedAt: null,
    appliedChangeIds: [],
    undo: null,
    conversationId: state.sessionId,
    source: null,
  } : null;
  return { status: "completed", sessionId: state.sessionId, entryId: response.entryId ?? null, reply: reply || (proposal ? proposal.summary : "完成。"), proposal, comments: state.comments, displays: state.displays, conventions: conventionsOf(record.conventions), eventViews: state.eventViews, supersedes: state.supersedes, limitNotice: response.limitNotice };
}

async function executeTool(state: RunState, toolId: string, input: Record<string, unknown>, memory: MemoryView | null, signal?: AbortSignal): Promise<ToolOutcome> {
  const handler = TOOL_HANDLERS[toolId];
  if (!handler) throw new Error(`未知工具 ${toolId}`);
  return handler({ state, input, memory, signal });
}

function agentUserPrompt(input: AgentInput) {
  const doc = docTitle(input.project, input.activeDoc);
  const selection = input.selection ? `\n【作者选中的文字】（可用 replaceText 的 useSelection 替换）\n${previewText(input.selection.text, 2_000)}` : "";
  const refine = input.supersedes ? `\n【要重做的上一版建议】${input.supersedes.title}：${input.supersedes.summary}（从当前原稿出发按新要求重做）` : "";
  return `【当前文档】${doc}${input.activeDoc.kind === "chapter" ? `（chapterId=${input.activeDoc.id}）` : ""}${selection}${refine}\n（之前几轮没被采纳的建议不作数，以当前原稿和设定为准。）\n【作者的要求】${input.instruction}`;
}

const FINAL_INSTRUCTIONS = `最终输出一个 JSON 对象：
{"reply":"对作者说的话（Markdown，先说改了什么或发现了什么，再说理由和下一步；用平常的话，保留必要的人名、事实、因果和不确定的地方，不为缩短而省掉解释）","title":"若有修改：一句话说这份提案改什么","summary":"若有修改：改了哪里，读者会更清楚什么，事情怎样往前走了","risks":["需要作者留意的地方：伏笔接不接得上、人物是否知道得太多、后面会不会出问题；没有就填空数组"],"conventions":[{"topic":"写作方法目录里的 id","text":"这本书以后照着做的写法约定","plan":"怎么做、用在哪"}]}
conventions 只在作者明确表达了值得长期遵守的个人写法偏好时提供，通常为空数组；作者采纳后才会记进笔记。`;

/** Craft conventions the assistant suggests recording; unknown topics are dropped. */
function conventionsOf(value: unknown): ConventionSuggestion[] {
  return arrayValue(value).flatMap((item) => {
    const record = asRecord(item);
    const topic = craftTopic(record.topic);
    const text = stringValue(record.text).trim();
    return topic && text ? [{ topic, text, plan: stringValue(record.plan).trim() }] : [];
  }).slice(0, 5);
}

function toInteraction(value: unknown): AgentInteraction {
  const questions = arrayValue(asRecord(value).questions).map((item, index) => {
    const record = asRecord(item);
    return { id: stringValue(record.id) || `q${index + 1}`, question: stringValue(record.question) || "请选择", options: arrayValue(record.options).map((option, optionIndex) => { const entry = asRecord(option); return { id: stringValue(entry.id) || `o${optionIndex + 1}`, label: stringValue(entry.label) || `选项${optionIndex + 1}`, description: stringValue(entry.description) || undefined }; }) };
  });
  return { type: "ask_user", questions };
}

/** What the agent reads back after the author answered. */
function answerObservation(result: unknown, ok: boolean): string {
  return `${ok ? "作者已回复" : "作者要求调整"}：\n${JSON.stringify(result, null, 2)}`;
}

function mergeEvents(state: RunState, views: AgentEventView[] | undefined) {
  for (const view of views ?? []) {
    const index = state.eventViews.findIndex((item) => item.id === view.id);
    if (index >= 0) state.eventViews[index] = view; else state.eventViews.push(view);
  }
}

function runPath(runId: string) { return `${RUNS_DIR}/${runId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`; }

/** Saves the run state under `runId`, keeping only the chapter texts the run changed. */
async function saveCheckpoint(state: RunState, runId: string, extra: { interaction?: AgentInteraction; delivered?: Delivery } = {}) {
  const changed = Object.keys(state.texts).filter((id) => state.texts[id] !== state.base[id]);
  const pick = (texts: ChapterTexts) => Object.fromEntries(changed.filter((id) => texts[id] !== undefined).map((id) => [id, texts[id]]));
  const checkpoint: Checkpoint = { ...state, texts: pick(state.texts), base: pick(state.base), runId, createdAt: unixTimestamp(), ...extra };
  await writeJson(runPath(runId), checkpoint);
}

async function loadCheckpoint(runId: string): Promise<Checkpoint | null> {
  const value = await readJson(runPath(runId)).catch(() => undefined);
  return value ? value as Checkpoint : null;
}

/** Unchanged chapters were left out of the checkpoint; `docText` reloads them on demand. */
function stateOf(checkpoint: Checkpoint): RunState {
  const { runId: _id, createdAt: _created, interaction: _interaction, delivered: _delivered, ...state } = checkpoint;
  return state;
}

/**
 * A run the host carried on while Writer was not following it (the bridge request timed out)
 * pauses under a run id Writer never saw. Its state is the session's latest Writer checkpoint,
 * whose delivered tool result the host already consumed; it moves to the new id.
 */
async function adoptSessionCheckpoint(runId: string, sessionId: string): Promise<Checkpoint | null> {
  const latest = await latestSessionCheckpoint(sessionId);
  if (!latest) return null;
  const { delivered: _delivered, interaction: _interaction, ...state } = latest;
  const adopted: Checkpoint = { ...state, runId, createdAt: unixTimestamp() };
  await writeJson(runPath(runId), adopted);
  await removeFile(runPath(latest.runId));
  return adopted;
}

async function latestSessionCheckpoint(sessionId: string): Promise<Checkpoint | null> {
  let latest: Checkpoint | null = null;
  for (const entry of await listEntries(RUNS_DIR).catch(() => [])) {
    if (entry.isDirectory || !entry.name.endsWith(".json")) continue;
    const run = await readJson(`${RUNS_DIR}/${entry.name}`).catch(() => undefined) as Checkpoint | undefined;
    if (run?.sessionId === sessionId && (!latest || run.createdAt > latest.createdAt)) latest = run;
  }
  return latest;
}

async function dropSessionCheckpoints(projectId: string, sessionId: string) {
  for (const run of await listPendingRuns(projectId).catch(() => [])) {
    if (run.sessionId === sessionId) await removeFile(runPath(run.runId));
  }
}

async function failedRunId(sessionId: string): Promise<string | null> {
  const session = await dailyHost().agent.session.get(sessionId);
  const entry = session.entries[session.entries.length - 1];
  return entry?.run?.status === "failed" ? entry.run.runId : null;
}
function tryJson(value: string) { try { return JSON.parse(value); } catch { const match = value.match(/\{[\s\S]*\}/); if (match) { try { return JSON.parse(match[0]); } catch { /* ignore */ } } return { reply: value }; } }
