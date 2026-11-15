import { asRecord, finiteNumber } from "../domain/util";
import { readJson, writeJson } from "./io";
import { statsFile } from "./paths";

export type DayStat = { start: number; end: number };
export type WritingStats = { days: Record<string, DayStat> };

export function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export async function readStats(projectId: string): Promise<WritingStats> {
  const stored = asRecord(asRecord(await readJson(statsFile(projectId)).catch(() => undefined)).days);
  const days: Record<string, DayStat> = {};
  for (const [key, value] of Object.entries(stored)) {
    const day = asRecord(value);
    days[key] = { start: finiteNumber(day.start, 0), end: finiteNumber(day.end, 0) };
  }
  return { days };
}

/** Records the book's total word count; today's progress is `end - start` where start is the first total seen today. */
export async function recordWordTotal(projectId: string, total: number): Promise<WritingStats> {
  const stats = await readStats(projectId);
  const today = localDateKey();
  const entry = stats.days[today];
  if (entry && entry.end === total) return stats;
  stats.days[today] = entry ? { start: entry.start, end: total } : { start: previousEnd(stats, today) ?? total, end: total };
  const keys = Object.keys(stats.days).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - 400))) delete stats.days[key];
  await writeJson(statsFile(projectId), stats);
  return stats;
}

export function wordsWrittenOn(stats: WritingStats, key = localDateKey()) {
  const day = stats.days[key];
  return day ? Math.max(0, day.end - day.start) : 0;
}

function previousEnd(stats: WritingStats, today: string) {
  const previous = Object.keys(stats.days).filter((key) => key < today).sort().pop();
  return previous ? stats.days[previous].end : undefined;
}
