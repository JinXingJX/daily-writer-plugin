import { LifeBuoy } from "lucide-react";
import { useState } from "react";
import { friendlyAiError } from "../../ai/client";
import { BLOCK_TYPE_LABELS, BLOCK_TYPES, diagnoseBlock, placeholderText, type BlockCard, type BlockResult, type BlockType } from "../../ai/pipelines/blockDoctor";
import { orderedChapters, readDoc } from "../../domain/documents";
import { uniqueId } from "../../domain/ids";
import { tailText } from "../../domain/util";
import { updateNotebook } from "../../notes/store";
import { Field, Markdown, Modal, Spinner } from "../common";
import { useWriter } from "../useWriter";

/** The block card (卡文卡): the author's answers that decide how to get unstuck. */
export function BlockCardForm({ analysis, suspected, question, busy, onSubmit, onCancel, submitLabel = "提交" }: { analysis?: string; suspected: BlockType | null; question?: string; busy: boolean; onSubmit: (card: BlockCard) => void; onCancel: () => void; submitLabel?: string }) {
  const [card, setCard] = useState<BlockCard>({ type: suspected, facts: "", want: "", emotion: "", note: "" });
  return (
    <section className="w-question w-block-card">
      <div className="w-row small"><LifeBuoy size={14} /><strong>卡文卡</strong></div>
      {analysis ? <Markdown content={analysis} /> : null}
      {question ? <p className="w-muted">{question}</p> : null}
      <fieldset>
        <legend>卡在哪</legend>
        {BLOCK_TYPES.map((type) => (
          <label key={type} className={`w-option ${card.type === type ? "active" : ""}`}>
            <input type="radio" name="block-type" checked={card.type === type} onChange={() => setCard({ ...card, type })} />
            <span>{BLOCK_TYPE_LABELS[type]}</span>
          </label>
        ))}
      </fieldset>
      <Field label="已经成立、不能推翻的事实与承诺"><textarea className="w-textarea" rows={2} value={card.facts} onChange={(event) => setCard({ ...card, facts: event.currentTarget.value })} /></Field>
      <Field label="人物现在最想做什么"><input className="w-input" value={card.want} onChange={(event) => setCard({ ...card, want: event.currentTarget.value })} /></Field>
      <Field label="这一段想传达的情绪"><input className="w-input" value={card.emotion} onChange={(event) => setCard({ ...card, emotion: event.currentTarget.value })} /></Field>
      <Field label="补充（可选）"><textarea className="w-textarea" rows={2} value={card.note} onChange={(event) => setCard({ ...card, note: event.currentTarget.value })} /></Field>
      <div className="w-row">
        <button type="button" className="w-btn primary" disabled={busy} onClick={() => onSubmit(card)}>{busy ? <Spinner size={12} /> : null}{submitLabel}</button>
        <button type="button" className="w-btn ghost" disabled={busy} onClick={onCancel}>先不管</button>
      </div>
    </section>
  );
}

/** Standalone block doctor: fill the card, get branches / ways in / a placeholder / a minimal task. */
export function BlockDoctorDialog({ onClose, onInsertPlaceholder }: { onClose: () => void; onInsertPlaceholder: (text: string) => void }) {
  const writer = useWriter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BlockResult | null>(null);
  const project = writer.project;
  if (!project) return null;
  const chapters = orderedChapters(project);
  const active = writer.active;
  const position = active.kind === "chapter" ? Math.max(0, chapters.findIndex((chapter) => chapter.id === active.id)) : chapters.length;
  const focus = writer.draft ? tailText(readDoc(writer.draft.project, writer.draft.texts, active) ?? "", 3_000) : "";

  const run = async (card: BlockCard) => {
    setBusy(true);
    try { setResult(await diagnoseBlock({ project, memory: writer.memory, story: writer.story, position, card, focus })); }
    catch (error) { writer.notify("error", friendlyAiError(error)); }
    finally { setBusy(false); }
  };
  const saveTask = async (task: string) => {
    const now = Math.floor(Date.now() / 1000);
    await updateNotebook(project.id, (notebook) => { notebook.notes.unshift({ id: uniqueId("note"), kind: "todo", text: task, plan: "", chapterId: active.kind === "chapter" ? active.id : null, done: false, origin: "ai", createdAt: now, updatedAt: now }); });
    writer.notify("success", "已记进作家笔记的待办。");
  };
  const sendBranch = (title: string, detail: string) => {
    writer.openAssist("chat", true, { text: `按这条思路写下一段：${title}。${detail}` });
    onClose();
  };

  return (
    <Modal title="卡文诊断" onClose={onClose} width={640}>
      {!result ? <BlockCardForm suspected={null} busy={busy} onSubmit={(card) => void run(card)} onCancel={onClose} submitLabel="诊断" /> : (
        <div className="w-block-result">
          <p><span className="w-pill tone">{BLOCK_TYPE_LABELS[result.type]}</span> {result.analysis}</p>
          {result.branches.length ? <div className="w-block-branches">{result.branches.map((branch, index) => (
            <article key={index} className="w-card">
              <strong>{branch.title}</strong>
              <p>{branch.cause ? `起因：${branch.cause}；` : ""}{branch.event}</p>
              {branch.leadsTo ? <p className="w-muted">读者的期待引向：{branch.leadsTo}</p> : null}
              <button type="button" className="w-btn small" onClick={() => sendBranch(branch.title, `${branch.cause} ${branch.event}`)}>交给写作助手</button>
            </article>
          ))}</div> : null}
          {result.emotion ? <p><b>要渲染的情绪：</b>{result.emotion}</p> : null}
          {result.approaches.length ? <ul>{result.approaches.map((approach, index) => <li key={index}><b>{approach.title}</b>：{approach.entry}</li>)}</ul> : null}
          {result.placeholder ? <div className="w-row"><code>{placeholderText(result.placeholder)}</code><button type="button" className="w-btn small" onClick={() => { onInsertPlaceholder(placeholderText(result.placeholder)); onClose(); }}>插入占位，先往后写</button></div> : null}
          {result.minimalTask ? <div className="w-row"><span><b>最小任务：</b>{result.minimalTask}</span><button type="button" className="w-btn small" onClick={() => void saveTask(result.minimalTask)}>记为待办</button></div> : null}
          <div className="w-row"><button type="button" className="w-btn" onClick={() => setResult(null)}>重新填卡</button><button type="button" className="w-btn ghost" onClick={onClose}>关闭</button></div>
        </div>
      )}
    </Modal>
  );
}
