// In-memory, read-only view over a project's story memory with derived indexes for retrieval.
import { chapterPositions, orderedChapters } from "../domain/documents";
import type { WriterProject } from "../types";
import { EntityRegistry } from "./ledger";
import { CARD_VERSION, type CardFact, type ChapterCard, type MemoryAggregates, type MemoryConflict, type MemoryEntity, type MemoryStatus, type StoryThread } from "./schema";
import { MemoryStore } from "./store";
import { Bm25Index } from "./text";

export type PositionedFact = CardFact & { chapterId: string; position: number };
export type EntityState = Record<string, PositionedFact>;

export class MemoryView {
  readonly positions: Map<string, number>;
  readonly orderedIds: string[];
  readonly registry: EntityRegistry;
  private mentionIndex: Map<string, Map<string, number>> | null = null;
  private factIndex: Map<string, PositionedFact[]> | null = null;
  private bm25: Bm25Index | null = null;

  constructor(
    readonly project: WriterProject,
    readonly cards: Map<string, ChapterCard>,
    readonly entities: MemoryEntity[],
    readonly threads: StoryThread[],
    readonly aggregates: MemoryAggregates,
    readonly conflicts: MemoryConflict[],
    readonly status: MemoryStatus,
  ) {
    this.positions = chapterPositions(project);
    this.orderedIds = orderedChapters(project).map((chapter) => chapter.id);
    this.registry = new EntityRegistry(entities);
  }

  static async load(project: WriterProject): Promise<MemoryView> {
    const store = new MemoryStore(project.id);
    const [cards, entities, threads, aggregates, conflicts, status] = await Promise.all([store.loadCards(), store.loadEntities(), store.loadThreads(), store.loadAggregates(), store.loadConflicts(), store.loadStatus()]);
    return new MemoryView(project, cards, entities, threads, aggregates, conflicts, status);
  }

  /** Same memory against updated project metadata (reorders, renames) without reloading files. */
  withProject(project: WriterProject) { return new MemoryView(project, this.cards, this.entities, this.threads, this.aggregates, this.conflicts, this.status); }

  get isEmpty() { return this.cards.size === 0; }
  position(chapterId: string) { return this.positions.get(chapterId) ?? -1; }
  cardAt(position: number) { const id = this.orderedIds[position]; return id ? this.cards.get(id) ?? null : null; }

  /** Chapters without a card, or whose card was extracted from an older version of the text. */
  staleChapterIds(): string[] {
    return orderedChapters(this.project).filter((chapter) => { if (chapter.wordCount <= 0) return false; const card = this.cards.get(chapter.id); return card?.sourceHash !== chapter.contentHash || card.version !== CARD_VERSION; }).map((chapter) => chapter.id);
  }

  coverage() {
    const withText = this.project.chapters.filter((chapter) => chapter.wordCount > 0).length;
    return { total: withText, fresh: withText - this.staleChapterIds().length };
  }

  entity(id: string) { return this.entities.find((entity) => entity.id === id) ?? null; }
  resolve(name: string) { return this.registry.resolve(name); }

  /** entity id -> chapter id -> mention count. */
  mentions(): Map<string, Map<string, number>> {
    if (this.mentionIndex) return this.mentionIndex;
    const index = new Map<string, Map<string, number>>();
    for (const card of this.cards.values()) {
      for (const [name, count] of Object.entries(card.mentions)) {
        const entity = this.registry.resolve(name);
        if (!entity) continue;
        const chapters = index.get(entity.id) ?? new Map<string, number>();
        chapters.set(card.chapterId, (chapters.get(card.chapterId) ?? 0) + count);
        index.set(entity.id, chapters);
      }
    }
    this.mentionIndex = index;
    return index;
  }

  mentionCount(entityId: string) { let total = 0; for (const count of this.mentions().get(entityId)?.values() ?? []) total += count; return total; }

  chaptersOf(entityId: string): string[] {
    return [...(this.mentions().get(entityId)?.keys() ?? [])].sort((left, right) => this.position(left) - this.position(right));
  }

