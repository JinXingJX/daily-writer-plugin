import { cancelWriterTask } from "../../worker/taskClient";
import { Bookmark, BookmarkCheck, Check, Combine, Copy, GitBranchPlus, MessageSquarePlus, RefreshCw, Sparkles, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { friendlyAiError } from "../../ai/client";
import { inspire, INSPIRE_TARGETS, type Idea, type InspireMode, type InspireTarget } from "../../ai/pipelines/inspire";
import { loadIdeas, removeIdea, saveIdea, type SavedIdea } from "../../storage/ideaStore";
import { Modal, Spinner, Tabs } from "../common";
import { useWriter } from "../useWriter";

export type InspireOptions = {
  target: InspireTarget;
  /** What the author is looking at (selected text, a scene, a node…); sent as 【当前内容】. */
  focus?: string;
  /** Reading position for chapter-level targets. */
  position?: number;
  /** Label of the adopt action, e.g. "设为本章意图". Without `onAdopt`, ideas can only be copied, saved or handed to the assistant. */
  adoptLabel?: string;
  onAdopt?: (idea: Idea) => void;
};

type Batch = { id: string; label: string; ideas: Idea[] };

/** Inspiration burst for one module: batches of ideas, each thought through a different lens. */
export function InspirePanel({ options, onClose }: { options: InspireOptions; onClose: () => void }) {
  const writer = useWriter();
  const { project, memory, draft } = writer;
  const info = INSPIRE_TARGETS[options.target];
  const [tab, setTab] = useState<"ideas" | "saved">("ideas");
  const [seed, setSeed] = useState("");
  const [count, setCount] = useState(6);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<SavedIdea[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const projectId = project?.id;

  useEffect(() => { if (projectId) void loadIdeas(projectId).then(setSaved).catch(() => undefined); }, [projectId]);
  useEffect(() => () => abortRef.current?.abort(), []);
  if (!project) return null;

  const allIdeas = batches.flatMap((batch) => batch.ideas);
  const savedIds = new Set(saved.map((idea) => idea.id));

  const run = async (label: string, mode: InspireMode, base: Idea[] = []) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(label);
    setTab("ideas");
    try {
      const ideas = await inspire({ project, memory, texts: draft?.texts, target: options.target, focus: options.focus, position: options.position, seed, avoid: allIdeas.map((idea) => idea.title), mode, base, count, signal: controller.signal });
      if (controller.signal.aborted) return;
      setBatches((current) => [{ id: `${Date.now()}`, label, ideas }, ...current]);
      setPicked(new Set());
    } catch (error) {
      if (!controller.signal.aborted) writer.notify("error", friendlyAiError(error));
    } finally {
      setBusy(null);
    }
  };

  const toggleSaved = async (idea: Idea) => {
    const next = savedIds.has(idea.id) ? await removeIdea(project.id, idea.id) : await saveIdea(project.id, idea, options.target);
    setSaved(next);
  };
  const copy = async (idea: Idea) => {
    try { await navigator.clipboard.writeText(`${idea.title}\n${idea.content}`); writer.notify("success", "已复制。"); }
    catch { writer.notify("error", "无法写入剪贴板。"); }
  };
  const handToAssistant = (idea: Idea) => {
    writer.openAssist("chat", true, { text: `【灵感 · ${info.label}】${idea.title}\n${idea.content}\n\n请沿着这个思路，` });
    onClose();
  };
  const adopt = (idea: Idea) => { options.onAdopt?.(idea); onClose(); };
  const togglePick = (id: string) => setPicked((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const pickedIdeas = allIdeas.filter((idea) => picked.has(idea.id));

  const card = (idea: Idea, savedCard = false) => (
    <article key={idea.id} className={`w-idea-card ${picked.has(idea.id) ? "picked" : ""}`}>
      <header>
        {!savedCard ? <input type="checkbox" checked={picked.has(idea.id)} onChange={() => togglePick(idea.id)} aria-label="选中用于混合" /> : null}
        <strong>{idea.title}</strong>
        {idea.lens ? <span className="w-pill">{idea.lens}</span> : null}
      </header>
      <p>{idea.content}</p>
      <footer>
        {options.onAdopt ? <button type="button" className="w-btn small primary" onClick={() => adopt(idea)}><Check size={12} />{options.adoptLabel ?? "采用"}</button> : null}
        {!savedCard ? <button type="button" className="w-btn small" disabled={Boolean(busy)} title="沿这条继续发散" onClick={() => void run(`展开「${idea.title}」`, "expand", [idea])}><GitBranchPlus size={12} />展开</button> : null}
        <button type="button" className="w-icon-btn small" title={savedIds.has(idea.id) ? "移出灵感箱" : "收进灵感箱"} onClick={() => void toggleSaved(idea)}>{savedIds.has(idea.id) ? <BookmarkCheck size={13} /> : <Bookmark size={13} />}</button>
        <button type="button" className="w-icon-btn small" title="复制" onClick={() => void copy(idea)}><Copy size={13} /></button>
        <button type="button" className="w-icon-btn small" title="交给写作助手展开" onClick={() => handToAssistant(idea)}><MessageSquarePlus size={13} /></button>
      </footer>
    </article>
  );

  const savedHere = saved.filter((idea) => idea.target === options.target);
  const savedOther = saved.filter((idea) => idea.target !== options.target);

  return (
    <Modal title={<span className="w-row"><Sparkles size={15} className="w-tone" />灵感涌现 · {info.label}</span>} width={860} onClose={onClose}>
      <div className="w-inspire">
        {options.focus?.trim() ? <div className="w-inspire-focus"><span className="w-muted">围绕</span>{options.focus.trim().slice(0, 160)}{options.focus.trim().length > 160 ? "…" : ""}</div> : null}
        <div className="w-row">
          <input className="w-input grow" value={seed} placeholder="可选：给一个方向、关键词或限制，例如“想要一个代价很重的选择”" onChange={(event) => setSeed(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter" && !busy) void run(seed.trim() ? `方向：${seed.trim()}` : "新一批", "fresh"); }} />
          <select className="w-select" value={count} onChange={(event) => setCount(Number(event.currentTarget.value))} title="每批数量">{[3, 4, 6, 8, 10].map((value) => <option key={value} value={value}>{value} 条</option>)}</select>
          {busy ? <button type="button" className="w-btn" onClick={() => { cancelWriterTask(abortRef.current?.signal); abortRef.current?.abort(); }}><Square size={12} />停止</button> : null}
          <button type="button" className="w-btn primary" disabled={Boolean(busy)} onClick={() => void run(seed.trim() ? `方向：${seed.trim()}` : batches.length ? "再来一批" : "第一批", "fresh")}>{busy ? <Spinner size={12} /> : batches.length ? <RefreshCw size={13} /> : <Sparkles size={13} />}{batches.length ? "再来一批" : "涌现"}</button>
        </div>
        <div className="w-row">
          <Tabs size="sm" value={tab} onChange={setTab} items={[{ value: "ideas", label: "本次", badge: allIdeas.length }, { value: "saved", label: "灵感箱", badge: saved.length }]} />
          <span className="w-spacer" />
          {pickedIdeas.length >= 2 ? <button type="button" className="w-btn small" disabled={Boolean(busy)} onClick={() => void run(`混合 ${pickedIdeas.length} 条`, "blend", pickedIdeas)}><Combine size={12} />混合所选（{pickedIdeas.length}）</button> : allIdeas.length ? <span className="w-muted small">勾选两条以上可以混合</span> : null}
        </div>
        {tab === "ideas" ? (
          batches.length ? batches.map((batch) => (
            <section key={batch.id} className="w-inspire-batch">
              <h5>{batch.label}</h5>
              <div className="w-idea-grid">{batch.ideas.map((idea) => card(idea))}</div>
            </section>
          )) : busy ? <p className="w-muted pad"><Spinner size={12} /> 正在想…</p> : <p className="w-muted pad">每条点子会从不同的角度去想（视角镜头可以在 作品设置 → 提示词 里修改）。可以先写一个方向，也可以直接点“涌现”。</p>
        ) : (
          saved.length ? (
            <>
              {savedHere.length ? <div className="w-idea-grid">{savedHere.map((idea) => card(idea, true))}</div> : null}
              {savedOther.length ? <><h5 className="w-inspire-sub">其他模块的灵感</h5><div className="w-idea-grid">{savedOther.map((idea) => (
                <article key={idea.id} className="w-idea-card">
                  <header><strong>{idea.title}</strong><span className="w-pill">{INSPIRE_TARGETS[idea.target]?.label ?? idea.target}</span></header>
                  <p>{idea.content}</p>
                  <footer>
                    <button type="button" className="w-icon-btn small" title="复制" onClick={() => void copy(idea)}><Copy size={13} /></button>
                    <button type="button" className="w-icon-btn small" title="交给写作助手展开" onClick={() => handToAssistant(idea)}><MessageSquarePlus size={13} /></button>
                    <button type="button" className="w-icon-btn small" title="删除" onClick={() => void removeIdea(project.id, idea.id).then(setSaved)}><Trash2 size={13} /></button>
                  </footer>
                </article>
              ))}</div></> : null}
            </>
          ) : <p className="w-muted pad">灵感箱是空的。点子卡片上的书签按钮可以把它收进来，留到以后用。</p>
        )}
      </div>
    </Modal>
  );
}
