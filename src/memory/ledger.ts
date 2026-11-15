// Keeps entities and story threads consistent with chapter cards as cards are added, replaced or removed.
import { uniqueId } from "../domain/ids";
import type { WriterProject } from "../types";
import type { ChapterCard, EntityCategory, MemoryEntity, StoryThread } from "./schema";
import { normalizeName } from "./text";

export class EntityRegistry {
  private byName = new Map<string, MemoryEntity>();
  constructor(readonly entities: MemoryEntity[]) {
    for (const entity of entities) this.index(entity);
  }

  private index(entity: MemoryEntity) {
    for (const name of [entity.name, ...entity.aliases]) {
      const key = normalizeName(name);
      if (key && !this.byName.has(key)) this.byName.set(key, entity);
    }
  }

  resolve(name: string): MemoryEntity | null { return this.byName.get(normalizeName(name)) ?? null; }

  /** Finds or creates the entity for a name seen in a chapter; merges new aliases. */
  upsert(input: { name: string; category: EntityCategory; aliases?: string[]; description?: string }): MemoryEntity {
    const names = [input.name, ...(input.aliases ?? [])];
    const existing = names.map((name) => this.resolve(name)).find(Boolean) ?? null;
    if (existing) {
      const known = new Set([existing.name, ...existing.aliases].map(normalizeName));
      const added = names.filter((name) => name.trim() && !known.has(normalizeName(name)));
      if (added.length) {
        existing.aliases = [...existing.aliases, ...added].slice(0, 50);
        existing.updatedAt = Date.now();
        this.index(existing);
      }
      if (!existing.summary && input.description) existing.summary = input.description;
      if (existing.category === "other" && input.category !== "other") existing.category = input.category;
      return existing;
    }
    const entity: MemoryEntity = { id: uniqueId("ent"), name: input.name.trim(), aliases: [...new Set((input.aliases ?? []).filter((alias) => alias.trim() && alias !== input.name))].slice(0, 50), category: input.category, summary: input.description ?? "", origin: "extracted", bibleId: null, updatedAt: Date.now() };
    this.entities.push(entity);
    this.index(entity);
    return entity;
  }

  merge(keepId: string, dropId: string) {
    const keep = this.entities.find((entity) => entity.id === keepId);
    const drop = this.entities.find((entity) => entity.id === dropId);
    if (!keep || !drop || keep === drop) return;
    keep.aliases = [...new Set([...keep.aliases, drop.name, ...drop.aliases].filter((name) => normalizeName(name) !== normalizeName(keep.name)))].slice(0, 80);
    if (!keep.summary) keep.summary = drop.summary;
    keep.bibleId ??= drop.bibleId;
    keep.updatedAt = Date.now();
    this.entities.splice(this.entities.indexOf(drop), 1);
    this.byName.clear();
    for (const entity of this.entities) this.index(entity);
  }
}

/** Registers every entity mentioned by a card. */
export function applyCardEntities(registry: EntityRegistry, card: ChapterCard) {
  for (const entity of card.entities) registry.upsert(entity);
  for (const character of card.characters) registry.upsert({ name: character.name, category: "character" });
  for (const scene of card.scenes) for (const name of scene.characters) registry.upsert({ name, category: "character" });
  for (const fact of card.facts) if (!registry.resolve(fact.subject)) registry.upsert({ name: fact.subject, category: "other" });
}

/** Mirrors curated bible characters/factions into memory entities so names and aliases resolve to them. */
export function syncBibleEntities(registry: EntityRegistry, project: WriterProject) {
  const link = (bibleId: string, name: string, aliases: string[], category: EntityCategory, summary: string) => {
    const linked = registry.entities.find((entity) => entity.bibleId === bibleId);
    const entity = linked ?? registry.upsert({ name, category, aliases, description: summary });
    entity.bibleId = bibleId;
    entity.origin = "user";
    if (summary) entity.summary = summary;
  };
  for (const character of project.characters) link(character.id, character.name, character.aliases, "character", [character.role, character.summary].filter(Boolean).join("。"));
  for (const faction of project.factions) link(faction.id, faction.name, faction.aliases, "faction", faction.summary);
}

