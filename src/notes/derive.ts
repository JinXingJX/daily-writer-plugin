// Deterministic views for the author notebook and the reader perspective, computed from project metadata and story
// memory. Reader knowledge only uses chapter cards up to the reading position, so it never leaks later chapters.
import { orderedChapters } from "../domain/documents";
import { contentHash } from "../domain/ids";
import type { CardFact, EntityCategory, MemoryEntity, StoryThread } from "../memory/schema";
import type { MemoryView } from "../memory/view";
import type { StoryPlan, StorySecret } from "../story/schema";
import type { ChapterStatus, WriterChapterMeta, WriterProject } from "../types";

/** Chapters since an entity's last appearance after which a reader may need a reminder. */
export const FORGET_GAP = 30;

export type WritingProgress = {
  totalWords: number;
  chapterCount: number;
  writtenCount: number;
  /** Last chapter that has text: where the author is in the book. */
  frontier: WriterChapterMeta | null;
  frontierPosition: number;
  /** Empty chapters after the frontier (planned but not written). */
  plannedAhead: number;
  statusCounts: Record<ChapterStatus, number>;
  volumeTitle: string;
};

export function writingProgress(project: WriterProject): WritingProgress {
  const chapters = orderedChapters(project);
  let frontierPosition = -1;
  chapters.forEach((chapter, index) => { if (chapter.wordCount > 0) frontierPosition = index; });
  const frontier = frontierPosition >= 0 ? chapters[frontierPosition] : null;
  const statusCounts: Record<ChapterStatus, number> = { draft: 0, writing: 0, review: 0, final: 0 };
  for (const chapter of chapters) statusCounts[chapter.status] += 1;
  return {
    totalWords: chapters.reduce((total, chapter) => total + chapter.wordCount, 0),
    chapterCount: chapters.length,
    writtenCount: chapters.filter((chapter) => chapter.wordCount > 0).length,
    frontier,
    frontierPosition,
    plannedAhead: chapters.length - frontierPosition - 1,
    statusCounts,
    volumeTitle: project.volumes.find((volume) => volume.id === frontier?.volumeId)?.title ?? "",
  };
}

/** Fingerprint of the first `count` chapters' text; AI output generated from them is stale once it changes. */
export function chaptersBasis(project: WriterProject, count: number): string {
  return contentHash(orderedChapters(project).slice(0, Math.max(0, count)).map((chapter) => `${chapter.id}:${chapter.contentHash}`).join("|"));
}

export type KnownEntity = {
  entity: MemoryEntity;
  /** Latest description the reader has been given (from cards up to the position). */
  description: string;
  state: (CardFact & { position: number })[];
  mentions: number;
  firstSeen: number;
  lastSeen: number;
};

export type ReaderThread = { thread: StoryThread; plantedAt: number; lastAt: number; resolvedAt: number | null; lastNote: string };

export type ReaderKnowledge = {
  /** Index of the chapter the reader just finished. */
  position: number;
  characters: KnownEntity[];
  others: KnownEntity[];
  rules: (CardFact & { position: number })[];
  events: (CardFact & { position: number; chapterId: string })[];
  openQuestions: ReaderThread[];
  resolved: ReaderThread[];
  /** Important entities absent for a long time; the reader may have forgotten them. */
  fading: KnownEntity[];
  hook: string;
  coveredChapters: number;
};

export function readerKnowledge(memory: MemoryView, position: number): ReaderKnowledge {
  const descriptions = new Map<string, string>();
  const rules = new Map<string, CardFact & { position: number }>();
  const events: ReaderKnowledge["events"] = [];
  let coveredChapters = 0;
  for (let index = 0; index <= position && index < memory.orderedIds.length; index += 1) {
    const card = memory.cardAt(index);
    if (!card) continue;
    coveredChapters += 1;
    for (const entity of card.entities) {
      const resolved = memory.resolve(entity.name);
      if (resolved && entity.description.trim()) descriptions.set(resolved.id, entity.description.trim());
    }
    for (const fact of card.facts) {
      if (fact.kind === "rule") rules.set(`${fact.subject}|${fact.value}`, { ...fact, position: index });
      if (fact.kind === "event") events.push({ ...fact, position: index, chapterId: card.chapterId });
    }
  }

  const known: KnownEntity[] = [];
  for (const entity of memory.entities) {
    let mentions = 0;
    let firstSeen = Number.POSITIVE_INFINITY;
    let lastSeen = -1;
    for (const [chapterId, count] of memory.mentions().get(entity.id) ?? []) {
      const at = memory.position(chapterId);
      if (at < 0 || at > position) continue;
      mentions += count;
      firstSeen = Math.min(firstSeen, at);
      lastSeen = Math.max(lastSeen, at);
    }
    if (lastSeen < 0) continue;
    const state = Object.values(memory.stateAt(entity.id, position));
    known.push({ entity, description: descriptions.get(entity.id) ?? "", state, mentions, firstSeen, lastSeen });
  }
  known.sort((left, right) => right.mentions - left.mentions);
  const isCharacter = (category: EntityCategory) => category === "character";

  const openQuestions: ReaderThread[] = [];
  const resolved: ReaderThread[] = [];
  for (const thread of memory.threads) {
    const seen = thread.events.map((event) => ({ event, at: memory.position(event.chapterId) })).filter((item) => item.at >= 0 && item.at <= position).sort((left, right) => left.at - right.at);
    if (!seen.length) continue;
    const payoff = seen.find((item) => item.event.type === "payoff");
    const last = seen[seen.length - 1];
    const entry = { thread, plantedAt: seen[0].at, lastAt: last.at, resolvedAt: payoff ? payoff.at : null, lastNote: last.event.description };
    (payoff ? resolved : openQuestions).push(entry);
  }
  openQuestions.sort((left, right) => left.plantedAt - right.plantedAt);
  resolved.sort((left, right) => (right.resolvedAt ?? 0) - (left.resolvedAt ?? 0));

  const fading = known.filter((item) => item.mentions >= 3 && position - item.lastSeen >= FORGET_GAP).slice(0, 20);
  return {
    position,
    characters: known.filter((item) => isCharacter(item.entity.category)),
    others: known.filter((item) => !isCharacter(item.entity.category)),
    rules: [...rules.values()],
    events: events.slice(-40),
    openQuestions,
    resolved,
    fading,
    hook: memory.cardAt(position)?.hook ?? "",
    coveredChapters,
  };
}

export type UnrevealedSecret = { secret: StorySecret; partial: boolean };

/**
 * Hidden lines whose truth a reader at `position` has not been shown: the reveal chapter comes later or is not set.
 * Without a reveal chapter, a secret marked revealed counts as known.
 */
export function unrevealedSecrets(story: StoryPlan | null, memory: MemoryView, position: number): UnrevealedSecret[] {
  return (story?.secrets ?? []).flatMap((secret) => {
    const revealAt = secret.readerRevealChapterId ? memory.position(secret.readerRevealChapterId) : -1;
    if (revealAt >= 0 ? revealAt <= position : secret.status === "revealed") return [];
    return [{ secret, partial: secret.status === "partial" }];
  });
}
