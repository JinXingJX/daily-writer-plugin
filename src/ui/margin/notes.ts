// What sits in the margin of a document: comments, notes written at publish time, continuity conflicts and story-health
// findings, reduced to one shape. Anchored notes line up with the paragraph they talk about.
import { resolveAnchor } from "../../domain/anchors";
import { chapterLabel } from "../../domain/documents";
import type { MemoryConflict } from "../../memory/schema";
import { HEALTH_RULE_LABELS, type HealthIssue } from "../../story/health";
import type { WriterComment } from "../../types";

export type MarginNoteSource = "comment" | "publish" | "conflict" | "health";
export type MarginNote = { id: string; source: MarginNoteSource; sourceId: string; tag: string; body: string; quote: string; from: number | null; to: number | null; severity: string; byAuthor: boolean };

const SEVERITY_TAGS: Record<string, string> = { error: "问题", warning: "留意", info: "批注" };

/** A comment's leading 〔label〕 becomes its tag. */
function splitTag(comment: string, severity: string) {
  const match = comment.match(/^〔([^〕]+)〕\s*/);
  return match ? { tag: match[1], body: comment.slice(match[0].length) } : { tag: SEVERITY_TAGS[severity] ?? "批注", body: comment };
}

function commentNote(comment: WriterComment, source: "comment" | "publish", text: string): MarginNote {
  const range = comment.quote ? resolveAnchor(text, { start: comment.start, end: comment.start + comment.quote.length, quote: comment.quote }) : null;
  const byAuthor = comment.author !== "ai";
  const { tag, body } = splitTag(comment.comment, comment.severity);
  return { id: `${source}:${comment.id}`, source, sourceId: comment.id, tag: byAuthor ? "我的批注" : tag, body, quote: comment.quote, from: range?.start ?? null, to: range?.end ?? null, severity: comment.severity, byAuthor };
}

function conflictNote(conflict: MemoryConflict, chapterId: string, text: string, positionOf: (chapterId: string) => number): MarginNote | null {
  const here = conflict.values.find((value) => value.chapterId === chapterId);
  if (!here) return null;
  const others = conflict.values.filter((value) => value !== here).map((value) => `${chapterLabel(positionOf(value.chapterId))}是“${value.value}”`);
  const at = here.quote ? text.indexOf(here.quote) : -1;
  return {
    id: `conflict:${conflict.id}`, source: "conflict", sourceId: conflict.id, tag: "前后矛盾", quote: here.quote,
    body: `${conflict.subject}的${conflict.attribute}这里写的是“${here.value}”${others.length ? `，${others.join("，")}` : ""}。${conflict.note}`.trim(),
    from: at >= 0 ? at : null, to: at >= 0 ? at + here.quote.length : null, severity: "warning", byAuthor: false,
  };
}

export type MarginNoteInput = {
  text: string;
  docKey: string;
  chapterId: string | null;
  comments: WriterComment[];
  publishNotes: WriterComment[];
  conflicts: MemoryConflict[];
  health: HealthIssue[];
  positionOf: (chapterId: string) => number;
};

/** Notes for one document: anchored ones in reading order first, then what concerns the whole chapter. */
export function buildMarginNotes(input: MarginNoteInput): MarginNote[] {
  const notes: MarginNote[] = input.comments.filter((comment) => !comment.resolved).map((comment) => commentNote(comment, "comment", input.text));
  for (const comment of input.publishNotes) if (!comment.resolved) notes.push(commentNote(comment, "publish", input.text));
  if (input.chapterId) {
    for (const conflict of input.conflicts) {
      if (conflict.status !== "open") continue;
      const note = conflictNote(conflict, input.chapterId, input.text, input.positionOf);
      if (note) notes.push(note);
    }
    for (const issue of input.health) notes.push({ id: `health:${issue.id}`, source: "health", sourceId: issue.id, tag: HEALTH_RULE_LABELS[issue.rule], body: issue.message, quote: "", from: null, to: null, severity: issue.severity, byAuthor: false });
  }
  const anchored = notes.filter((note) => note.from !== null).sort((left, right) => (left.from as number) - (right.from as number));
  return [...anchored, ...notes.filter((note) => note.from === null)];
}

/** Puts each note as close to its paragraph as it can get without overlapping the one above. */
export function stackNotes(items: { id: string; top: number; height: number }[], gap = 12): Record<string, number> {
  const tops: Record<string, number> = {};
  let floor = Number.NEGATIVE_INFINITY;
  for (const item of [...items].sort((left, right) => left.top - right.top)) {
    const top = Math.max(item.top, floor);
    tops[item.id] = top;
    floor = top + item.height + gap;
  }
  return tops;
}
