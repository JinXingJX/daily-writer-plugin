import { Pause, Play, RefreshCw } from "lucide-react";
import { useState } from "react";
import { estimateMemoryCost, formatTokens } from "../../memory/cost";
import { pauseMemoryRuns, resumeMemoryRuns, startMemoryRun } from "../../pipeline/templates";
import { AUTO_PHASES, MEMORY_PHASES, MEMORY_PHASE_LABELS, type MemoryPhase } from "../../memory/schema";
import { Field, NumberInput, useDialogs } from "../common";
import { useWriter } from "../useWriter";

export function OverviewTab() {
  const writer = useWriter();
  const dialogs = useDialogs();
  const { project, memory, memoryStatus } = writer;
  const [phases, setPhases] = useState<Set<MemoryPhase>>(new Set(MEMORY_PHASES));
  if (!project) return null;
  const stale = memory ? memory.staleChapterIds() : project.chapters.filter((chapter) => chapter.wordCount > 0).map((chapter) => chapter.id);
  const coverage = memory?.coverage() ?? { total: project.chapters.filter((chapter) => chapter.wordCount > 0).length, fresh: 0 };
  const estimate = estimateMemoryCost(project, stale, [...phases], Boolean(memory?.aggregates.worldview));
  const running = memoryStatus.state === "running";
  const failures = Object.keys(memoryStatus.failures).length;

  const start = async () => {
    if (estimate.calls > 50 && !(await dialogs.confirm("建立故事记忆", `将调用模型约 ${estimate.calls} 次，输入约 ${formatTokens(estimate.inputTokens)} tokens、输出约 ${formatTokens(estimate.outputTokens)} tokens。可以随时暂停，下次从断点继续。确定开始？`, { confirmLabel: "开始" }))) return;
    await writer.flush();
    if (memoryStatus.state === "paused" && await resumeMemoryRuns(project.id)) { writer.notify("info", "已继续。"); return; }
    await startMemoryRun(project.id, MEMORY_PHASES.filter((phase) => phases.has(phase)));
    writer.notify("info", "已开始。关闭 Writer 页面后，后台会继续处理。");
  };

  return (
    <div className="w-memory-overview">
      <section className="w-card">
        <h3>记忆覆盖</h3>
        <div className="w-progress big"><span style={{ width: `${coverage.total ? (coverage.fresh / coverage.total) * 100 : 0}%` }} /></div>
        <p>{coverage.fresh} / {coverage.total} 章已建立记忆 · 实体 {memory?.entities.length ?? 0} · 伏笔 {memory?.threads.length ?? 0} · 情节弧 {memory?.aggregates.arcs.length ?? 0}</p>
        <p className="w-muted">故事记忆把正文逐章提炼为摘要、人物状态、事实与伏笔，再逐层汇总为情节弧、分卷和全书大纲。AI 写作时按需检索记忆，所以几百万字的作品也能前后连贯。</p>
      </section>
      <section className="w-card">
        <h3>{running ? "正在建立" : memoryStatus.state === "paused" ? "已暂停" : memoryStatus.state === "error" ? "出错了" : "建立 / 更新记忆"}</h3>
        {running ? (
          <>
            <p>{memoryStatus.phase ? MEMORY_PHASE_LABELS[memoryStatus.phase] : ""} · {memoryStatus.message}</p>
            {memoryStatus.total ? <div className="w-progress"><span style={{ width: `${(memoryStatus.done / memoryStatus.total) * 100}%` }} /></div> : null}
            <p className="w-muted">已调用模型 {memoryStatus.usage.calls} 次</p>
            <div className="w-row"><button type="button" className="w-btn" onClick={() => void pauseMemoryRuns(project.id)}><Pause size={13} />暂停</button><button type="button" className="w-link" onClick={() => writer.setView("bureau")}>在编辑部查看</button></div>
          </>
        ) : (
          <>
            {memoryStatus.state === "error" ? <p className="w-error-text">{memoryStatus.message}</p> : null}
            <div className="w-check-list inline">
              {MEMORY_PHASES.map((phase) => <label key={phase} className="w-check"><input type="checkbox" checked={phases.has(phase)} onChange={(event) => setPhases((current) => { const next = new Set(current); if (event.currentTarget.checked) next.add(phase); else next.delete(phase); return next; })} />{MEMORY_PHASE_LABELS[phase]}</label>)}
            </div>
            <p className="w-muted">待处理 {stale.length} 章{failures ? `（${failures} 章上次失败，会重试）` : ""} · 预计调用 {estimate.calls} 次 · 输入约 {formatTokens(estimate.inputTokens)} tokens</p>
            <div className="w-row">
              <button type="button" className="w-btn primary" disabled={!phases.size} onClick={() => void start()}><Play size={13} />{memoryStatus.state === "paused" ? "继续" : coverage.fresh ? "更新记忆" : "建立记忆"}</button>
              <button type="button" className="w-btn" onClick={() => void startMemoryRun(project.id, AUTO_PHASES).then(() => writer.notify("info", "已开始增量更新。"))}><RefreshCw size={13} />只更新变化部分</button>
            </div>
          </>
        )}
      </section>
      <section className="w-card">
        <h3>设置</h3>
        <label className="w-check"><input type="checkbox" checked={project.settings.autoMemory} onChange={(event) => { const value = event.currentTarget.checked; writer.mutateProject((draft) => { draft.settings.autoMemory = value; }); }} />编辑后自动更新记忆（章节停笔 5 分钟后；发布章节时由流水线更新）</label>
        <Field label="并发请求数"><NumberInput className="w-input narrow" min={1} max={6} fallback={1} value={project.settings.memoryConcurrency} onCommit={(value) => writer.mutateProject((draft) => { draft.settings.memoryConcurrency = value; })} /></Field>
      </section>
    </div>
  );
}
