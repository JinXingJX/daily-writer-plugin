// Pulls the body of a web novel chapter out of its page: the title, then the run of paragraphs with the most text.
// Works on plain server-rendered pages; pages that render their text with scripts come back empty.
import { dailyHost } from "../host";

export type WebChapter = { title: string; text: string; url: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ldquo: "“", rdquo: "”", hellip: "…", mdash: "—" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const value = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

function stripTags(html: string): string {
  return decode(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/[​﻿]/g, "").replace(/[ \t　]+/g, " ").trim();
}

export function extractChapter(html: string): { title: string; text: string } {
  const cleaned = html.replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const heading = cleaned.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const title = stripTags(heading).split(/[_|｜-]\s*/)[0].trim();
  // Group paragraphs by their parent block and keep the block with the most text: that is the chapter body.
  const blocks = new Map<number, string[]>();
  const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let match: RegExpExecArray | null;
  let lastEnd = -1;
  let block = 0;
  while ((match = paragraph.exec(cleaned))) {
    // A gap with other markup than whitespace or closing/opening tags of inline wrappers starts a new block.
    const gap = lastEnd < 0 ? "" : cleaned.slice(lastEnd, match.index);
    if (lastEnd >= 0 && /<\/(div|section|article|main)>/i.test(gap)) block += 1;
    lastEnd = match.index + match[0].length;
    const line = stripTags(match[1]);
    if (line) blocks.set(block, [...(blocks.get(block) ?? []), line]);
  }
  let best: string[] = [];
  for (const lines of blocks.values()) if (lines.join("").length > best.join("").length) best = lines;
  const text = best.length ? best.join("\n") : stripTags(cleaned.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? "");
  return { title, text: text.replace(/\n{3,}/g, "\n\n").trim() };
}

/** Fetches a chapter page through the host's SSRF-guarded network bridge. */
export async function fetchChapter(url: string): Promise<WebChapter> {
  const response = await dailyHost().network.fetch(url.trim(), { timeoutMs: 20_000 });
  if (!response.ok) throw new Error(`页面打不开（HTTP ${response.status}）。`);
  const { title, text } = extractChapter(response.text);
  if (text.length < 200) throw new Error("没在页面里找到章节正文。可能是付费章节、需要登录，或者正文是由脚本加载的；可以直接复制正文粘贴进来。");
  return { title, text, url: response.url || url };
}
