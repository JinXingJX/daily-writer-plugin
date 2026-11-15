// The thread score: every story thread as one line across the chapters, from where it was planted to where it paid off.
import type { ThreadKind } from "../memory/schema";
import type { PositionedThread } from "./selectors";

export type ScoreRow = {
  id: string;
  title: string;
  kind: ThreadKind;
  status: PositionedThread["status"];
  /** Chapter positions: planted, last touched, planned payoff (null when no later target is set). */
  start: number;
  end: number;
  planEnd: number | null;
  ticks: { position: number; payoff: boolean }[];
  /** Chapters since the thread last moved, while it is still open. */
  silent: number;
  stale: boolean;
};

export type Score = { rows: ScoreRow[]; horizon: number; current: number };

/**
 * `total` is the number of chapters, `staleAfter` the story-health threshold for a silent plant. Open threads come first,
 * in the order they were planted; finished ones follow, most recent first. The axis stretches to the furthest planned payoff.
 */
export function buildScore(threads: PositionedThread[], total: number, staleAfter: number, positionOf: (chapterId: string) => number, limit = 60): Score {
  const located = threads.filter((thread) => thread.plantedAt >= 0);
  const rows = located.map((thread): ScoreRow => {
    const end = thread.paidAt ?? thread.lastAt;
    const target = thread.targetChapterId ? positionOf(thread.targetChapterId) : -1;
    const open = thread.status === "open";
    const silent = open ? Math.max(0, total - 1 - thread.lastAt) : 0;
    const ticks = thread.events.map((event) => ({ position: positionOf(event.chapterId), payoff: event.type === "payoff" })).filter((tick) => tick.position >= 0).sort((left, right) => left.position - right.position);
    return { id: thread.id, title: thread.title, kind: thread.kind, status: thread.status, start: thread.plantedAt, end, planEnd: open && target > end ? target : null, ticks, silent, stale: thread.kind === "foreshadow" && open && silent >= staleAfter };
  });
  const open = rows.filter((row) => row.status === "open").sort((left, right) => left.start - right.start);
  const closed = rows.filter((row) => row.status !== "open").sort((left, right) => right.end - left.end);
  const kept = [...open, ...closed].slice(0, limit);
  const furthest = kept.reduce((max, row) => Math.max(max, row.planEnd ?? row.end), 0);
  return { rows: kept, horizon: Math.max(total, furthest + 1, 1), current: Math.max(0, total - 1) };
}
