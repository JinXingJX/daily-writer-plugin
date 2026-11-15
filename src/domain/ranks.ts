// Float ranks keep reorders merge-friendly: moving or inserting a chapter only touches that chapter's rank.
export const RANK_STEP = 1024;
const MIN_GAP = 1e-6;

export function rankAfter(last: number | undefined) { return last === undefined ? RANK_STEP : Math.floor(last / RANK_STEP) * RANK_STEP + RANK_STEP; }

export function rankBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return RANK_STEP;
  if (before === undefined) return (after as number) - RANK_STEP;
  if (after === undefined) return rankAfter(before);
  return (before + after) / 2;
}

export function needsRebalance(ranks: number[]) {
  const sorted = [...ranks].sort((left, right) => left - right);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] - sorted[index - 1] < MIN_GAP) return true;
  }
  return false;
}

export function rebalance<T extends { rank: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.rank - right.rank).map((item, index) => ({ ...item, rank: (index + 1) * RANK_STEP }));
}

export function byRank<T extends { rank: number }>(left: T, right: T) { return left.rank - right.rank; }

/** Rebalances the ranks of chapters in `volumeId` when two of them got too close; other chapters are returned as is. */
export function rebalanceIfNeeded<T extends { id: string; rank: number; volumeId: string }>(chapters: T[], volumeId: string): T[] {
  const inVolume = chapters.filter((chapter) => chapter.volumeId === volumeId);
  if (!needsRebalance(inVolume.map((chapter) => chapter.rank))) return chapters;
  const balanced = new Map(rebalance(inVolume).map((chapter) => [chapter.id, chapter.rank]));
  return chapters.map((chapter) => (balanced.has(chapter.id) ? { ...chapter, rank: balanced.get(chapter.id) as number } : chapter));
}
