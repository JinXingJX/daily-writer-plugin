import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { WriterProposal } from "../../types";
import type { EditorApi } from "../editor/ManuscriptEditor";
import { ProposalCard } from "../assist/ProposalCard";
import { useWriter } from "../useWriter";
import { stackNotes, type MarginNote } from "./notes";
import type { MarginNotesApi } from "./useMarginNotes";

type Props = {
  api: MarginNotesApi;
  editorRef: React.RefObject<EditorApi | null>;
  pageScrollRef: React.RefObject<HTMLDivElement | null>;
  activeNote: string | null;
  onActiveNote: (id: string | null) => void;
  /** Line notes up with their paragraphs; off when the margin floats over the page. */
  aligned: boolean;
  onReveal: (key: string) => void;
};

/** 朱批: proposals waiting on the author, what concerns the whole chapter, then notes beside the lines they are about. */
export function MarginNotes({ api, editorRef, pageScrollRef, activeNote, onActiveNote, aligned, onReveal }: Props) {
  const writer = useWriter();
  const { notes } = api;
  const pending = useMemo(() => writer.proposals.filter((proposal) => proposal.status === "pending").reverse(), [writer.proposals]);
  const handled = useMemo(() => writer.proposals.filter((proposal) => proposal.status !== "pending").slice(-8).reverse(), [writer.proposals]);
  const anchored = notes.filter((note) => note.from !== null);
  const general = notes.filter((note) => note.from === null);
  const pick = (note: MarginNote) => {
    onActiveNote(note.id);
    if (note.from !== null) { const api = editorRef.current; if (api) api.revealRange(note.from, note.to ?? note.from); }
  };
  const item = (note: MarginNote) => <Note key={note.id} note={note} active={activeNote === note.id} onPick={() => pick(note)} onResolve={() => api.resolve(note)} />;

  return (
    <div className="w-margin-notes">
      {pending.length || general.length ? (
        <div className="w-margin-pinned">
          {pending.map((proposal) => <PendingProposal key={proposal.id} proposal={proposal} />)}
          {general.map(item)}
        </div>
      ) : null}
      {aligned ? <AlignedNotes notes={anchored} editorRef={editorRef} pageScrollRef={pageScrollRef} render={item} /> : <div className="w-margin-list">{anchored.map(item)}</div>}
      {!notes.length && !pending.length ? <p className="w-margin-empty">这一章还没有朱批。发布时会自动审读一次，也可以在“本章”里随时发起。</p> : null}
      {handled.length ? (
        <details className="w-margin-handled">
          <summary>已处理的 AI 修改 {handled.length}</summary>
          {handled.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} onReveal={onReveal} />)}
        </details>
      ) : null}
    </div>
  );
}

function PendingProposal({ proposal }: { proposal: WriterProposal }) {
  const writer = useWriter();
  return (
    <article className="w-zhu">
      <button type="button" className="w-zhu-main" onClick={() => writer.openReview(proposal.id)}>
        <span className="w-zhu-tag">AI 改稿 · {proposal.changes.length} 处待审</span>
        <span className="w-zhu-body">{proposal.title}{proposal.summary ? `：${proposal.summary}` : ""}</span>
      </button>
      <div className="w-zhu-actions"><button type="button" className="w-text-btn" onClick={() => writer.openReview(proposal.id)}>在稿纸上审</button></div>
    </article>
  );
}

function Note({ note, active, onPick, onResolve }: { note: MarginNote; active: boolean; onPick: () => void; onResolve: () => void }) {
  const writer = useWriter();
  const ask = () => writer.openAssist("chat", true, { text: `${note.quote ? `关于“${note.quote}”：` : ""}${note.body}\n\n这一处怎么改好？给我修改建议，由我逐处决定。` });
  return (
    <article className={`w-zhu ${active ? "active" : ""} ${note.byAuthor ? "mine" : ""}`}>
      <button type="button" className="w-zhu-main" onClick={onPick}>
        <span className="w-zhu-tag">{note.tag}</span>
        <span className="w-zhu-body">{note.body}</span>
      </button>
      <div className="w-zhu-actions">
        {note.source === "conflict" ? <button type="button" className="w-text-btn" onClick={() => writer.openArchive("conflicts")}>去处理矛盾</button> : null}
        {note.source === "health" ? <button type="button" className="w-text-btn" onClick={() => writer.openStory("score")}>看线索谱</button> : null}
        <button type="button" className="w-text-btn" onClick={ask}>让 AI 想想</button>
        {note.source === "comment" || note.source === "publish" ? <button type="button" className="w-text-btn" onClick={onResolve}>解决</button> : null}
      </div>
    </article>
  );
}

/** Notes keep level with their paragraph as the page scrolls; scrolling over the margin scrolls the page. */
function AlignedNotes({ notes, editorRef, pageScrollRef, render }: { notes: MarginNote[]; editorRef: React.RefObject<EditorApi | null>; pageScrollRef: React.RefObject<HTMLDivElement | null>; render: (note: MarginNote) => React.ReactNode }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  const follow = useCallback(() => {
    const frame = frameRef.current;
    const layer = layerRef.current;
    const scroller = pageScrollRef.current;
    if (!frame || !layer || !scroller) return;
    const offset = scroller.getBoundingClientRect().top - frame.getBoundingClientRect().top;
    layer.style.transform = `translateY(${offset - scroller.scrollTop}px)`;
  }, [pageScrollRef]);

  const measure = useCallback(() => {
    const layer = layerRef.current;
    const scroller = pageScrollRef.current;
    const view = editorRef.current?.view();
    if (!layer || !scroller || !view) { setReady(false); return; }
    const documentOffset = view.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const length = view.state.doc.length;
    const items = notes.flatMap((note) => {
      const element = layer.querySelector<HTMLElement>(`[data-note="${CSS.escape(note.id)}"]`);
      return element ? [{ id: note.id, element, top: documentOffset + view.lineBlockAt(Math.min(note.from ?? 0, length)).top, height: element.offsetHeight }] : [];
    });
    const tops = stackNotes(items);
    for (const item of items) item.element.style.transform = `translateY(${tops[item.id]}px)`;
    follow();
    setReady(true);
  }, [editorRef, follow, notes, pageScrollRef]);

  useLayoutEffect(() => { measure(); }, [measure]);
  useEffect(() => {
    const scroller = pageScrollRef.current;
    const layer = layerRef.current;
    if (!scroller || !layer) return;
    let frame = 0;
    const schedule = () => { globalThis.cancelAnimationFrame(frame); frame = globalThis.requestAnimationFrame(measure); };
    const content = editorRef.current?.view()?.contentDOM;
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    observer.observe(layer);
    if (content) observer.observe(content);
    scroller.addEventListener("scroll", follow, { passive: true });
    return () => { globalThis.cancelAnimationFrame(frame); observer.disconnect(); scroller.removeEventListener("scroll", follow); };
  }, [editorRef, follow, measure, pageScrollRef]);

  return (
    <div className={`w-margin-flow ${ready ? "" : "pending"}`} ref={frameRef} onWheel={(event) => { const scroller = pageScrollRef.current; if (scroller) scroller.scrollTop += event.deltaY; }}>
      <div className="w-margin-layer" ref={layerRef}>
        {notes.map((note) => <div key={note.id} data-note={note.id} className="w-margin-slot">{render(note)}</div>)}
      </div>
    </div>
  );
}