  /** Facts about an entity in reading order. */
  facts(entityId: string): PositionedFact[] {
    if (!this.factIndex) {
      const index = new Map<string, PositionedFact[]>();
      for (const card of this.cards.values()) {
        const position = this.position(card.chapterId);
        if (position < 0) continue;
        for (const fact of card.facts) {
          const entity = this.registry.resolve(fact.subject);
          if (!entity) continue;
          const list = index.get(entity.id) ?? [];
          list.push({ ...fact, chapterId: card.chapterId, position });
          index.set(entity.id, list);
        }
      }
      for (const list of index.values()) list.sort((left, right) => left.position - right.position);
      this.factIndex = index;
    }
    return this.factIndex.get(entityId) ?? [];
  }

  /** Latest value of every state/trait attribute at or before `position`. */
  stateAt(entityId: string, position: number): EntityState {
    const state: EntityState = {};
    for (const fact of this.facts(entityId)) {
      if (fact.position > position) break;
      if (fact.kind === "state" || fact.kind === "trait") state[fact.attribute] = fact;
    }
    return state;
  }

  /** Entities whose name or alias occurs in `text`, most mentioned first. */
  entitiesIn(text: string, limit = 30): MemoryEntity[] {
    const found = this.entities.filter((entity) => [entity.name, ...entity.aliases].some((name) => name.length >= 2 && text.includes(name)));
    return found.sort((left, right) => this.mentionCount(right.id) - this.mentionCount(left.id)).slice(0, limit);
  }

  searchCards(query: string, limit = 10, beforePosition = Number.POSITIVE_INFINITY) {
    if (!this.bm25) {
      const index = new Bm25Index();
      for (const card of this.cards.values()) index.add(card.chapterId, cardSearchText(card));
      this.bm25 = index;
    }
    return this.bm25.search(query, limit * 3).filter((hit) => this.position(hit.id) >= 0 && this.position(hit.id) < beforePosition).slice(0, limit);
  }

  /** Past chapters where the given entities appear together, weighted by co-occurrence and recency. */
  relatedChapters(entityIds: string[], beforePosition: number, limit = 6): string[] {
    const scores = new Map<string, number>();
    for (const entityId of entityIds) {
      for (const [chapterId, count] of this.mentions().get(entityId) ?? []) {
        const position = this.position(chapterId);
        if (position < 0 || position >= beforePosition) continue;
        scores.set(chapterId, (scores.get(chapterId) ?? 0) + 1 + Math.log(1 + count));
      }
    }
    for (const [chapterId, score] of scores) {
      const card = this.cards.get(chapterId);
      const keyEvents = card ? card.threads.length + card.facts.filter((fact) => fact.kind === "event").length : 0;
      const recency = 1 / (1 + (beforePosition - this.position(chapterId)) / 200);
      scores.set(chapterId, score * (1 + recency) + keyEvents * 0.2);
    }
    return [...scores].sort((left, right) => right[1] - left[1]).slice(0, limit).map(([chapterId]) => chapterId);
  }

  openThreads(beforePosition = Number.POSITIVE_INFINITY): (StoryThread & { plantedAt: number; age: number })[] {
    return this.threads
      .filter((thread) => thread.status === "open")
      .map((thread) => {
        const positions = thread.events.map((event) => this.position(event.chapterId)).filter((position) => position >= 0);
        const plantedAt = positions.length ? Math.min(...positions) : -1;
        return { ...thread, plantedAt, age: Number.isFinite(beforePosition) ? beforePosition - plantedAt : this.orderedIds.length - plantedAt };
      })
      .filter((thread) => thread.plantedAt < beforePosition)
      .sort((left, right) => right.age - left.age);
  }
}

export function cardSearchText(card: ChapterCard) {
  return [card.summary, card.hook, ...card.scenes.map((scene) => `${scene.title} ${scene.location} ${scene.summary}`), ...card.facts.map((fact) => `${fact.subject}${fact.attribute}${fact.value}`), ...card.threads.map((thread) => `${thread.title}${thread.description}`)].join("\n");
}

const cache = new Map<string, { key: string; view: MemoryView }>();

/** Cached load keyed by memory status timestamp so the UI re-reads memory only after it changed. */
export async function loadMemoryView(project: WriterProject, force = false): Promise<MemoryView> {
  const status = await new MemoryStore(project.id).loadStatus();
  const key = `${status.updatedAt}`;
  const cached = cache.get(project.id);
  if (!force && cached && cached.key === key) return cached.view.withProject(project);
  const view = await MemoryView.load(project);
  cache.set(project.id, { key, view });
  return view;
}

export function invalidateMemoryView(projectId: string) { cache.delete(projectId); }
