import { whileViewVisible } from "../../view";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { asRecord, previewText, stringValue } from "../../domain/util";
import type { AgentEventView } from "../../types";
import { localizeHostText } from "../../host";
import { Spinner } from "../common";

const RECENT_STEPS = 8;

/** Live step timeline: every model request and tool call, expandable to its input, result or streamed text. */
export function EventList({ events }: { events: AgentEventView[] }) {
  const [elapsed, setElapsed] = useState(0);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    const started = Date.now();
    return whileViewVisible(() => {
      const timer = globalThis.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1_000);
      return () => globalThis.clearInterval(timer);
    });
  }, []);
  const results = new Map(events.filter((event) => event.kind === "tool_result").map((event) => [event.id.replace(/-result$/, "-call"), event]));
  const steps = events.filter((event) => event.kind === "tool_call" || event.kind === "llm_thought" || event.kind === "runtime" || event.kind === "error");
  const hidden = showAll ? 0 : Math.max(0, steps.length - RECENT_STEPS);
  return (
    <div className="w-events" role="status">
      <div className="w-events-head"><Spinner size={12} />AI 正在工作… <span className="w-muted">{Math.floor(elapsed / 60) ? `${Math.floor(elapsed / 60)} 分 ` : ""}{elapsed % 60} 秒 · {steps.length} 步</span></div>
      {hidden ? <button type="button" className="w-link w-events-more" onClick={() => setShowAll(true)}>显示前面 {hidden} 步</button> : null}
      {steps.slice(hidden).map((event, index, shown) => <EventStep key={event.id} event={event} result={results.get(event.id)} last={index === shown.length - 1} />)}
    </div>
  );
}

function EventStep({ event, result, last }: { event: AgentEventView; result?: AgentEventView; last: boolean }) {
  const [open, setOpen] = useState(false);
  const meta = asRecord(event.metadata);
  const rationale = stringValue(meta.rationale);
  const thinking = event.kind === "llm_thought";
  const detail = localizeHostText(thinking ? event.content || stringValue(meta.request) : event.content, "zh-CN");
  // The step being streamed shows its latest text without expanding.
  const live = thinking && last && event.status === "in_progress" && event.content;
  const expandable = Boolean(detail || rationale || result);
  // Steps of a sub-agent the agent created sit under the call that started it.
  const subAgent = stringValue(asRecord(meta.subAgent).name);
  return (
    <div className={`w-event ${event.status}${subAgent ? " sub" : ""}`}>
      <button type="button" className="w-event-row" aria-expanded={open} disabled={!expandable} onClick={() => setOpen(!open)}>
        {expandable ? (open ? <ChevronDown size={11} /> : <ChevronRight size={11} />) : <span className="w-dot" />}
        {subAgent ? <span className="w-pill tone">{subAgent}</span> : null}
        <span className="w-event-title">{localizeHostText(event.title, "zh-CN")}</span>
        {rationale && !open ? <span className="w-muted w-event-hint">{previewText(rationale, 50)}</span> : null}
      </button>
      {live && !open ? <div className="w-event-stream">{event.content.slice(-240)}</div> : null}
      {open ? (
        <div className="w-run-detail">
          {rationale ? <p className="w-muted">{rationale}</p> : null}
          {detail ? <pre>{previewText(detail, 6_000)}</pre> : null}
          {result ? <pre>{previewText(result.content, 6_000)}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}
