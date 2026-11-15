// Creating runs. A publish run keeps memory, story and settings up to date after a chapter is published and drafts
// the next chapter; a memory run builds or refreshes story memory.
import { uniqueId } from "../domain/ids";
import { chapterLabel, orderedChapters } from "../domain/documents";
import { MEMORY_PHASES, MEMORY_PHASE_LABELS, type MemoryPhase } from "../memory/schema";
import type { WriterProject } from "../types";
import { isActiveRun, newStep, type PipelineRun, type PipelineStep, type StepKind } from "./schema";
import { listRuns, markActive, saveRun, sendCommand } from "./store";

function chain(kinds: StepKind[]): PipelineStep[] {
  return kinds.map((kind, index) => newStep(`s${index + 1}`, kind, index ? [`s${index}`] : []));
}

/** Steps of a publish run, following the work's pipeline settings. */
export function publishSteps(project: WriterProject): PipelineStep[] {
  const enabled = new Set(project.settings.pipeline.steps);
  const steps: PipelineStep[] = [];
  const add = (kind: StepKind, dependsOn: (string | null)[]) => { const step = newStep(`s${steps.length + 1}`, kind, dependsOn.filter((id): id is string => Boolean(id))); steps.push(step); return step.id; };
  const extract = add("memory.extract", []);
  const resolve = add("memory.resolve", [extract]);
  const arcs = add("memory.arcs", [resolve]);
  const volumes = add("memory.volumes", [arcs]);
  const book = add("memory.book", [volumes]);
  const conflicts = add("memory.conflicts", [resolve]);
  const story = enabled.has("story") ? add("story.update", [resolve]) : null;
  const health = add("story.health", [book, conflicts, story]);
  const reader = enabled.has("reader") ? add("reader.snapshot", [book]) : null;
  const briefing = enabled.has("briefing") ? add("briefing", [health, reader]) : null;
  if (enabled.has("notes")) add("chapter.notes", [resolve]);
  if (enabled.has("next")) {
    const plan = add("next.plan", [health, reader, briefing]);
    const draft = add("next.draft", [plan]);
    const review = add("next.review", [draft]);
    add("next.propose", [review]);
  }
  return steps;
}

async function createRun(run: PipelineRun) {
  await saveRun(run);
  await markActive(run.projectId);
  return run;
}

/** Starts the publish pipeline for a chapter. Unfinished publish runs of the same chapter are cancelled. */
export async function startPublishRun(project: WriterProject, chapterId: string): Promise<PipelineRun> {
  const position = orderedChapters(project).findIndex((chapter) => chapter.id === chapterId);
  if (position < 0) throw new Error("章节不存在。");
  for (const run of await listRuns(project.id)) {
    if (run.template === "publish" && run.chapterId === chapterId && isActiveRun(run)) await sendCommand(project.id, { runId: run.id, type: "cancel" });
  }
  const chapter = orderedChapters(project)[position];
  return createRun({ id: uniqueId("run"), projectId: project.id, template: "publish", title: `发布 ${chapterLabel(position)}「${chapter.title}」`, trigger: { kind: "publish", chapterId, chapterIds: [chapterId] }, state: "queued", steps: publishSteps(project), message: "", createdAt: Date.now(), updatedAt: Date.now() });
}

/** Starts a memory build. Queued or paused memory runs it replaces are cancelled. */
export async function startMemoryRun(projectId: string, phases: MemoryPhase[] = MEMORY_PHASES, chapterIds: string[] | null = null): Promise<PipelineRun> {
  for (const run of await listRuns(projectId)) {
    if (run.template === "memory" && (run.state === "queued" || run.state === "paused")) await sendCommand(projectId, { runId: run.id, type: "cancel" });
  }
  const ordered = MEMORY_PHASES.filter((phase) => phases.includes(phase));
  const title = chapterIds ? `更新记忆（${chapterIds.length} 章）` : ordered.length === 1 ? MEMORY_PHASE_LABELS[ordered[0]] : "构建故事记忆";
  return createRun({ id: uniqueId("run"), projectId, template: "memory", title, trigger: { kind: "manual", chapterId: chapterIds?.length === 1 ? chapterIds[0] : null, chapterIds }, state: "queued", steps: chain(ordered.map((phase) => `memory.${phase}` as StepKind)), message: "", createdAt: Date.now(), updatedAt: Date.now() });
}

/** Pauses every unfinished memory run (the memory view's pause button). */
export async function pauseMemoryRuns(projectId: string) {
  for (const run of await listRuns(projectId)) if (run.template === "memory" && (run.state === "queued" || run.state === "running")) await sendCommand(projectId, { runId: run.id, type: "pause" });
}

/** Resumes paused or failed memory runs; returns whether any was found. */
export async function resumeMemoryRuns(projectId: string) {
  const paused = (await listRuns(projectId)).filter((run) => run.template === "memory" && (run.state === "paused" || run.state === "error"));
  for (const run of paused) await sendCommand(projectId, { runId: run.id, type: "resume" });
  return paused.length > 0;
}
