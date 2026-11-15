// Derived reads over story memory and the story plan: which threads matter now, what each character knows, and how
// recent chapters paid off and moved the reader's emotion.
import { chapterLabel } from "../domain/documents";
import type { EmotionBeat, StoryThread } from "../memory/schema";
import type { MemoryView } from "../memory/view";
import type { StoryPlan, StorySecret } from "./schema";

export type PositionedThread = StoryThread & { plantedAt: number; lastAt: number; paidAt: number | null; age: number };

/** Threads with their first/last/payoff positions in reading order. Threads with no located event start at -1. */
export function positionedThreads(memory: MemoryView): PositionedThread[] {
  const total = memory.orderedIds.length;
  return memory.threads.map((thread) => {
    const positions = thread.events.map((event) => memory.position(event.chapterId)).filter((position) => position >= 0);
    const payoffs = thread.events.filter((event) => event.type === "payoff").map((event) => memory.position(event.chapterId)).filter((position) => position >= 0);
    const plantedAt = positions.length ? Math.min(...positions) : -1;
    const lastAt = positions.length ? Math.max(...positions) : -1;
    return { ...thread, plantedAt, lastAt, paidAt: payoffs.length ? Math.min(...payoffs) : null, age: plantedAt >= 0 ? total - plantedAt : 0 };
  });
}

/** Whether the thread is waiting for its payoff as of `position` (planted before it, not paid or dropped before it). */
export function isOpenAt(thread: PositionedThread, position: number) {
  if (thread.plantedAt < 0 || thread.plantedAt >= position) return thread.plantedAt < 0 && thread.status === "open";
  if (thread.status === "abandoned") return false;
  return thread.paidAt === null || thread.paidAt >= position;
}

/** Reader-facing threads (expectations and mysteries) open as of `position`, most advanced first. */
export function activeExpectations(memory: MemoryView, position: number): PositionedThread[] {
  return positionedThreads(memory).filter((thread) => thread.kind !== "foreshadow" && isOpenAt(thread, position)).sort((left, right) => right.progress - left.progress);
}

/**
 * Open threads ranked by how much they matter for the chapter at `position`: shared names with the chapter's
 * characters and focus, a planned payoff close ahead, reader-facing kind, and age.
 */
export function relevantThreads(memory: MemoryView, position: number, names: string[], limit = 15): PositionedThread[] {
  const terms = names.filter((name) => name.length >= 2);
  const scored = positionedThreads(memory).filter((thread) => isOpenAt(thread, position)).map((thread) => {
    const text = `${thread.title}${thread.description}${thread.plan}`;
    let score = terms.filter((term) => text.includes(term)).length * 5;
    if (thread.targetChapterId) {
      const target = memory.position(thread.targetChapterId);
      if (target >= position && target - position <= 5) score += 4;
      else if (target >= position && target - position <= 20) score += 2;
      else if (target >= 0 && target < position) score += 3;
    }
    if (thread.kind !== "foreshadow") score += 1;
    if (thread.progress >= 0.5) score += 1;
    score += Math.min(1.5, Math.max(0, position - thread.lastAt) / 60);
    return { thread, score };
  });
  return scored.sort((left, right) => right.score - left.score).slice(0, limit).map((item) => item.thread);
}

export type KnowledgeState = { known: { secret: StorySecret; chapterId: string | null; source: string }[]; unknown: StorySecret[] };

/** Which tracked secrets `who` (a name or alias) knows before the chapter at `position`. */
export function knowledgeAt(plan: StoryPlan, memory: MemoryView | null, who: string, position: number, aliases: string[] = []): KnowledgeState {
  const names = new Set([who, ...aliases].map((name) => name.trim()).filter(Boolean));
  const known: KnowledgeState["known"] = [];
  const unknown: StorySecret[] = [];
  for (const secret of plan.secrets) {
    const entry = secret.knownBy.find((item) => names.has(item.who) && (!item.chapterId || !memory || memory.position(item.chapterId) < position));
    if (entry) known.push({ secret, chapterId: entry.chapterId, source: entry.source });
    else unknown.push(secret);
  }
  return { known, unknown };
}

