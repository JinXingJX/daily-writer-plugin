import { useState } from "react";
import type { PublishStepToggle, WriterProject } from "../types";
import { searchBook } from "../storage/bookOps";
import { deleteProject } from "../storage/projectStore";
import { exportProject } from "../storage/exporter";
import { Field, Modal, NumberInput, Spinner, Tabs, useDialogs } from "./common";
import { ModelsTab } from "./settings/ModelsTab";
import { PromptsTab } from "./settings/PromptsTab";
import { StyleSamplesTab } from "./settings/StyleSamplesTab";
import { useWriter } from "./useWriter";

const PUBLISH_STEP_OPTIONS: { value: PublishStepToggle; label: string }[] = [
  { value: "story", label: "更新设定、人物与线索" },
  { value: "reader", label: "模拟读者" },
  { value: "briefing", label: "刷新作家简报" },
  { value: "notes", label: "审读本章，把问题写成页边朱批" },
  { value: "next", label: "起草下一章" },
];

export type SettingsTab = "work" | "samples" | "prompts" | "models" | "editor" | "export";
const TABS: { value: SettingsTab; label: string }[] = [
  { value: "work", label: "作品" },
  { value: "samples", label: "样章" },
  { value: "prompts", label: "提示词" },
  { value: "models", label: "模型" },
  { value: "editor", label: "编辑器" },
  { value: "export", label: "导出" },
];