/** Removes everything a chapter contributed to threads (before re-extraction or deletion). */
export function retractChapterThreads(threads: StoryThread[], chapterId: string): StoryThread[] {
  const next: StoryThread[] = [];
  for (const thread of threads) {
    const events = thread.events.filter((event) => event.chapterId !== chapterId);
    if (!events.length && thread.origin === "extracted") continue;
    const changed = events.length !== thread.events.length;
    if (!changed) { next.push(thread); continue; }
    const updated: StoryThread = { ...thread, events, status: thread.status === "abandoned" ? "abandoned" : events.some((event) => event.type === "payoff") ? "paid" : "open", updatedAt: Date.now() };
    updated.progress = threadProgress(updated, true);
    next.push(updated);
  }
  return next;
}

/** Paid threads are complete; open ones move a step with every advance, never past 0.9. The author's own estimate is kept unless `recompute`. */
export function threadProgress(thread: StoryThread, recompute = false): number {
  if (thread.status === "paid") return 1;
  const advances = thread.events.filter((event) => event.type === "advance").length;
  const derived = thread.events.length ? Math.min(0.9, 0.1 + advances * 0.2) : 0;
  return recompute ? derived : Math.max(thread.progress, derived);
}

/** Folds a card's thread events into the thread ledger. Unknown thread ids fall back to title matching. */
export function applyCardThreads(threads: StoryThread[], card: ChapterCard): StoryThread[] {
  const next = retractChapterThreads(threads, card.chapterId);
  const byId = new Map(next.map((thread) => [thread.id, thread]));
  const byTitle = new Map(next.map((thread) => [normalizeName(thread.title), thread]));
  for (const event of card.threads) {
    let thread = (event.threadId ? byId.get(event.threadId) : undefined) ?? (event.title ? byTitle.get(normalizeName(event.title)) : undefined);
    if (!thread) {
      thread = { id: uniqueId("thread"), title: event.title || event.description.slice(0, 20), description: event.description, status: "open", events: [], origin: "extracted", updatedAt: Date.now(), kind: event.kind, tier: event.tier, plan: "", targetChapterId: null, progress: 0, successorIds: [] };
      next.push(thread);
      byId.set(thread.id, thread);
      byTitle.set(normalizeName(thread.title), thread);
    }
    thread.events.push({ chapterId: card.chapterId, type: event.type, description: event.description });
    if (event.type === "payoff" && thread.status === "open") thread.status = "paid";
    thread.progress = threadProgress(thread);
    thread.updatedAt = Date.now();
  }
  return next;
}

/** Candidate pairs that may be the same entity (nicknames, partial names). Exact alias matches are merged already. */
export function mergeCandidates(entities: MemoryEntity[], limit = 80): [MemoryEntity, MemoryEntity][] {
  const pairs: [MemoryEntity, MemoryEntity][] = [];
  const groups = new Map<EntityCategory, MemoryEntity[]>();
  for (const entity of entities) groups.set(entity.category, [...(groups.get(entity.category) ?? []), entity]);
  for (const group of groups.values()) {
    for (let i = 0; i < group.length && pairs.length < limit; i += 1) {
      for (let j = i + 1; j < group.length && pairs.length < limit; j += 1) {
        if (similarNames(group[i], group[j])) pairs.push([group[i], group[j]]);
      }
    }
  }
  return pairs;
}

function similarNames(left: MemoryEntity, right: MemoryEntity) {
  const a = normalizeName(left.name);
  const b = normalizeName(right.name);
  if (a.length < 2 || b.length < 2) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const stripped = (name: string) => name.replace(/^(小|老|阿)/, "").replace(/(哥|姐|兄|弟|妹|叔|伯|爷|儿|子)$/, "");
  const sa = stripped(a);
  const sb = stripped(b);
  return sa.length >= 1 && sb.length >= 1 && (sa === sb || (sa.length >= 2 && sb.endsWith(sa)) || (sb.length >= 2 && sa.endsWith(sb)));
}
