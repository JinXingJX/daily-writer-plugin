// Background pipeline runs: an ordered list of steps (memory upkeep, story updates, reader simulation, next-chapter
// drafting) that run in the background, can be paused, resumed, and re-run one step at a time.
import type { ModelUsage } from "../ai/client";
import { arrayValue, asRecord, finiteNumber, nullableString, stringArray, stringValue } from "../domain/util";

export type StepKind =
  | "memory.extract" | "memory.resolve" | "memory.arcs" | "memory.volumes" | "memory.book" | "memory.worldview" | "memory.conflicts"
  | "story.update" | "story.health" | "reader.snapshot" | "briefing" | "chapter.notes"
  | "next.plan" | "next.draft" | "next.review" | "next.propose";
export const STEP_KINDS: StepKind[] = ["memory.extract", "memory.resolve", "memory.arcs", "memory.volumes", "memory.book", "memory.worldview", "memory.conflicts", "story.update", "story.health", "reader.snapshot", "briefing", "chapter.notes", "next.plan", "next.draft", "next.review", "next.propose"];
export const STEP_LABELS: Record<StepKind, string> = {
  "memory.extract": "逐章抽取记忆",
  "memory.resolve": "实体与线索归并",
  "memory.arcs": "情节弧汇总",
  "memory.volumes": "分卷汇总",
  "memory.book": "全书大纲",
  "memory.worldview": "世界观与人物档案",
  "memory.conflicts": "设定冲突检测",
  "story.update": "更新设定与线索",
  "story.health": "故事体检",
  "reader.snapshot": "模拟读者",
  briefing: "作家简报",
  "chapter.notes": "写朱批",
  "next.plan": "下一章计划",
  "next.draft": "逐场写下一章",
  "next.review": "审读与修订",
  "next.propose": "生成草稿提案",
};

/**
 * pending: waits to run. running: in progress. done: finished. failed: errored (re-run or skip it). skipped: passed over
 * on request. stale: done, but an upstream step ran again since. awaiting: needs the author (e.g. plan approval).
 */
export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped" | "stale" | "awaiting";
export type RunState = "queued" | "running" | "paused" | "awaiting" | "done" | "error" | "cancelled";
export type RunTemplate = "publish" | "memory";

export type StepProgress = { done: number; total: number; message: string };
export type PipelineStep = {
  id: string;
  kind: StepKind;
  label: string;
  dependsOn: string[];
  status: StepStatus;
  progress: StepProgress;
  /** Fingerprint of the inputs the step last ran on (upstream finish times + trigger chapter hash). */
  inputHash: string;
  /** One line for the timeline. */
  summary: string;
  /** Proposal the step created, if any. */
  proposalId: string | null;
  error: string;
  attempts: number;
  startedAt: number;
  finishedAt: number;
  usage: ModelUsage;
};

export type RunTrigger = { kind: "publish" | "manual"; chapterId: string | null; chapterIds: string[] | null };
export type PipelineRun = {
  id: string;
  projectId: string;
  template: RunTemplate;
  title: string;
  trigger: RunTrigger;
  state: RunState;
  steps: PipelineStep[];
  message: string;
  createdAt: number;
  updatedAt: number;
};
export type RunSummary = Pick<PipelineRun, "id" | "template" | "title" | "state" | "message" | "createdAt" | "updatedAt"> & { chapterId: string | null; done: number; total: number };

export type CommandType = "pause" | "resume" | "cancel" | "rerun" | "skip" | "approve";
export type PipelineCommand = { id: string; runId: string; type: CommandType; stepId?: string; cascade?: boolean; payload?: unknown; at: number };

export const RUN_STATE_LABELS: Record<RunState, string> = { queued: "排队中", running: "运行中", paused: "已暂停", awaiting: "等你确认", done: "已完成", error: "出错", cancelled: "已取消" };
export const STEP_STATUS_LABELS: Record<StepStatus, string> = { pending: "等待", running: "运行中", done: "完成", failed: "失败", skipped: "已跳过", stale: "已过期", awaiting: "等你确认" };