export function SettingsDialog({ onClose, initialTab = "work" }: { onClose: () => void; initialTab?: SettingsTab }) {
  const writer = useWriter();
  const dialogs = useDialogs();
  const { project, prefs } = writer;
  const [exporting, setExporting] = useState<string | null>(null);
  const [finalOnly, setFinalOnly] = useState(false);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  if (!project) return null;
  const set = (mutate: (draft: WriterProject) => void) => writer.mutateProject(mutate);

  const runExport = async () => {
    setExporting("准备中…");
    try {
      await writer.flush();
      const holes = await searchBook(writer.getDraft()?.project ?? project, "【待补[:：][^】]*】", { regex: true, limitPerChapter: 1 });
      if (holes.length && !(await dialogs.confirm("还有占位没补", `${holes.length} 章里还留着【待补：…】占位。仍然导出吗？`, { confirmLabel: "仍然导出" }))) return;
      const result = await exportProject(writer.getDraft()?.project ?? project, { finalOnly, onProgress: (done, total) => setExporting(`${done}/${total}`) });
      writer.notify("success", `已导出到工作区 ${result.path}（${result.files.length} 个文件）`);
    } catch (error) { writer.notify("error", `导出失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setExporting(null); }
  };

  return (
    <Modal title="作品设置" width={tab === "work" || tab === "models" || tab === "editor" || tab === "export" ? 680 : 900} onClose={onClose}>
      <div className="w-settings-tabs"><Tabs value={tab} onChange={setTab} items={TABS} /></div>
      {tab === "samples" ? <StyleSamplesTab /> : null}
      {tab === "prompts" ? <PromptsTab /> : null}
      {tab === "models" ? <ModelsTab /> : null}
      {tab === "work" ? <section className="w-form">
        <h4>作品信息</h4>
        <div className="w-inspector-grid">
          <Field label="类型"><input className="w-input" value={project.genre} onChange={(event) => { const value = event.currentTarget.value; set((draft) => { draft.genre = value; }); }} /></Field>
          <Field label="目标读者"><input className="w-input" value={project.audience} onChange={(event) => { const value = event.currentTarget.value; set((draft) => { draft.audience = value; }); }} /></Field>
          <Field label="篇幅"><input className="w-input" value={project.targetLength} onChange={(event) => { const value = event.currentTarget.value; set((draft) => { draft.targetLength = value; }); }} /></Field>
          <Field label="语言"><input className="w-input" value={project.language} onChange={(event) => { const value = event.currentTarget.value; set((draft) => { draft.language = value; }); }} /></Field>
        </div>
        <h4>写作目标</h4>
        <Field label="每日目标字数（0 为不设）"><NumberInput className="w-input narrow" min={0} step={500} fallback={0} value={project.settings.dailyGoal} onCommit={(value) => set((draft) => { draft.settings.dailyGoal = value; })} /></Field>
        <h4>AI</h4>
        <Field label="上下文预算（字符）" hint="AI 写作时最多参考多少字的记忆与前文。越大越连贯，但更慢、更贵。"><NumberInput className="w-input narrow" min={8_000} max={80_000} step={4_000} fallback={60_000} value={project.settings.contextBudgetChars} onCommit={(value) => set((draft) => { draft.settings.contextBudgetChars = value; })} /></Field>
        <Field label="参考最近几章"><NumberInput className="w-input narrow" min={1} max={40} fallback={10} value={project.settings.recentCardCount} onCommit={(value) => set((draft) => { draft.settings.recentCardCount = value; })} /></Field>
        <h4>发布后的后台流水线</h4>
        <p className="w-muted">点“发布本章”后，后台总会更新本章记忆；下面这些步骤可以按需开关。整个过程在“编辑部”里可以查看、暂停、恢复、单步重跑。</p>
        <div className="w-check-list">
          {PUBLISH_STEP_OPTIONS.map((option) => (
            <label key={option.value} className="w-check"><input type="checkbox" checked={project.settings.pipeline.steps.includes(option.value)} onChange={(event) => { const checked = event.currentTarget.checked; set((draft) => { const steps = draft.settings.pipeline.steps.filter((step) => step !== option.value); draft.settings.pipeline.steps = checked ? [...steps, option.value] : steps; }); }} />{option.label}</label>
          ))}
        </div>
        <Field label="设定与线索更新" hint="自动应用只针对线索和关系这类可撤销的记录；设定库和文档的修改总要你审核。">
          <select className="w-select" value={project.settings.pipeline.storyGate} onChange={(event) => { const value = event.currentTarget.value as "review" | "auto-safe"; set((draft) => { draft.settings.pipeline.storyGate = value; }); }}>
            <option value="review">全部生成待审建议</option>
            <option value="auto-safe">线索与关系自动应用，其余待审</option>
          </select>
        </Field>
        <Field label="下一章计划">
          <select className="w-select" value={project.settings.pipeline.planGate} onChange={(event) => { const value = event.currentTarget.value as "approve" | "auto"; set((draft) => { draft.settings.pipeline.planGate = value; }); }}>
            <option value="approve">先等我确认计划再写</option>
            <option value="auto">直接按计划写草稿</option>
          </select>
        </Field>
        <Field label="下一章目标字数"><NumberInput className="w-input narrow" min={500} max={20_000} step={500} fallback={3_000} value={project.settings.pipeline.nextWords} onCommit={(value) => set((draft) => { draft.settings.pipeline.nextWords = value; })} /></Field>
      </section> : null}
      {tab === "editor" ? <section className="w-form">
        <div className="w-inspector-grid">
          <Field label={`字号 ${prefs.fontSize}px`}><input type="range" min={13} max={26} value={prefs.fontSize} onChange={(event) => writer.setPrefs({ fontSize: Number(event.currentTarget.value) })} /></Field>
          <Field label={`行距 ${prefs.lineHeight.toFixed(2)}`}><input type="range" min={1.4} max={2.6} step={0.05} value={prefs.lineHeight} onChange={(event) => writer.setPrefs({ lineHeight: Number(event.currentTarget.value) })} /></Field>
          <Field label={`版心宽度 ${prefs.pageWidth}px`}><input type="range" min={520} max={1200} step={20} value={prefs.pageWidth} onChange={(event) => writer.setPrefs({ pageWidth: Number(event.currentTarget.value) })} /></Field>
        </div>
        <label className="w-check"><input type="checkbox" checked={prefs.typewriter} onChange={(event) => writer.setPrefs({ typewriter: event.currentTarget.checked })} />打字机模式（光标所在行保持在屏幕中央）</label>
        <label className="w-check"><input type="checkbox" checked={prefs.highlightEntities} onChange={(event) => writer.setPrefs({ highlightEntities: event.currentTarget.checked })} />高亮人物与设定名，悬停查看档案</label>
      </section> : null}
      {tab === "export" ? <section className="w-form">
        <h4>导出</h4>
        <label className="w-check"><input type="checkbox" checked={finalOnly} onChange={(event) => setFinalOnly(event.currentTarget.checked)} />只导出“定稿”章节</label>
        <div className="w-row">
          <button type="button" className="w-btn" disabled={Boolean(exporting)} onClick={() => void runExport()}>{exporting ? <><Spinner size={12} />{exporting}</> : "导出 Markdown 与全文 txt 到工作区"}</button>
          <span className="w-spacer" />
          <button type="button" className="w-btn danger" onClick={async () => {
            if (!(await dialogs.confirm("删除作品", `从作品列表移除「${project.title}」？`, { danger: true, confirmLabel: "删除" }))) return;
            await writer.flush("manual");
            await deleteProject(project.id);
            const list = await writer.reloadProjects();
            onClose();
            if (list[0]) await writer.openProjectById(list[0].id); else writer.closeProject();
          }}>删除作品</button>
        </div>
      </section> : null}
    </Modal>
  );
}
