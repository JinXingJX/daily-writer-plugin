import { onViewKeyDown } from "../view";
import { LoaderCircle, PanelRight, PenLine, Plus, Import, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveAnchor } from "../domain/anchors";
import { docRefFromKey, orderedChapters, readDoc } from "../domain/documents";
import { AssistPanel } from "./assist/AssistPanel";
import { CommandPalette } from "./CommandPalette";
import { DialogProvider, useMediaQuery } from "./common";
import type { EditorApi, EditorSelection } from "./editor/ManuscriptEditor";
import { ImportDialog } from "./ImportDialog";
import { Rail, RoomSwitch } from "./Rail";
import { InspirePanel, type InspireOptions } from "./inspire/InspirePanel";
import { insertImageAtCaret } from "./editor/extensions";
import { ImageStudioProvider, useImageStudio } from "./images/ImageStudio";
import { imageMarkup } from "../images/schema";
import { setActiveImageProject } from "../images/store";
import { SelectionPanel } from "./margin/SelectionPanel";
import { useMarginNotes } from "./margin/useMarginNotes";
import { useSelectionAi } from "./margin/useSelectionAi";
import { NewProjectDialog } from "./NewProjectDialog";
import { BlockDoctorDialog } from "./assist/BlockDoctor";
import { BureauView } from "./pipeline/PipelineView";
import { ReviewView } from "./review/ReviewView";
import { ArchiveRoom, ARCHIVE_LENSES, StoryRoom, STORY_LENSES } from "./rooms/Rooms";
import { SettingsDialog, type SettingsTab } from "./SettingsDialog";
import { NEXT_CHAPTER_INSTRUCTION } from "../ai/promptDefaults";
import { usePublish } from "./usePublish";
import { useWriter, useWriterController, WriterContext, type AssistTab } from "./useWriter";
import { WriteView } from "./WriteView";

export function WriterApp() {
  const controller = useWriterController();
  return (
    <WriterContext.Provider value={controller}>
      <DialogProvider>
        <ImageStudioProvider>
          <Shell />
        </ImageStudioProvider>
      </DialogProvider>
    </WriterContext.Provider>
  );
}

const EMPTY_SELECTION: EditorSelection = { from: 0, to: 0, text: "" };

