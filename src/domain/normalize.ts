import { PROJECT_SCHEMA_VERSION } from "../types";
import type {
  ChapterStatus,
  CommentSeverity,
  DocRef,
  PipelineSettings,
  ProposalChange,
  PublishStepToggle,
  QuickActionConfig,
  StoryEdgeRelation,
  StoryNodeKind,
  WriterChapterMeta,
  WriterCharacter,
  WriterCharacterRelation,
  WriterComment,
  WriterFaction,
  WriterProject,
  WriterProjectSummary,
  WriterPromptConfig,
  WriterProposal,
  WriterSettings,
  WriterStoryEdge,
  WriterStoryNode,
  WriterVolume,
} from "../types";
import { parseThreadOperation } from "../memory/operations";
import { parseStoryOperation } from "../story/schema";
import { contentHash, projectIdValue, safeIdFrom, slugify, uniqueId } from "./ids";
import { parsePatchOperation } from "./operations";
import { RANK_STEP } from "./ranks";
import { arrayValue, asRecord, clampNumber, dedupeById, finiteNumber, nullableString, stringArray, stringValue, textOr, unixTimestamp } from "./util";

export const DEFAULT_VOLUME_ID = "volume-main";
export const DEFAULT_PIPELINE: PipelineSettings = { steps: ["story", "reader", "briefing", "notes", "next"], storyGate: "review", planGate: "approve", nextWords: 3_000 };
export const DEFAULT_SETTINGS: WriterSettings = { dailyGoal: 0, contextBudgetChars: 60_000, recentCardCount: 10, autoMemory: true, memoryConcurrency: 3, pipeline: DEFAULT_PIPELINE };
const PUBLISH_STEPS: PublishStepToggle[] = ["story", "reader", "briefing", "notes", "next"];
const LIMITS = { chapters: 20_000, volumes: 500, characters: 5_000, factions: 2_000, nodes: 10_000, edges: 20_000, relations: 10_000, comments: 5_000 };
export const PROPOSAL_LIMIT = 200;

export const PROJECT_SCHEMA_VERSION_LABEL = "旧版格式，需重新导入";

/** Thrown for projects saved by an older Writer; their text has to be imported again. */
export class OutdatedProjectError extends Error {
  constructor(readonly version: unknown) { super("这部作品是旧版 Writer 保存的格式，新版不再读取。请在“导入”中重新导入正文。"); }
}

/** Normalizes a stored v3 project. Older schema versions are rejected with `OutdatedProjectError`. */
export function normalizeProject(raw: unknown): WriterProject {
  const source = asRecord(raw);
  if (source.schemaVersion !== PROJECT_SCHEMA_VERSION) throw new OutdatedProjectError(source.schemaVersion);
  const id = projectIdValue(source.id);
  const createdAt = finiteNumber(source.createdAt, unixTimestamp());
  const title = textOr(source.title, "未命名长篇项目");

  const rawChapters = arrayValue(source.chapters).map(asRecord);
  const volumes = dedupeById(arrayValue(source.volumes).map(normalizeVolume)).slice(0, LIMITS.volumes);
  if (!volumes.length) volumes.push({ id: DEFAULT_VOLUME_ID, title: "正文", rank: RANK_STEP, summary: "" });
  const volumeIds = new Set(volumes.map((volume) => volume.id));

  const chapters = dedupeById(rawChapters.map((chapter) => {
    const meta = normalizeChapterMeta(chapter);
    if (!volumeIds.has(meta.volumeId)) meta.volumeId = volumes[0].id;
    return meta;
  })).slice(0, LIMITS.chapters);

  const project: WriterProject = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id,
    title,
    slug: slugify(textOr(source.slug, title), id),
    genre: textOr(source.genre, "长篇小说"),
    audience: textOr(source.audience, "中文读者"),
    targetLength: textOr(source.targetLength, "长篇连载"),
    language: textOr(source.language, "中文"),
    worldview: stringValue(source.worldview),
    background: stringValue(source.background),
    outline: stringValue(source.outline),
    styleGuide: stringValue(source.styleGuide),
    volumes,
    chapters,
    characters: dedupeById(arrayValue(source.characters).map(normalizeCharacter)).slice(0, LIMITS.characters),
    factions: dedupeById(arrayValue(source.factions).map(normalizeFaction)).slice(0, LIMITS.factions),
    storyNodes: dedupeById(arrayValue(source.storyNodes).map(normalizeStoryNode)).slice(0, LIMITS.nodes),
    storyEdges: dedupeById(arrayValue(source.storyEdges).map(normalizeStoryEdge)).filter((edge) => edge.source && edge.target).slice(0, LIMITS.edges),
    characterRelations: dedupeById(arrayValue(source.characterRelations).map(normalizeCharacterRelation)).slice(0, LIMITS.relations),
    comments: dedupeById(arrayValue(source.comments).flatMap((value) => normalizeComment(value) ?? [])).slice(-LIMITS.comments),
    settings: normalizeSettings(source.settings),
    prompts: normalizePromptConfig(source.prompts),
    createdAt,
    updatedAt: finiteNumber(source.updatedAt, createdAt),
  };
  return project;
}

