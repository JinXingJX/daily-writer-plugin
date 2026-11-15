// Runs pipeline work for a project while holding its lease: applies queued commands, then executes runnable steps in
// dependency order. Every step records its status in the run file, so stopping at any point (pause, crash, closed
// window) loses at most the step in flight, which runs again on resume.
import { trackModelUsage } from "../ai/client";
import { normalizePlan } from "../ai/pipelines/nextChapter";
import { contentHash } from "../domain/ids";
import { asRecord } from "../domain/util";
import { MemoryStore } from "../memory/store";
import { invalidateMemoryView } from "../memory/view";
import { releaseLease, renewLease, tryAcquireLease } from "../storage/lock";
import { openProject } from "../storage/projectStore";
import type { MemoryStatus } from "../memory/schema";
import type { WriterProject } from "../types";
import { downstreamOf, isActiveRun, isSettled, type PipelineCommand, type PipelineRun, type PipelineStep } from "./schema";
import { MEMORY_STEPS } from "./steps/memory";
import { NEXT_STEPS, type PlanArtifact } from "./steps/next";
import { STORY_STEPS } from "./steps/story";
import type { StepExecutor } from "./steps/types";
import { leaseKey, listRuns, loadRun, markIdle, readArtifact, removeArtifact, saveRun, takeCommands, writeArtifact } from "./store";

const LEASE_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const COMMAND_POLL_MS = 1_500;
const REPORT_THROTTLE_MS = 1_000;

export const EXECUTORS: Record<PipelineStep["kind"], StepExecutor> = { ...MEMORY_STEPS, ...STORY_STEPS, ...NEXT_STEPS };

class StopRequested extends Error {
  constructor(readonly reason: "pause" | "cancel") { super(reason === "pause" ? "已暂停" : "已取消"); }
}

/**
 * Applies a command to a run (not the step currently executing; the engine handles pause/cancel of that one).
 * Returns artifacts to delete for steps that will run again.
 */
export function applyCommand(run: PipelineRun, command: PipelineCommand): string[] {
  const step = command.stepId ? run.steps.find((item) => item.id === command.stepId) : undefined;
  const cleared: string[] = [];
  const reset = (target: PipelineStep) => { Object.assign(target, { status: "pending", error: "", attempts: 0, summary: "", proposalId: null, progress: { done: 0, total: 0, message: "" } }); cleared.push(target.id); };
  switch (command.type) {
    case "pause":
      if (isActiveRun(run)) { run.state = "paused"; run.message = "已暂停，可随时继续"; }
      for (const item of run.steps) if (item.status === "running") item.status = "pending";
      break;
    case "cancel":
      if (run.state !== "done") { run.state = "cancelled"; run.message = "已取消"; }
      for (const item of run.steps) if (item.status === "running") item.status = "pending";
      break;
    case "resume":
      if (run.state === "paused" || run.state === "error" || run.state === "cancelled" || run.state === "awaiting") {
        for (const item of run.steps) if (item.status === "failed") { item.status = "pending"; item.error = ""; }
        run.state = "queued";
        run.message = "";
      }
      break;
    case "rerun":
      if (!step) break;
      reset(step);
      for (const downstream of downstreamOf(run, step.id)) {
        if (command.cascade) reset(downstream);
        else if (downstream.status === "done") downstream.status = "stale";
      }
      if (run.state !== "paused") run.state = "queued";
      break;
    case "skip":
      if (!step || step.status === "done") break;
      step.status = "skipped";
      step.summary = "已跳过";
      if (run.state === "error" || run.state === "awaiting" || run.state === "done") run.state = "queued";
      break;
    case "approve":
      if (!step || step.status !== "awaiting") break;
      step.status = "done";
      step.finishedAt = Date.now();
      step.summary = step.summary.replace(/，等你确认$/, "，已确认");
      if (run.state === "awaiting" || run.state === "paused") run.state = "queued";
      break;
  }
  return command.type === "rerun" ? cleared : [];
}

/**
 * Processes queued pipeline work for a project if this caller obtains the lease.
 * Returns false when another runner holds the lease.
 */
