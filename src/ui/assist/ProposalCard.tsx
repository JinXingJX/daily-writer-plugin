import { Check, ChevronDown, ChevronRight, RotateCcw, Sparkles, Undo2, X } from "lucide-react";
import { useState } from "react";
import { docKey, docTitle } from "../../domain/documents";
import type { WriterProposal } from "../../types";
import { Markdown, Spinner } from "../common";
import { useWriter } from "../useWriter";
import { DiffView } from "./DiffView";
import { useProposalActions } from "./useProposalActions";

export const PROPOSAL_STATUS_LABELS: Record<WriterProposal["status"], string> = { pending: "待审核", applied: "已应用", partially_applied: "部分应用", rejected: "已放弃", superseded: "已被新版本替代", reverted: "已撤销" };

export function ProposalCard({ proposal, onRefine, onReveal }: { proposal: WriterProposal; onRefine?: (proposal: WriterProposal) => void; onReveal?: (key: string) => void }) {
  const writer = useWriter();
  const actions = useProposalActions(proposal);
  const { busy, hunkCounts, isAccepted, acceptedHunks, toggleChange, toggleHunk, acceptedCount, partial } = actions;
  const [open, setOpen] = useState<Set<string>>(() => new Set(proposal.changes.slice(0, 1).map((change) => change.id)));
  const project = writer.project;
  const pending = proposal.status === "pending";
  if (!project) return null;

  const textChanges = proposal.changes.filter((change) => change.kind === "text").length;
  return (
    <section className={`w-proposal ${pending ? "" : "done"}`}>
      <header className="w-proposal-head">
        <Sparkles size={14} />
        <strong>{proposal.title}</strong>
        {proposal.source?.kind === "pipeline" ? <span className="w-pill">编辑部</span> : null}
        <span className={`w-pill ${pending ? "tone" : ""}`}>{PROPOSAL_STATUS_LABELS[proposal.status]}</span>
      </header>
      {proposal.summary ? <p className="w-proposal-summary">{proposal.summary}</p> : null}
      {proposal.risks.length ? <ul className="w-proposal-risks">{proposal.risks.map((risk, index) => <li key={index}>{risk}</li>)}</ul> : null}
      <div className="w-changes">
        {proposal.changes.map((change) => {
          const expanded = open.has(change.id);
          const accepted = isAccepted(change.id);
          const title = change.kind === "text" ? (change.createChapter ? `新章节：${change.title}` : change.doc.kind === "chapter" ? docTitle(project, change.doc) || change.title : change.title) : change.label;
          const promptPatch = change.kind === "entity" && change.operation.type === "setPromptConfig" ? change.operation.patch : null;
          const expandable = change.kind === "text" || Boolean(promptPatch);
          return (
            <div key={change.id} className={`w-change ${accepted ? "" : "rejected"}`}>
              <div className="w-change-head">
                {pending ? <input type="checkbox" checked={accepted} onChange={() => toggleChange(change.id)} aria-label="采用这项修改" /> : null}
                <button type="button" className="w-change-title" onClick={() => setOpen((current) => { const next = new Set(current); if (next.has(change.id)) next.delete(change.id); else next.add(change.id); return next; })}>
                  {expandable ? (expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}
                  <span>{title}</span>
                  {change.kind === "text" ? <span className="w-muted">{change.summary || `${hunkCounts.get(change.id)} 处`}</span> : null}
                </button>
                {change.kind === "text" && onReveal ? <button type="button" className="w-link" onClick={() => onReveal(docKey(change.doc))}>打开</button> : null}
              </div>
              {change.kind === "text" && expanded ? <DiffView before={change.before} after={change.after} accepted={pending ? acceptedHunks(change.id) : undefined} onToggle={pending ? (hunk) => toggleHunk(change.id, hunk) : undefined} /> : null}
              {promptPatch && expanded ? (
                <div className="w-prompt-change">
                  {promptPatch.overrides ? <p className="w-muted">覆盖的提示词：{Object.keys(promptPatch.overrides).join("、") || "全部恢复默认"}</p> : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {proposal.previewMarkdown ? <details className="w-proposal-report"><summary>查看报告与复测依据</summary><Markdown content={proposal.previewMarkdown} className="small" /></details> : null}
      <footer className="w-proposal-actions">
        {pending ? (
          <>
            <button type="button" className="w-btn w-btn-zhu" disabled={Boolean(busy)} onClick={() => writer.openReview(proposal.id)}>在稿纸上审</button>
            <button type="button" className="w-btn" disabled={Boolean(busy) || acceptedCount === 0} title={acceptedCount === 0 ? "没有勾选任何修改" : undefined} onClick={() => void actions.apply()}>{busy === "apply" ? <Spinner size={12} /> : <Check size={13} />}{acceptedCount === 0 ? "未选择修改" : partial ? `应用所选（${acceptedCount}/${proposal.changes.length}）` : textChanges > 1 ? "全部应用" : "应用"}</button>
            {onRefine ? <button type="button" className="w-btn" disabled={Boolean(busy)} onClick={() => onRefine(proposal)}><RotateCcw size={13} />再改改</button> : null}
            <button type="button" className="w-btn ghost" disabled={Boolean(busy)} onClick={() => void actions.reject()}><X size={13} />放弃</button>
          </>
        ) : null}
        {(proposal.status === "applied" || proposal.status === "partially_applied") && proposal.undo ? <button type="button" className="w-btn" disabled={Boolean(busy)} onClick={() => void actions.undo()}>{busy === "undo" ? <Spinner size={12} /> : <Undo2 size={13} />}撤销</button> : null}
        {proposal.status === "rejected" || proposal.status === "reverted" ? <button type="button" className="w-btn ghost" disabled={Boolean(busy)} onClick={() => void actions.retry()}>恢复为待审核</button> : null}
      </footer>
    </section>
  );
}
