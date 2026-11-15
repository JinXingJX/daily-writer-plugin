import { contentHash } from "../domain/ids";
import { arrayValue, asRecord, finiteNumber, mapLimit, nullableString, stringArray, stringValue } from "../domain/util";
import { readJson, writeJson } from "../storage/io";
import { withWriterMutationLock } from "../storage/lock";
import { memoryDir } from "../storage/paths";
import {
  CARD_SHARDS,
  CARD_VERSION,
  emptyStatus,
  ENTITY_CATEGORIES,
  type CardFact,
  type ChapterCard,
  type EntityCategory,
  type FactKind,
  type MemoryAggregates,
  type MemoryConflict,
  type MemoryEntity,
  type MemoryStatus,
  CHANGE_KINDS,
  EMOTION_BEAT_TYPES,
  THREAD_KINDS,
  THREAD_TIERS,
  type ChangeKind,
  type EmotionBeatType,
  type StoryThread,
  type ThreadEventType,
  type ThreadKind,
  type ThreadTier,
} from "./schema";

const FACT_KINDS: FactKind[] = ["state", "trait", "event", "rule"];
const EVENT_TYPES: ThreadEventType[] = ["plant", "advance", "payoff"];

export function shardOf(chapterId: string) { return parseInt(contentHash(chapterId).slice(0, 4), 36) % CARD_SHARDS; }

/** File-backed memory of one project. Writes go through a per-project memory lock. */
export class MemoryStore {
  constructor(readonly projectId: string) {}

  private path(name: string) { return `${memoryDir(this.projectId)}/${name}`; }
  private shardPath(shard: number) { return this.path(`cards/${String(shard).padStart(2, "0")}.json`); }

  withLock<T>(task: () => Promise<T>) { return withWriterMutationLock(task, `writer.memory.lock.${this.projectId}`); }

  async loadCards(): Promise<Map<string, ChapterCard>> {
    const cards = new Map<string, ChapterCard>();
    const shards = await mapLimit(Array.from({ length: CARD_SHARDS }, (_, index) => index), 8, (shard) => this.readShard(shard));
    for (const shard of shards) for (const card of shard.values()) cards.set(card.chapterId, card);
    return cards;
  }

  async loadCard(chapterId: string): Promise<ChapterCard | null> {
    return (await this.readShard(shardOf(chapterId))).get(chapterId) ?? null;
  }

  /** Writes cards grouped by shard. Caller holds the memory lock when other writers may run. */
  async putCards(cards: ChapterCard[]) {
    const byShard = new Map<number, ChapterCard[]>();
    for (const card of cards) byShard.set(shardOf(card.chapterId), [...(byShard.get(shardOf(card.chapterId)) ?? []), card]);
    for (const [shard, items] of byShard) {
      const current = await this.readShard(shard);
      for (const card of items) current.set(card.chapterId, card);
      await writeJson(this.shardPath(shard), { cards: [...current.values()] });
    }
  }

  async removeCards(chapterIds: string[]) {
    const byShard = new Map<number, string[]>();
    for (const id of chapterIds) byShard.set(shardOf(id), [...(byShard.get(shardOf(id)) ?? []), id]);
    for (const [shard, ids] of byShard) {
      const current = await this.readShard(shard);
      if (!ids.some((id) => current.delete(id))) continue;
      await writeJson(this.shardPath(shard), { cards: [...current.values()] });
    }
  }

  private async readShard(shard: number): Promise<Map<string, ChapterCard>> {
    const stored = asRecord(await readJson(this.shardPath(shard)).catch(() => undefined));
    return new Map(arrayValue(stored.cards).flatMap((value) => { const card = normalizeCard(value); return card ? [[card.chapterId, card] as const] : []; }));
  }

  async loadEntities(): Promise<MemoryEntity[]> {
    return arrayValue(asRecord(await readJson(this.path("entities.json")).catch(() => undefined)).entities).flatMap((value) => normalizeEntity(value) ?? []);
  }
  async saveEntities(entities: MemoryEntity[]) { await writeJson(this.path("entities.json"), { entities }); }

  async loadThreads(): Promise<StoryThread[]> {
    return arrayValue(asRecord(await readJson(this.path("threads.json")).catch(() => undefined)).threads).flatMap((value) => normalizeThread(value) ?? []);
  }
  async saveThreads(threads: StoryThread[]) { await writeJson(this.path("threads.json"), { threads }); }

