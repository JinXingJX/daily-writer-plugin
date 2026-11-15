import { useMemo, useState } from "react";
import { diffLines } from "../../domain/textDiff";
import { appendProposal, applyProposal, setProposalStatus, undoProposal } from "../../storage/proposalStore";
import type { ProposalSelection, WriterProposal } from "../../types";
import { useDialogs } from "../common";
import { useWriter } from "../useWriter";

/** Which parts of a proposal the author takes, and applying, rejecting or undoing it. */
export function useProposalActions(proposal: WriterProposal) {
  const writer = useWriter();
  const dialogs = useDialogs();
  const [busy, setBusy] = useState<string | null>(null);
  const [selection, setSelection] = useState<ProposalSelection>({});
  const project = writer.project;
  const hunkCounts = useMemo(() => new Map(proposal.changes.map((change) => [change.id, change.kind === "text" ? diffLines(change.before, change.after).hunks.length : 0])), [proposal.changes]);

  const isAccepted = (id: string) => selection[id]?.accepted ?? true;
  const acceptedHunks = (id: string) => new Set(selection[id]?.hunks ?? Array.from({ length: hunkCounts.get(id) ?? 0 }, (_, index) => index));
  // Re-checking a change takes all of its hunks again, even if every hunk had been unticked one by one.
  const toggleChange = (id: string) => setSelection((current) => ({ ...current, [id]: isAccepted(id) ? { ...current[id], accepted: false } : { accepted: true } }));
  const setHunk = (id: string, hunk: number, take: boolean) => setSelection((current) => {
    const set = acceptedHunks(id);
    if (take) set.add(hunk); else set.delete(hunk);
    return { ...current, [id]: { accepted: set.size > 0, hunks: [...set] } };
  });
  const toggleHunk = (id: string, hunk: number) => setHunk(id, hunk, !acceptedHunks(id).has(hunk));

  const run = async (label: string, task: () => Promise<void>) => {
    if (!project) return;
    setBusy(label);
    try { await writer.flush(); await task(); }
    catch (error) { writer.notify("error", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  };

  const undo = () => run("undo", async () => {
    if (!project || !(await dialogs.confirm("撤销这次 AI 修改", "会把相关文档恢复到应用前的版本（应用后又手动修改过的文档会跳过）。"))) return;
    const result = await undoProposal(project.id, proposal.id);
    writer.adopt(result.project, result.texts);
    writer.setProposals(result.proposals);
    void writer.refreshMemory(true);
    void writer.refreshStory();
    writer.notify(result.skipped.length ? "error" : "success", result.skipped.length ? `已撤销，但以下内容在应用后被修改过，未恢复：${result.skipped.join("、")}` : "已撤销。");
  });

  const apply = (afterApplied?: () => void) => run("apply", async () => {
    if (!project) return;
    const result = await applyProposal(project.id, proposal.id, selection);
    writer.adopt(result.project, result.texts);
    writer.setProposals(result.proposals);
    if (result.failures.length) writer.notify("error", `部分修改未应用：${result.failures.map((failure) => `${failure.title}（${failure.reason}）`).join("；")}`);
    else writer.notify("success", "已写入稿纸。", { label: "撤销", run: () => void undo() });
    void writer.refreshMemory(true);
    void writer.refreshStory();
    afterApplied?.();
  });
  const reject = (afterRejected?: () => void) => run("reject", async () => {
    if (!project) return;
    writer.setProposals(await setProposalStatus(project.id, proposal.id, "rejected"));
    afterRejected?.();
  });
  const retry = () => run("retry", async () => {
    if (!project) return;
    const copy: WriterProposal = { ...proposal, id: `${proposal.id}-r${Date.now().toString(36)}`, status: "pending", appliedAt: null, appliedChangeIds: [], undo: null, createdAt: Math.floor(Date.now() / 1000) };
    writer.setProposals(await appendProposal(project.id, copy));
  });

  const acceptedCount = proposal.changes.filter((change) => isAccepted(change.id) && (change.kind !== "text" || acceptedHunks(change.id).size > 0 || (hunkCounts.get(change.id) ?? 0) === 0)).length;
  const partial = acceptedCount < proposal.changes.length || Object.values(selection).some((choice) => choice.hunks !== undefined);
  return { busy, selection, hunkCounts, isAccepted, acceptedHunks, toggleChange, setHunk, toggleHunk, apply, reject, undo, retry, acceptedCount, partial };
}
