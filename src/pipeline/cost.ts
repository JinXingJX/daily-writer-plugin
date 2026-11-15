// Rough cost of a publish run, shown before it starts.
import { readerPanel } from "../ai/promptRegistry";
import { estimateMemoryCost, type CostEstimate } from "../memory/cost";
import { AUTO_PHASES } from "../memory/schema";
import type { WriterProject } from "../types";

export function estimatePublishCost(project: WriterProject, chapterId: string): CostEstimate {
  const memory = estimateMemoryCost(project, [chapterId], AUTO_PHASES);
  const steps = new Set(project.settings.pipeline.steps);
  let calls = memory.calls;
  let inputTokens = memory.inputTokens;
  let outputTokens = memory.outputTokens;
  const add = (count: number, input: number, output: number) => { calls += count; inputTokens += input; outputTokens += output; };
  if (steps.has("story")) add(1, 14_000, 2_500);
  if (steps.has("reader")) {
    // Every panel member reads the chapter text, then one call sums the panel up.
    const readers = readerPanel(project).length;
    add(readers + 1, readers * 16_000 + 12_000, readers * 1_500 + 2_500);
  }
  if (steps.has("briefing")) add(1, 22_000, 3_000);
  if (steps.has("notes")) add(1, 18_000, 3_000);
  if (steps.has("next")) {
    const scenes = Math.max(3, Math.round(project.settings.pipeline.nextWords / 900));
    add(1, 20_000, 4_000);
    add(scenes, scenes * 22_000, Math.round(project.settings.pipeline.nextWords * 1.6));
    add(4, 4 * 20_000, 6_000);
  }
  return { chapters: memory.chapters, calls, inputTokens, outputTokens };
}
