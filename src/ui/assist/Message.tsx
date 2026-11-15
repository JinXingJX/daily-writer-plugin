import { Plus } from "lucide-react";
import { useState } from "react";
import { friendlyAiError } from "../../ai/client";
import { craftLabel } from "../../ai/craft";
import { entryKind, entryMeta, type ConventionSuggestion } from "../../ai/sessions";
import { INTERACTION_TOOLS } from "../../ai/tools";
import { docRefFromKey } from "../../domain/documents";
import type { AgentSessionEntry, WriterProposal } from "../../types";
import { uniqueId } from "../../domain/ids";
import { unixTimestamp } from "../../domain/util";
import { Markdown } from "../common";
import { useNotebook } from "../story/useNotebook";
import { ProposalCard } from "./ProposalCard";
import { RunSteps } from "./RunSteps";

export function proposalOf(entry: AgentSessionEntry, proposals: Map<string, WriterProposal>) {
  const id = entryMeta(entry).proposalId;
  return id ? proposals.get(id) : undefined;
}

export function Message({ entry, live, proposal, onRefine, onReveal, onLink, onRetry, onContinue, onAbandon }: { entry: AgentSessionEntry; live: boolean; proposal?: WriterProposal; onRefine: (proposal: WriterProposal) => void; onReveal: (key: string) => void; onLink: (key: string) => void; onRetry?: () => void; onContinue?: () => void; onAbandon?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  if (entry.role === "user") {
    const long = entry.content.length > 600;
    return <div className="w-msg user"><div className="w-bubble">{long && !expanded ? `${entry.content.slice(0, 600)}…` : entry.content}{long ? <button type="button" className="w-link" onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : `展开全文（${entry.content.length} 字）`}</button> : null}</div></div>;
  }
  const kind = entryKind(entry);
  const run = entry.run;
  // While the task runs, live progress is shown by the event list instead.
  if (run?.status === "running" && live) return null;
  const steps = run ? <RunSteps run={run} /> : null;
  if (kind === "error") {
    const resumable = Boolean(run?.runId && onContinue);
    return (
      <div className="w-msg error">
        {steps}
        <div className="w-bubble">
          {friendlyAiError(run?.error || entry.content)}
          <div className="w-msg-actions">
            {resumable ? <button type="button" className="w-btn small" title="保留已完成的步骤和草稿修改，从失败的那一步继续" onClick={onContinue}>从断点继续</button> : null}
            {onRetry ? <button type="button" className="w-link" title="作为新消息重新发送这条要求" onClick={onRetry}>重新发送</button> : null}
          </div>
        </div>
      </div>
    );
  }
  // Stopped while a Writer tool was pending: the run keeps its checkpoint.
  if (run?.status === "waiting" && run.runId && run.pendingToolId && !INTERACTION_TOOLS.has(run.pendingToolId)) {
    return (
      <div className="w-msg assistant">
        {steps}
        <p className="w-muted">（已暂停）</p>
        <div className="w-msg-actions">
          {onContinue ? <button type="button" className="w-btn small" onClick={onContinue}>继续</button> : null}
          {onAbandon ? <button type="button" className="w-link" onClick={onAbandon}>放弃</button> : null}
        </div>
      </div>
    );
  }
  const displays = entryMeta(entry).displays ?? [];
  const conventions = entryMeta(entry).conventions ?? [];
  const content = kind === "question" ? run?.pendingMessage || entry.content : run && run.status !== "completed" && !entry.content ? statusText(run.status) : entry.content;
  return (
    <div className="w-msg assistant" onClick={(event) => {
      const anchor = (event.target as HTMLElement).closest("a");
      const href = anchor?.getAttribute("href") ?? "";
      if (href.startsWith("#")) { event.preventDefault(); const key = href.slice(1); if (docRefFromKey(key)) onLink(key); }
    }}>
      {steps}
      {displays.map((display) => <Markdown key={display.id} content={`### ${display.title}\n\n${display.content}`} />)}
      {content ? <Markdown content={content} /> : null}
      {kind === "question" && run?.status === "waiting" ? <p className="w-muted">（等待你的回答）</p> : null}
      {conventions.length ? <Conventions conventions={conventions} /> : null}
      {proposal ? <ProposalCard proposal={proposal} onRefine={onRefine} onReveal={onReveal} /> : null}
    </div>
  );
}

/** Writing conventions the assistant suggested; each becomes a craft note only when the author files it. */
function Conventions({ conventions }: { conventions: ConventionSuggestion[] }) {
  const { notebook, loaded, update } = useNotebook();
  const filed = (convention: ConventionSuggestion) => notebook.notes.some((note) => note.kind === "craft" && note.text === convention.text);
  const adopt = (convention: ConventionSuggestion) => update((draft) => {
    const now = unixTimestamp();
    draft.notes.unshift({ id: uniqueId("note"), kind: "craft", text: convention.text, plan: convention.plan, topic: convention.topic, chapterId: null, done: false, origin: "ai", createdAt: now, updatedAt: now });
  });
  return (
    <ul className="w-notebook-list">
      {conventions.map((convention, index) => (
        <li key={index}>
          <span><b>〔写法约定·{craftLabel(convention.topic)}〕</b>{convention.text}{convention.plan ? `：${convention.plan}` : ""}</span>
          {!loaded ? null : filed(convention) ? <span className="w-pill ok">已记下</span> : <button type="button" className="w-link" onClick={() => void adopt(convention)}><Plus size={11} />记为写法约定</button>}
        </li>
      ))}
    </ul>
  );
}

function statusText(status: string) {
  if (status === "cancelled") return "（任务已结束）";
  if (status === "running") return "（任务未完成）";
  return "";
}