export function projectSummary(project: WriterProject): WriterProjectSummary {
  return { id: project.id, title: project.title, genre: project.genre, updatedAt: project.updatedAt, chapterCount: project.chapters.length, wordCount: project.chapters.reduce((total, chapter) => total + chapter.wordCount, 0) };
}

export function normalizeSettings(value: unknown): WriterSettings {
  const settings = asRecord(value);
  return {
    dailyGoal: Math.round(clampNumber(settings.dailyGoal, DEFAULT_SETTINGS.dailyGoal, 0, 100_000)),
    contextBudgetChars: Math.round(clampNumber(settings.contextBudgetChars, DEFAULT_SETTINGS.contextBudgetChars, 8_000, 80_000)),
    recentCardCount: Math.round(clampNumber(settings.recentCardCount, DEFAULT_SETTINGS.recentCardCount, 1, 40)),
    autoMemory: typeof settings.autoMemory === "boolean" ? settings.autoMemory : DEFAULT_SETTINGS.autoMemory,
    memoryConcurrency: Math.round(clampNumber(settings.memoryConcurrency, DEFAULT_SETTINGS.memoryConcurrency, 1, 6)),
    pipeline: normalizePipelineSettings(settings.pipeline),
  };
}

export function normalizePipelineSettings(value: unknown): PipelineSettings {
  if (value === undefined || value === null) return { ...DEFAULT_PIPELINE, steps: [...DEFAULT_PIPELINE.steps] };
  const pipeline = asRecord(value);
  return {
    steps: PUBLISH_STEPS.filter((step) => stringArray(pipeline.steps).includes(step)),
    storyGate: pipeline.storyGate === "auto-safe" ? "auto-safe" : "review",
    planGate: pipeline.planGate === "auto" ? "auto" : "approve",
    nextWords: Math.round(clampNumber(pipeline.nextWords, DEFAULT_PIPELINE.nextWords, 500, 20_000)),
  };
}

export function defaultPromptConfig(): WriterPromptConfig {
  return { overrides: {}, quickActions: null, updatedAt: 0 };
}

export function normalizePromptConfig(value: unknown): WriterPromptConfig {
  if (value === undefined || value === null) return defaultPromptConfig();
  const config = asRecord(value);
  const overrides: Record<string, string> = {};
  for (const [key, text] of Object.entries(asRecord(config.overrides))) if (typeof text === "string" && text.trim()) overrides[key] = text;
  return {
    overrides,
    quickActions: Array.isArray(config.quickActions) ? config.quickActions.flatMap((item) => normalizeQuickAction(item) ?? []).slice(0, 30) : null,
    updatedAt: finiteNumber(config.updatedAt, 0),
  };
}

export function normalizeQuickAction(value: unknown): QuickActionConfig | null {
  const action = asRecord(value);
  const label = stringValue(action.label).trim();
  const instruction = stringValue(action.instruction).trim();
  if (!label || !instruction) return null;
  const ask = stringValue(action.ask).trim();
  return { id: textOr(action.id, uniqueId("action")), label: label.slice(0, 20), instruction, candidates: Math.round(clampNumber(action.candidates, 2, 1, 4)), ...(ask ? { ask } : {}) };
}

export function normalizeVolume(value: unknown): WriterVolume {
  const volume = asRecord(value);
  return { id: safeIdFrom(textOr(volume.id, uniqueId("volume")), "volume"), title: textOr(volume.title, "未命名卷"), rank: finiteNumber(volume.rank, RANK_STEP), summary: stringValue(volume.summary) };
}

