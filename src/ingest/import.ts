import { contentHash, uniqueId } from "../domain/ids";
import { normalizeChapterMeta, normalizeVolume } from "../domain/normalize";
import { rankAfter } from "../domain/ranks";
import { mapLimit } from "../domain/util";
import { countWords } from "../domain/words";
import { writeText } from "../storage/io";
import { chapterFile } from "../storage/paths";
import { createProject, mutateProject } from "../storage/projectStore";
import type { WriterChapterMeta, WriterProject, WriterVolume } from "../types";
import type { SplitResult } from "./splitter";

export type ImportProgress = (done: number, total: number) => void;

/** Imports split chapters into a new project, or appends them to an existing one. Chapter files are written first. */
export async function importManuscript(split: SplitResult, target: { projectId?: string; title?: string; genre?: string }, onProgress?: ImportProgress): Promise<WriterProject> {
  const projectId = target.projectId ?? (await createProject({ title: target.title, genre: target.genre })).id;
  const ids = split.chapters.map(() => uniqueId("chapter"));
  let done = 0;
  await mapLimit(split.chapters, 8, async (chapter, index) => {
    await writeText(chapterFile(projectId, ids[index]), chapter.content);
    done += 1;
    if (done % 20 === 0 || done === split.chapters.length) onProgress?.(done, split.chapters.length);
  });
  const { project } = await mutateProject(projectId, (project) => {
    const freshDefault = project.chapters.length === 0 && project.volumes.length === 1 ? project.volumes[0] : null;
    let renamedDefault = false;
    const ensureVolume = (title: string | null): WriterVolume => {
      const wanted = title ?? "正文";
      const existing = project.volumes.find((volume) => volume.title === wanted);
      if (existing) return existing;
      if (freshDefault && !renamedDefault) {
        renamedDefault = true;
        freshDefault.title = wanted;
        return freshDefault;
      }
      const volume = normalizeVolume({ id: uniqueId("volume"), title: wanted, rank: rankAfter(Math.max(0, ...project.volumes.map((item) => item.rank)) || undefined) });
      project.volumes.push(volume);
      return volume;
    };
    const lastRank = new Map<string, number>();
    for (const chapter of project.chapters) lastRank.set(chapter.volumeId, Math.max(lastRank.get(chapter.volumeId) ?? 0, chapter.rank));
    split.chapters.forEach((chapter, index) => {
      const volume = ensureVolume(chapter.volumeTitle);
      const rank = rankAfter(lastRank.get(volume.id));
      lastRank.set(volume.id, rank);
      const meta: WriterChapterMeta = normalizeChapterMeta({ id: ids[index], volumeId: volume.id, title: chapter.title, rank, status: "final", updatedAt: Math.floor(Date.now() / 1000) });
      meta.wordCount = countWords(chapter.content);
      meta.contentHash = contentHash(chapter.content);
      project.chapters.push(meta);
    });
  });
  return project;
}