function Shell() {
  const writer = useWriter();
  const { project, view, prefs, loading } = writer;
  useEffect(() => { setActiveImageProject(project?.id ?? null); }, [project?.id]);
  const editorRef = useRef<EditorApi | null>(null);
  const pageScrollRef = useRef<HTMLDivElement | null>(null);
  const [selection, setSelection] = useState<EditorSelection>(EMPTY_SELECTION);
  const [modal, setModal] = useState<"import" | "settings" | "palette" | "new" | "block" | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("work");
  const [inspireOptions, setInspireOptions] = useState<InspireOptions | null>(null);
  const [marginTab, setMarginTab] = useState<AssistTab>("notes");
  const [activeNote, setActiveNote] = useState<string | null>(null);
  const [planHost, setPlanHost] = useState<HTMLElement | null>(null);
  // Below 1180px the margin floats over the page; below 880px the spine becomes a drawer too.
  const narrow = useMediaQuery("(max-width: 1180px)");
  const narrowRail = useMediaQuery("(max-width: 880px)");
  const [assistOverlay, setAssistOverlay] = useState(false);
  const [railOverlay, setRailOverlay] = useState(false);
  const pendingReveal = useRef<{ key: string; quote?: string } | null>(null);
  const notesApi = useMarginNotes();
  const selectionAi = useSelectionAi(editorRef, selection);
  const activeChapterId = writer.active.kind === "chapter" ? writer.active.id : null;
  const { publish } = usePublish(activeChapterId);

  const reveal = useCallback((key: string, quote?: string) => {
    const ref = docRefFromKey(key);
    if (!ref) return;
    pendingReveal.current = { key, quote };
    // Revealing a passage needs the editor, not the rendered preview.
    if (quote && writer.prefs.markdownPreview) writer.setPrefs({ markdownPreview: false });
    writer.selectDoc(ref);
  }, [writer]);

  // After navigating, scroll the editor to the quoted text once the document is loaded.
  useEffect(() => {
    const target = pendingReveal.current;
    if (!target || !project || !writer.draft) return;
    const ref = docRefFromKey(target.key);
    if (!ref) return;
    const text = readDoc(project, writer.draft.texts, ref);
    if (text === undefined) return;
    pendingReveal.current = null;
    globalThis.setTimeout(() => {
      if (!target.quote) { editorRef.current?.focus(); return; }
      const range = resolveAnchor(text, { start: 0, end: target.quote.length, quote: target.quote });
      if (range) editorRef.current?.revealRange(range.start, range.end);
    }, 60);
  }, [project, writer.draft, writer.active]);

  /** The next chapter is written in the studio: the conversation beside its plan. */
  const writeNextChapter = useCallback(() => {
    writer.openAssist("chat", true, { text: NEXT_CHAPTER_INSTRUCTION });
    writer.setView("studio");
  }, [writer]);

  // On narrow windows the margin opens as an overlay when something asks for it.
  useEffect(() => { if (writer.assistRequest && narrow) setAssistOverlay(true); }, [writer.assistRequest, narrow]);
  useEffect(() => { if (!narrow) setAssistOverlay(false); }, [narrow]);
  useEffect(() => { if (!narrowRail) setRailOverlay(false); }, [narrowRail]);
  // Opening a chapter from the drawer hands the space back to the page.
  useEffect(() => { setRailOverlay(false); setActiveNote(null); setSelection(EMPTY_SELECTION); }, [writer.active]);
  useEffect(() => { if (view !== "write") setSelection(EMPTY_SELECTION); }, [view]);

  const toggleRail = useCallback(() => {
    if (narrowRail) setRailOverlay((open) => !open);
    else writer.setPrefs({ showRail: !writer.prefs.showRail });
  }, [narrowRail, writer]);

  const toggleMargin = useCallback(() => {
    if (narrow) setAssistOverlay((open) => !open);
    else writer.setPrefs({ showAssist: !writer.prefs.showAssist });
  }, [narrow, writer]);

  const openSettings = useCallback((tab: SettingsTab = "work") => { setSettingsTab(tab); setModal("settings"); }, []);

  /** Inspiration for wherever the author is: the open document, or the current view's lens. */
  const openInspireHere = useCallback(() => {
    if (!project) return;
    const ordered = orderedChapters(project);
    const active = writer.active;
    if (view === "archive") { setInspireOptions({ target: "character" }); return; }
    if (view === "story") { setInspireOptions({ target: writer.storyLens === "map" ? "storyNode" : writer.storyLens === "board" ? "outline" : "thread" }); return; }
    if (active.kind === "chapter") {
      const position = Math.max(0, ordered.findIndex((chapter) => chapter.id === active.id));
      setInspireOptions(selection.text.trim() ? { target: "selection", position, focus: selection.text } : { target: "chapter", position, focus: (writer.draft?.texts[active.id] ?? "").slice(-1_500) });
      return;
    }
    setInspireOptions({ target: active.kind });
  }, [project, selection.text, view, writer.active, writer.draft, writer.storyLens]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "s") { event.preventDefault(); void writer.flush("manual"); }
      if (mod && event.key.toLowerCase() === "k") { event.preventDefault(); setModal((current) => (current === "palette" ? null : "palette")); }
      if (mod && event.shiftKey && event.key.toLowerCase() === "i") { event.preventDefault(); openInspireHere(); return; }
      if (mod && !event.shiftKey && event.key.toLowerCase() === "l") { event.preventDefault(); writer.openAssist("chat", true); }
      if (mod && event.key === "\\") { event.preventDefault(); toggleRail(); }
      if (mod && event.shiftKey && event.key.toLowerCase() === "p" && !typingInField(event)) { event.preventDefault(); writer.setPrefs({ markdownPreview: !writer.prefs.markdownPreview }); }
      if (mod && event.shiftKey && event.key.toLowerCase() === "f" && !typingInField(event)) { event.preventDefault(); writer.setPrefs({ focusMode: !writer.prefs.focusMode }); }
    };
    return onViewKeyDown(onKey);
  }, [openInspireHere, toggleRail, writer]);

  const paletteActions = useMemo(() => [
    { label: "新建章节", hint: "在当前章节之后", run: () => writer.addChapter(writer.active.kind === "chapter" ? { afterId: writer.active.id } : {}) },
    { label: "写下一章", hint: "对谈 → 计划 → 逐场写 → 自审", run: writeNextChapter },
    { label: "灵感涌现", hint: "⌘⇧I · 当前位置", run: openInspireHere },
    { label: "新建作品", run: () => setModal("new") },
    { label: "导入小说", run: () => setModal("import") },
    { label: "作品设置与导出", run: () => openSettings("work") },
    { label: "样章", hint: "AI 照样章的文风写", run: () => openSettings("samples") },
    { label: "提示词设置", run: () => openSettings("prompts") },
    { label: "回到稿纸", run: () => writer.setView("write") },
    ...STORY_LENSES.flat().map((lens) => ({ label: `故事：${lens.label}`, run: () => writer.openStory(lens.value) })),
    ...ARCHIVE_LENSES.map((lens) => ({ label: `档案：${lens.label}`, run: () => writer.openArchive(lens.value) })),
    { label: "卡文诊断", hint: "没剧情／缺切口／写不出／不想写", run: () => setModal("block") },
    { label: "发布本章", hint: "后台更新记忆与设定，起草下一章", run: () => { if (activeChapterId) void publish(); else writer.notify("info", "先打开要发布的章节。"); } },
    { label: "编辑部", hint: "查看、暂停、恢复后台任务", run: () => writer.setView("bureau") },
    { label: prefs.markdownPreview ? "返回编辑" : "预览 Markdown", hint: "⌘⇧P", run: () => writer.setPrefs({ markdownPreview: !prefs.markdownPreview }) },
    { label: prefs.focusMode ? "退出专注模式" : "专注模式", hint: "⌘⇧F", run: () => writer.setPrefs({ focusMode: !prefs.focusMode }) },
    { label: "显示 / 隐藏书脊", hint: "⌘\\", run: () => { writer.setView("write"); toggleRail(); } },
    { label: "立即保存", hint: "⌘S", run: () => void writer.flush("manual") },
  ], [activeChapterId, openInspireHere, openSettings, prefs.focusMode, prefs.markdownPreview, publish, toggleRail, writeNextChapter, writer]);

  if (loading && !project) return <div className="w-loading"><LoaderCircle size={16} className="spin" /> 正在加载 Writer…</div>;
  if (!project) {
    return (
      <div className="w-welcome">
        <section>
          <div className="w-empty-icon"><PenLine size={20} /></div>
          <h1>开始一部长篇作品</h1>
          <p>Writer 为长篇创作而生：卷章管理、设定库、线索谱，以及能读懂几百万字作品的 AI 记忆。AI 的每一处修改都会先落在稿纸上，由你逐处决定。</p>
          <div className="w-row">
            <button type="button" className="w-btn primary" onClick={() => setModal("new")}><Plus size={14} />新建作品</button>
            <button type="button" className="w-btn" onClick={() => setModal("import")}><Import size={14} />导入已有小说</button>
          </div>
        </section>
        {modal === "import" ? <ImportDialog onClose={() => setModal(null)} onImported={() => { setModal(null); writer.openArchive("memory"); }} /> : null}
        {modal === "new" ? <NewProjectDialog onClose={() => setModal(null)} /> : null}
        <Notices />
      </div>
    );
  }

  const writing = view === "write";
  const focus = prefs.focusMode && writing;
  const room = view === "story" || view === "archive";
  const studio = view === "studio";
  const marginAvailable = (writing && !focus) || room || studio;
  const assistOpen = narrow ? assistOverlay : prefs.showAssist;
  const showAssist = marginAvailable && (studio || assistOpen);
  const overlay = narrow && !studio && showAssist;
  // The spine belongs to the manuscript; other views use the full width.
  const railOpen = narrowRail ? railOverlay : prefs.showRail;
  const showRail = writing && !focus && railOpen;
  const panelInMargin = writing && showAssist && !overlay && marginTab !== "chat" && !prefs.markdownPreview;
  const panelFloats = writing && (!showAssist || overlay) && !prefs.markdownPreview;

  const openStudio = useImageStudio();
  const illustrateSelection = () => {
    const passage = selection.text;
    openStudio({ title: "为这段配图", material: passage, owners: writer.active.kind === "chapter" ? [`chapter:${writer.active.id}`] : [`doc:${writer.active.kind}`], pickLabel: "插入正文", onPick: (asset) => { const current = editorRef.current?.view(); if (current) insertImageAtCaret(current, imageMarkup(asset.id, asset.caption)); } });
  };
  const selectionPanel = (placement: "margin" | "float") => (
    <SelectionPanel ai={selectionAi} selection={selection} editorRef={editorRef} pageScrollRef={pageScrollRef} placement={placement}
      onInspire={() => { const focusText = selection.text; setInspireOptions({ target: "selection", position: selectionAi.position, focus: focusText, adoptLabel: "按这个改写", onAdopt: (idea) => void selectionAi.runRewrite("灵感改写", `${idea.title}：${idea.content}`, 2) }); }}
      onToChat={() => writer.openAssist("chat", true)} onIllustrate={illustrateSelection} />
  );

  return (
    <div className={`w-app ${focus ? "focus" : ""} ${studio ? "is-studio" : ""}`}>
      {room ? <RoomHead onToggleMargin={toggleMargin} marginOpen={assistOpen} onPalette={() => setModal("palette")} /> : null}
      <div className="w-body">
        {showRail ? <Rail overlay={narrowRail} onImport={() => setModal("import")} onNewProject={() => setModal("new")} onPalette={() => setModal("palette")} onSettings={() => openSettings("work")} /> : null}
        {showRail && narrowRail ? <div className="w-drawer-backdrop" onMouseDown={() => setRailOverlay(false)} /> : null}
        <main className="w-main">
          <div className="w-view" key={view}>
            {writing ? <WriteView editorRef={editorRef} pageScrollRef={pageScrollRef} onSelectionChange={setSelection} onSuggestionChange={selectionAi.setSuggestion} onWriteNextChapter={writeNextChapter} onBlocked={() => setModal("block")} onOpenSettings={(tab) => openSettings(tab as SettingsTab)} notes={notesApi.notes} activeNote={activeNote} onActiveNote={(id) => { setActiveNote(id); setMarginTab("notes"); }} railOpen={railOpen} onToggleRail={toggleRail} marginOpen={assistOpen} onToggleMargin={toggleMargin} floatingPanel={panelFloats ? selectionPanel("float") : null} /> : null}
            {view === "story" ? <StoryRoom onOpenChapter={(id, quote) => reveal(`chapter:${id}`, quote)} /> : null}
            {view === "archive" ? <ArchiveRoom onOpenChapter={(id, quote) => reveal(`chapter:${id}`, quote)} /> : null}
            {view === "bureau" ? <BureauView onOpenChapter={(id) => reveal(`chapter:${id}`)} /> : null}
            {view === "review" ? <ReviewView /> : null}
            {studio ? (
              <div className="w-studio">
                <header className="w-fullpage-head">
                  <button type="button" className="w-text-btn plain" onClick={() => writer.setView("write")}>返回稿纸</button>
                  <div className="w-fullpage-title"><strong>写下一章</strong></div>
                </header>
                <div className="w-studio-scroll" ref={setPlanHost} />
              </div>
            ) : null}
          </div>
        </main>
        {overlay ? <div className="w-assist-backdrop" onMouseDown={() => setAssistOverlay(false)} /> : null}
        <AssistPanel hidden={!showAssist} overlay={overlay} room={view} planHost={planHost} tab={marginTab} onTab={setMarginTab} notesApi={notesApi} editorRef={editorRef} pageScrollRef={pageScrollRef} activeNote={activeNote} onActiveNote={setActiveNote} alignNotes={!overlay} selection={selection} editorSelection={() => editorRef.current?.selection() ?? EMPTY_SELECTION} onReveal={reveal} selectionPanel={panelInMargin ? selectionPanel("margin") : null} />
      </div>
      {modal === "import" ? <ImportDialog onClose={() => setModal(null)} onImported={() => { setModal(null); writer.openArchive("memory"); }} /> : null}
      {modal === "settings" ? <SettingsDialog initialTab={settingsTab} onClose={() => setModal(null)} /> : null}
      {modal === "new" ? <NewProjectDialog onClose={() => setModal(null)} /> : null}
      {inspireOptions ? <InspirePanel options={inspireOptions} onClose={() => setInspireOptions(null)} /> : null}
      {modal === "block" ? <BlockDoctorDialog onClose={() => setModal(null)} onInsertPlaceholder={(text) => { const view = editorRef.current?.view(); if (view && writer.view === "write") { const at = view.state.selection.main.head; view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } }); view.focus(); } else void navigator.clipboard?.writeText(text).then(() => writer.notify("info", "占位已复制，粘贴到正文里即可。")); }} /> : null}
      {modal === "palette" ? <CommandPalette onClose={() => setModal(null)} actions={paletteActions} /> : null}
      <Notices />
    </div>
  );
}