  async loadAggregates(): Promise<MemoryAggregates> {
    const stored = asRecord(await readJson(this.path("aggregates.json")).catch(() => undefined));
    return {
      arcs: arrayValue(stored.arcs).map((value) => value as MemoryAggregates["arcs"][number]).filter((arc) => typeof arc?.id === "string"),
      volumes: arrayValue(stored.volumes).map((value) => value as MemoryAggregates["volumes"][number]).filter((volume) => typeof volume?.volumeId === "string"),
      book: stored.book && typeof asRecord(stored.book).outline === "string" ? stored.book as MemoryAggregates["book"] : null,
      worldview: stored.worldview && Array.isArray(asRecord(stored.worldview).sections) ? stored.worldview as MemoryAggregates["worldview"] : null,
    };
  }
  async saveAggregates(aggregates: MemoryAggregates) { await writeJson(this.path("aggregates.json"), aggregates); }

  async loadConflicts(): Promise<MemoryConflict[]> {
    return arrayValue(asRecord(await readJson(this.path("conflicts.json")).catch(() => undefined)).conflicts).filter((value): value is MemoryConflict => typeof asRecord(value).id === "string");
  }
  async saveConflicts(conflicts: MemoryConflict[]) { await writeJson(this.path("conflicts.json"), { conflicts }); }

  async loadStatus(): Promise<MemoryStatus> {
    const stored = asRecord(await readJson(this.path("status.json")).catch(() => undefined));
    const base = emptyStatus();
    return { ...base, ...stored, failures: asRecord(stored.failures) as MemoryStatus["failures"], usage: { ...base.usage, ...asRecord(stored.usage) } } as MemoryStatus;
  }
  async saveStatus(status: MemoryStatus) { await writeJson(this.path("status.json"), { ...status, updatedAt: Date.now() }); }
}

export function normalizeCard(value: unknown): ChapterCard | null {
  const card = asRecord(value);
  if (typeof card.chapterId !== "string" || !card.chapterId) return null;
  return {
    chapterId: card.chapterId,
    sourceHash: stringValue(card.sourceHash),
    version: finiteNumber(card.version, CARD_VERSION),
    summary: stringValue(card.summary),
    scenes: arrayValue(card.scenes).map((item) => { const scene = asRecord(item); return { title: stringValue(scene.title), time: stringValue(scene.time), location: stringValue(scene.location), characters: stringArray(scene.characters, 40), summary: stringValue(scene.summary) }; }).slice(0, 30),
    characters: arrayValue(card.characters).flatMap((item) => { const character = asRecord(item); const name = stringValue(character.name).trim(); return name ? [{ name, change: stringValue(character.change) }] : []; }).slice(0, 60),
    entities: arrayValue(card.entities).flatMap((item) => { const entity = asRecord(item); const name = stringValue(entity.name).trim(); return name ? [{ name, category: categoryValue(entity.category), aliases: stringArray(entity.aliases, 20), description: stringValue(entity.description) }] : []; }).slice(0, 120),
    facts: arrayValue(card.facts).flatMap((item) => normalizeFact(item) ?? []).slice(0, 200),
    threads: arrayValue(card.threads).flatMap((item) => {
      const event = asRecord(item);
      const type = EVENT_TYPES.includes(event.type as ThreadEventType) ? event.type as ThreadEventType : null;
      const description = stringValue(event.description).trim();
      return type && (description || event.threadId) ? [{ threadId: nullableString(event.threadId), type, title: stringValue(event.title).trim(), description, kind: threadKindValue(event.kind), tier: threadTierValue(event.tier) }] : [];
    }).slice(0, 40),
    hook: stringValue(card.hook),
    emotionBeats: arrayValue(card.emotionBeats).flatMap((item) => { const beat = asRecord(item); return EMOTION_BEAT_TYPES.includes(beat.type as EmotionBeatType) ? [{ type: beat.type as EmotionBeatType, reason: stringValue(beat.reason) }] : []; }).slice(0, 20),
    payoffs: arrayValue(card.payoffs).flatMap((item) => { const payoff = asRecord(item); const type = stringValue(payoff.type).trim(); return type ? [{ type: type.slice(0, 12), description: stringValue(payoff.description) }] : []; }).slice(0, 10),
    changes: [...new Set(stringArray(card.changes, 10).filter((kind): kind is ChangeKind => CHANGE_KINDS.includes(kind as ChangeKind)))],
    knowledge: arrayValue(card.knowledge).flatMap((item) => { const entry = asRecord(item); const who = stringValue(entry.who).trim(); const learns = stringValue(entry.learns).trim(); return who && learns ? [{ who, learns, source: stringValue(entry.source), secretId: nullableString(entry.secretId) }] : []; }).slice(0, 30),
    intimacy: arrayValue(card.intimacy).flatMap((item) => { const entry = asRecord(item); const a = stringValue(entry.a).trim(); const b = stringValue(entry.b).trim(); const delta = Math.round(finiteNumber(entry.delta, 0)); return a && b && delta ? [{ a, b, delta: Math.max(-10, Math.min(10, delta)), event: stringValue(entry.event) }] : []; }).slice(0, 20),
    newCast: stringArray(card.newCast, 40).filter((name) => name.trim()),
    mentions: Object.fromEntries(Object.entries(asRecord(card.mentions)).filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)),
    extractedAt: finiteNumber(card.extractedAt, 0),
  };
}

