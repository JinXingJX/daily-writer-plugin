import type { WriterPatchOperation, WriterProject, WriterProjectField, WriterPromptConfig } from "../types";
import {
  normalizeChapterMeta,
  normalizeCharacter,
  normalizeCharacterRelation,
  normalizeFaction,
  normalizeStoryEdge,
  normalizeStoryNode,
  normalizeVolume,
} from "./normalize";
import { normalizePromptConfig } from "./normalize";
import { asRecord, upsertById } from "./util";

export const MAX_PATCH_OPERATIONS = 200;
export const PROJECT_FIELDS: WriterProjectField[] = ["title", "genre", "audience", "targetLength", "language", "worldview", "background", "outline", "styleGuide"];
const FIELD_ALIASES: Record<string, WriterProjectField> = { target_length: "targetLength", style: "styleGuide", style_guide: "styleGuide" };

export function parsePatchOperations(value: unknown): WriterPatchOperation[] {
  if (!Array.isArray(value)) throw new Error("Writer patch operations must be an array.");
  if (value.length > MAX_PATCH_OPERATIONS) throw new Error(`Writer patch operations cannot contain more than ${MAX_PATCH_OPERATIONS} items.`);
  return value.map((operation, index) => {
    try { return parsePatchOperation(operation); }
    catch (error) { throw new Error(`operations[${index}]: ${error instanceof Error ? error.message : String(error)}`); }
  });
}

export function parsePatchOperation(value: unknown): WriterPatchOperation {
  const operation = asRecord(value);
  const type = typeof operation.type === "string" ? operation.type : "";
  if (!type) throw new Error('Writer patch 缺少 type（操作类型）。每项必须包含 type 和对应的数据对象。分卷示例：{"type":"upsertVolume","volume":{"id":"volume-main","title":"第一卷","rank":1024,"summary":""}}。分卷使用 volume.id 和 volume.rank，不是顶层 volumeId 和 order；请修正参数后重试。');
  switch (type) {
    case "setProjectField": {
      const raw = typeof operation.field === "string" ? operation.field : "";
      const field = FIELD_ALIASES[raw] ?? raw;
      if (!PROJECT_FIELDS.includes(field as WriterProjectField)) throw new Error(`Unsupported Writer project field ${raw || "<missing>"}.`);
      const fieldValue = typeof operation.value === "string" ? operation.value : operation.value == null ? "" : JSON.stringify(operation.value);
      return { type, field: field as WriterProjectField, value: fieldValue };
    }
    case "upsertVolume": return { type, volume: normalizeVolume(entityRecord(operation.volume, "volume")) };
    case "upsertChapterMeta":
    case "upsertChapter": {
      const chapter = entityRecord(operation.chapter, "chapter");
      const { content: _content, wordCount: _wordCount, contentHash: _hash, ...meta } = chapter;
      return { type: "upsertChapterMeta", chapter: { ...meta, id: String(chapter.id).trim() } };
    }
    case "upsertCharacter": return { type, character: normalizeCharacter(entityRecord(operation.character, "character")) };
    case "upsertFaction": return { type, faction: normalizeFaction(entityRecord(operation.faction, "faction")) };
    case "upsertStoryNode": return { type, node: normalizeStoryNode(entityRecord(operation.node, "node")) };
    case "upsertStoryEdge": {
      const edge = normalizeStoryEdge(entityRecord(operation.edge, "edge"));
      if (!edge.source || !edge.target) throw new Error("Writer patch story edge requires source and target ids.");
      return { type, edge };
    }
    case "upsertCharacterRelation": {
      const relation = normalizeCharacterRelation(entityRecord(operation.relation, "relation"));
      if (!relation.sourceCharacterId || !relation.targetCharacterId) throw new Error("Writer patch character relation requires source and target character ids.");
      return { type, relation };
    }
    case "removeCharacter":
    case "removeFaction":
    case "removeStoryNode":
    case "removeStoryEdge":
    case "removeCharacterRelation":
      if (typeof operation.id !== "string" || !operation.id.trim()) throw new Error(`${type} requires a non-empty id.`);
      return { type, id: operation.id.trim() };
    case "setPromptConfig": return { type, patch: promptPatch(operation.patch) };
    default:
      throw new Error(`Unknown Writer patch operation ${type || "<missing>"}.`);
  }
}

/** Applies one validated operation in place. Removals cascade to every reference. */
export function applyOperation(project: WriterProject, operation: WriterPatchOperation) {
  switch (operation.type) {
    case "setProjectField":
      project[operation.field] = operation.value;
      return;
    case "upsertVolume": upsertById(project.volumes, normalizeVolume(operation.volume)); return;
    case "upsertChapterMeta": {
      const current = project.chapters.find((chapter) => chapter.id === operation.chapter.id);
      if (!current) throw new Error(`Chapter ${operation.chapter.id} was not found; chapters are created through text changes.`);
      const merged = normalizeChapterMeta({ ...current, ...operation.chapter });
      Object.assign(current, merged, { id: current.id, wordCount: current.wordCount, contentHash: current.contentHash });
      return;
    }
    case "upsertCharacter": upsertById(project.characters, normalizeCharacter(operation.character)); return;
    case "upsertFaction": upsertById(project.factions, normalizeFaction(operation.faction)); return;
    case "upsertStoryNode": upsertById(project.storyNodes, normalizeStoryNode(operation.node)); return;
    case "upsertStoryEdge": upsertById(project.storyEdges, normalizeStoryEdge(operation.edge)); return;
    case "upsertCharacterRelation": upsertById(project.characterRelations, normalizeCharacterRelation(operation.relation)); return;
    case "removeCharacter": removeCharacter(project, operation.id); return;
    case "removeFaction": project.factions = project.factions.filter((faction) => faction.id !== operation.id); return;
    case "removeStoryNode": removeStoryNode(project, operation.id); return;
    case "removeStoryEdge": project.storyEdges = project.storyEdges.filter((edge) => edge.id !== operation.id); return;
    case "removeCharacterRelation": project.characterRelations = project.characterRelations.filter((relation) => relation.id !== operation.id); return;
    case "setPromptConfig": project.prompts = normalizePromptConfig({ ...project.prompts, ...operation.patch, updatedAt: Math.floor(Date.now() / 1000) }); return;
  }
}