/** Knowledge lines for the characters named in `names`, for the writer and the reviewer. */
export function knowledgeLines(plan: StoryPlan | null, memory: MemoryView | null, names: string[], position: number): string[] {
  if (!plan?.secrets.length) return [];
  return names.flatMap((name) => {
    const state = knowledgeAt(plan, memory, name, position, memory?.resolve(name)?.aliases ?? []);
    if (!state.known.length && !state.unknown.length) return [];
    const known = state.known.map((item) => `${item.secret.title}${item.chapterId && memory ? `（${chapterLabel(memory.position(item.chapterId))}，${item.source || "来源未记"}）` : ""}`).join("；");
    const unknown = state.unknown.map((secret) => secret.title).join("；");
    return [`- ${name}：已知 ${known || "无"}｜不知道 ${unknown || "无"}`];
  });
}

/** Chapters of absence after which readers need a line to remember who someone is. */
export const RECALL_GAP = 20;

/** The cast list contains names; a free-form focal description is not another person. */
export function sceneCast(scene: { characters: string[]; focal: string }, memory: MemoryView | null = null): string[] {
  const names = scene.characters.map((name) => name.trim()).filter(Boolean);
  const focal = memory?.resolve(scene.focal.trim());
  if (focal?.category === "character") names.push(focal.name);
  return [...new Set(names)];
}

/** The last chapter before `position` in which `name` appears on the page; -1 when readers have never seen them. */
export function lastSeenBefore(memory: MemoryView, name: string, position: number): number {
  const entity = memory.resolve(name);
  let last = -1;
  for (const chapterId of (entity ? memory.mentions().get(entity.id)?.keys() : undefined) ?? []) {
    const at = memory.position(chapterId);
    if (at >= 0 && at < position) last = Math.max(last, at);
  }
  return last;
}

/**
 * What readers remember of the characters in `names` when they reach `position`: the writer works from the whole
 * memory, readers only from the page. Someone never on the page is new to them; someone last seen RECALL_GAP or more
 * chapters back needs a line to be recognised. People seen lately are left out.
 */
export function readerCues(memory: MemoryView | null, names: string[], position: number): string[] {
  if (!memory || memory.isEmpty) return [];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const name of names.map((item) => item.trim()).filter(Boolean)) {
    const entity = memory.resolve(name);
    const key = entity?.id ?? name;
    if (seen.has(key)) continue;
    seen.add(key);
    const last = lastSeenBefore(memory, name, position);
    if (last < 0) lines.push(`- ${name}：读者第一次见，出场时交代这是谁、和眼前的事有什么关系`);
    else if (position - last >= RECALL_GAP) lines.push(`- ${entity?.name ?? name}：上次出场在${chapterLabel(last)}，隔了 ${position - last} 章，回来时带一句让读者想起这是谁`);
  }
  return lines;
}

/** Payoff types of the `count` chapters before `position`, oldest first; chapters without a payoff are skipped. */
export function recentPayoffTypes(memory: MemoryView, position: number, count = 6): { position: number; types: string[] }[] {
  const result: { position: number; types: string[] }[] = [];
  for (let index = Math.max(0, position - count); index < position; index += 1) {
    const card = memory.cardAt(index);
    if (card?.payoffs.length) result.push({ position: index, types: [...new Set(card.payoffs.map((payoff) => payoff.type))] });
  }
  return result;
}

/** Emotion beats of the `count` chapters before `position`, in reading order. */
export function emotionTrend(memory: MemoryView, position: number, count = 5): { position: number; beats: EmotionBeat[] }[] {
  const result: { position: number; beats: EmotionBeat[] }[] = [];
  for (let index = Math.max(0, position - count); index < position; index += 1) {
    const card = memory.cardAt(index);
    if (card?.emotionBeats.length) result.push({ position: index, beats: card.emotionBeats });
  }
  return result;
}

/** Suppressed beats since the last release before `position`. */
export function pendingSuppression(memory: MemoryView, position: number): EmotionBeat[] {
  const pending: EmotionBeat[] = [];
  for (let index = 0; index < position; index += 1) {
    for (const beat of memory.cardAt(index)?.emotionBeats ?? []) {
      if (beat.type === "release") pending.length = 0;
      else if (beat.type === "suppress") pending.push(beat);
    }
  }
  return pending;
}