export function normalizeFact(value: unknown): CardFact | null {
  const fact = asRecord(value);
  const subject = stringValue(fact.subject).trim();
  const attribute = stringValue(fact.attribute).trim();
  const factValue = stringValue(fact.value).trim();
  if (!subject || !attribute || !factValue) return null;
  return { subject, attribute, value: factValue, kind: FACT_KINDS.includes(fact.kind as FactKind) ? fact.kind as FactKind : "state", quote: stringValue(fact.quote).slice(0, 200) };
}

export function categoryValue(value: unknown): EntityCategory {
  if (ENTITY_CATEGORIES.includes(value as EntityCategory)) return value as EntityCategory;
  const text = String(value ?? "");
  if (/人|角色|character/i.test(text)) return "character";
  if (/地|城|location|place/i.test(text)) return "location";
  if (/派|宗|门|组织|势力|faction/i.test(text)) return "faction";
  if (/物|器|item/i.test(text)) return "item";
  if (/功|法|技|能力|skill/i.test(text)) return "skill";
  return "term";
}

function normalizeEntity(value: unknown): MemoryEntity | null {
  const entity = asRecord(value);
  if (typeof entity.id !== "string" || typeof entity.name !== "string") return null;
  return { id: entity.id, name: entity.name, aliases: stringArray(entity.aliases, 50), category: categoryValue(entity.category), summary: stringValue(entity.summary), origin: entity.origin === "user" ? "user" : "extracted", bibleId: nullableString(entity.bibleId), updatedAt: finiteNumber(entity.updatedAt, 0) };
}

export function normalizeThread(value: unknown): StoryThread | null {
  const thread = asRecord(value);
  if (typeof thread.id !== "string") return null;
  const status = thread.status === "paid" || thread.status === "abandoned" ? thread.status : "open";
  return {
    id: thread.id,
    title: stringValue(thread.title) || "未命名线索",
    description: stringValue(thread.description),
    status,
    events: arrayValue(thread.events).flatMap((item) => { const event = asRecord(item); return typeof event.chapterId === "string" && EVENT_TYPES.includes(event.type as ThreadEventType) ? [{ chapterId: event.chapterId, type: event.type as ThreadEventType, description: stringValue(event.description) }] : []; }),
    origin: thread.origin === "user" ? "user" : "extracted",
    updatedAt: finiteNumber(thread.updatedAt, 0),
    kind: threadKindValue(thread.kind),
    tier: threadTierValue(thread.tier),
    plan: stringValue(thread.plan),
    targetChapterId: nullableString(thread.targetChapterId),
    progress: Math.max(0, Math.min(1, finiteNumber(thread.progress, 0))),
    successorIds: stringArray(thread.successorIds, 20),
  };
}

export function threadKindValue(value: unknown): ThreadKind { return THREAD_KINDS.includes(value as ThreadKind) ? value as ThreadKind : "foreshadow"; }
export function threadTierValue(value: unknown): ThreadTier { return THREAD_TIERS.includes(value as ThreadTier) ? value as ThreadTier : "short"; }
