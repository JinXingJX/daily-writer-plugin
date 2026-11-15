import type { ChapterTexts, DocRef, RootDocKind, WriterChapterMeta, WriterProject, WriterVolume } from "../types";
import { contentHash } from "./ids";
import { byRank } from "./ranks";
import { stripImageMarkup } from "../images/schema";
import { countWords } from "./words";

export const ROOT_DOCS: { kind: RootDocKind; label: string; field: "worldview" | "background" | "outline" | "styleGuide"; hint: string }[] = [
  { kind: "worldview", label: "世界观", field: "worldview", hint: "力量体系、地理、势力格局、历史、社会规则与专有名词。" },
  { kind: "background", label: "背景设定", field: "background", hint: "故事开始前发生的事、主角处境与核心矛盾的来源。" },
  { kind: "outline", label: "全书大纲", field: "outline", hint: "主线、分卷走向与关键转折。" },
  { kind: "style", label: "文风指南", field: "styleGuide", hint: "叙述视角、人称、语言风格、禁忌写法。AI 每次写作都会遵循这里的要求。" },
];

export function isRootDocKind(value: unknown): value is RootDocKind { return value === "worldview" || value === "background" || value === "outline" || value === "style"; }
export function rootDocInfo(kind: RootDocKind) { return ROOT_DOCS.find((doc) => doc.kind === kind) ?? ROOT_DOCS[0]; }

export function docKey(ref: DocRef): string { return ref.kind === "chapter" ? `chapter:${ref.id}` : ref.kind; }
export function docRefFromKey(key: string): DocRef | null {
  if (key.startsWith("chapter:")) return { kind: "chapter", id: key.slice("chapter:".length) };
  return isRootDocKind(key) ? { kind: key } : null;
}
export function sameDoc(left: DocRef, right: DocRef) { return docKey(left) === docKey(right); }

export const UNTITLED_CHAPTER = "未命名章节";

export function docTitle(project: WriterProject, ref: DocRef): string {
  if (ref.kind !== "chapter") return rootDocInfo(ref.kind).label;
  const chapter = project.chapters.find((item) => item.id === ref.id);
  return chapter ? chapter.title.trim() || UNTITLED_CHAPTER : "章节";
}

/** Returns document text, or `undefined` when a chapter body is not loaded. */
export function readDoc(project: WriterProject, texts: ChapterTexts, ref: DocRef): string | undefined {
  if (ref.kind === "chapter") return texts[ref.id];
  return project[rootDocInfo(ref.kind).field];
}

export function writeDoc(project: WriterProject, texts: ChapterTexts, ref: DocRef, content: string) {
  if (ref.kind !== "chapter") { project[rootDocInfo(ref.kind).field] = content; return; }
  texts[ref.id] = content;
  const chapter = project.chapters.find((item) => item.id === ref.id);
  if (chapter) refreshChapterDerived(chapter, content);
}

export function refreshChapterDerived(chapter: WriterChapterMeta, content: string) {
  chapter.wordCount = countWords(content);
  // Adding an illustration must not make the chapter's memory card stale.
  chapter.contentHash = contentHash(stripImageMarkup(content));
}

export function docExists(project: WriterProject, ref: DocRef) { return ref.kind !== "chapter" || project.chapters.some((chapter) => chapter.id === ref.id); }

export function sortedVolumes(project: WriterProject): WriterVolume[] { return [...project.volumes].sort(byRank); }

/** Chapters in reading order: by volume rank, then chapter rank. */
export function orderedChapters(project: WriterProject): WriterChapterMeta[] {
  const volumeRank = new Map(project.volumes.map((volume) => [volume.id, volume.rank]));
  return [...project.chapters].sort((left, right) => (volumeRank.get(left.volumeId) ?? 0) - (volumeRank.get(right.volumeId) ?? 0) || left.rank - right.rank);
}

/** Map chapter id -> 0-based reading position. Positions are recomputed from ranks, so reorders never rewrite memory. */
export function chapterPositions(project: WriterProject): Map<string, number> {
  return new Map(orderedChapters(project).map((chapter, index) => [chapter.id, index]));
}

export function chapterLabel(position: number) { return `第 ${position + 1} 章`; }

export function totalWords(project: WriterProject) { return project.chapters.reduce((total, chapter) => total + chapter.wordCount, 0); }
