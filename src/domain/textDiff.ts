// Line (paragraph) level diff for prose review, with optional character-level highlighting inside changed lines.

export type DiffHunk = { index: number; beforeStart: number; afterStart: number; before: string[]; after: string[] };
export type DiffSegment = { type: "equal"; lines: string[]; beforeStart: number } | { type: "change"; hunk: DiffHunk };
export type LineDiff = { segments: DiffSegment[]; hunks: DiffHunk[] };
export type InlinePart = { type: "equal" | "insert" | "delete"; text: string };

const MAX_LCS_CELLS = 4_000_000;

export function splitLines(text: string) { return text.split("\n"); }

export function diffLines(before: string, after: string): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = lcsOps(a, b, (x, y) => x === y);
  const segments: DiffSegment[] = [];
  const hunks: DiffHunk[] = [];
  let aIndex = 0;
  let bIndex = 0;
  let pending: DiffHunk | null = null;
  const flush = () => { if (pending) { hunks.push(pending); segments.push({ type: "change", hunk: pending }); pending = null; } };
  for (const op of ops) {
    if (op === "equal") {
      flush();
      const last = segments[segments.length - 1];
      if (last?.type === "equal") last.lines.push(a[aIndex]);
      else segments.push({ type: "equal", lines: [a[aIndex]], beforeStart: aIndex });
      aIndex += 1; bIndex += 1;
      continue;
    }
    pending ??= { index: hunks.length, beforeStart: aIndex, afterStart: bIndex, before: [], after: [] };
    if (op === "delete") { pending.before.push(a[aIndex]); aIndex += 1; }
    else { pending.after.push(b[bIndex]); bIndex += 1; }
  }
  flush();
  return { segments, hunks };
}

/** Rebuilds text taking `after` for accepted hunks and `before` for the rest. */
export function applyHunks(diff: LineDiff, accepted: Iterable<number>): string {
  const set = new Set(accepted);
  const lines: string[] = [];
  for (const segment of diff.segments) {
    if (segment.type === "equal") lines.push(...segment.lines);
    else lines.push(...(set.has(segment.hunk.index) ? segment.hunk.after : segment.hunk.before));
  }
  return lines.join("\n");
}

export function inlineDiff(before: string, after: string): InlinePart[] {
  const a = Array.from(before);
  const b = Array.from(after);
  if (a.length * b.length > 400_000) {
    return [...(before ? [{ type: "delete" as const, text: before }] : []), ...(after ? [{ type: "insert" as const, text: after }] : [])];
  }
  const parts: InlinePart[] = [];
  let aIndex = 0;
  let bIndex = 0;
  for (const op of lcsOps(a, b, (x, y) => x === y)) {
    const text = op === "insert" ? b[bIndex] : a[aIndex];
    if (op !== "insert") aIndex += 1;
    if (op !== "delete") bIndex += 1;
    const last = parts[parts.length - 1];
    if (last && last.type === op) last.text += text;
    else parts.push({ type: op, text });
  }
  return parts;
}

/**
 * Inline changes a reader can follow: edits separated by only a few unchanged characters become one replacement, so a
 * rewritten clause reads as old-then-new rather than alternating fragments.
 */
export function readableInlineDiff(before: string, after: string, minEqual = 4): InlinePart[] {
  const merged: { del: string; ins: string; equal: string }[] = [];
  const parts = inlineDiff(before, after);
  let current = { del: "", ins: "", equal: "" };
  parts.forEach((part, index) => {
    if (part.type === "delete") current.del += part.text;
    else if (part.type === "insert") current.ins += part.text;
    else if (Array.from(part.text).length < minEqual && (current.del || current.ins) && index < parts.length - 1) { current.del += part.text; current.ins += part.text; }
    else { current.equal = part.text; merged.push(current); current = { del: "", ins: "", equal: "" }; }
  });
  if (current.del || current.ins) merged.push(current);
  return merged.flatMap((group) => [
    ...(group.del ? [{ type: "delete" as const, text: group.del }] : []),
    ...(group.ins ? [{ type: "insert" as const, text: group.ins }] : []),
    ...(group.equal ? [{ type: "equal" as const, text: group.equal }] : []),
  ]);
}

export function diffStats(diff: LineDiff) {
  let added = 0;
  let removed = 0;
  for (const hunk of diff.hunks) { added += hunk.after.join("\n").length; removed += hunk.before.join("\n").length; }
  return { hunks: diff.hunks.length, added, removed };
}

type Op = "equal" | "delete" | "insert";

function lcsOps<T>(a: T[], b: T[], equal: (x: T, y: T) => boolean): Op[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && equal(a[prefix], b[prefix])) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && equal(a[a.length - 1 - suffix], b[b.length - 1 - suffix])) suffix += 1;
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const ops: Op[] = Array<Op>(prefix).fill("equal");
  if (midA.length * midB.length > MAX_LCS_CELLS) {
    ops.push(...Array<Op>(midA.length).fill("delete"), ...Array<Op>(midB.length).fill("insert"));
  } else {
    ops.push(...lcsMiddle(midA, midB, equal));
  }
  ops.push(...Array<Op>(suffix).fill("equal"));
  return ops;
}

function lcsMiddle<T>(a: T[], b: T[], equal: (x: T, y: T) => boolean): Op[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = equal(a[i], b[j]) ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (equal(a[i], b[j])) { ops.push("equal"); i += 1; j += 1; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { ops.push("delete"); i += 1; }
    else { ops.push("insert"); j += 1; }
  }
  while (i < n) { ops.push("delete"); i += 1; }
  while (j < m) { ops.push("insert"); j += 1; }
  return ops;
}
