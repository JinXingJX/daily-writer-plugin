import { presetSample } from "../ai/presetSamples";
import { stripImageMarkup } from "../images/schema";
import { docTitle, orderedChapters, refreshChapterDerived } from "../domain/documents";
import { contentHash, projectIdValue, slugify, uniqueId } from "../domain/ids";
import { diffDrafts, mergeDraft, type MergeConflict } from "../domain/merge";
import { DEFAULT_VOLUME_ID, normalizeProject, OutdatedProjectError, PROJECT_SCHEMA_VERSION_LABEL, projectSummary } from "../domain/normalize";
import { RANK_STEP } from "../domain/ranks";
import { PROJECT_SCHEMA_VERSION } from "../types";
import { asRecord, mapLimit, unixTimestamp } from "../domain/util";
import type { ChapterTexts, ProjectDraft, WriterProject, WriterProjectSummary } from "../types";
import { listEntries, readJson, readTextOr, removeFile, writeJson, writeText } from "./io";
import { withWriterMutationLock } from "./lock";
import { chapterFile, INDEX_PATH, PROJECTS_DIR, projectFile } from "./paths";
import { addPresetSamples } from "./sampleStore";
import { createSnapshot } from "./snapshots";

type ProjectIndex = { version: 3; projectIds: string[] };

/** Lists readable works. Works saved by an older Writer are listed as outdated so the author can re-import them. */
export async function listProjects(): Promise<WriterProjectSummary[]> {
  const index = await readIndex();
  const summaries = await mapLimit(index.projectIds, 4, async (id): Promise<WriterProjectSummary | null> => {
    const raw = await readJson(projectFile(id)).catch(() => undefined);
    if (raw === undefined) return null;
    try { return projectSummary(normalizeProject(raw)); }
    catch (error) {
      if (!(error instanceof OutdatedProjectError)) return null;
      const stored = asRecord(raw);
      return { id, title: `${typeof stored.title === "string" ? stored.title : "旧作品"}（${PROJECT_SCHEMA_VERSION_LABEL}）`, genre: "", updatedAt: 0, chapterCount: 0, wordCount: 0, outdated: true };
    }
  });
  return summaries.filter((summary): summary is WriterProjectSummary => Boolean(summary)).sort((left, right) => right.updatedAt - left.updatedAt);
}

/** `presets` are ids of built-in style samples (ai/presetSamples.ts) copied into the new work. */
export type CreateProjectInput = { title?: string; genre?: string; audience?: string; targetLength?: string; outline?: string; presets?: string[] };

export async function createProject(input: CreateProjectInput = {}): Promise<WriterProject> {
  const now = unixTimestamp();
  const id = uniqueId("writer");
  const title = input.title?.trim() || "未命名长篇项目";
  const project = normalizeProject({
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id,
    title,
    slug: slugify(title, id),
    genre: input.genre,
    audience: input.audience,
    targetLength: input.targetLength,
    outline: input.outline,
    volumes: [{ id: DEFAULT_VOLUME_ID, title: "正文", rank: RANK_STEP, summary: "" }],
    createdAt: now,
    updatedAt: now,
  });
  await withWriterMutationLock(async () => {
    await writeProjectFile(project);
    await addToIndex(project.id);
  });
  await addPresetSamples(project.id, (input.presets ?? []).flatMap((id) => presetSample(id) ?? []));
  return project;
}

/** Reads a project. Throws `OutdatedProjectError` for works saved by an older Writer. */
export async function openProject(projectId: string): Promise<WriterProject> {
  const raw = await readJson(projectFile(projectId));
  if (raw === undefined) throw new Error("写作项目不存在或已被删除。");
  return normalizeProject(raw);
}

export async function readProject(projectId: string): Promise<WriterProject> { return openProject(projectId); }

export async function loadChapterText(projectId: string, chapterId: string): Promise<string> {
  return readTextOr(chapterFile(projectId, chapterId), "");
}

export async function loadChapterTexts(projectId: string, chapterIds: string[], onProgress?: (done: number, total: number) => void): Promise<ChapterTexts> {
  const texts: ChapterTexts = {};
  let done = 0;
  await mapLimit(chapterIds, 8, async (chapterId) => {
    texts[chapterId] = await loadChapterText(projectId, chapterId);
    done += 1;
    onProgress?.(done, chapterIds.length);
  });
  return texts;
}

/** Streams chapter bodies in reading order without holding the whole book in memory. */
export async function forEachChapterText(project: WriterProject, visit: (chapterId: string, text: string, position: number) => void | Promise<void>, options: { concurrency?: number; signal?: AbortSignal } = {}) {
  const chapters = orderedChapters(project);
  const batch = Math.max(1, options.concurrency ?? 8);
  for (let start = 0; start < chapters.length; start += batch) {
    if (options.signal?.aborted) return;
    const slice = chapters.slice(start, start + batch);
    const texts = await Promise.all(slice.map((chapter) => loadChapterText(project.id, chapter.id)));
    for (let index = 0; index < slice.length; index += 1) await visit(slice[index].id, texts[index], start + index);
  }
}

