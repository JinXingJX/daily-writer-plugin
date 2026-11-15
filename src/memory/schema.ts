// Story memory: everything AI knows about a long manuscript, derived from chapter text and kept incrementally.

export const CARD_VERSION = 2;
export const CARD_SHARDS = 64;

export type EntityCategory = "character" | "location" | "faction" | "item" | "skill" | "term" | "other";
export const ENTITY_CATEGORIES: EntityCategory[] = ["character", "location", "faction", "item", "skill", "term", "other"];
export const ENTITY_CATEGORY_LABELS: Record<EntityCategory, string> = { character: "人物", location: "地点", faction: "势力", item: "物品", skill: "功法/能力", term: "术语", other: "其他" };

export type CardScene = { title: string; time: string; location: string; characters: string[]; summary: string };
/** `state` changes over time (location, injury, realm); `trait` should stay constant (birth, appearance); `rule` is a world rule. */
export type FactKind = "state" | "trait" | "event" | "rule";
export type CardFact = { subject: string; attribute: string; value: string; kind: FactKind; quote: string };
export type ThreadEventType = "plant" | "advance" | "payoff";
/** foreshadow: a planted object or line that pays off later; expectation: something readers are waiting to see; mystery: an open question. */
export type ThreadKind = "foreshadow" | "expectation" | "mystery";
export const THREAD_KINDS: ThreadKind[] = ["foreshadow", "expectation", "mystery"];
export const THREAD_KIND_LABELS: Record<ThreadKind, string> = { foreshadow: "伏笔", expectation: "期待", mystery: "悬念" };
/** How far ahead the thread reaches: within the chapter, a few chapters, an arc, a volume, or the whole book. */
export type ThreadTier = "chapter" | "short" | "arc" | "volume" | "ultimate";
export const THREAD_TIERS: ThreadTier[] = ["chapter", "short", "arc", "volume", "ultimate"];
export const THREAD_TIER_LABELS: Record<ThreadTier, string> = { chapter: "章内", short: "短线", arc: "中线", volume: "卷级", ultimate: "终极" };
export type CardThreadEvent = { threadId: string | null; type: ThreadEventType; title: string; description: string; kind: ThreadKind; tier: ThreadTier };
export type CardEntity = { name: string; category: EntityCategory; aliases: string[]; description: string };
export type CardCharacter = { name: string; change: string };
/** rise/fall move the reader's emotion; suppress holds an outburst back for a reason; release lets it out. */
export type EmotionBeatType = "rise" | "fall" | "suppress" | "release";
export const EMOTION_BEAT_TYPES: EmotionBeatType[] = ["rise", "fall", "suppress", "release"];
export const EMOTION_BEAT_LABELS: Record<EmotionBeatType, string> = { rise: "升", fall: "落", suppress: "压", release: "放" };
export type EmotionBeat = { type: EmotionBeatType; reason: string };
/** A payoff moment of the chapter (打脸, 智取, 守护, 认可, 揭穿, 收获, 反转…). */
export type CardPayoff = { type: string; description: string };
/** What the chapter changed for the characters. */
export type ChangeKind = "info" | "relation" | "resource" | "risk" | "judgment";
export const CHANGE_KINDS: ChangeKind[] = ["info", "relation", "resource", "risk", "judgment"];
export const CHANGE_KIND_LABELS: Record<ChangeKind, string> = { info: "信息", relation: "关系", resource: "资源", risk: "风险", judgment: "判断" };
/** Who learned what in this chapter, and how. `secretId` links a tracked secret of the story plan. */
export type CardKnowledge = { who: string; learns: string; source: string; secretId: string | null };
/** A shift in how close two characters are; `delta` is on a 0-10 scale. */
export type CardIntimacy = { a: string; b: string; delta: number; event: string };

export type ChapterCard = {
  chapterId: string;
  /** contentHash of the chapter body this card was extracted from. */
  sourceHash: string;
  version: number;
  summary: string;
  scenes: CardScene[];
  characters: CardCharacter[];
  entities: CardEntity[];
  facts: CardFact[];
  threads: CardThreadEvent[];
  hook: string;
  emotionBeats: EmotionBeat[];
  payoffs: CardPayoff[];
  changes: ChangeKind[];
  knowledge: CardKnowledge[];
  intimacy: CardIntimacy[];
  /** Characters who appear for the first time. */
  newCast: string[];
  /** Surface name -> occurrences in the chapter text (counted deterministically, not by the model). */
  mentions: Record<string, number>;
  extractedAt: number;
};

