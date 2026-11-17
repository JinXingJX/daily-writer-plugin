import { onViewKeyDown } from "../view";
import { cancelWriterTask } from "../worker/taskClient";
import { Maximize2, Minimize2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { docKey, docTitle, orderedChapters, readDoc, rootDocInfo, UNTITLED_CHAPTER } from "../domain/documents";
import { countWords } from "../domain/words";
import { friendlyAiError } from "../ai/client";
import { continueWriting } from "../ai/quick";
import type { Idea } from "../ai/pipelines/inspire";
import { ENTITY_CATEGORY_LABELS } from "../memory/schema";
import { wordsWrittenOn } from "../storage/stats";
import { chapterStatusLabel } from "../domain/markdown";
import { imageMarkup, type ImageAsset } from "../images/schema";
import { Markdown, Spinner } from "./common";
import { useImageStudio } from "./images/ImageStudio";
import { ManuscriptEditor, type EditorApi, type EditorSelection } from "./editor/ManuscriptEditor";
import { insertImageAtCaret, type CommentMark, type EntityInfo, type InlineSuggestion } from "./editor/extensions";
import { InspireButton } from "./inspire/InspireButton";
import type { MarginNote } from "./margin/notes";
import { usePublish } from "./usePublish";
import { useWriter } from "./useWriter";
import { ToneReview } from "./assist/ToneReview";

export type WriteViewProps = {
  /** Opens 作品设置 on a tab (used by the style-guide banner). */
  onOpenSettings?: (tab: string) => void;
  editorRef: React.RefObject<EditorApi | null>;
  pageScrollRef: React.RefObject<HTMLDivElement | null>;
  /** Starts the next chapter in the studio. */
  onWriteNextChapter: () => void;
  onBlocked: () => void;
  onSelectionChange: (selection: EditorSelection) => void;
  onSuggestionChange: (suggestion: InlineSuggestion | null) => void;
  notes: MarginNote[];
  activeNote: string | null;
  onActiveNote: (id: string) => void;
  /** The selection panel, when there is no margin to hold it. */
  floatingPanel: React.ReactNode;
};

/** Global shortcuts should not fire while the author types in a form field (composer, inspector). */
function typingInField(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  return Boolean(target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) && !target.closest(".w-cm"));
}

const SAVE_LABELS = { saved: "已保存", saving: "保存中…", dirty: "未保存", error: "保存失败" };

