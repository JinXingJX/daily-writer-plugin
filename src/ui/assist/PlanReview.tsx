import { AlertTriangle, ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { normalizePlan, type ChapterPlan, type PlanScene, type PromiseAlignment } from "../../ai/pipelines/nextChapter";
import { uniqueId } from "../../domain/ids";
import { CHANGE_KIND_LABELS, CHANGE_KINDS, type ChangeKind } from "../../memory/schema";
import type { PlanWarning } from "../../story/planLint";
import { Field } from "../common";

const TEXT_FIELDS = [["cause", "起因"], ["goal", "目标"], ["stakes", "代价/收益"], ["deadline", "期限（含来由）"], ["choice", "关键选择"], ["turn", "转折"], ["outcome", "结果"], ["readerKnows", "读者已知"], ["characterUnknown", "人物未知"], ["focal", "焦点人物"]] as const;
const LIST_FIELDS = [["events", "发生的事", "每行一件，按顺序：读者读完能复述的事"], ["obstacles", "阻力", "每行一个，会变招的"]] as const;
const ALIGNMENTS: { value: PromiseAlignment; label: string }[] = [{ value: "direct", label: "直接兑现核心承诺" }, { value: "support", label: "为承诺铺垫" }, { value: "off", label: "与承诺无关" }];

function emptyScene(): PlanScene {
  return normalizePlan({ scenes: [{ id: uniqueId("scene"), title: "新场景", words: 800 }] }).scenes[0];
}

function cleaned(plan: ChapterPlan): ChapterPlan {
  const trim = (items: string[]) => items.map((item) => item.trim()).filter(Boolean);
  return { ...plan, skim: trim(plan.skim), scenes: plan.scenes.map((scene) => ({ ...scene, events: trim(scene.events), obstacles: trim(scene.obstacles) })) };
}

export type PlanReviewProps = {
  plan: ChapterPlan;
  note: string;
  warnings?: PlanWarning[];
  busy: boolean;
  /** `ok` approves the (edited) plan; otherwise the author asks for a revision with a note. */
  onAnswer: (result: unknown, ok: boolean) => void;
  onDismiss: () => void;
  /** Hides the "ask the AI to revise" button (the pipeline re-runs the step instead). */
  noRevise?: boolean;
  approveLabel?: string;
  dismissLabel?: string;
};

/** A chapter plan shaped like the scene card; the author edits it in place, then approves or asks for changes. */
export function PlanReview({ plan: initial, note: agentNote, warnings = [], busy, onAnswer, onDismiss, noRevise = false, approveLabel = "按计划写", dismissLabel = "结束" }: PlanReviewProps) {
  const [plan, setPlan] = useState(initial);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState<string | null>(initial.scenes[0]?.id ?? null);
  const updateScene = (index: number, patch: Partial<PlanScene>) => setPlan((current) => ({ ...current, scenes: current.scenes.map((scene, sceneIndex) => (sceneIndex === index ? { ...scene, ...patch } : scene)) }));
  const moveScene = (index: number, delta: number) => setPlan((current) => {
    const list = [...current.scenes];
    const target = index + delta;
    if (target < 0 || target >= list.length) return current;
    [list[index], list[target]] = [list[target], list[index]];
    return { ...current, scenes: list };
  });
  const toggleChange = (index: number, kind: ChangeKind) => updateScene(index, { changes: plan.scenes[index].changes.includes(kind) ? plan.scenes[index].changes.filter((item) => item !== kind) : [...plan.scenes[index].changes, kind] });
  const words = plan.scenes.reduce((total, scene) => total + scene.words, 0);
  const general = warnings.filter((warning) => warning.sceneIndex === null);
  return (
    <section className="w-question w-plan-review">
      <strong>请确认章节计划</strong>
      {agentNote ? <p className="w-muted">{agentNote}</p> : null}
      {general.length ? <ul className="w-plan-warnings">{general.map((warning, index) => <li key={index}><AlertTriangle size={12} />{warning.message}</li>)}</ul> : null}
      <Field label="章节标题"><input className="w-input" value={plan.title} onChange={(event) => setPlan({ ...plan, title: event.currentTarget.value })} /></Field>
      <Field label="这一章想让读者感到或得到的那件事"><input className="w-input" value={plan.core} onChange={(event) => setPlan({ ...plan, core: event.currentTarget.value })} /></Field>
      <Field label="给读者的兑现（谁得到什么、谁看见；压着不给就写压的是什么）"><textarea className="w-textarea" rows={2} value={plan.reward} onChange={(event) => setPlan({ ...plan, reward: event.currentTarget.value })} /></Field>
      <Field label="台面下的推演（写给执笔者，不进正文）"><textarea className="w-textarea" rows={3} value={plan.logic} onChange={(event) => setPlan({ ...plan, logic: event.currentTarget.value })} /></Field>
      <Field label="取材内核（只取内核，事件推翻重写）"><textarea className="w-textarea" rows={2} value={plan.kernel} onChange={(event) => setPlan({ ...plan, kernel: event.currentTarget.value })} /></Field>
      <div className="w-row">
        <select className="w-select" value={plan.promiseAlignment} onChange={(event) => setPlan({ ...plan, promiseAlignment: event.currentTarget.value as PromiseAlignment })}>
          {ALIGNMENTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        <input className="w-input grow" placeholder="与核心承诺的关系说明" value={plan.promiseNote} onChange={(event) => setPlan({ ...plan, promiseNote: event.currentTarget.value })} />
      </div>
      <Field label="梗概"><textarea className="w-textarea" rows={2} value={plan.summary} onChange={(event) => setPlan({ ...plan, summary: event.currentTarget.value })} /></Field>
      <div className="w-scene-list">
        {plan.scenes.map((scene, index) => {
          const sceneWarnings = warnings.filter((warning) => warning.sceneIndex === index);
          return (
            <article key={scene.id} className="w-scene">
              <div className="w-row">
                <button type="button" className="w-link" onClick={() => setOpen(open === scene.id ? null : scene.id)}><b>场景 {index + 1}</b>{sceneWarnings.length ? <AlertTriangle size={12} className="w-warn-icon" /> : null}</button>
                <input className="w-input grow" value={scene.title} onChange={(event) => updateScene(index, { title: event.currentTarget.value })} />
                <input className="w-input narrow" type="number" min={0} step={100} value={scene.words} title="字数" onChange={(event) => updateScene(index, { words: Math.max(0, Number(event.currentTarget.value) || 0) })} />
                <button type="button" className="w-icon-btn small" aria-label="上移" disabled={index === 0} onClick={() => moveScene(index, -1)} title="上移"><ArrowUp size={13} /></button>
                <button type="button" className="w-icon-btn small" aria-label="下移" disabled={index === plan.scenes.length - 1} onClick={() => moveScene(index, 1)} title="下移"><ArrowDown size={13} /></button>
                <button type="button" className="w-icon-btn small" aria-label="删除场景" disabled={plan.scenes.length <= 1} onClick={() => setPlan({ ...plan, scenes: plan.scenes.filter((_, sceneIndex) => sceneIndex !== index) })} title="删除场景"><Trash2 size={13} /></button>
              </div>
              {sceneWarnings.length ? <ul className="w-plan-warnings">{sceneWarnings.map((warning, item) => <li key={item}>{warning.message}</li>)}</ul> : null}
              {open === scene.id ? (
                <div className="w-scene-grid">
                  {TEXT_FIELDS.map(([field, label]) => <label key={field}><span>{label}</span><textarea rows={2} value={scene[field]} onChange={(event) => updateScene(index, { [field]: event.currentTarget.value })} /></label>)}
                  <label><span>情绪起点</span><textarea rows={1} value={scene.emotion.from} onChange={(event) => updateScene(index, { emotion: { ...scene.emotion, from: event.currentTarget.value } })} /></label>
                  <label><span>情绪终点</span><textarea rows={1} value={scene.emotion.to} onChange={(event) => updateScene(index, { emotion: { ...scene.emotion, to: event.currentTarget.value } })} /></label>
                  <div className="wide w-check-list"><span>结束时改变了：</span>{CHANGE_KINDS.map((kind) => <label key={kind} className="w-check"><input type="checkbox" checked={scene.changes.includes(kind)} onChange={() => toggleChange(index, kind)} />{CHANGE_KIND_LABELS[kind]}</label>)}</div>
                  {LIST_FIELDS.map(([field, label, placeholder]) => <label key={field} className="wide"><span>{label}</span><textarea rows={3} value={scene[field].join("\n")} placeholder={placeholder} onChange={(event) => updateScene(index, { [field]: event.currentTarget.value.split("\n") })} /></label>)}
                </div>
              ) : <p className="w-muted small">{scene.events.length ? scene.events.join(" → ") : scene.goal}{scene.stakes ? `｜代价：${scene.stakes}` : ""}{scene.emotion.from || scene.emotion.to ? `｜${scene.emotion.from}→${scene.emotion.to}` : ""}</p>}
            </article>
          );
        })}
      </div>
      <div className="w-row small">
        <button type="button" className="w-btn small" onClick={() => { const scene = emptyScene(); setPlan({ ...plan, scenes: [...plan.scenes, scene] }); setOpen(scene.id); }}><Plus size={12} />添加场景</button>
        <span className="w-muted">共 {plan.scenes.length} 场，约 {words} 字</span>
      </div>
      {plan.threads.advance.length || plan.threads.plant.length || plan.threads.payoff.length ? <p className="w-muted small">线索：{[...plan.threads.advance.map((item) => `推进 ${item}`), ...plan.threads.plant.map((item) => `引入 ${item}`), ...plan.threads.payoff.map((item) => `兑现 ${item}`)].join("；")}</p> : null}
      <Field label="一笔带过（每行一条：过场、推理过程、设定解释……）"><textarea className="w-textarea" rows={2} value={plan.skim.join("\n")} onChange={(event) => setPlan({ ...plan, skim: event.currentTarget.value.split("\n") })} /></Field>
      <Field label="章末钩子（接续的期待）"><input className="w-input" value={plan.hook} onChange={(event) => setPlan({ ...plan, hook: event.currentTarget.value })} /></Field>
      {noRevise ? null : <textarea className="w-textarea" rows={2} placeholder="意见（可选），例如：第二场的笑点换成老周的口头禅" value={note} onChange={(event) => setNote(event.currentTarget.value)} />}
      <div className="w-row">
        <button type="button" className="w-btn primary" disabled={busy || !plan.scenes.length} onClick={() => onAnswer({ decision: "approved", plan: cleaned(plan), note }, true)}>{approveLabel}</button>
        {noRevise ? null : <button type="button" className="w-btn" disabled={busy || !note.trim()} title="写下意见后让 AI 重新规划" onClick={() => onAnswer({ decision: "revise", note }, false)}>让 AI 改计划</button>}
        <button type="button" className="w-btn ghost" disabled={busy} onClick={onDismiss}>{dismissLabel}</button>
      </div>
    </section>
  );
}
