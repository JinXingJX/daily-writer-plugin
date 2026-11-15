import { whileViewVisible } from "../../view";
import { Ban, Pause, Play, RotateCcw, SkipForward, Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import { REVIEW_CATEGORY_LABELS } from "../../ai/pipelines/nextChapter";
import { previewText } from "../../domain/util";
import { formatTokens } from "../../memory/cost";
import { RUN_STATE_LABELS, STEP_STATUS_LABELS, type PipelineRun, type PipelineStep } from "../../pipeline/schema";
import type { DraftArtifact, PlanArtifact, ReviewArtifact } from "../../pipeline/steps/next";
import type { HealthArtifact } from "../../pipeline/steps/story";
import { loadRun, readArtifact } from "../../pipeline/store";
import { HEALTH_RULE_LABELS } from "../../story/health";
import { Empty, formatTime, Spinner } from "../common";
import { PlanReview } from "../assist/PlanReview";
import { ProposalCard } from "../assist/ProposalCard";
import { useNotebook } from "../story/useNotebook";
import { useWriter } from "../useWriter";

type Command = (type: "rerun" | "skip" | "approve", extra?: { stepId?: string; cascade?: boolean; payload?: unknown }) => void;

/** The editor's office: what ran after publishing, what it produced, and what is waiting on the author. */
export function BureauView({ onOpenChapter }: { onOpenChapter: (chapterId: string) => void }) {
  const writer = useWriter();
  const { project, runs } = writer;
  const [selected, setSelected] = useState<string | null>(runs[0]?.id ?? null);
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [stepId, setStepId] = useState<string | null>(null);
  const current = runs.find((item) => item.id === selected) ?? runs[0];
  const projectId = project?.id;
  const runId = current?.id;
  const updatedAt = current?.updatedAt;

  useEffect(() => {
    if (!projectId || !runId) { setRun(null); return; }
    let cancelled = false;
    const load = () => void loadRun(projectId, runId).then((value) => { if (!cancelled) setRun(value); });
    return whileViewVisible(() => {
      cancelled = false;
      load();
      const timer = globalThis.setInterval(load, 2_000);
      return () => { cancelled = true; globalThis.clearInterval(timer); };
    });
  }, [projectId, runId, updatedAt]);
  useEffect(() => { setStepId(null); }, [runId]);

  if (!project) return null;
  const header = (body: React.ReactNode) => (
    <header className="w-fullpage-head">
      <button type="button" className="w-text-btn plain" onClick={() => writer.setView("write")}>返回稿纸</button>
      {body}
    </header>
  );
  if (!runs.length) {
    return <div className="w-fullpage">{header(<div className="w-fullpage-title"><strong>编辑部</strong></div>)}<Empty icon={<Workflow size={20} />} title="编辑部还没有开工">在稿末点“发布本章”，这里会更新记忆、设定与线索，模拟读者，写朱批和作家简报，并起草下一章。建立故事记忆的任务也会出现在这里。</Empty></div>;
  }
  const command = (type: "pause" | "resume" | "cancel" | "rerun" | "skip" | "approve", extra: { stepId?: string; cascade?: boolean; payload?: unknown } = {}) => {
    if (!run) return;
    void writer.pipelineCommand({ runId: run.id, type, ...extra }).then(() => writer.notify("info", type === "pause" ? "正在暂停…" : type === "cancel" ? "正在取消…" : "已提交，后台会接着运行。"));
  };
  const active = run && (run.state === "running" || run.state === "queued");
  // Unless the author picked a step: the one waiting on them, else what is running or broke, else the latest result.
  const step = run ? run.steps.find((item) => item.id === stepId) ?? run.steps.find((item) => item.status === "awaiting") ?? run.steps.find((item) => item.status === "running" || item.status === "failed") ?? [...run.steps].reverse().find((item) => item.status === "done") ?? run.steps[0] : null;

  return (
    <div className="w-fullpage">
      {header(<>
        <div className="w-fullpage-title">
          <strong>编辑部</strong>
          {runs.length > 1 ? (
            <select className="w-select small" aria-label="选择任务" value={current?.id} onChange={(event) => setSelected(event.currentTarget.value)}>
              {runs.map((item) => <option key={item.id} value={item.id}>{item.title} · {RUN_STATE_LABELS[item.state]} · {formatTime(Math.floor(item.createdAt / 1000))}</option>)}
            </select>
          ) : <span>{current?.title}</span>}
        </div>
        {run ? <span className={run.state === "awaiting" ? "w-bureau-state waiting" : "w-bureau-state"}>{run.state === "awaiting" ? "等你确认" : RUN_STATE_LABELS[run.state]}</span> : null}
        {run?.trigger.chapterId ? <button type="button" className="w-text-btn plain" onClick={() => onOpenChapter(run.trigger.chapterId ?? "")}>打开章节</button> : null}
        {active ? <button type="button" className="w-text-btn plain" onClick={() => command("pause")}><Pause size={12} />暂停</button> : null}
        {run && (run.state === "paused" || run.state === "error" || run.state === "cancelled") ? <button type="button" className="w-btn small primary" onClick={() => command("resume")}><Play size={12} />继续</button> : null}
        {run && run.state !== "done" && run.state !== "cancelled" ? <button type="button" className="w-text-btn plain" onClick={() => command("cancel")}><Ban size={12} />取消这次</button> : null}
      </>)}
      {!run || !step ? <p className="w-muted pad"><Spinner size={11} /> 正在读取…</p> : (
        <div className="w-bureau">
          <nav className="w-bureau-route" aria-label="步骤">
            <ol>
              {run.steps.map((item) => (
                <li key={item.id} className={`${item.status} ${item.id === step.id ? "current" : ""}`}>
                  <button type="button" aria-current={item.id === step.id ? "step" : undefined} onClick={() => setStepId(item.id)}>
                    <span className="w-route-dot" aria-hidden="true" />
                    <span className="w-route-text"><b>{item.label}</b><small>{item.error ? "出错了" : item.status === "running" ? item.progress.message || "运行中" : item.summary || STEP_STATUS_LABELS[item.status]}</small></span>
                  </button>
                </li>
              ))}
            </ol>
            <p className="w-muted">用量：{run.steps.reduce((total, item) => total + item.usage.calls, 0)} 次调用，约 {formatTokens(Math.round(run.steps.reduce((total, item) => total + item.usage.inputChars, 0) / 1.5))} 输入 tokens</p>
          </nav>
          <main className="w-bureau-detail">
            <div className="w-bureau-column" key={step.id}>
              <div className="w-row">
                <h1>{step.label}</h1>
                <span className="w-muted">{STEP_STATUS_LABELS[step.status]}</span>
                {step.status === "running" && step.progress.total ? <progress max={step.progress.total} value={step.progress.done} /> : null}
                {step.status === "running" ? <Spinner size={11} /> : null}
                <span className="w-spacer" />
                {step.status !== "running" && step.status !== "pending" ? <>
                  <button type="button" className="w-text-btn plain" title="只重跑这一步（后面已完成的步骤标为已过期）" onClick={() => command("rerun", { stepId: step.id })}><RotateCcw size={12} />重跑</button>
                  <button type="button" className="w-text-btn plain" title="连同依赖它的后续步骤一起重跑" onClick={() => command("rerun", { stepId: step.id, cascade: true })}>连同后续</button>
                </> : null}
                {step.status === "failed" || step.status === "pending" || step.status === "awaiting" ? <button type="button" className="w-text-btn plain" onClick={() => command("skip", { stepId: step.id })}><SkipForward size={12} />跳过</button> : null}
              </div>
              {step.error ? <p className="w-error-text">{step.error}</p> : step.status === "running" ? <p className="w-muted">{step.progress.message}</p> : step.summary ? <p className="w-bureau-summary">{step.summary}</p> : null}
              <StepDetail run={run} step={step} onCommand={command} />
            </div>
          </main>
        </div>
      )}
    </div>
  );
}

function StepDetail({ run, step, onCommand }: { run: PipelineRun; step: PipelineStep; onCommand: Command }) {
  const writer = useWriter();
  const { notebook, loaded } = useNotebook();
  const [artifact, setArtifact] = useState<unknown>(null);
  useEffect(() => {
    let cancelled = false;
    setArtifact(null);
    void readArtifact(run.projectId, run.id, step.id).then((value) => { if (!cancelled) setArtifact(value); });
    return () => { cancelled = true; };
  }, [run.projectId, run.id, step.id, step.status, step.finishedAt, step.progress.done]);
  const proposal = step.proposalId ? writer.proposals.find((item) => item.id === step.proposalId) : undefined;
  if (step.kind === "next.plan" && artifact) {
    const plan = artifact as PlanArtifact;
    if (step.status === "awaiting") return <PlanReview plan={plan.plan} note={plan.direction ? `参考方向：\n${plan.direction}` : ""} warnings={plan.warnings} busy={false} noRevise approveLabel="按这个计划写" dismissLabel="重新生成计划" onAnswer={(result) => onCommand("approve", { stepId: step.id, payload: result })} onDismiss={() => onCommand("rerun", { stepId: step.id })} />;
    return <div className="w-step-detail"><b>{plan.plan.title}</b><p>{plan.plan.core}</p><ol>{plan.plan.scenes.map((scene) => <li key={scene.id}>{scene.title}：{scene.goal}</li>)}</ol>{plan.warnings.length ? <ul className="w-plan-warnings">{plan.warnings.map((warning, index) => <li key={index}>{warning.message}</li>)}</ul> : null}</div>;
  }
  if (step.kind === "story.health" && artifact) {
    const { issues } = artifact as HealthArtifact;
    return <div className="w-margin-list">{issues.map((issue) => <article key={issue.id} className="w-zhu"><div className="w-zhu-main static"><span className="w-zhu-tag">{HEALTH_RULE_LABELS[issue.rule]}</span><span className="w-zhu-body">{issue.message}</span></div></article>)}</div>;
  }
  if (step.kind === "next.draft" && artifact) {
    const draft = artifact as DraftArtifact;
    return <div className="w-step-detail"><p className="w-muted">已写 {draft.written.length} 场，{draft.text.length} 字</p><pre className="w-draft-preview">{previewText(draft.text, 3_000)}</pre></div>;
  }
  if (step.kind === "next.review" && artifact) {
    const review = artifact as ReviewArtifact;
    return <ul className="w-fact-list">{review.issues.map((issue) => <li key={issue.id}><span className="w-pill">{REVIEW_CATEGORY_LABELS[issue.category]}</span>{review.fixed.includes(issue.id) ? <span className="w-pill ok">已修订</span> : null} “{issue.quote}”：{issue.problem}</li>)}</ul>;
  }
  if (step.kind === "reader.snapshot" && loaded) {
    const snapshot = run.trigger.chapterId ? notebook.readers[run.trigger.chapterId] : undefined;
    if (snapshot) return (
      <section className="w-bureau-section">
        <h2>模拟读者的复述 <small>模型模拟，不是真实读者数据</small></h2>
        {snapshot.voices.map((voice) => <div key={voice.persona} className="w-plan-beat read"><span>{voice.persona}</span><p>{voice.retell || voice.comment}</p></div>)}
        {snapshot.digest?.problems.length ? <p className="w-margin-ink">{snapshot.digest.problems[0].title}</p> : null}
        <button type="button" className="w-text-btn" onClick={() => writer.openStory("reader")}>看完整的读者反应</button>
      </section>
    );
  }
  if (step.kind === "briefing" && loaded && notebook.briefing) {
    const { briefing } = notebook;
    return (
      <section className="w-bureau-section">
        {briefing.storySoFar ? <p className="w-bureau-prose">{briefing.storySoFar}</p> : null}
        {briefing.focus.length ? <><h2>重点关注</h2><ul>{briefing.focus.map((item, index) => <li key={index}>{item}</li>)}</ul></> : null}
        {briefing.next.length ? <><h2>下一步</h2><ul>{briefing.next.map((item, index) => <li key={index}>{item.title}{item.detail ? `：${item.detail}` : ""}</li>)}</ul></> : null}
        <button type="button" className="w-text-btn" onClick={() => writer.openStory("brief")}>打开简报</button>
      </section>
    );
  }
  if (step.kind === "chapter.notes" && run.trigger.chapterId) return <button type="button" className="w-text-btn" onClick={() => { writer.selectDoc({ kind: "chapter", id: run.trigger.chapterId ?? "" }); writer.openAssist("notes"); }}>去这一章的页边看</button>;
  if (proposal) return <ProposalCard proposal={proposal} />;
  if (step.status === "running") return <p className="w-muted">进行中，完成一段后这里会显示结果。</p>;
  return step.summary ? null : <p className="w-muted">没有可展示的结果。</p>;
}
