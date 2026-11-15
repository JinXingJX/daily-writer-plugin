// Splits an imported manuscript into volumes and chapters.

export type SplitChapter = { volumeTitle: string | null; title: string; content: string };
export type SplitMode = "auto" | "heading" | "length";
export type SplitOptions = { mode: SplitMode; targetLength: number; chapterPattern?: string; volumePattern?: string };
export type SplitResult = { chapters: SplitChapter[]; volumes: string[]; mode: "heading" | "length"; totalChars: number };

const NUM = "0-9０-９零〇一二两三四五六七八九十百千万";
export const DEFAULT_CHAPTER_PATTERN = `^\\s*((?:第[${NUM}]+[章回节话幕])|(?:chapter|CHAPTER|Chapter)\\s*\\d+|序章|序言|序幕|楔子|引子|尾声|终章|后记|番外)(.{0,40})$`;
export const DEFAULT_VOLUME_PATTERN = `^\\s*(第[${NUM}]+[卷部集篇])(.{0,40})$`;

export function normalizeManuscript(text: string) {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/[ \t　]+$/gm, "").replace(/\n{4,}/g, "\n\n\n");
}

export function splitManuscript(raw: string, options: SplitOptions): SplitResult {
  const text = normalizeManuscript(raw);
  if (options.mode !== "length") {
    const byHeading = splitByHeadings(text, options);
    if (options.mode === "heading" || byHeading.chapters.length >= 2) return { ...byHeading, mode: "heading", totalChars: text.length };
  }
  const chapters = splitByLength(text, options.targetLength).map((content, index) => ({ volumeTitle: null, title: `第 ${index + 1} 节`, content }));
  return { chapters, volumes: [], mode: "length", totalChars: text.length };
}

function compile(pattern: string | undefined, fallback: string) {
  try { return new RegExp(pattern || fallback, "u"); } catch { return new RegExp(fallback, "u"); }
}

function splitByHeadings(text: string, options: SplitOptions) {
  const chapterRe = compile(options.chapterPattern, DEFAULT_CHAPTER_PATTERN);
  const volumeRe = compile(options.volumePattern, DEFAULT_VOLUME_PATTERN);
  const chapters: SplitChapter[] = [];
  const volumes: string[] = [];
  let volume: string | null = null;
  let current: { title: string; lines: string[] } | null = null;
  const preface: string[] = [];
  const close = () => {
    if (!current) return;
    chapters.push({ volumeTitle: volume, title: current.title, content: trimBlankLines(current.lines.join("\n")) });
    current = null;
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length <= 50 && volumeRe.test(trimmed) && !chapterRe.test(trimmed)) {
      close();
      volume = trimmed.replace(/\s+/g, " ");
      volumes.push(volume);
      continue;
    }
    if (trimmed.length <= 50 && chapterRe.test(trimmed)) {
      close();
      current = { title: trimmed.replace(/\s+/g, " "), lines: [] };
      continue;
    }
    if (current) current.lines.push(line); else preface.push(line);
  }
  close();
  const prefaceText = trimBlankLines(preface.join("\n"));
  if (prefaceText.length > 50 && chapters.length) chapters.unshift({ volumeTitle: chapters[0].volumeTitle, title: "前言", content: prefaceText });
  return { chapters: mergeEmptyChapters(chapters), volumes: [...new Set(volumes)] };
}

/** Headings followed by no text (tables of contents) are dropped. */
function mergeEmptyChapters(chapters: SplitChapter[]) { return chapters.filter((chapter) => chapter.content.trim().length > 0); }

export function splitByLength(text: string, target: number): string[] {
  const size = Math.max(1_000, target);
  const paragraphs = text.split(/\n/);
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const paragraph of paragraphs) {
    current.push(paragraph);
    length += paragraph.length + 1;
    if (length >= size) { chunks.push(trimBlankLines(current.join("\n"))); current = []; length = 0; }
  }
  const rest = trimBlankLines(current.join("\n"));
  if (rest) {
    if (chunks.length && rest.length < size / 3) chunks[chunks.length - 1] += `\n${rest}`;
    else chunks.push(rest);
  }
  return chunks.filter(Boolean);
}

function trimBlankLines(text: string) { return text.replace(/^\s*\n/, "").replace(/\n\s*$/, ""); }

/** Decodes uploaded bytes as UTF-8, falling back to GB18030 (common for Chinese .txt files). */
export function decodeManuscript(bytes: ArrayBuffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch {
    try { return new TextDecoder("gb18030").decode(bytes); }
    catch { return new TextDecoder("utf-8").decode(bytes); }
  }
}
