// Three-way merge for saving drafts: only items changed locally are written, and only items that were
// also changed elsewhere since the draft's base are reported as conflicts.
import type { ProjectDraft, WriterChapterMeta, WriterProject } from "../types";
import { refreshChapterDerived } from "./documents";
import { slugify } from "./ids";
import { jsonEqual } from "./util";

export const SCALAR_FIELDS = ["title", "genre", "audience", "targetLength", "language", "worldview", "background", "outline", "styleGuide", "settings", "prompts"] as const;
export const ENTITY_COLLECTIONS = ["volumes", "chapters", "characters", "factions", "storyNodes", "storyEdges", "characterRelations", "comments"] as const;
export type ScalarField = typeof SCALAR_FIELDS[number];
export type EntityCollection = typeof ENTITY_COLLECTIONS[number];

export type DraftChange =
  | { kind: "field"; field: ScalarField }
  | { kind: "entity"; collection: EntityCollection; id: string }
  | { kind: "text"; chapterId: string };

export type MergeConflict = { change: DraftChange; label: string };
export type MergeResult = { merged: ProjectDraft; applied: DraftChange[]; conflicts: MergeConflict[] };

type AnyEntity = { id: string };

export function diffDrafts(base: ProjectDraft, next: ProjectDraft): DraftChange[] {
  const changes: DraftChange[] = [];
  for (const field of SCALAR_FIELDS) {
    if (!jsonEqual(base.project[field], next.project[field])) changes.push({ kind: "field", field });
  }
  for (const collection of ENTITY_COLLECTIONS) {
    const baseItems = entityMap(base.project, collection);
    const nextItems = entityMap(next.project, collection);
    for (const id of new Set([...baseItems.keys(), ...nextItems.keys()])) {
      if (!jsonEqual(comparable(collection, baseItems.get(id)), comparable(collection, nextItems.get(id)))) changes.push({ kind: "entity", collection, id });
    }
  }
  for (const id of new Set([...Object.keys(base.texts), ...Object.keys(next.texts)])) {
    if (base.texts[id] !== next.texts[id] && next.texts[id] !== undefined) changes.push({ kind: "text", chapterId: id });
  }
  for (const id of entityMap(base.project, "chapters").keys()) {
    if (!next.project.chapters.some((chapter) => chapter.id === id) && base.texts[id] !== undefined) changes.push({ kind: "text", chapterId: id });
  }
  return dedupeChanges(changes);
}

/**
 * Applies `base -> next` changes on top of `current`. `current.texts` must contain the current body of every
 * chapter touched by a text change (missing means the chapter has no body yet).
 */
export function mergeDraft(base: ProjectDraft, next: ProjectDraft, current: ProjectDraft, changes = diffDrafts(base, next)): MergeResult {
  const merged: ProjectDraft = { project: structuredClone(current.project), texts: { ...current.texts } };
  const applied: DraftChange[] = [];
  const conflicts: MergeConflict[] = [];
  for (const change of changes) {
    const baseValue = valueOf(base, change);
    const nextValue = valueOf(next, change);
    const currentValue = valueOf(current, change);
    if (jsonEqual(currentValue, nextValue)) { applied.push(change); continue; }
    if (!jsonEqual(currentValue, baseValue)) { conflicts.push({ change, label: describeChange(next.project, current.project, change) }); continue; }
    setValue(merged, change, nextValue);
    applied.push(change);
  }
  merged.project.slug = slugify(merged.project.title, merged.project.id);
  for (const chapter of merged.project.chapters) {
    const text = merged.texts[chapter.id];
    if (text !== undefined) refreshChapterDerived(chapter, text);
  }
  return { merged, applied, conflicts };
}

export function describeChange(next: WriterProject, current: WriterProject, change: DraftChange): string {
  if (change.kind === "field") return FIELD_LABELS[change.field];
  if (change.kind === "text") {
    const chapter = next.chapters.find((item) => item.id === change.chapterId) ?? current.chapters.find((item) => item.id === change.chapterId);
    return `章节正文「${chapter?.title ?? change.chapterId}」`;
  }
  const entity = (entityMap(next, change.collection).get(change.id) ?? entityMap(current, change.collection).get(change.id)) as Record<string, unknown> | undefined;
  const name = entity ? String(entity.title ?? entity.name ?? entity.comment ?? change.id).slice(0, 30) : change.id;
  return `${COLLECTION_LABELS[change.collection]}「${name}」`;
}

const FIELD_LABELS: Record<ScalarField, string> = { title: "项目标题", genre: "类型", audience: "读者", targetLength: "目标篇幅", language: "语言", worldview: "世界观", background: "背景设定", outline: "全书大纲", styleGuide: "文风指南", settings: "项目设置", prompts: "提示词配置" };
const COLLECTION_LABELS: Record<EntityCollection, string> = { volumes: "卷", chapters: "章节", characters: "人物", factions: "势力", storyNodes: "剧情节点", storyEdges: "剧情关联", characterRelations: "人物关系", comments: "批注" };

function entityMap(project: WriterProject, collection: EntityCollection): Map<string, AnyEntity> {
  return new Map((project[collection] as AnyEntity[]).map((item) => [item.id, item]));
}

/** Chapter word count / hash / timestamps derive from the body and never conflict on their own. */
function comparable(collection: EntityCollection, value: AnyEntity | undefined): unknown {
  if (!value || collection !== "chapters") return value ?? null;
  const { wordCount: _w, contentHash: _h, updatedAt: _u, ...rest } = value as WriterChapterMeta;
  return rest;
}

function valueOf(draft: ProjectDraft, change: DraftChange): unknown {
  if (change.kind === "field") return draft.project[change.field];
  if (change.kind === "text") return draft.project.chapters.some((chapter) => chapter.id === change.chapterId) ? draft.texts[change.chapterId] ?? "" : null;
  return comparable(change.collection, entityMap(draft.project, change.collection).get(change.id));
}

function setValue(draft: ProjectDraft, change: DraftChange, value: unknown) {
  if (change.kind === "field") { (draft.project as Record<string, unknown>)[change.field] = structuredClone(value); return; }
  if (change.kind === "text") {
    if (value === null) delete draft.texts[change.chapterId];
    else draft.texts[change.chapterId] = value as string;
    return;
  }
  const items = draft.project[change.collection] as AnyEntity[];
  const index = items.findIndex((item) => item.id === change.id);
  if (value === null) { if (index >= 0) items.splice(index, 1); return; }
  const nextValue = structuredClone(value) as AnyEntity;
  if (change.collection === "chapters") Object.assign(nextValue, { wordCount: 0, contentHash: "", updatedAt: Math.floor(Date.now() / 1000), ...(index >= 0 ? pickDerived(items[index] as WriterChapterMeta) : {}) });
  if (index >= 0) items[index] = nextValue; else items.push(nextValue);
}

function pickDerived(chapter: WriterChapterMeta) { return { wordCount: chapter.wordCount, contentHash: chapter.contentHash }; }

function dedupeChanges(changes: DraftChange[]) {
  const seen = new Set<string>();
  return changes.filter((change) => {
    const key = JSON.stringify(change);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
