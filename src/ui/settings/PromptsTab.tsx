import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from "lucide-react";
import { DEFAULT_QUICK_ACTIONS } from "../../ai/promptDefaults";
import { isCustomized, PROMPT_DEFS, promptDef, quickActionsFor, type PromptKey } from "../../ai/promptRegistry";
import { uniqueId } from "../../domain/ids";
import { unixTimestamp } from "../../domain/util";
import type { QuickActionConfig, WriterProject } from "../../types";
import { CommitTextarea, NumberInput } from "../common";
import { useWriter } from "../useWriter";

/** Editor for one registry prompt: shows the work's override or the built-in text; saving the default text clears the override. */
export function PromptEditor({ promptKey, rows = 8 }: { promptKey: PromptKey; rows?: number }) {
  const writer = useWriter();
  const project = writer.project;
  if (!project) return null;
  const def = promptDef(promptKey);
  const customized = isCustomized(project, promptKey);
  const setOverride = (text: string | null) => writer.mutateProject((draft) => {
    const overrides = { ...draft.prompts.overrides };
    if (text === null || !text.trim() || text.trim() === def.defaultText.trim()) delete overrides[promptKey];
    else overrides[promptKey] = text;
    draft.prompts = { ...draft.prompts, overrides, updatedAt: unixTimestamp() };
  });
  return (
    <div className="w-prompt-item">
      <div className="w-row">
        <strong>{def.label}</strong>
        {customized ? <span className="w-pill tone">已自定义</span> : <span className="w-pill">默认</span>}
        <span className="w-spacer" />
        {customized ? <button type="button" className="w-link" onClick={() => setOverride(null)}><RotateCcw size={11} />恢复默认</button> : null}
      </div>
      <p className="w-muted small">{def.description}{def.vars.length ? <> 可用变量：{def.vars.map((name) => <code key={name}>{`{{${name}}}`}</code>)}</> : null}</p>
      <CommitTextarea rows={rows} className="w-textarea mono" value={project.prompts.overrides[promptKey] ?? def.defaultText} onCommit={(text) => setOverride(text)} />
    </div>
  );
}

const GROUPS = [...new Set(PROMPT_DEFS.map((def) => def.group))];

export function PromptsTab() {
  const writer = useWriter();
  const project = writer.project;
  if (!project) return null;
  const customizedCount = PROMPT_DEFS.filter((def) => isCustomized(project, def.key)).length;
  return (
    <section className="w-form">
      <p className="w-muted">这些提示词只对本作生效。输出格式（JSON 结构）由程序固定追加，这里改不到，所以不会把解析改坏。写作助手也可以根据作品提议修改它们，修改会以建议的形式交给你审核。</p>
      {customizedCount ? <div className="w-row"><span className="w-muted">已自定义 {customizedCount} 项</span><span className="w-spacer" /><button type="button" className="w-btn small" onClick={() => writer.mutateProject((draft) => { draft.prompts = { ...draft.prompts, overrides: {}, updatedAt: unixTimestamp() }; })}><RotateCcw size={12} />全部恢复默认</button></div> : null}
      {GROUPS.map((group) => (
        <details key={group} className="w-prompt-group" open={group === "写作"}>
          <summary>{group}<span className="w-muted">（{PROMPT_DEFS.filter((def) => def.group === group).length}）</span></summary>
          {PROMPT_DEFS.filter((def) => def.group === group).map((def) => <PromptEditor key={def.key} promptKey={def.key} />)}
        </details>
      ))}
      <details className="w-prompt-group">
        <summary>快捷改写<span className="w-muted">（选中文字时的工具栏）</span></summary>
        <QuickActionsEditor project={project} />
      </details>
    </section>
  );
}

function QuickActionsEditor({ project }: { project: WriterProject }) {
  const writer = useWriter();
  const actions = quickActionsFor(project);
  const custom = Boolean(project.prompts.quickActions?.length);
  const save = (next: QuickActionConfig[] | null) => writer.mutateProject((draft) => { draft.prompts = { ...draft.prompts, quickActions: next, updatedAt: unixTimestamp() }; });
  const update = (index: number, patch: Partial<QuickActionConfig>) => save(actions.map((action, actionIndex) => (actionIndex === index ? { ...action, ...patch } : action)));
  const move = (index: number, delta: number) => {
    const next = [...actions];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    save(next);
  };
  return (
    <div className="w-form">
      <div className="w-row">
        <span className="w-muted">工具栏显示前 8 个。{custom ? "" : "当前使用内置列表，修改任意一项后会保存为本作的列表。"}</span>
        <span className="w-spacer" />
        {custom ? <button type="button" className="w-link" onClick={() => save(null)}><RotateCcw size={11} />恢复内置列表</button> : null}
      </div>
      {actions.map((action, index) => (
        <div key={action.id} className="w-quick-action">
          <div className="w-row">
            <input className="w-input narrow" value={action.label} maxLength={20} onChange={(event) => update(index, { label: event.currentTarget.value })} />
            <span className="w-muted small">候选数</span>
            <NumberInput className="w-input tiny" min={1} max={4} fallback={2} value={action.candidates} onCommit={(value) => update(index, { candidates: value })} />
            <span className="w-spacer" />
            <button type="button" className="w-icon-btn small" aria-label="上移" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={13} /></button>
            <button type="button" className="w-icon-btn small" aria-label="下移" disabled={index === actions.length - 1} onClick={() => move(index, 1)}><ArrowDown size={13} /></button>
            <button type="button" className="w-icon-btn small" aria-label="删除" disabled={actions.length <= 1} onClick={() => save(actions.filter((_, actionIndex) => actionIndex !== index))}><Trash2 size={13} /></button>
          </div>
          <CommitTextarea rows={2} value={action.instruction} onCommit={(instruction) => update(index, { instruction })} />
        </div>
      ))}
      <div className="w-row">
        <button type="button" className="w-btn small" onClick={() => save([...actions, { id: uniqueId("action"), label: "新动作", instruction: "描述 AI 应该怎样改写选中的文字。", candidates: 2 }])}><Plus size={12} />添加</button>
        <span className="w-muted small">内置共 {DEFAULT_QUICK_ACTIONS.length} 个</span>
      </div>
    </div>
  );
}