/** The page: nothing above the prose but where you are; actions wait at the end of the text. */
export function WriteView({ editorRef, pageScrollRef, onWriteNextChapter, onBlocked, onSelectionChange, onSuggestionChange, onOpenSettings, notes, activeNote, onActiveNote, floatingPanel }: WriteViewProps) {
  const writer = useWriter();
  const { project, draft, active, prefs, memory, saveState } = writer;
  const [selectionWords, setSelectionWords] = useState(0);
  const [continuing, setContinuing] = useState(false);
  const [loadError, setLoadError] = useState<{ key: string; message: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const text = draft && project ? readDoc(project, draft.texts, active) : undefined;
  const key = docKey(active);
  const chapters = useMemo(() => (project ? orderedChapters(project) : []), [project]);
  const position = active.kind === "chapter" ? Math.max(0, chapters.findIndex((chapter) => chapter.id === active.id)) : chapters.length;
  const chapter = active.kind === "chapter" ? project?.chapters.find((item) => item.id === active.id) : undefined;
  const { publishing, publish } = usePublish(chapter?.id ?? null);

  const failedKey = loadError?.key;
  useEffect(() => {
    if (active.kind !== "chapter" || text !== undefined || failedKey === key) return;
    writer.ensureText(active.id).catch((error) => setLoadError({ key, message: error instanceof Error ? error.message : String(error) }));
  }, [active, failedKey, key, text, writer]);
  useEffect(() => { setSelectionWords(0); abortRef.current?.abort(); writer.setToneOpen(false); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const entities = useMemo(() => {
    const map = new Map<string, EntityInfo>();
    if (!prefs.highlightEntities || !project) return map;
    for (const entity of memory?.entities ?? []) {
      const info = { name: entity.name, category: ENTITY_CATEGORY_LABELS[entity.category], summary: entity.summary };
      for (const name of [entity.name, ...entity.aliases]) if (name.length >= 2 && !map.has(name)) map.set(name, info);
    }
    for (const character of project.characters) {
      const info = { name: character.name, category: "人物", summary: [character.role, character.summary].filter(Boolean).join("。") };
      for (const name of [character.name, ...character.aliases]) if (name.length >= 2) map.set(name, info);
    }
    return map;
  }, [memory?.entities, project, prefs.highlightEntities]);

  const marks = useMemo<CommentMark[]>(() => notes.flatMap((note) => (note.from !== null && note.to !== null && note.to > note.from ? [{ id: note.id, from: note.from, to: note.to, severity: note.severity, text: note.body, active: note.id === activeNote }] : [])), [activeNote, notes]);

  const handleSelection = useCallback((next: EditorSelection) => {
    setSelectionWords(next.text ? countWords(next.text) : 0);
    onSelectionChange(next);
  }, [onSelectionChange]);

  const runContinue = useCallback(async () => {
    if (!project || !draft || text === undefined || continuing) return;
    const cursor = editorRef.current?.selection().to ?? text.length;
    const controller = new AbortController();
    abortRef.current = controller;
    setContinuing(true);
    try {
      const result = await continueWriting({ project, memory, texts: draft.texts, position, docText: text, cursor, signal: controller.signal });
      const view = editorRef.current?.view();
      const unchanged = view?.state.selection.main.to === cursor && view.state.doc.length === text.length;
      if (!controller.signal.aborted && result && unchanged) editorRef.current?.showGhost(cursor, result);
      else if (!controller.signal.aborted && result) writer.notify("info", "正文在续写期间有改动，已放弃这次续写结果，可再按 ⌘J。");
    } catch (error) {
      if (!controller.signal.aborted) writer.notify("error", friendlyAiError(error));
    } finally {
      setContinuing(false);
    }
  }, [continuing, draft, editorRef, memory, position, project, text, writer]);

  /** Inserts an adopted idea at the cursor as an ordinary (undoable) editor edit. */
  const insertIdea = useCallback((idea: Idea) => {
    const view = editorRef.current?.view();
    if (!view) { writer.notify("error", "请先切回编辑模式再采用。"); return; }
    const at = view.state.selection.main.to;
    const before = view.state.doc.sliceString(Math.max(0, at - 1), at);
    const block = `${before && before !== "\n" ? "\n\n" : ""}${idea.title}：${idea.content}\n`;
    view.dispatch({ changes: { from: at, insert: block }, selection: { anchor: at + block.length } });
    view.focus();
  }, [editorRef, writer]);

  const openStudio = useImageStudio();
  const illustrate = useCallback(() => {
    const view = editorRef.current?.view();
    if (!view) { writer.notify("error", "请先切回编辑模式再插图。"); return; }
    const at = view.state.selection.main.to;
    const passage = view.state.sliceDoc(Math.max(0, at - 1_200), at);
    openStudio({ title: "插图", material: passage || view.state.doc.toString().slice(-1_200), owners: active.kind === "chapter" ? [`chapter:${active.id}`] : [`doc:${active.kind}`], pickLabel: "插入正文", onPick: (asset: ImageAsset) => { const current = editorRef.current?.view(); if (current) insertImageAtCaret(current, imageMarkup(asset.id, asset.caption)); } });
  }, [active, editorRef, openStudio, writer]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || typingInField(event)) return;
      if (mod && event.key.toLowerCase() === "j" && !prefs.markdownPreview) { event.preventDefault(); void runContinue(); }
    };
    return onViewKeyDown(onKey);
  }, [prefs.markdownPreview, runContinue]);

  if (!project || !draft) return null;
  const title = docTitle(project, active);
  const words = text === undefined ? 0 : countWords(text);
  const today = wordsWrittenOn(writer.stats);
  const goal = project.settings.dailyGoal;
  const preview = prefs.markdownPreview;
  const focus = prefs.focusMode;
  const volumeTitle = project.volumes.find((volume) => volume.id === chapter?.volumeId)?.title;
  const place = active.kind === "chapter" ? [volumeTitle, `第 ${position + 1} 章`].filter(Boolean).join(" · ") : "底稿";

  return (
    <div className="w-write">
      <div className="w-write-scroll" ref={pageScrollRef}>
        <div className="w-page" style={{ maxWidth: prefs.pageWidth, ["--w-font-size" as string]: `${prefs.fontSize}px`, ["--w-line-height" as string]: String(prefs.lineHeight) }}>
          <div className="w-page-kicker">
            <span>{place}</span>
            <span className="w-page-count">{selectionWords ? `已选 ${selectionWords} 字` : chapter?.targetWords ? `${words} / ${chapter.targetWords} 字` : `${words} 字`}{focus ? ` · 今日 +${today}${goal ? ` / ${goal}` : ""}` : ""}</span>
            <span className="w-spacer" />
            {saveState === "error" ? <button type="button" className="w-save error" title="点击重试保存" onClick={() => void writer.flush("manual")}><span className="w-save-dot" />保存失败 · 重试</button>
              : <span className={`w-save ${saveState}`} role="status">{chapter ? `${chapterStatusLabel(chapter.status)} · ` : ""}{SAVE_LABELS[saveState]}</span>}
            <button type="button" className="w-kicker-btn" title={focus ? "退出专注 ⌘⇧F" : "专注 ⌘⇧F"} aria-label="专注模式" aria-pressed={focus} onClick={() => writer.setPrefs({ focusMode: !focus })}>{focus ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
          </div>
          {active.kind === "chapter" && chapter ? (
            <input aria-label="章节标题" className="w-page-title" placeholder={UNTITLED_CHAPTER} value={chapter.title} onChange={(event) => writer.updateChapter(chapter.id, { title: event.currentTarget.value })} />
          ) : (
            <>
              <h1 className="w-page-title static">{title}</h1>
              <p className="w-page-hint">{active.kind !== "chapter" ? rootDocInfo(active.kind).hint : ""}</p>
            </>
          )}
          {writer.toneOpen && text !== undefined ? <ToneReview key={`${project.id}/${key}`} text={text} onClose={() => writer.setToneOpen(false)} /> : null}
          {active.kind === "style" ? <div className="w-callout">这里是写给自己和 AI 的文风指南。AI 写正文时的声音来自本作的样章。{onOpenSettings ? <button type="button" className="w-link" onClick={() => onOpenSettings("samples")}>管理样章</button> : null}</div> : null}
          {text === undefined ? (
            loadError?.key === key
              ? <div className="w-callout warn inline">正文加载失败：{loadError.message}<button type="button" className="w-btn small" onClick={() => setLoadError(null)}>重试</button></div>
              : <div className="w-loading-inline"><Spinner />正在加载正文…</div>
          ) : preview ? (
            text.trim() ? <div onDoubleClick={() => writer.setPrefs({ markdownPreview: false })} title="双击返回编辑"><Markdown className="w-manuscript-md" content={text} prose /></div> : <p className="w-muted">（空白文档）</p>
          ) : (
            <div onClick={(event) => { const id = (event.target as HTMLElement).closest("[data-comment]")?.getAttribute("data-comment"); if (id) onActiveNote(id); }}>
              <ManuscriptEditor
                ref={editorRef}
                docKey={`${project.id}/${key}`}
                text={text}
                placeholder={active.kind === "chapter" ? "开始写作。选中文字，页边会出现改写；⌘J 让 AI 续写。" : rootDocInfo(active.kind).hint}
                entities={entities}
                comments={marks}
                typewriterMode={prefs.typewriter || focus}
                onChange={(value) => writer.editText(active, value)}
                onSelectionChange={handleSelection}
                onSuggestionChange={onSuggestionChange}
              />
            </div>
          )}
          {focus || text === undefined ? null : (
            <div className="w-page-end" role="toolbar" aria-label="接下来">
              <button type="button" className="w-end-btn strong" disabled={continuing || preview} onClick={() => void runContinue()}>{continuing ? <Spinner size={12} /> : null}续写<kbd>⌘J</kbd></button>
              <InspireButton className="w-end-btn" options={() => ({ target: active.kind === "chapter" ? "chapter" : active.kind, position: active.kind === "chapter" ? position : undefined, focus: active.kind === "chapter" ? (text ?? "").slice(-1_500) : "", adoptLabel: "插入到光标处", onAdopt: insertIdea })} />
              <button type="button" className="w-end-btn" disabled={preview} onClick={illustrate}>插图</button>
              {active.kind === "chapter" ? <button type="button" className="w-end-btn" onClick={onBlocked}>卡住了</button> : null}
              <span className="w-spacer" />
              {active.kind === "chapter" ? <>
                <button type="button" className="w-end-btn" onClick={onWriteNextChapter}>写下一章</button>
                <button type="button" className="w-btn primary" disabled={!text.trim() || publishing} onClick={() => void publish()}>{publishing ? <Spinner size={12} /> : null}{publishing ? "编辑部运行中" : chapter?.status === "final" ? "重新发布" : "发布本章"}</button>
              </> : null}
            </div>
          )}
        </div>
        {floatingPanel}
        {continuing ? <div className="w-ai-float" role="status"><Spinner size={12} />AI 正在续写…<button type="button" onClick={() => { cancelWriterTask(abortRef.current?.signal); abortRef.current?.abort(); setContinuing(false); }}>取消</button></div> : null}
      </div>
    </div>
  );
}