export type SaveResult = { draft: ProjectDraft; conflicts: MergeConflict[]; changed: boolean };

/**
 * Saves `next` relative to the draft's `base`. Only changed items are written; items changed elsewhere since `base`
 * are kept as they are on disk, reported as conflicts, and the local version of conflicting text is kept as a snapshot.
 */
export async function saveDraft(base: ProjectDraft, next: ProjectDraft): Promise<SaveResult> {
  const changes = diffDrafts(base, next);
  if (!changes.length) return { draft: next, conflicts: [], changed: false };
  const projectId = next.project.id;
  return withWriterMutationLock(async () => {
    const currentProject = normalizeProject(await readJson(projectFile(projectId)));
    const touched = [...new Set(changes.flatMap((change) => (change.kind === "text" ? [change.chapterId] : [])))];
    const currentTexts: ChapterTexts = {};
    await mapLimit(touched.filter((id) => currentProject.chapters.some((chapter) => chapter.id === id)), 8, async (id) => { currentTexts[id] = await loadChapterText(projectId, id); });
    const result = mergeDraft(base, next, { project: currentProject, texts: currentTexts }, changes);
    const merged = result.merged;

    for (const conflict of result.conflicts) {
      if (conflict.change.kind !== "text") continue;
      const mine = next.texts[conflict.change.chapterId];
      if (mine !== undefined) await createSnapshot(projectId, { kind: "chapter", id: conflict.change.chapterId }, `${docTitle(next.project, { kind: "chapter", id: conflict.change.chapterId })}（冲突时的本地版本）`, mine, "before-replace", { force: true });
    }

    const now = unixTimestamp();
    for (const id of touched) {
      const exists = merged.project.chapters.some((chapter) => chapter.id === id);
      if (!exists) { await removeFile(chapterFile(projectId, id)); continue; }
      const text = merged.texts[id];
      if (text !== undefined && text !== currentTexts[id]) {
        await writeText(chapterFile(projectId, id), text);
        const chapter = merged.project.chapters.find((item) => item.id === id);
        if (chapter) { refreshChapterDerived(chapter, text); chapter.updatedAt = now; }
      }
    }
    merged.project.updatedAt = Math.max(Date.now(), currentProject.updatedAt + 1);
    await writeProjectFile(merged.project);

    const texts: ChapterTexts = {};
    for (const id of Object.keys(next.texts)) {
      if (!merged.project.chapters.some((chapter) => chapter.id === id)) continue;
      texts[id] = merged.texts[id] ?? currentTexts[id] ?? next.texts[id];
    }
    return { draft: { project: merged.project, texts }, conflicts: result.conflicts, changed: true };
  });
}

/** Read-modify-write of project metadata under the mutation lock. */
export async function mutateProject<T>(projectId: string, mutate: (project: WriterProject) => Promise<T> | T): Promise<{ project: WriterProject; result: T }> {
  return withWriterMutationLock(async () => {
    const project = normalizeProject(await readJson(projectFile(projectId)));
    const result = await mutate(project);
    project.updatedAt = Math.max(Date.now(), project.updatedAt + 1);
    await writeProjectFile(project);
    return { project, result };
  });
}

/** Writes chapter bodies and their derived metadata (used by import and batch operations). Caller holds no lock. */
export async function writeChapterTexts(projectId: string, texts: ChapterTexts) {
  await mapLimit(Object.entries(texts), 8, ([chapterId, text]) => writeText(chapterFile(projectId, chapterId), text));
}

export async function deleteProject(projectId: string) {
  await withWriterMutationLock(async () => {
    const index = await readIndex();
    index.projectIds = index.projectIds.filter((id) => id !== projectId);
    await writeJson(INDEX_PATH, index, true);
    await removeFile(projectFile(projectId));
  });
}

export async function writeProjectFile(project: WriterProject) {
  await writeJson(projectFile(project.id), project);
}

export function chapterHashMatches(project: WriterProject, chapterId: string, text: string) {
  return project.chapters.find((chapter) => chapter.id === chapterId)?.contentHash === contentHash(stripImageMarkup(text));
}

async function addToIndex(projectId: string) {
  const index = await readIndex();
  if (!index.projectIds.includes(projectId)) {
    index.projectIds.push(projectId);
    await writeJson(INDEX_PATH, index, true);
  }
}

async function readIndex(): Promise<ProjectIndex> {
  const stored = asRecord(await readJson(INDEX_PATH).catch(() => undefined));
  const ids = new Set<string>();
  for (const value of Array.isArray(stored.projectIds) ? stored.projectIds : []) {
    try { ids.add(projectIdValue(value)); } catch { /* skip invalid ids */ }
  }
  let repaired = !Array.isArray(stored.projectIds);
  for (const entry of await listEntries(PROJECTS_DIR)) {
    if (!entry.isDirectory) continue;
    try {
      const id = projectIdValue(entry.name);
      if (!ids.has(id)) { ids.add(id); repaired = true; }
    } catch { /* not a project directory */ }
  }
  const index: ProjectIndex = { version: 3, projectIds: [...ids] };
  if (repaired) await writeJson(INDEX_PATH, index, true);
  return index;
}