const PROMPT_PATCH_KEYS = ["overrides", "quickActions"] as const;

/** Keeps only known prompt-config fields, normalized; absent fields stay absent so they are left unchanged. */
export function promptPatch(value: unknown): Partial<WriterPromptConfig> {
  const raw = asRecord(value);
  const normalized = normalizePromptConfig({ ...raw, overrides: raw.overrides ?? {} });
  const patch: Partial<WriterPromptConfig> = {};
  for (const key of PROMPT_PATCH_KEYS) if (key in raw) (patch as Record<string, unknown>)[key] = normalized[key];
  if (!Object.keys(patch).length) throw new Error("setPromptConfig requires at least one prompt field.");
  return patch;
}

/** Validates every operation first, then applies them to a clone. */
export function applyOperations(project: WriterProject, operations: unknown): WriterProject {
  const parsed = parsePatchOperations(operations);
  const next = structuredClone(project);
  for (const operation of parsed) applyOperation(next, operation);
  return next;
}

export function removeCharacter(project: WriterProject, id: string) {
  project.characters = project.characters.filter((character) => character.id !== id);
  project.characterRelations = project.characterRelations.filter((relation) => relation.sourceCharacterId !== id && relation.targetCharacterId !== id);
  for (const node of project.storyNodes) node.characterIds = node.characterIds.filter((characterId) => characterId !== id);
  for (const chapter of project.chapters) if (chapter.povCharacterId === id) chapter.povCharacterId = null;
}

export function removeStoryNode(project: WriterProject, id: string) {
  project.storyNodes = project.storyNodes.filter((node) => node.id !== id);
  project.storyEdges = project.storyEdges.filter((edge) => edge.source !== id && edge.target !== id);
  for (const chapter of project.chapters) chapter.storyNodeIds = chapter.storyNodeIds.filter((nodeId) => nodeId !== id);
  for (const relation of project.characterRelations) relation.storyNodeIds = relation.storyNodeIds.filter((nodeId) => nodeId !== id);
  for (const character of project.characters) {
    if (character.firstNodeId === id) character.firstNodeId = null;
    if (character.lastNodeId === id) character.lastNodeId = null;
  }
}

/** Removes chapter metadata and every reference to it. The chapter file is removed by the store. */
export function removeChapter(project: WriterProject, id: string) {
  project.chapters = project.chapters.filter((chapter) => chapter.id !== id);
  for (const node of project.storyNodes) if (node.chapterId === id) node.chapterId = null;
  project.comments = project.comments.filter((comment) => !(comment.doc.kind === "chapter" && comment.doc.id === id));
}

export function removeVolume(project: WriterProject, id: string, moveChaptersTo: string) {
  if (id === moveChaptersTo) return;
  project.volumes = project.volumes.filter((volume) => volume.id !== id);
  for (const chapter of project.chapters) if (chapter.volumeId === id) chapter.volumeId = moveChaptersTo;
}

export function describeOperation(operation: WriterPatchOperation): string {
  switch (operation.type) {
    case "setProjectField": return `设置项目字段 ${operation.field}`;
    case "upsertVolume": return `卷：${operation.volume.title}`;
    case "upsertChapterMeta": return `章节信息：${operation.chapter.title ?? operation.chapter.id}`;
    case "upsertCharacter": return `人物：${operation.character.name}`;
    case "upsertFaction": return `势力：${operation.faction.name}`;
    case "upsertStoryNode": return `剧情节点：${operation.node.title}`;
    case "upsertStoryEdge": return `剧情关联：${operation.edge.source} → ${operation.edge.target}`;
    case "upsertCharacterRelation": return `人物关系：${operation.relation.relation || "关系"}`;
    case "removeCharacter": return `删除人物 ${operation.id}`;
    case "removeFaction": return `删除势力 ${operation.id}`;
    case "removeStoryNode": return `删除剧情节点 ${operation.id}`;
    case "removeStoryEdge": return `删除剧情关联 ${operation.id}`;
    case "removeCharacterRelation": return `删除人物关系 ${operation.id}`;
    case "setPromptConfig": return `提示词配置：${Object.keys(operation.patch).map((key) => PROMPT_FIELD_LABELS[key] ?? key).join("、")}`;
  }
}

const PROMPT_FIELD_LABELS: Record<string, string> = { overrides: "提示词覆盖", quickActions: "快捷改写" };

function entityRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Writer patch ${label} must be an object.`);
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim()) throw new Error(`Writer patch ${label} requires a stable non-empty id.`);
  return record;
}
