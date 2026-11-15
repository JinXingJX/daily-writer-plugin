// Whole-book search and replace over chapter files.
import { docTitle, refreshChapterDerived } from "../domain/documents";
import { unixTimestamp } from "../domain/util";
import type { ChapterTexts, WriterProject } from "../types";
import { writeText } from "./io";
import { chapterFile } from "./paths";
import { forEachChapterText, loadChapterText, mutateProject } from "./projectStore";
import { createSnapshot } from "./snapshots";

export type SearchOptions = { regex?: boolean; caseSensitive?: boolean; limitPerChapter?: number };
export type SearchHit = { chapterId: string; position: number; count: number; snippets: { start: number; before: string; match: string; after: string }[] };

export function buildMatcher(query: string, options: SearchOptions): RegExp {
  const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(source, options.caseSensitive ? "gu" : "giu");
}

export async function searchBook(project: WriterProject, query: string, options: SearchOptions = {}, onProgress?: (done: number, total: number, hits: SearchHit[]) => void, signal?: AbortSignal): Promise<SearchHit[]> {
  if (!query) return [];
  const matcher = buildMatcher(query, options);
  const hits: SearchHit[] = [];
  const total = project.chapters.length;
  await forEachChapterText(project, (chapterId, text, position) => {
    matcher.lastIndex = 0;
    const snippets: SearchHit["snippets"] = [];
    let count = 0;
    for (const match of text.matchAll(matcher)) {
      if (!match[0]) break;
      count += 1;
      if (snippets.length < (options.limitPerChapter ?? 5)) {
        const start = match.index ?? 0;
        snippets.push({ start, before: text.slice(Math.max(0, start - 30), start).replace(/\n/g, " "), match: match[0], after: text.slice(start + match[0].length, start + match[0].length + 30).replace(/\n/g, " ") });
      }
    }
    if (count) hits.push({ chapterId, position, count, snippets });
    if ((position + 1) % 40 === 0 || position + 1 === total) onProgress?.(position + 1, total, hits);
  }, { signal });
  return hits;
}

/** Replaces in the given chapters; every changed chapter gets a "before-replace" snapshot first. */
export async function replaceInBook(project: WriterProject, query: string, replacement: string, chapterIds: string[], options: SearchOptions = {}): Promise<{ project: WriterProject; texts: ChapterTexts; replaced: number }> {
  const matcher = buildMatcher(query, options);
  const texts: ChapterTexts = {};
  let replaced = 0;
  for (const chapterId of chapterIds) {
    const before = await loadChapterText(project.id, chapterId);
    let count = 0;
    const after = before.replace(matcher, (...args) => { count += 1; return options.regex ? expandReplacement(replacement, args) : replacement; });
    if (!count || after === before) continue;
    await createSnapshot(project.id, { kind: "chapter", id: chapterId }, docTitle(project, { kind: "chapter", id: chapterId }), before, "before-replace", { force: true });
    await writeText(chapterFile(project.id, chapterId), after);
    texts[chapterId] = after;
    replaced += count;
  }
  const { project: next } = await mutateProject(project.id, (current) => {
    for (const [chapterId, text] of Object.entries(texts)) {
      const chapter = current.chapters.find((item) => item.id === chapterId);
      if (chapter) { refreshChapterDerived(chapter, text); chapter.updatedAt = unixTimestamp(); }
    }
  });
  return { project: next, texts, replaced };
}

function expandReplacement(template: string, args: unknown[]) {
  const groups = args.slice(1, -2) as (string | undefined)[];
  return template.replace(/\$(\d)/g, (_, digit: string) => groups[Number(digit) - 1] ?? "");
}
