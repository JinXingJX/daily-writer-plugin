// Cost estimates shown before a memory build or a pipeline run.
import type { WriterProject } from "../types";
import type { MemoryPhase } from "./schema";

export type CostEstimate = { chapters: number; calls: number; inputTokens: number; outputTokens: number };

export function estimateMemoryCost(project: WriterProject, staleIds: string[], phases: MemoryPhase[], hasWorldview = false): CostEstimate {
  const stale = new Set(staleIds);
  const chapters = project.chapters.filter((chapter) => stale.has(chapter.id));
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  if (phases.includes("extract")) {
    for (const chapter of chapters) {
      const parts = Math.max(1, Math.ceil(chapter.wordCount / 12_000));
      calls += parts;
      inputTokens += Math.ceil(chapter.wordCount * 1.05) + 2_500 * parts;
      outputTokens += 1_500 * parts;
    }
  }
  const arcs = Math.ceil(chapters.length / 15);
  if (!chapters.length) {
    return phases.includes("worldview") && !hasWorldview ? { chapters: 0, calls: 13, inputTokens: 13 * 12_000, outputTokens: 13 * 2_000 } : { chapters: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
  }
  if (phases.includes("arcs")) { calls += arcs; inputTokens += arcs * 6_000; outputTokens += arcs * 800; }
  if (phases.includes("volumes")) { calls += project.volumes.length + Math.ceil(arcs / 60); inputTokens += arcs * 700; outputTokens += project.volumes.length * 1_500; }
  if (phases.includes("book")) { calls += 1; inputTokens += project.volumes.length * 1_500; outputTokens += 3_000; }
  if (phases.includes("worldview")) { calls += 13; inputTokens += 13 * 12_000; outputTokens += 13 * 2_000; }
  return { chapters: chapters.length, calls, inputTokens, outputTokens };
}

export function formatTokens(tokens: number) { return tokens >= 10_000 ? `${(tokens / 10_000).toFixed(1)} 万` : String(tokens); }
