import { onViewKeyDown, viewBounds, viewPoint } from "../view";
import { ChevronRight, FolderPlus, Import, MoreHorizontal, Pencil, Plus, Search, Settings, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { docKey, orderedChapters, ROOT_DOCS, sortedVolumes, UNTITLED_CHAPTER } from "../domain/documents";
import { chapterStatusLabel } from "../domain/markdown";
import { formatWordCount } from "../domain/words";
import { wordsWrittenOn } from "../storage/stats";
import type { WriterChapterMeta } from "../types";
import { useDialogs } from "./common";
import { useWriter } from "./useWriter";

const ROW = 32;

type Row = { type: "volume"; id: string; title: string; count: number; words: number; collapsed: boolean } | { type: "chapter"; chapter: WriterChapterMeta; index: number };
type Menu = { kind: "chapter" | "volume"; id: string; x: number; y: number };

/** Keeps a context menu of roughly this size inside the window. */
function clampMenu(x: number, y: number, width = 200, height = 300) {
  const point = viewPoint(x, y);
  const bounds = viewBounds();
  return { left: Math.max(4, Math.min(point.x, bounds.width - width - 4)), top: Math.max(4, Math.min(point.y, bounds.height - height - 4)) };
}

/** The three rooms of the book. */
export function RoomSwitch() {
  const writer = useWriter();
  const { view } = writer;
  return (
    <nav className="w-rooms" aria-label="空间">
      <button type="button" aria-current={view === "write" ? "page" : undefined} className={view === "write" ? "active" : ""} onClick={() => writer.setView("write")}>写作</button>
      <button type="button" aria-current={view === "story" ? "page" : undefined} className={view === "story" ? "active" : ""} onClick={() => writer.setView("story")}>故事</button>
      <button type="button" aria-current={view === "archive" ? "page" : undefined} className={view === "archive" ? "active" : ""} onClick={() => writer.setView("archive")}>档案</button>
    </nav>
  );
}

/** The spine: the book, its rooms and its chapters. */
export function Rail({ onImport, onNewProject, onPalette, onSettings, overlay = false }: { onImport: () => void; onNewProject: () => void; onPalette: () => void; onSettings: () => void; overlay?: boolean }) {
  const writer = useWriter();
  const dialogs = useDialogs();
  const { project, active, projects, memory } = writer;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showRootDocs, setShowRootDocs] = useState(false);
  const [filter, setFilter] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const activeKeyValue = docKey(active);

  // The virtualized list needs its real height; the rail resizes with the window.
  useLayoutEffect(() => {
    const node = listRef.current;
    if (!node) return;
    const measure = () => { if (node.clientHeight) setHeight(node.clientHeight); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [project?.id]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    return onViewKeyDown(onKey);
  }, [menu]);

  // When a chapter is opened from elsewhere (palette, memory links, new chapter), expand its volume.
  const activeVolumeId = active.kind === "chapter" ? project?.chapters.find((chapter) => chapter.id === active.id)?.volumeId : undefined;
  // A long book opens folded down to the volume being written.
  const projectId = project?.id;
  useEffect(() => {
    if (project && project.volumes.length > 1 && activeVolumeId) setCollapsed(new Set(project.volumes.filter((volume) => volume.id !== activeVolumeId).map((volume) => volume.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  useEffect(() => {
    if (!activeVolumeId) return;
    setCollapsed((current) => { if (!current.has(activeVolumeId)) return current; const next = new Set(current); next.delete(activeVolumeId); return next; });
  }, [activeKeyValue, activeVolumeId]);

  const rows = useMemo<Row[]>(() => {
    if (!project) return [];
    const chapters = orderedChapters(project);
    const index = new Map(chapters.map((chapter, position) => [chapter.id, position]));
    const query = filter.trim();
    const result: Row[] = [];
    for (const volume of sortedVolumes(project)) {
      const inVolume = chapters.filter((chapter) => chapter.volumeId === volume.id);
      const visible = query ? inVolume.filter((chapter) => chapter.title.toLowerCase().includes(query.toLowerCase()) || String((index.get(chapter.id) ?? 0) + 1) === query) : inVolume;
      if (query && !visible.length) continue;
      const isCollapsed = collapsed.has(volume.id) && !query;
      result.push({ type: "volume", id: volume.id, title: volume.title, count: inVolume.length, words: inVolume.reduce((total, chapter) => total + chapter.wordCount, 0), collapsed: isCollapsed });
      if (!isCollapsed) for (const chapter of visible) result.push({ type: "chapter", chapter, index: index.get(chapter.id) ?? 0 });
    }
    return result;
  }, [project, collapsed, filter]);

  // ...and scroll it into view.
  const activeRow = rows.findIndex((row) => row.type === "chapter" && `chapter:${row.chapter.id}` === activeKeyValue);
  useEffect(() => {
    const node = listRef.current;
    if (!node || activeRow < 0) return;
    const top = activeRow * ROW;
    if (top < node.scrollTop || top + ROW > node.scrollTop + node.clientHeight) node.scrollTop = Math.max(0, top - node.clientHeight / 3);
    // Only when the active document changes, not on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKeyValue, activeRow >= 0]);

  if (!project) return null;
  const activeKey = activeKeyValue;
  const start = Math.max(0, Math.floor(scrollTop / ROW) - 10);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + 10);
  const stale = memory ? new Set(memory.staleChapterIds()) : null;
  const rootDocsOpen = showRootDocs || active.kind !== "chapter";
  const aiPending = new Set(writer.proposals.filter((proposal) => proposal.status === "pending").flatMap((proposal) => proposal.changes.flatMap((change) => (change.kind === "text" && change.doc.kind === "chapter" ? [change.doc.id] : []))));

  const onDrop = (event: DragEvent, row: Row) => {
    event.preventDefault();
    const id = dragging ?? event.dataTransfer.getData("text/chapter");
    setDragging(null);
    setDropTarget(null);
    if (!id) return;
    if (row.type === "volume") writer.moveChapter(id, row.id, null);
    else if (row.chapter.id !== id) writer.moveChapter(id, row.chapter.volumeId, row.chapter.id);
  };

  const menuChapter = menu?.kind === "chapter" ? project.chapters.find((chapter) => chapter.id === menu.id) : undefined;
  const menuVolume = menu?.kind === "volume" ? project.volumes.find((volume) => volume.id === menu.id) : undefined;
  const menuPos = menu ? clampMenu(menu.x, menu.y) : null;
  const dragProps = (id: string) => ({
    onDragOver: (event: DragEvent) => { if (!dragging) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; if (dropTarget !== id) setDropTarget(id); },
    onDragLeave: () => setDropTarget((current) => (current === id ? null : current)),
  });

  return (
    <aside className={`w-rail ${overlay ? "overlay" : ""}`} aria-label="作品导航">
      <div className="w-rail-head">
        <div className="w-rail-title">
          <input aria-label="作品标题" value={project.title} onChange={(event) => { const title = event.currentTarget.value; writer.mutateProject((next) => { next.title = title; }); }} />
          <select aria-label="切换作品" value={project.id} onChange={(event) => { const value = event.currentTarget.value; if (value === "__new") onNewProject(); else void writer.openProjectById(value); }}>
            {projects.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            <option value="__new">＋ 新建作品…</option>
          </select>
        </div>
        <button type="button" className="w-icon-btn small" title="导入小说" aria-label="导入小说" onClick={onImport}><Import size={14} /></button>
      </div>

      <button type="button" className="w-rail-search" onClick={onPalette}><span>搜索、跳转、执行</span><kbd>⌘K</kbd></button>

      {project.chapters.length > 30 || filter ? (
        <label className="w-rail-filter">
          <Search size={13} aria-hidden="true" />
          <input aria-label="筛选章节" placeholder="跳到章节（标题或序号）" value={filter} onChange={(event) => setFilter(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Escape") setFilter(""); }} />
          {filter ? <button type="button" className="w-icon-btn tiny visible" aria-label="清除筛选" onClick={() => setFilter("")} title="清除筛选"><X size={12} /></button> : null}
        </label>
      ) : null}

      <button type="button" className="w-rail-drafts" aria-expanded={rootDocsOpen} onClick={() => setShowRootDocs(!rootDocsOpen)}><ChevronRight size={13} className={`w-tree-chevron ${rootDocsOpen ? "open" : ""}`} /><span>底稿</span><span className="w-nav-meta">世界观 · 大纲 · 文风</span></button>
      {rootDocsOpen ? (
        <nav className="w-root-docs" aria-label="设定文档">
          {ROOT_DOCS.map((doc) => (
            <button key={doc.kind} type="button" className={`w-root-doc ${activeKey === doc.kind ? "active" : ""}`} onClick={() => writer.selectDoc({ kind: doc.kind })}>
              <span>{doc.label}</span>
              <span className="w-root-doc-meta num">{project[doc.field].length ? formatWordCount(project[doc.field].length) : "空"}</span>
            </button>
          ))}
        </nav>
      ) : null}

      <div className="w-rail-section">
        <span>正文 · <span className="num">{project.chapters.length}</span> 章</span>
        <span className="w-spacer" />
        <button type="button" className="w-icon-btn small" title="新建卷" aria-label="新建卷" onClick={() => void dialogs.prompt("新建卷", "卷名：", `第${project.volumes.length + 1}卷`).then((title) => { if (title?.trim()) writer.addVolume(title.trim()); })}><FolderPlus size={14} /></button>
        <button type="button" className="w-icon-btn small" title="新建章节" aria-label="新建章节" onClick={() => writer.addChapter(active.kind === "chapter" ? { afterId: active.id } : {})}><Plus size={14} /></button>
      </div>

      <div className="w-tree" ref={listRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
        {!project.chapters.length ? <button type="button" className="w-tree-empty" onClick={() => writer.addChapter()}>还没有章节，点这里写第一章，或导入已有小说</button> : null}
        {filter && project.chapters.length && !rows.length ? <p className="w-tree-none">没有匹配“{filter}”的章节</p> : null}
        <div style={{ height: rows.length * ROW, position: "relative" }}>
          {rows.slice(start, end).map((row, offset) => {
            const top = (start + offset) * ROW;
            if (row.type === "volume") {
              return (
                <div key={row.id} className={`w-tree-volume ${dropTarget === row.id ? "drop" : ""}`} style={{ top }} onContextMenu={(event) => { event.preventDefault(); setMenu({ kind: "volume", id: row.id, x: event.clientX, y: event.clientY }); }} {...dragProps(row.id)} onDrop={(event) => onDrop(event, row)}>
                  <button type="button" className="w-tree-toggle" aria-expanded={!row.collapsed} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; })}>
                    <ChevronRight size={13} className={`w-tree-chevron ${row.collapsed ? "" : "open"}`} />
                    <span className="w-tree-volume-title">{row.title}</span>
                  </button>
                  <span className="w-nav-meta num">{row.count} 章 · {formatWordCount(row.words)}</span>
                  <button type="button" className="w-icon-btn tiny" aria-label="卷操作" onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ kind: "volume", id: row.id, x: box.left, y: box.bottom + 4 }); }} title="卷操作"><MoreHorizontal size={13} /></button>
                </div>
              );
            }
            const { chapter } = row;
            const key = `chapter:${chapter.id}`;
            return (
              <button
                key={chapter.id}
                type="button"
                draggable
                aria-current={activeKey === key ? "page" : undefined}
                className={`w-tree-chapter ${activeKey === key ? "active" : ""} ${dragging === chapter.id ? "dragging" : ""} ${dropTarget === chapter.id && dragging !== chapter.id ? "drop" : ""}`}
                style={{ top }}
                onClick={() => writer.selectDoc({ kind: "chapter", id: chapter.id })}
                onContextMenu={(event) => { event.preventDefault(); setMenu({ kind: "chapter", id: chapter.id, x: event.clientX, y: event.clientY }); }}
                onDragStart={(event) => { setDragging(chapter.id); event.dataTransfer.setData("text/chapter", chapter.id); event.dataTransfer.effectAllowed = "move"; }}
                onDragEnd={() => { setDragging(null); setDropTarget(null); }}
                {...dragProps(chapter.id)}
                onDrop={(event) => onDrop(event, row)}
                title={chapter.summary || chapter.title || UNTITLED_CHAPTER}
              >
                <span className="w-tree-index num">{row.index + 1}</span>
                <span className={`w-tree-title ${chapter.title.trim() ? "" : "untitled"}`}>{chapter.title.trim() || UNTITLED_CHAPTER}</span>
                {stale?.has(chapter.id) && memory && !memory.isEmpty ? <span className="w-dot warn" title="记忆待更新" /> : null}
                <span className={`w-tree-status s-${aiPending.has(chapter.id) ? "ai" : chapter.status}`} role="img" aria-label={aiPending.has(chapter.id) ? "AI 修改待审" : chapterStatusLabel(chapter.status)} title={aiPending.has(chapter.id) ? "AI 修改待审" : chapterStatusLabel(chapter.status)} />
              </button>
            );
          })}
        </div>
      </div>

      <RailFoot total={project.chapters.reduce((total, chapter) => total + chapter.wordCount, 0)} today={wordsWrittenOn(writer.stats)} goal={project.settings.dailyGoal} onSettings={onSettings} />

      {menuPos && menuVolume ? (
        <div className="w-menu-backdrop" onMouseDown={() => setMenu(null)} onContextMenu={(event) => { event.preventDefault(); setMenu(null); }}>
          <div className="w-menu" role="menu" style={menuPos} onMouseDown={(event) => event.stopPropagation()}>
            <button type="button" onClick={() => { writer.addChapter({ volumeId: menuVolume.id }); setMenu(null); }}><Plus size={13} />在本卷末尾新建章节</button>
            <button type="button" onClick={async () => { setMenu(null); const title = await dialogs.prompt("重命名卷", "卷名：", menuVolume.title); if (title?.trim()) writer.mutateProject((next) => { const volume = next.volumes.find((item) => item.id === menuVolume.id); if (volume) volume.title = title.trim(); }); }}><Pencil size={13} />重命名</button>
            {project.volumes.length > 1 ? (
              <button type="button" className="danger" onClick={async () => {
                setMenu(null);
                const count = project.chapters.filter((chapter) => chapter.volumeId === menuVolume.id).length;
                if (await dialogs.confirm("删除卷", count ? `删除「${menuVolume.title}」？其中的 ${count} 章会移到其他卷，正文不会丢失。` : `删除空卷「${menuVolume.title}」？`, { danger: true, confirmLabel: "删除" })) writer.deleteVolume(menuVolume.id);
              }}><Trash2 size={13} />删除卷</button>
            ) : <span className="w-menu-note">至少保留一卷</span>}
          </div>
        </div>
      ) : null}

      {menuPos && menuChapter ? (
        <div className="w-menu-backdrop" onMouseDown={() => setMenu(null)} onContextMenu={(event) => { event.preventDefault(); setMenu(null); }}>
          <div className="w-menu" role="menu" style={menuPos} onMouseDown={(event) => event.stopPropagation()}>
            <button type="button" onClick={() => { writer.addChapter({ afterId: menuChapter.id }); setMenu(null); }}>在此后插入新章</button>
            <button type="button" onClick={async () => { setMenu(null); const title = await dialogs.prompt("重命名章节", "章节标题：", menuChapter.title); if (title?.trim()) writer.updateChapter(menuChapter.id, { title: title.trim() }); }}>重命名</button>
            <div className="w-menu-sep" />
            {(["draft", "writing", "review", "final"] as const).map((status) => <button key={status} type="button" className={menuChapter.status === status ? "checked" : ""} onClick={() => { writer.updateChapter(menuChapter.id, { status }); setMenu(null); }}>标记为「{chapterStatusLabel(status)}」</button>)}
            <div className="w-menu-sep" />
            <button type="button" className="danger" onClick={async () => { setMenu(null); if (await dialogs.confirm("删除章节", `删除「${menuChapter.title.trim() || UNTITLED_CHAPTER}」？正文会保存在历史版本中。`, { danger: true, confirmLabel: "删除" })) await writer.deleteChapter(menuChapter.id); }}><Trash2 size={13} />删除章节</button>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

/** The editor's office, today's words against the goal, and the book's total. */
function RailFoot({ total, today, goal, onSettings }: { total: number; today: number; goal: number; onSettings: () => void }) {
  const writer = useWriter();
  const waiting = writer.runs.filter((run) => run.state === "awaiting").length;
  const running = writer.runs.some((run) => run.state === "running" || run.state === "queued");
  const ratio = goal ? Math.min(1, today / goal) : 0;
  return (
    <div className="w-rail-foot">
      <div className="w-rail-foot-row">
        <button type="button" className={`w-bureau-link ${waiting ? "waiting" : ""}`} onClick={() => writer.setView("bureau")}>
          <span>编辑部</span><span>{waiting ? `${waiting} 项等你确认` : running ? "工作中…" : ""}</span>
        </button>
        <button type="button" className="w-icon-btn small" title="作品设置" aria-label="作品设置" onClick={onSettings}><Settings size={14} /></button>
      </div>
      <div className="w-rail-foot-row small"><span className="num">今日 +{today}{goal ? ` / ${goal}` : ""}</span><span className="num">全书 {formatWordCount(total)}</span></div>
      {goal ? <div className="w-goal-line"><span style={{ width: `${ratio * 100}%` }} /></div> : null}
    </div>
  );
}
