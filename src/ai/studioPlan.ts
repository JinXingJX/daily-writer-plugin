// The chapter plan the assistant last made, kept in structured form for the studio. The host only records a tool's
// text observation, which the author cannot edit. One per work: a plan is only useful while its chapter is being written.
import { dailyHost } from "../host";
import { asRecord, arrayValue, stringValue } from "../domain/util";
import type { PlanWarning } from "../story/planLint";
import { normalizePlan, type ChapterPlan } from "./pipelines/nextChapter";

export type StudioPlanRecord = { plan: ChapterPlan; warnings: PlanWarning[] };

const keyOf = (projectId: string) => `writer.studioPlan.${projectId}`;

export async function saveStudioPlan(projectId: string, sessionId: string, plan: ChapterPlan, warnings: PlanWarning[]) {
  await dailyHost().storage.set(keyOf(projectId), { sessionId, plan, warnings });
}

/** The plan made in this conversation, or null when the latest plan belongs to another one. */
export async function loadStudioPlan(projectId: string, sessionId: string): Promise<StudioPlanRecord | null> {
  const stored = asRecord(await dailyHost().storage.get(keyOf(projectId)));
  if (stringValue(stored.sessionId) !== sessionId || !stored.plan) return null;
  const warnings = arrayValue(stored.warnings).filter((item): item is PlanWarning => typeof asRecord(item).message === "string");
  return { plan: normalizePlan(stored.plan), warnings };
}
