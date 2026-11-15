import { stripImageMarkup } from "../images/schema";

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/** CJK characters count one each; other scripts count by word sequence. */
export function countWords(raw: string) {
  const content = stripImageMarkup(raw);
  const cjkCharacters = content.match(CJK)?.length ?? 0;
  const nonCjk = content.replace(CJK, " ");
  const wordSequences = nonCjk.match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  return cjkCharacters + wordSequences;
}

/** Rough token estimate for budgeting model calls (CJK ~1 token/char, latin ~1 token/4 chars). */
export function estimateTokens(content: string) {
  const cjk = content.match(CJK)?.length ?? 0;
  return Math.ceil(cjk + (content.length - cjk) / 4);
}

export function formatWordCount(count: number) {
  if (count >= 10_000) return `${(count / 10_000).toFixed(count >= 1_000_000 ? 0 : 1)} 万字`;
  return `${count} 字`;
}