const CHAPTER_STATUSES: ChapterStatus[] = ["draft", "writing", "review", "final"];
export function chapterStatusValue(value: unknown): ChapterStatus {
  return CHAPTER_STATUSES.includes(value as ChapterStatus) ? value as ChapterStatus : "draft";
}

export function normalizeChapterMeta(value: unknown): WriterChapterMeta {
  const chapter = asRecord(value);
  return {
    id: safeIdFrom(textOr(chapter.id, uniqueId("chapter")), "chapter"),
    volumeId: textOr(chapter.volumeId, DEFAULT_VOLUME_ID),
    title: textOr(chapter.title, "未命名章节"),
    summary: stringValue(chapter.summary),
    status: chapterStatusValue(chapter.status),
    rank: finiteNumber(chapter.rank, RANK_STEP),
    povCharacterId: nullableString(chapter.povCharacterId),
    storyNodeIds: stringArray(chapter.storyNodeIds),
    wordCount: Math.max(0, Math.round(finiteNumber(chapter.wordCount, 0))),
    contentHash: stringValue(chapter.contentHash) || contentHash(""),
    targetWords: Math.max(0, Math.round(finiteNumber(chapter.targetWords, 0))),
    notes: stringValue(chapter.notes),
    updatedAt: finiteNumber(chapter.updatedAt, 0),
  };
}

export function normalizeCharacter(value: unknown): WriterCharacter {
  const character = asRecord(value);
  return {
    id: textOr(character.id, uniqueId("character")), name: textOr(character.name, "未命名人物"), aliases: stringArray(character.aliases, 50), role: stringValue(character.role), summary: stringValue(character.summary), arc: stringValue(character.arc), tags: stringArray(character.tags, 50),
    minimalTag: stringValue(character.minimalTag), desire: stringValue(character.desire), hiddenInner: stringValue(character.hiddenInner), independentGoal: stringValue(character.independentGoal), currentAction: stringValue(character.currentAction),
    firstNodeId: nullableString(character.firstNodeId), lastNodeId: nullableString(character.lastNodeId),
  };
}

export function normalizeFaction(value: unknown): WriterFaction {
  const faction = asRecord(value);
  return { id: textOr(faction.id, uniqueId("faction")), name: textOr(faction.name, "未命名势力"), aliases: stringArray(faction.aliases, 50), summary: stringValue(faction.summary), motivation: stringValue(faction.motivation), tags: stringArray(faction.tags, 50) };
}

const NODE_KINDS: StoryNodeKind[] = ["volume", "chapter", "scene", "plot_key", "character_key"];
export function normalizeStoryNode(value: unknown): WriterStoryNode {
  const node = asRecord(value);
  const position = asRecord(node.position);
  return {
    id: textOr(node.id, uniqueId("node")),
    kind: NODE_KINDS.includes(node.kind as StoryNodeKind) ? node.kind as StoryNodeKind : "plot_key",
    title: textOr(node.title, "剧情节点"),
    summary: stringValue(node.summary),
    characterIds: stringArray(node.characterIds),
    startsAt: stringValue(node.startsAt),
    endsAt: stringValue(node.endsAt),
    chapterId: nullableString(node.chapterId),
    sceneId: nullableString(node.sceneId),
    position: { x: finiteNumber(position.x, 0), y: finiteNumber(position.y, 0) },
    tags: stringArray(node.tags, 50),
  };
}

const EDGE_RELATIONS: StoryEdgeRelation[] = ["causal", "timeline", "branch", "foreshadow", "character"];
export function normalizeStoryEdge(value: unknown): WriterStoryEdge {
  const edge = asRecord(value);
  return { id: textOr(edge.id, uniqueId("edge")), source: stringValue(edge.source).trim(), target: stringValue(edge.target).trim(), relation: EDGE_RELATIONS.includes(edge.relation as StoryEdgeRelation) ? edge.relation as StoryEdgeRelation : "causal", label: stringValue(edge.label) };
}

export function normalizeCharacterRelation(value: unknown): WriterCharacterRelation {
  const relation = asRecord(value);
  return { id: textOr(relation.id, uniqueId("relation")), sourceCharacterId: stringValue(relation.sourceCharacterId).trim(), targetCharacterId: stringValue(relation.targetCharacterId).trim(), relation: stringValue(relation.relation), startsAt: stringValue(relation.startsAt), endsAt: stringValue(relation.endsAt), storyNodeIds: stringArray(relation.storyNodeIds) };
}

