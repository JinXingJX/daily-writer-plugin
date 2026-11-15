import { useEffect, useMemo, useRef, useState } from "react";
import type { ChapterPlan, PlanScene } from "../../ai/pipelines/nextChapter";
import { loadStudioPlan } from "../../ai/studioPlan";
import type { PlanWarning } from "../../story/planLint";
import type { AgentEventView, AgentSession, AgentSessionEntry } from "../../types";
import { Markdown } from "../common";
import { useWriter } from "../useWriter";

export type StudioStage = "direction" | "plan" | "draft" | "review";
const STAGES: { value: StudioStage; label: string }[] = [{ value: "direction", label: "方向" }, { value: "plan", label: "计划" }, { value: "draft", label: "逐场写" }, { value: "review", label: "自审" }];
const WRITE_TOOLS = new Set(["writer.createChapter", "writer.replaceDocument", "writer.replaceText", "writer.insertText"]);

/** The text of the newest plan in this conversation, for sessions whose structured plan is no longer kept. */
export function latestPlanText(entries: AgentSessionEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const calls = entries[index].run?.toolCalls ?? [];
    for (let at = calls.length - 1; at >= 0; at -= 1) if (calls[at].toolId === "writer.planChapter" && calls[at].ok) return calls[at].result;
  }
  return "";
}

/** How far the conversation's latest turn has come, read from the tools it has called. */
export function studioStage(entries: AgentSessionEntry[], events: AgentEventView[]): StudioStage {
  const last = [...entries].reverse().find((entry) => entry.run);
  const tools = [...(last?.run?.toolCalls.map((call) => call.toolId) ?? []), ...events.filter((event) => event.kind === "tool_call").map((event) => event.toolId ?? "")];
  if (tools.includes("writer.reviewChapter")) return "review";
  if (tools.some((tool) => WRITE_TOOLS.has(tool))) return "draft";
  if (tools.includes("writer.planChapter")) return "plan";
  return "direction";
}

const BEATS = [["cause", "因为"], ["goal", "他想要"], ["choice", "他选择"], ["outcome", "变了什么"]] as const;

/** The plan beside the conversation: the author edits it directly, then has it written. */
export function StudioPlan({ session, running, events, waiting, onSend }: { session: AgentSession | null; running: boolean; events: AgentEventView[]; waiting: boolean; onSend: (text: string) => void }) {
  const projectId = useWriter().project?.id;
  const entries = useMemo(() => session?.entries ?? [], [session]);
  const planText = useMemo(() => latestPlanText(entries), [entries]);
  const stage = studioStage(entries, events);
  const [plan, setPlan] = useState<ChapterPlan | null>(null);
  const [warnings, setWarnings] = useState<PlanWarning[]>([]);
  const [edited, setEdited] = useState(false);
  const shown = useRef("");
  const sessionId = session?.id;
  const planCalls = entries.reduce((total, entry) => total + (entry.run?.toolCalls.length ?? 0), 0) + events.length;
  // Re-read as the assistant works; the author's edits stay until the assistant makes a different plan.
  useEffect(() => {
    if (!projectId || !sessionId) { setPlan(null); setWarnings([]); shown.current = ""; return; }
    let cancelled = false;
    void loadStudioPlan(projectId, sessionId).then((record) => {
      const stamp = record ? JSON.stringify(record.plan) : "";
      if (cancelled || stamp === shown.current) return;
      shown.current = stamp;
      setPlan(record?.plan ?? null);
      setWarnings(record?.warnings ?? []);
      setEdited(false);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [planCalls, projectId, sessionId]);

  const updateScene = (index: number, patch: Partial<PlanScene>) => { setEdited(true); setPlan((current) => current && { ...current, scenes: current.scenes.map((scene, at) => (at === index ? { ...scene, ...patch } : scene)) }); };
  const updatePlan = (patch: Partial<ChapterPlan>) => { setEdited(true); setPlan((current) => current && { ...current, ...patch }); };
  const write = () => onSend(edited && plan ? `我改过章纲了，先用 planChapter 的 plan 参数传回去自查，再照它逐场写：\n${JSON.stringify(plan)}` : "章纲可以，按它逐场写。写完用 reviewChapter 审一遍，改掉要紧的问题再交给我。");

  return (
    <div className="w-studio-doc">
      <ol className="w-stages" aria-label="进度">
        {STAGES.map((item) => <li key={item.value} aria-current={stage === item.value ? "step" : undefined} className={stage === item.value ? "active" : ""}>{item.label}</li>)}
      </ol>
      {plan ? (
        <>
          <div className="w-studio-title">
            <input className="w-plan-heading" aria-label="章节标题" value={plan.title} placeholder="这一章叫什么" onChange={(event) => updatePlan({ title: event.currentTarget.value })} />
            <button type="button" className="w-btn primary" disabled={running || waiting} onClick={write}>按计划逐场写</button>
          </div>
          <div className="w-plan-duo">
            <PlanField label="台下" value={plan.logic} onChange={(logic) => updatePlan({ logic })} />
            <PlanField label="事件内核" value={plan.kernel} onChange={(kernel) => updatePlan({ kernel })} />
          </div>
          {warnings.filter((warning) => warning.sceneIndex === null).map((warning, index) => <p key={index} className="w-margin-ink">{warning.message}</p>)}
          <PlanField label="这一章读者得到什么" value={plan.reward || plan.core} onChange={(reward) => updatePlan({ reward })} />
          {plan.scenes.map((scene, index) => (
            <section key={scene.id} className="w-plan-scene">
              <input className="w-plan-scene-title" aria-label={`第 ${index + 1} 场标题`} value={scene.title} onChange={(event) => updateScene(index, { title: event.currentTarget.value })} />
              {BEATS.map(([field, label]) => <Beat key={field} label={label} value={scene[field]} onChange={(value) => updateScene(index, { [field]: value })} />)}
              <Beat label="挡路的" value={scene.obstacles.join("；")} onChange={(value) => updateScene(index, { obstacles: value.split(/[；;]/).map((item) => item.trim()).filter(Boolean) })} />
              {warnings.filter((warning) => warning.sceneIndex === index).map((warning, at) => <p key={at} className="w-margin-ink">{warning.message}</p>)}
            </section>
          ))}
          <PlanField label="章末钩子" value={plan.hook} onChange={(hook) => updatePlan({ hook })} />
        </>
      ) : planText ? <Markdown content={planText} /> : (
        <div className="w-studio-empty">
          <h1>这一章想怎么写？</h1>
          <p>在左边说说你的想法。它会读前文和线索，先和你定方向，再把计划稿放到这里，由你直接改。</p>
        </div>
      )}
    </div>
  );
}

function PlanField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="w-plan-field"><span>{label}</span><AutoText value={value} onChange={onChange} /></label>;
}

function Beat({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="w-plan-beat"><span>{label}</span><AutoText value={value} onChange={onChange} /></label>;
}

/** A borderless text area that grows with its text, so the plan reads as a document. */
function AutoText({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <textarea rows={1} value={value} ref={(node) => { if (node) { node.style.height = "auto"; node.style.height = `${node.scrollHeight}px`; } }} onChange={(event) => onChange(event.currentTarget.value)} />;
}
