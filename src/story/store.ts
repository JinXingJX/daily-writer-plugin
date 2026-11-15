// File-backed story plan of one work. Writes go through a per-project story lock.
import { readJson, writeJson } from "../storage/io";
import { withWriterMutationLock } from "../storage/lock";
import { storyFile } from "../storage/paths";
import { applyStoryOperations } from "./operations";
import { normalizeStoryPlan, type StoryOperation, type StoryPlan } from "./schema";

const lockKey = (projectId: string) => `writer.story.lock.${projectId}`;

export async function loadStoryPlan(projectId: string): Promise<StoryPlan> {
  return normalizeStoryPlan(await readJson(storyFile(projectId)).catch(() => undefined));
}

/** Writes the plan as is. Caller holds the story lock when other writers may run. */
export async function saveStoryPlan(projectId: string, plan: StoryPlan) {
  await writeJson(storyFile(projectId), { ...plan, updatedAt: Date.now() });
}

export function withStoryLock<T>(projectId: string, task: () => Promise<T>) { return withWriterMutationLock(task, lockKey(projectId)); }

/** Read-modify-write of the story plan under its lock. */
export async function mutateStoryPlan<T>(projectId: string, mutate: (plan: StoryPlan) => T | Promise<T>): Promise<{ plan: StoryPlan; result: T }> {
  return withStoryLock(projectId, async () => {
    const plan = await loadStoryPlan(projectId);
    const result = await mutate(plan);
    await saveStoryPlan(projectId, plan);
    return { plan, result };
  });
}

export async function applyStoryPlanOperations(projectId: string, operations: StoryOperation[]): Promise<StoryPlan> {
  return (await mutateStoryPlan(projectId, (plan) => applyStoryOperations(plan, operations))).plan;
}
