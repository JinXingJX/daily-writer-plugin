import type { DocRef, ProposalChange, ProposalSelection, ProposalTextChange, WriterProposal } from "../types";
import { docKey } from "./documents";
import { uniqueId } from "./ids";
import { applyHunks, diffLines } from "./textDiff";
import { unixTimestamp } from "./util";

export function changeDocKey(change: ProposalChange): string | null { return change.kind === "text" ? docKey(change.doc) : null; }

export function isChangeAccepted(change: ProposalChange, selection: ProposalSelection | undefined) {
  return selection?.[change.id]?.accepted ?? true;
}

/** Final text for a text change under the user's hunk selection; `null` when nothing is accepted. */
export function selectedTextResult(change: ProposalTextChange, selection: ProposalSelection | undefined): string | null {
  const choice = selection?.[change.id];
  if (choice && !choice.accepted) return null;
  if (!choice?.hunks) return change.after;
  const diff = diffLines(change.before, change.after);
  if (!choice.hunks.length && diff.hunks.length) return null;
  return applyHunks(diff, choice.hunks);
}

export function proposalTouchesDoc(proposal: WriterProposal, ref: DocRef) {
  const key = docKey(ref);
  return proposal.changes.some((change) => changeDocKey(change) === key);
}

/** Merges consecutive edits of the same document into one change: original `before`, latest `after`. */
export function coalesceTextChanges(changes: ProposalChange[]): ProposalChange[] {
  const result: ProposalChange[] = [];
  const byDoc = new Map<string, ProposalTextChange>();
  for (const change of changes) {
    if (change.kind !== "text") { result.push(change); continue; }
    const key = docKey(change.doc);
    const existing = byDoc.get(key);
    if (existing) {
      existing.after = change.after;
      existing.summary = [existing.summary, change.summary].filter(Boolean).join("；");
      continue;
    }
    const copy = { ...change };
    byDoc.set(key, copy);
    result.push(copy);
  }
  return result.filter((change) => change.kind !== "text" || change.before !== change.after || change.createChapter);
}

/** A pending proposal with defaults filled in. */
export function newProposal(fields: Pick<WriterProposal, "title" | "changes"> & Partial<WriterProposal>): WriterProposal {
  return { id: uniqueId("proposal"), instruction: "", summary: "", previewMarkdown: "", risks: [], status: "pending", createdAt: unixTimestamp(), appliedAt: null, appliedChangeIds: [], undo: null, conversationId: null, source: null, ...fields };
}