export type MemoryEntity = {
  id: string;
  name: string;
  aliases: string[];
  category: EntityCategory;
  /** Short dossier. Extracted entities get a generated profile; user entities keep what the author wrote. */
  summary: string;
  origin: "extracted" | "user";
  /** Linked Writer bible id (character or faction) when the entity mirrors a curated record. */
  bibleId: string | null;
  updatedAt: number;
};

export type ThreadStatus = "open" | "paid" | "abandoned";
export type ThreadEvent = { chapterId: string; type: ThreadEventType; description: string };
/**
 * A foreshadowing thread, reader expectation or mystery. `plan` is the author's payoff plan, `targetChapterId` where it
 * should pay off, `progress` (0-1) how far it has advanced, and `successorIds` the threads meant to take over once it pays off.
 */
export type StoryThread = {
  id: string; title: string; description: string; status: ThreadStatus; events: ThreadEvent[]; origin: "extracted" | "user"; updatedAt: number;
  kind: ThreadKind; tier: ThreadTier; plan: string; targetChapterId: string | null; progress: number; successorIds: string[];
};
export type ThreadOperation = { type: "upsertThread"; thread: StoryThread } | { type: "removeThread"; id: string };

export type ArcSummary = { id: string; volumeId: string; index: number; chapterIds: string[]; inputHash: string; title: string; summary: string; conflicts: string; growth: string; generatedAt: number };
export type VolumeSummary = { volumeId: string; inputHash: string; summary: string; mainline: string; sublines: string; generatedAt: number };
export type BookSummary = { inputHash: string; outline: string; mainline: string; characterArcs: string; generatedAt: number };
export type WorldSection = { key: string; title: string; content: string; sources: string[] };
export type WorldviewSummary = { inputHash: string; sections: WorldSection[]; generatedAt: number };
export type MemoryAggregates = { arcs: ArcSummary[]; volumes: VolumeSummary[]; book: BookSummary | null; worldview: WorldviewSummary | null };

export type ConflictStatus = "open" | "ignored" | "resolved";
export type MemoryConflict = { id: string; kind: "trait" | "death" | "llm"; subject: string; attribute: string; values: { value: string; chapterId: string; quote: string }[]; note: string; status: ConflictStatus; detectedAt: number };

export type MemoryPhase = "extract" | "resolve" | "arcs" | "volumes" | "book" | "worldview" | "conflicts";
export const MEMORY_PHASES: MemoryPhase[] = ["extract", "resolve", "arcs", "volumes", "book", "worldview", "conflicts"];
/** Phases run when chapters change during writing (the worldview rebuild is costly and runs on request). */
export const AUTO_PHASES: MemoryPhase[] = ["extract", "resolve", "arcs", "volumes", "book", "conflicts"];
export const MEMORY_PHASE_LABELS: Record<MemoryPhase, string> = { extract: "逐章抽取", resolve: "实体与线索归并", arcs: "情节弧汇总", volumes: "分卷汇总", book: "全书大纲", worldview: "世界观与人物档案", conflicts: "设定冲突检测" };

export type MemoryRunState = "idle" | "running" | "paused" | "error" | "done";
export type MemoryStatus = {
  state: MemoryRunState;
  phase: MemoryPhase | null;
  done: number;
  total: number;
  message: string;
  owner: string | null;
  startedAt: number;
  updatedAt: number;
  /** Chapters whose extraction failed, with attempt counts; retried on the next run. */
  failures: Record<string, { attempts: number; error: string }>;
  usage: { calls: number; inputChars: number; outputChars: number };
};

export function emptyStatus(): MemoryStatus {
  return { state: "idle", phase: null, done: 0, total: 0, message: "", owner: null, startedAt: 0, updatedAt: 0, failures: {}, usage: { calls: 0, inputChars: 0, outputChars: 0 } };
}
