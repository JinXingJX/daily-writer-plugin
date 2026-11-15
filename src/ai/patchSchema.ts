import type { WriterPatchOperation } from "../types";
import { MAX_PATCH_OPERATIONS, PROJECT_FIELDS } from "../domain/operations";

const TEXT = { type: "string" };
const TEXTS = { type: "array", items: TEXT };
const ID = { type: "string", minLength: 1, description: "稳定且非空的 id；修改已有实体时沿用原 id" };
const OPTIONAL_ID = { type: "string", description: "关联实体的 id；传空字符串表示清空关联" };
const RANK = { type: "number", description: "排序值，越小越靠前；新建时建议依次为 1024、2048、3072；重命名时保留原值。字段名为 rank，不是 order" };

function entity(description: string, properties: Record<string, unknown>, required = ["id"]) {
  return { type: "object", description, properties: { id: ID, ...properties }, required, additionalProperties: false };
}

const INPUTS_BY_TYPE = {
  setProjectField: ["field", "value"],
  upsertVolume: ["volume"],
  upsertChapterMeta: ["chapter"],
  upsertCharacter: ["character"],
  upsertFaction: ["faction"],
  upsertStoryNode: ["node"],
  upsertStoryEdge: ["edge"],
  upsertCharacterRelation: ["relation"],
  removeCharacter: ["id"],
  removeFaction: ["id"],
  removeStoryNode: ["id"],
  removeStoryEdge: ["id"],
  removeCharacterRelation: ["id"],
  setPromptConfig: ["patch"],
} satisfies Record<WriterPatchOperation["type"], string[]>;

// Use object/properties/required rather than union schemas: the host's Antigravity adapter
// strips anyOf/oneOf. Conditional payload requirements are also checked by the domain parser.
export const PATCH_OPERATIONS_SCHEMA = {
  type: "array",
  maxItems: MAX_PATCH_OPERATIONS,
  description: '每项必须包含 type 和对应数据。分卷示例：{"type":"upsertVolume","volume":{"id":"volume-main","title":"第一卷","rank":1024,"summary":""}}。upsert 会替换完整实体（chapter 除外），保留不想修改的原字段；修改结果作为建议交给作者审核。',
  items: {
    type: "object",
    required: ["type"],
    additionalProperties: false,
    description: `按 type 填写对应的必填字段：${Object.entries(INPUTS_BY_TYPE).map(([type, fields]) => `${type} → ${fields.join("、")}`).join("；")}。不要把实体字段直接放在操作顶层。`,
    properties: {
      type: { type: "string", enum: Object.keys(INPUTS_BY_TYPE), description: "必填操作类型，决定使用哪个数据字段" },
      field: { type: "string", enum: PROJECT_FIELDS, description: "setProjectField 时必填" },
      value: { ...TEXT, description: "setProjectField 时必填，字段的新文本" },
      id: { ...ID, description: "remove 开头的删除操作必填：要删除的实体 id" },
      volume: entity("upsertVolume 时必填；使用 id、rank，不使用 volumeId、order", { title: TEXT, rank: RANK, summary: TEXT }, ["id", "title", "rank", "summary"]),
      chapter: entity("upsertChapterMeta 时必填，仅更新提供的元数据；章节必须已存在，正文用文本工具修改", {
        volumeId: TEXT, title: TEXT, summary: TEXT, status: { type: "string", enum: ["draft", "writing", "review", "final"] }, rank: RANK,
        povCharacterId: OPTIONAL_ID, storyNodeIds: TEXTS, targetWords: { type: "number" }, notes: TEXT,
      }),
      character: entity("upsertCharacter 时必填，完整人物档案", {
        name: TEXT, aliases: TEXTS, role: TEXT, summary: TEXT, arc: TEXT, tags: TEXTS, firstNodeId: OPTIONAL_ID, lastNodeId: OPTIONAL_ID,
      }, ["id", "name"]),
      faction: entity("upsertFaction 时必填，完整势力档案", { name: TEXT, aliases: TEXTS, summary: TEXT, motivation: TEXT, tags: TEXTS }, ["id", "name"]),
      node: entity("upsertStoryNode 时必填，完整剧情节点", {
        kind: { type: "string", enum: ["volume", "chapter", "scene", "plot_key", "character_key"] }, title: TEXT, summary: TEXT, characterIds: TEXTS,
        startsAt: TEXT, endsAt: TEXT, chapterId: OPTIONAL_ID, sceneId: OPTIONAL_ID, tags: TEXTS,
        position: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false },
      }, ["id", "title"]),
      edge: entity("upsertStoryEdge 时必填，完整剧情关联；source/target 是节点 id", {
        source: ID, target: ID, relation: { type: "string", enum: ["causal", "timeline", "branch", "foreshadow", "character"] }, label: TEXT,
      }, ["id", "source", "target"]),
      relation: entity("upsertCharacterRelation 时必填，完整人物关系", {
        sourceCharacterId: ID, targetCharacterId: ID, relation: TEXT, startsAt: TEXT, endsAt: TEXT, storyNodeIds: TEXTS,
      }, ["id", "sourceCharacterId", "targetCharacterId"]),
      patch: {
        type: "object", minProperties: 1, additionalProperties: false, description: "setPromptConfig 时必填，仅更新提供的配置字段（overrides、quickActions）",
        properties: {
          templateId: OPTIONAL_ID, templateName: TEXT, writingPrompt: TEXT, overrides: { type: "object", additionalProperties: TEXT },
          quickActions: { type: "array", nullable: true, items: { type: "object", properties: { id: ID, label: TEXT, instruction: TEXT, candidates: { type: "integer", minimum: 1, maximum: 4 } }, required: ["id", "label", "instruction", "candidates"], additionalProperties: false } },
        },
      },
    },
  },
};