export function normalizeDocRef(value: unknown): DocRef | null {
  const ref = asRecord(value);
  if (ref.kind === "chapter" && typeof ref.id === "string" && ref.id) return { kind: "chapter", id: ref.id };
  if (ref.kind === "worldview" || ref.kind === "background" || ref.kind === "outline" || ref.kind === "style") return { kind: ref.kind };
  return null;
}

function normalizeComment(value: unknown): WriterComment | null {
  const comment = asRecord(value);
  const doc = normalizeDocRef(comment.doc);
  if (!doc || typeof comment.comment !== "string") return null;
  const severity: CommentSeverity = comment.severity === "warning" || comment.severity === "error" ? comment.severity : "info";
  return { id: textOr(comment.id, uniqueId("comment")), doc, quote: stringValue(comment.quote), start: Math.max(0, Math.round(finiteNumber(comment.start, 0))), comment: comment.comment, severity, author: comment.author === "user" ? "user" : "ai", resolved: comment.resolved === true, createdAt: finiteNumber(comment.createdAt, unixTimestamp()) };
}

export function normalizeProposals(value: unknown): WriterProposal[] {
  return arrayValue(asRecord(value).proposals).flatMap((item) => normalizeProposal(item) ?? []).slice(-PROPOSAL_LIMIT);
}

export function normalizeProposal(value: unknown): WriterProposal | null {
  const proposal = asRecord(value);
  if (typeof proposal.id !== "string" || !proposal.id.trim()) return null;
  const statuses = ["pending", "applied", "partially_applied", "rejected", "superseded", "reverted"] as const;
  const status = statuses.includes(proposal.status as never) ? proposal.status as WriterProposal["status"] : "pending";
  let changes: ProposalChange[];
  try {
    changes = arrayValue(proposal.changes).flatMap((change) => normalizeChange(change) ?? []);
  } catch {
    if (status === "pending") return null;
    changes = [];
  }
  const undo = asRecord(proposal.undo);
  const source = asRecord(proposal.source);
  return {
    id: proposal.id,
    title: textOr(proposal.title, "写作建议"),
    instruction: stringValue(proposal.instruction),
    summary: stringValue(proposal.summary),
    previewMarkdown: stringValue(proposal.previewMarkdown),
    risks: stringArray(proposal.risks, 30),
    changes,
    status,
    createdAt: finiteNumber(proposal.createdAt, unixTimestamp()),
    appliedAt: typeof proposal.appliedAt === "number" ? proposal.appliedAt : null,
    appliedChangeIds: stringArray(proposal.appliedChangeIds),
    undo: proposal.undo ? {
      snapshots: stringRecord(undo.snapshots),
      afterHashes: stringRecord(undo.afterHashes),
      inverseOperations: parseAll(undo.inverseOperations, parsePatchOperation),
      createdChapterIds: stringArray(undo.createdChapterIds),
      inverseStoryOperations: parseAll(undo.inverseStoryOperations, parseStoryOperation),
      inverseThreadOperations: parseAll(undo.inverseThreadOperations, parseThreadOperation),
    } : null,
    conversationId: nullableString(proposal.conversationId),
    source: source.kind === "pipeline" && typeof source.runId === "string" && typeof source.stepId === "string" ? { kind: "pipeline", runId: source.runId, stepId: source.stepId } : null,
  };
}

function parseAll<T>(value: unknown, parse: (item: unknown) => T): T[] {
  return arrayValue(value).flatMap((item) => { try { return [parse(item)]; } catch { return []; } });
}

function normalizeChange(value: unknown): ProposalChange | null {
  const change = asRecord(value);
  const id = textOr(change.id, uniqueId("change"));
  if (change.kind === "text") {
    const doc = normalizeDocRef(change.doc);
    if (!doc) return null;
    return { id, kind: "text", doc, title: textOr(change.title, "文本修改"), summary: stringValue(change.summary), before: stringValue(change.before), after: stringValue(change.after), ...(change.createChapter ? { createChapter: normalizeChapterMeta(change.createChapter) } : {}) };
  }
  if (change.kind === "entity") return { id, kind: "entity", label: textOr(change.label, "结构修改"), operation: parsePatchOperation(change.operation) };
  if (change.kind === "story") return { id, kind: "story", label: textOr(change.label, "故事规划"), operation: parseStoryOperation(change.operation) };
  if (change.kind === "thread") return { id, kind: "thread", label: textOr(change.label, "线索"), operation: parseThreadOperation(change.operation) };
  return null;
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(asRecord(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