/** The bar over the story and archive rooms: the book, the three rooms, and this room's lenses. */
function RoomHead({ onToggleMargin, marginOpen, onPalette }: { onToggleMargin: () => void; marginOpen: boolean; onPalette: () => void }) {
  const writer = useWriter();
  const { project, view } = writer;
  if (!project) return null;
  const groups = view === "story" ? STORY_LENSES : [ARCHIVE_LENSES];
  const current = view === "story" ? writer.storyLens : writer.archiveLens;
  const openConflicts = writer.memory?.conflicts.filter((conflict) => conflict.status === "open").length ?? 0;
  return (
    <header className="w-room-head">
      <strong className="w-book-title">{project.title}</strong>
      <RoomSwitch />
      <nav className="w-lenses" aria-label="视角">
        {groups.map((group, index) => (
          <span key={index} className="w-lens-group">
            {group.map((lens) => (
              <button key={lens.value} type="button" aria-current={current === lens.value ? "true" : undefined} className={current === lens.value ? "active" : ""} onClick={() => (view === "story" ? writer.setStoryLens(lens.value as typeof writer.storyLens) : writer.setArchiveLens(lens.value as typeof writer.archiveLens))}>
                {lens.label}{lens.value === "conflicts" && openConflicts ? ` ${openConflicts}` : ""}
              </button>
            ))}
          </span>
        ))}
      </nav>
      <span className="w-spacer" />
      <button type="button" className="w-text-btn plain" onClick={onPalette}>⌘K</button>
      <button type="button" className={`w-kicker-btn ${marginOpen ? "" : "off"}`} title="页边 ⌘L" aria-label="页边" aria-pressed={marginOpen} onClick={onToggleMargin}><PanelRight size={14} /></button>
    </header>
  );
}

function typingInField(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  return Boolean(target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA"));
}

function Notices() {
  const writer = useWriter();
  if (!writer.notices.length) return null;
  return (
    <div className="w-notices" role="status" aria-live="polite">
      {writer.notices.map((notice) => (
        <div key={notice.id} className={`w-notice ${notice.tone}`}>
          <span>{notice.text}</span>
          {notice.action ? <button type="button" className="w-link" onClick={() => { notice.action?.run(); writer.dismiss(notice.id); }}>{notice.action.label}</button> : null}
          <button type="button" className="w-icon-btn small" aria-label="关闭" onClick={() => writer.dismiss(notice.id)}><X size={13} /></button>
        </div>
      ))}
    </div>
  );
}
