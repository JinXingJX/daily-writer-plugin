// Pipeline persistence. Run files are written by whoever holds the project's pipeline lease (the runner), except when a
// run is created; the UI talks to the runner through a command queue in host storage.
import { dailyHost } from "../host";
import { uniqueId } from "../domain/ids";
import { arrayValue, asRecord, delay, stringArray } from "../domain/util";
import { readJson, removeFile, writeJson } from "../storage/io";
import { withWriterMutationLock } from "../storage/lock";
import { pipelineDir } from "../storage/paths";
import { normalizeRun, runSummary, type PipelineCommand, type PipelineRun, type RunSummary } from "./schema";

const INDEX_LIMIT = 50;
const ACTIVE_KEY = "writer.pipeline.active.v1";
const commandKey = (projectId: string) => `writer.pipeline.cmd.${projectId}`;
export const leaseKey = (projectId: string) => `writer.pipeline.lease.${projectId}`;
const indexLock = (projectId: string) => `writer.pipeline.lock.${projectId}`;

const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");
const indexFile = (projectId: string) => `${pipelineDir(projectId)}/index.json`;
const runFile = (projectId: string, runId: string) => `${pipelineDir(projectId)}/${safe(runId)}.json`;
const artifactFile = (projectId: string, runId: string, stepId: string) => `${pipelineDir(projectId)}/${safe(runId)}/${safe(stepId)}.json`;

export async function listRuns(projectId: string): Promise<RunSummary[]> {
  const stored = asRecord(await readJson(indexFile(projectId)).catch(() => undefined));
  return arrayValue(stored.runs).map((item) => item as RunSummary).filter((item) => typeof item?.id === "string").sort((left, right) => right.createdAt - left.createdAt);
}

export async function loadRun(projectId: string, runId: string): Promise<PipelineRun | null> {
  return normalizeRun(await readJson(runFile(projectId, runId)).catch(() => undefined));
}

/** Writes the run and refreshes its index entry. */
export async function saveRun(run: PipelineRun, options: { index?: boolean } = {}) {
  run.updatedAt = Date.now();
  await writeJson(runFile(run.projectId, run.id), run);
  if (options.index !== false) await updateIndex(run.projectId, (runs) => [runSummary(run), ...runs.filter((item) => item.id !== run.id)]);
}

async function updateIndex(projectId: string, update: (runs: RunSummary[]) => RunSummary[]) {
  await withWriterMutationLock(async () => {
    const current = await listRuns(projectId);
    const next = update(current).sort((left, right) => right.createdAt - left.createdAt);
    for (const dropped of next.slice(INDEX_LIMIT)) await removeFile(runFile(projectId, dropped.id));
    await writeJson(indexFile(projectId), { runs: next.slice(0, INDEX_LIMIT) });
  }, indexLock(projectId));
}

export async function readArtifact<T = unknown>(projectId: string, runId: string, stepId: string): Promise<T | null> {
  const value = await readJson(artifactFile(projectId, runId, stepId)).catch(() => undefined);
  return value === undefined ? null : value as T;
}

export async function writeArtifact(projectId: string, runId: string, stepId: string, value: unknown) {
  await writeJson(artifactFile(projectId, runId, stepId), value);
}

export async function removeArtifact(projectId: string, runId: string, stepId: string) {
  await removeFile(artifactFile(projectId, runId, stepId));
}

/** Queues a command for the runner (compare-and-set, so concurrent writers do not lose commands). */
export async function sendCommand(projectId: string, command: Omit<PipelineCommand, "id" | "at">) {
  const entry: PipelineCommand = { ...command, id: uniqueId("cmd"), at: Date.now() };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await dailyHost().storage.get(commandKey(projectId));
    const list = arrayValue(current) as PipelineCommand[];
    if (await dailyHost().storage.compareAndSet(commandKey(projectId), current ?? null, [...list, entry].slice(-200))) {
      await markActive(projectId);
      return;
    }
    await delay(30 + attempt * 20);
  }
  throw new Error("流水线命令发送失败，请重试。");
}

/** Removes and returns the queued commands. */
export async function takeCommands(projectId: string): Promise<PipelineCommand[]> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await dailyHost().storage.get(commandKey(projectId));
    const list = arrayValue(current) as PipelineCommand[];
    if (!list.length) return [];
    if (await dailyHost().storage.compareAndRemove(commandKey(projectId), current)) return list;
    await delay(30 + attempt * 20);
  }
  return [];
}

/** Projects with pipeline work, for the background worker. */
export async function activeProjects(): Promise<string[]> { return stringArray(await dailyHost().storage.get(ACTIVE_KEY)); }

export async function markActive(projectId: string) {
  const active = await activeProjects();
  if (!active.includes(projectId)) await dailyHost().storage.set(ACTIVE_KEY, [...active, projectId].slice(-20));
}

export async function markIdle(projectId: string) {
  const active = await activeProjects();
  if (active.includes(projectId)) await dailyHost().storage.set(ACTIVE_KEY, active.filter((id) => id !== projectId));
}