export function emptyUsage(): ModelUsage { return { calls: 0, inputChars: 0, outputChars: 0 }; }

export function newStep(id: string, kind: StepKind, dependsOn: string[] = []): PipelineStep {
  return { id, kind, label: STEP_LABELS[kind], dependsOn, status: "pending", progress: { done: 0, total: 0, message: "" }, inputHash: "", summary: "", proposalId: null, error: "", attempts: 0, startedAt: 0, finishedAt: 0, usage: emptyUsage() };
}

export function runSummary(run: PipelineRun): RunSummary {
  return { id: run.id, template: run.template, title: run.title, state: run.state, message: run.message, createdAt: run.createdAt, updatedAt: run.updatedAt, chapterId: run.trigger.chapterId, done: run.steps.filter((step) => step.status === "done" || step.status === "skipped").length, total: run.steps.length };
}

/** Whether the run still has work to do or is waiting on the author. */
export function isActiveRun(run: Pick<PipelineRun, "state">) { return run.state === "queued" || run.state === "running" || run.state === "paused" || run.state === "awaiting"; }

/** Steps whose outputs are satisfied for dependants. Stale steps still count: their output exists. */
export function isSettled(step: PipelineStep) { return step.status === "done" || step.status === "skipped" || step.status === "stale"; }

export function normalizeRun(value: unknown): PipelineRun | null {
  const run = asRecord(value);
  if (typeof run.id !== "string" || typeof run.projectId !== "string") return null;
  const trigger = asRecord(run.trigger);
  const states: RunState[] = ["queued", "running", "paused", "awaiting", "done", "error", "cancelled"];
  return {
    id: run.id,
    projectId: run.projectId,
    template: run.template === "memory" ? "memory" : "publish",
    title: stringValue(run.title),
    trigger: { kind: trigger.kind === "manual" ? "manual" : "publish", chapterId: nullableString(trigger.chapterId), chapterIds: Array.isArray(trigger.chapterIds) ? stringArray(trigger.chapterIds, 50_000) : null },
    state: states.includes(run.state as RunState) ? run.state as RunState : "queued",
    steps: arrayValue(run.steps).flatMap((item) => normalizeStep(item) ?? []),
    message: stringValue(run.message),
    createdAt: finiteNumber(run.createdAt, 0),
    updatedAt: finiteNumber(run.updatedAt, 0),
  };
}

function normalizeStep(value: unknown): PipelineStep | null {
  const step = asRecord(value);
  if (typeof step.id !== "string" || !STEP_KINDS.includes(step.kind as StepKind)) return null;
  const statuses: StepStatus[] = ["pending", "running", "done", "failed", "skipped", "stale", "awaiting"];
  const progress = asRecord(step.progress);
  const usage = asRecord(step.usage);
  return {
    id: step.id,
    kind: step.kind as StepKind,
    label: stringValue(step.label) || STEP_LABELS[step.kind as StepKind],
    dependsOn: stringArray(step.dependsOn, 30),
    status: statuses.includes(step.status as StepStatus) ? step.status as StepStatus : "pending",
    progress: { done: finiteNumber(progress.done, 0), total: finiteNumber(progress.total, 0), message: stringValue(progress.message) },
    inputHash: stringValue(step.inputHash),
    summary: stringValue(step.summary),
    proposalId: nullableString(step.proposalId),
    error: stringValue(step.error),
    attempts: finiteNumber(step.attempts, 0),
    startedAt: finiteNumber(step.startedAt, 0),
    finishedAt: finiteNumber(step.finishedAt, 0),
    usage: { calls: finiteNumber(usage.calls, 0), inputChars: finiteNumber(usage.inputChars, 0), outputChars: finiteNumber(usage.outputChars, 0) },
  };
}

/** Steps downstream of `stepId` (transitively), in run order. */
export function downstreamOf(run: PipelineRun, stepId: string): PipelineStep[] {
  const affected = new Set([stepId]);
  const result: PipelineStep[] = [];
  for (const step of run.steps) {
    if (step.dependsOn.some((id) => affected.has(id))) { affected.add(step.id); result.push(step); }
  }
  return result;
}
