export type TextRange = { start: number; end: number };
export type TextAnchor = TextRange & { quote: string };

export function findOccurrences(text: string, quote: string, limit = 1_000): number[] {
  const positions: number[] = [];
  if (!quote) return positions;
  let index = text.indexOf(quote);
  while (index >= 0 && positions.length < limit) {
    positions.push(index);
    index = text.indexOf(quote, index + 1);
  }
  return positions;
}

/** Re-locates an anchor after edits: exact offset first, then the occurrence of the quote nearest to the old offset. */
export function resolveAnchor(text: string, anchor: TextAnchor): TextRange | null {
  if (!anchor.quote) return null;
  if (text.slice(anchor.start, anchor.end) === anchor.quote) return { start: anchor.start, end: anchor.end };
  const occurrences = findOccurrences(text, anchor.quote);
  if (!occurrences.length) return null;
  const nearest = occurrences.reduce((best, position) => (Math.abs(position - anchor.start) < Math.abs(best - anchor.start) ? position : best));
  return { start: nearest, end: nearest + anchor.quote.length };
}

export type LocateResult = { ok: true; range: TextRange } | { ok: false; count: number; message: string };

/** Finds a quote that must be unique, optionally disambiguated by text that immediately precedes it. */
export function locateUnique(text: string, quote: string, contextBefore?: string): LocateResult {
  if (!quote) return { ok: false, count: 0, message: "quote 不能为空。" };
  let occurrences = findOccurrences(text, quote);
  if (contextBefore && occurrences.length > 1) {
    const context = contextBefore.slice(-80);
    occurrences = occurrences.filter((position) => text.slice(Math.max(0, position - context.length), position).endsWith(context));
  }
  if (occurrences.length === 1) return { ok: true, range: { start: occurrences[0], end: occurrences[0] + quote.length } };
  if (!occurrences.length) return { ok: false, count: 0, message: "在文档中找不到这段原文，请先读取文档并逐字复制原文。" };
  return { ok: false, count: occurrences.length, message: `这段原文在文档中出现了 ${occurrences.length} 次，请提供更长的原文或 contextBefore 以唯一定位。` };
}

export function replaceRange(text: string, range: TextRange, replacement: string) {
  return `${text.slice(0, range.start)}${replacement}${text.slice(range.end)}`;
}

/** Expands a range to whole paragraphs (lines). */
export function paragraphRange(text: string, range: TextRange): TextRange {
  const start = text.lastIndexOf("\n", Math.max(0, range.start - 1)) + 1;
  const endIndex = text.indexOf("\n", range.end);
  return { start: range.start === 0 ? 0 : start, end: endIndex < 0 ? text.length : endIndex };
}

/**
 * Finds a selection again after the document may have changed: at its old offsets, or at its only
 * occurrence if edits shifted it. `null` when it was edited away or is ambiguous.
 */
export function relocateSelection(doc: string, range: { from: number; to: number }, original: string): { from: number; to: number } | null {
  if (doc.slice(range.from, range.to) === original) return range;
  if (!original) return null;
  const first = doc.indexOf(original);
  if (first < 0 || doc.indexOf(original, first + 1) >= 0) return null;
  return { from: first, to: first + original.length };
}
