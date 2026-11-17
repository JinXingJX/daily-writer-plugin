import { Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import { friendlyAiError } from "../ai/client";
import { inspire, type Idea } from "../ai/pipelines/inspire";
import { PRESET_SAMPLES } from "../ai/presetSamples";
import { normalizeProject } from "../domain/normalize";
import { Field, Modal, Spinner } from "./common";
import { useWriter } from "./useWriter";

/** New work: title, genre and an optional one-line premise. Style samples are added in the work's settings. */
export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const writer = useWriter();
  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState("");
  const [premise, setPremise] = useState("");
  const [presets, setPresets] = useState<string[]>([]);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [busy, setBusy] = useState<"ideas" | "create" | null>(null);

  // The project does not exist yet, so ideas are drawn against a throwaway project shell.
  const brainstorm = async () => {
    setBusy("ideas");
    try {
      const shell = normalizeProject({ schemaVersion: 2, id: "draft", title: title || "新作品", genre: genre || "长篇小说" });
      setIdeas(await inspire({ project: shell, memory: null, target: "premise", seed: premise, avoid: ideas.map((idea) => idea.title), count: 6 }));
    } catch (error) { writer.notify("error", friendlyAiError(error)); }
    finally { setBusy(null); }
  };

  const create = async () => {
    setBusy("create");
    try {
      await writer.createNewProject({ title: title.trim() || undefined, genre: genre.trim() || undefined, outline: premise.trim() ? `一句话故事：${premise.trim()}\n` : undefined, presets });
      onClose();
    } catch (error) { writer.notify("error", friendlyAiError(error)); setBusy(null); }
  };

  return (
    <Modal title="新建作品" width={760} onClose={onClose} footer={<>
      <button type="button" className="w-btn ghost" onClick={onClose}>取消</button>
      <button type="button" className="w-btn primary" disabled={Boolean(busy)} onClick={() => void create()}>{busy === "create" ? <Spinner size={12} /> : <Plus size={13} />}创建</button>
    </>}>
      <section className="w-form">
        <div className="w-inspector-grid">
          <Field label="作品名称"><input className="w-input" value={title} placeholder="未命名长篇" data-autofocus onChange={(event) => setTitle(event.currentTarget.value)} /></Field>
          <Field label="类型"><input className="w-input" value={genre} placeholder="例如：悬疑、仙侠、都市" onChange={(event) => setGenre(event.currentTarget.value)} /></Field>
        </div>
        <Field label="一句话想法（可选，会写进大纲）">
          <div className="w-row">
            <input className="w-input grow" value={premise} placeholder="主角是谁，想要什么，什么挡着他" onChange={(event) => setPremise(event.currentTarget.value)} />
            <button type="button" className="w-btn" disabled={Boolean(busy)} onClick={() => void brainstorm()}>{busy === "ideas" ? <Spinner size={12} /> : <Sparkles size={13} />}{ideas.length ? "再来一批" : "灵感"}</button>
          </div>
        </Field>
        {ideas.length ? <div className="w-direction-list">{ideas.map((idea) => <button key={idea.id} type="button" className={`w-direction ${premise === idea.content ? "active" : ""}`} onClick={() => setPremise(idea.content)}><strong>{idea.title}</strong><span>{idea.content}</span>{idea.lens ? <span className="w-muted small">{idea.lens}</span> : null}</button>)}</div> : null}
        <h4>样章</h4>
        <p className="w-muted small">AI 照样章的文风写。可以先选几篇预制样章，之后在 作品设置 → 样章 里增删或导入你自己的。</p>
        <div className="w-template-grid">
          {PRESET_SAMPLES.map((preset) => (
            <button key={preset.id} type="button" className={`w-template-card ${presets.includes(preset.id) ? "active" : ""}`} aria-pressed={presets.includes(preset.id)} onClick={() => setPresets((current) => current.includes(preset.id) ? current.filter((id) => id !== preset.id) : [...current, preset.id])}>
              <strong>{preset.title}</strong>
              <span>{preset.style}</span>
            </button>
          ))}
        </div>
      </section>
    </Modal>
  );
}