export async function runPipelineWork(projectId: string, owner: string, onChange?: (run: PipelineRun) => void): Promise<boolean> {
  const key = leaseKey(projectId);
  if (!(await tryAcquireLease(key, owner, LEASE_MS))) return false;
  const heartbeat = globalThis.setInterval(() => { void renewLease(key, owner, LEASE_MS).catch(() => undefined); }, HEARTBEAT_MS);
  try {
    for (;;) {
      await drainCommands(projectId, null);
      const runs = await listRuns(projectId);
      // A run left "running" belonged to a runner that stopped; it continues here.
      const next = [...runs].reverse().find((run) => run.state === "queued" || run.state === "running");
      if (!next) {
        if (!runs.some((run) => run.state === "queued" || run.state === "running")) await markIdle(projectId);
        break;
      }
      const run = await loadRun(projectId, next.id);
      if (!run) { await saveRun({ ...next, projectId, trigger: { kind: "manual", chapterId: null, chapterIds: null }, steps: [], state: "error", message: "运行记录已丢失" } as PipelineRun); continue; }
      await processRun(run, onChange);
    }
  } finally {
    globalThis.clearInterval(heartbeat);
    await releaseLease(key, owner).catch(() => undefined);
  }
  return true;
}

/**
 * Applies queued commands to their runs. Commands for `current` (the run being processed) are applied to that object;
 * returns the pause/cancel reason when one targets it.
 */
async function drainCommands(projectId: string, current: PipelineRun | null): Promise<"pause" | "cancel" | null> {
  const commands = await takeCommands(projectId);
  let stop: "pause" | "cancel" | null = null;
  const touched = new Map<string, PipelineRun>();
  for (const command of commands) {
    const run = current?.id === command.runId ? current : touched.get(command.runId) ?? await loadRun(projectId, command.runId);
    if (!run) continue;
    if (run === current && (command.type === "pause" || command.type === "cancel")) stop = command.type;
    for (const stepId of applyCommand(run, command)) await removeArtifact(projectId, run.id, stepId);
    if (command.type === "approve") await approvePayload(run, command);
    if (run !== current) touched.set(run.id, run);
  }
  for (const run of touched.values()) await saveRun(run);
  return stop;
}

/** An approved plan may come back edited by the author. */
async function approvePayload(run: PipelineRun, command: PipelineCommand) {
  if (!command.stepId) return;
  const artifact = await readArtifact<PlanArtifact>(run.projectId, run.id, command.stepId);
  if (!artifact) return;
  const edited = asRecord(command.payload).plan;
  let plan = artifact.plan;
  if (edited) { try { plan = normalizePlan(edited); } catch { /* keep the generated plan */ } }
  await writeArtifact(run.projectId, run.id, command.stepId, { ...artifact, plan, approved: true } satisfies PlanArtifact);
}

async function processRun(run: PipelineRun, onChange?: (run: PipelineRun) => void) {
  const projectId = run.projectId;
  const store = new MemoryStore(projectId);
  const memoryStatus = await store.loadStatus();
  let memoryTouched = false;
  const publishMemory = async () => { memoryTouched = true; await store.saveStatus(memoryStatus); invalidateMemoryView(projectId); };
  const save = async (index = true) => { await saveRun(run, { index }); onChange?.(structuredClone(run)); };

  run.state = "running";
  run.message = "";
  await save();
  let outcome: "done" | "paused" | "cancelled" | "error" | "awaiting" | "blocked" = "done";
  for (;;) {
    const stop = await drainCommands(projectId, run);
    const state: string = run.state;
    if (stop || state !== "running") { outcome = stop === "cancel" || state === "cancelled" ? "cancelled" : "paused"; break; }
    const step = run.steps.find((item) => item.status === "pending" && item.dependsOn.every((id) => { const dep = run.steps.find((other) => other.id === id); return !dep || isSettled(dep); }));
    if (!step) {
      if (run.steps.every(isSettled)) outcome = "done";
      else if (run.steps.some((item) => item.status === "awaiting")) outcome = "awaiting";
      else if (run.steps.some((item) => item.status === "failed")) outcome = "error";
      else outcome = "blocked";
      break;
    }
    const result = await executeStep(run, step, { memoryStatus, publishMemory, save });
    if (result === "stopped") {
      const reason = lastStop.get(run.id) ?? "pause";
      outcome = reason === "cancel" ? "cancelled" : "paused";
      break;
    }
  }
  run.state = outcome === "done" ? "done" : outcome === "awaiting" ? "awaiting" : outcome === "paused" ? "paused" : outcome === "cancelled" ? "cancelled" : "error";
  run.message = outcome === "done" ? "全部完成" : outcome === "awaiting" ? "有一步等你确认" : outcome === "paused" ? "已暂停，可随时继续" : outcome === "cancelled" ? "已取消" : outcome === "blocked" ? "有步骤无法继续（前置步骤未完成）" : run.steps.find((item) => item.status === "failed")?.error ?? "出错";
  await save();
  if (memoryTouched) {
    Object.assign(memoryStatus, { state: outcome === "done" || outcome === "awaiting" ? "done" : outcome === "error" ? "error" : "paused", phase: null, message: outcome === "error" ? run.message : outcome === "paused" ? "已暂停，可随时继续" : "记忆已是最新", owner: null });
    await store.saveStatus(memoryStatus).catch(() => undefined);
    invalidateMemoryView(projectId);
  }
}

