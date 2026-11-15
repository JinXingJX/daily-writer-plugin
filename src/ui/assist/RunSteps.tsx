import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { asRecord, previewText, stringValue } from "../../domain/util";
import { localizeHostText } from "../../host";
import type { AgentSessionRun, AgentSessionToolCall } from "../../types";

/** Collapsible record of what the agent did in one turn: tool calls with inputs and results. */
export function RunSteps({ run }: { run: AgentSessionRun }) {
  const [open, setOpen] = useState(false);
  const notes = run.eventViews.filter((view) => (view.kind === "runtime" || view.kind === "error") && !subAgentOf(view.metadata));
  // Sub-agents' own tool calls are not in the run's record; their steps are.
  const subSteps = run.eventViews.filter((view) => view.kind === "tool_call" && subAgentOf(view.metadata));
  if (!run.toolCalls.length && !notes.length) return null;
  return (
    <div className="w-run-steps">
      <button type="button" className="w-run-steps-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        工作步骤（{run.toolCalls.length}）
        {run.iterationsUsed ? <span className="w-muted">· {run.iterationsUsed}/{run.maxIterations} 轮</span> : null}
      </button>
      {open ? (
        <ol>
          {notes.map((view) => <li key={view.id} className={`w-run-note ${view.status}`}>{localizeHostText(view.title, "zh-CN")}{view.content ? `：${previewText(localizeHostText(view.content, "zh-CN"), 200)}` : ""}</li>)}
          {run.toolCalls.map((call, index) => <ToolCallItem key={`${call.toolId}-${index}`} call={call} />)}
          {subSteps.map((view) => <li key={view.id} className={`w-run-note sub ${view.status}`}>{subAgentOf(view.metadata)} · {localizeHostText(view.title, "zh-CN")}</li>)}
        </ol>
      ) : null}
    </div>
  );
}

function subAgentOf(metadata: unknown): string { return stringValue(asRecord(asRecord(metadata).subAgent).name); }

function ToolCallItem({ call }: { call: AgentSessionToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const input = JSON.stringify(call.input ?? null, null, 1);
  return (
    <li className={call.ok ? "" : "failed"}>
      <button type="button" className="w-run-call" onClick={() => setExpanded(!expanded)}>
        <b>{call.toolName || call.toolId}</b>
        {call.rationale ? <span className="w-muted">{previewText(call.rationale, 60)}</span> : null}
      </button>
      {expanded ? (
        <div className="w-run-detail">
          <pre>{input}</pre>
          <pre>{call.result}</pre>
        </div>
      ) : <div className="w-run-preview">{previewText(call.result, 120)}</div>}
    </li>
  );
}