const lastStop = new Map<string, "pause" | "cancel">();

async function executeStep(run: PipelineRun, step: PipelineStep, shared: { memoryStatus: MemoryStatus; publishMemory: () => Promise<void>; save: (index?: boolean) => Promise<void> }): Promise<"ok" | "stopped"> {
  const controller = new AbortController();
  let project: WriterProject;
  try { project = await openProject(run.projectId); }
  catch (error) { Object.assign(step, { status: "failed", error: error instanceof Error ? error.message : String(error), finishedAt: Date.now() }); await shared.save(); return "ok"; }
  const trigger = run.trigger.chapterId ? project.chapters.find((chapter) => chapter.id === run.trigger.chapterId) : undefined;
  step.inputHash = contentHash(`${step.dependsOn.map((id) => run.steps.find((item) => item.id === id)?.finishedAt ?? 0).join(",")}|${trigger?.contentHash ?? ""}`);
  Object.assign(step, { status: "running", startedAt: Date.now(), finishedAt: 0, error: "", attempts: step.attempts + 1, usage: { calls: 0, inputChars: 0, outputChars: 0 } });
  await shared.save();

  let lastPoll = 0;
  let lastReport = 0;
  const checkStop = async (force = false) => {
    if (controller.signal.aborted) return true;
    if (!force && Date.now() - lastPoll < COMMAND_POLL_MS) return false;
    lastPoll = Date.now();
    const stop = await drainCommands(run.projectId, run);
    if (stop) { lastStop.set(run.id, stop); controller.abort(); }
    return controller.signal.aborted;
  };
  const poller = globalThis.setInterval(() => { void checkStop().catch(() => undefined); }, COMMAND_POLL_MS);
  const untrack = trackModelUsage(({ inputChars, outputChars }) => {
    step.usage.calls += 1; step.usage.inputChars += inputChars; step.usage.outputChars += outputChars;
    if (step.kind.startsWith("memory.")) { const usage = shared.memoryStatus.usage; usage.calls += 1; usage.inputChars += inputChars; usage.outputChars += outputChars; }
  });
  try {
    const outcome = await EXECUTORS[step.kind]({
      project,
      run,
      step,
      signal: controller.signal,
      report: async (done, total, message) => {
        step.progress = { done, total, message: message ?? step.progress.message };
        if (Date.now() - lastReport < REPORT_THROTTLE_MS) return;
        lastReport = Date.now();
        await shared.save(false);
      },
      checkStop,
      artifactOf: async <T,>(kind: PipelineStep["kind"]) => { const source = run.steps.find((item) => item.kind === kind); return source ? readArtifact<T>(run.projectId, run.id, source.id) : null; },
      ownArtifact: <T,>() => readArtifact<T>(run.projectId, run.id, step.id),
      writeArtifact: (value) => writeArtifact(run.projectId, run.id, step.id, value),
      memoryStatus: shared.memoryStatus,
      publishMemory: shared.publishMemory,
    });
    if (controller.signal.aborted) throw new StopRequested(lastStop.get(run.id) ?? "pause");
    Object.assign(step, { status: outcome.awaiting ? "awaiting" : "done", summary: outcome.summary, proposalId: outcome.proposalId ?? step.proposalId, finishedAt: Date.now() });
    step.progress = { ...step.progress, message: "" };
    await shared.save();
    return "ok";
  } catch (error) {
    if (controller.signal.aborted || error instanceof StopRequested) {
      // The step runs again on resume; executors pick up from their own artifact where they can.
      if (step.status === "running") step.status = "pending";
      step.progress = { ...step.progress, message: "已暂停" };
      await shared.save();
      return "stopped";
    }
    Object.assign(step, { status: "failed", error: error instanceof Error ? error.message : String(error), finishedAt: Date.now() });
    await shared.save();
    return "ok";
  } finally {
    globalThis.clearInterval(poller);
    untrack();
  }
}

/** Runs everything queued, for tests and the scale check. */
export async function runAllPipelineWork(projectId: string, owner = "test") {
  while (await runPipelineWork(projectId, owner)) {
    const runs = await listRuns(projectId);
    if (!runs.some((run) => run.state === "queued" || run.state === "running")) return;
  }
}
