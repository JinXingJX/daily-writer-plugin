import { useMemo, useState } from "react";
import { docTitle } from "../../domain/documents";
import { diffLines, readableInlineDiff, type LineDiff } from "../../domain/textDiff";
import type { ProposalChange, WriterProposal } from "../../types";
import { useProposalActions } from "../assist/useProposalActions";
import { Empty, isComposing, Spinner } from "../common";
import { useWriter } from "../useWriter";

type TextChange = Extract<ProposalChange, { kind: "text" }>;
type Actions = ReturnType<typeof useProposalActions>;

/** Unchanged runs longer than this fold down to their ends. */
const FOLD_OVER = 8;

/** A proposal read on the manuscript itself: ink stays, vermilion is new, and each change is decided beside its line. */
export function ReviewView() {
  const writer = useWriter();
  const proposal = writer.proposals.find((item) => item.id === writer.reviewId);
  if (!proposal) return <ReviewMissing />;
  return <Review key={proposal.id} proposal={proposal} />;
}

function ReviewMissing() {
  const writer = useWriter();
  return <Empty title="这份修改已经不在了"><button type="button" className="w-btn" onClick={() => writer.setView("write")}>返回稿纸</button></Empty>;
}

function Review({ proposal }: { proposal: WriterProposal }) {
  const writer = useWriter();
  const actions = useProposalActions(proposal);
  const [refine, setRefine] = useState("");
  const project = writer.project;
  const back = () => writer.setView("write");
  const pending = proposal.status === "pending";
  const texts = proposal.changes.filter((change): change is TextChange => change.kind === "text");
  const others = proposal.changes.filter((change) => change.kind !== "text");
  const total = texts.reduce((sum, change) => sum + (actions.hunkCounts.get(change.id) ?? 0), 0) + others.length;
  const taken = texts.reduce((sum, change) => sum + (actions.isAccepted(change.id) ? actions.acceptedHunks(change.id).size : 0), 0) + others.filter((change) => actions.isAccepted(change.id)).length;
  if (!project) return null;
  const sendRefine = () => { if (refine.trim()) writer.openAssist("chat", true, { text: refine.trim(), refineId: proposal.id }); };
  const applyLabel = taken === total ? "全部采纳" : taken === 0 ? "未选修改" : `采纳所选 ${taken} 处`;

  return (
    <div className="w-fullpage">
      <header className="w-fullpage-head">
        <button type="button" className="w-text-btn plain" onClick={back}>返回稿纸</button>
        <div className="w-fullpage-title"><strong>{proposal.title}</strong>{proposal.summary ? <span>{proposal.summary}</span> : null}</div>
        {pending ? (
          <>
            <span className="w-muted">已选 {taken} / {total} 处</span>
            <button type="button" className="w-text-btn plain" disabled={Boolean(actions.busy)} onClick={() => void actions.reject(back)}>全部放弃</button>
            <button type="button" className="w-btn w-btn-zhu" disabled={Boolean(actions.busy) || taken === 0} onClick={() => void actions.apply(back)}>{actions.busy === "apply" ? <Spinner size={12} /> : null}{applyLabel}</button>
          </>
        ) : <span className="w-muted">这份修改已经处理过了</span>}
      </header>
      <main className="w-review">
        {proposal.risks.length ? <ul className="w-review-risks">{proposal.risks.map((risk, index) => <li key={index}>{risk}</li>)}</ul> : null}
        {others.length ? (
          <section className="w-review-others">
            <h2>设定与线索</h2>
            {others.map((change) => <label key={change.id} className="w-check"><input type="checkbox" disabled={!pending} checked={actions.isAccepted(change.id)} onChange={() => actions.toggleChange(change.id)} />{change.label}</label>)}
          </section>
        ) : null}
        {texts.map((change) => <ChangeReview key={change.id} change={change} actions={actions} pending={pending} title={change.createChapter ? `新章节：${change.title}` : change.doc.kind === "chapter" ? docTitle(project, change.doc) || change.title : change.title} />)}
      </main>
      {pending ? (
        <footer className="w-review-foot">
          <label><span>再改改</span>
            <input className="w-input" value={refine} placeholder="比如：新增那段再短一点" onChange={(event) => setRefine(event.currentTarget.value)} onKeyDown={(event) => { if (!isComposing(event) && event.key === "Enter") sendRefine(); }} />
          </label>
        </footer>
      ) : null}
    </div>
  );
}

function ChangeReview({ change, actions, pending, title }: { change: TextChange; actions: Actions; pending: boolean; title: string }) {
  const diff = useMemo(() => diffLines(change.before, change.after), [change.before, change.after]);
  let hunkOrder = 0;
  return (
    <article className="w-review-change">
      <h1>{title}</h1>
      {diff.segments.map((segment, index) => {
        if (segment.type === "equal") return <EqualRun key={index} lines={segment.lines} first={index === 0} last={index === diff.segments.length - 1} />;
        hunkOrder += 1;
        return <HunkRow key={index} hunk={segment.hunk} order={hunkOrder} summary={hunkOrder === 1 ? change.summary : ""} taken={actions.isAccepted(change.id) && actions.acceptedHunks(change.id).has(segment.hunk.index)} pending={pending} onDecide={(take) => actions.setHunk(change.id, segment.hunk.index, take)} />;
      })}
      {!diff.hunks.length ? <p className="w-muted">没有文字改动。</p> : null}
    </article>
  );
}

function EqualRun({ lines, first, last }: { lines: string[]; first: boolean; last: boolean }) {
  const [open, setOpen] = useState(false);
  const paragraphs = lines.filter((line) => line.trim());
  if (open || paragraphs.length <= FOLD_OVER) return <>{paragraphs.map((line, index) => <div key={index} className="w-review-row"><p className="w-review-prose">{line}</p></div>)}</>;
  const head = first ? [] : paragraphs.slice(0, 2);
  const tail = last ? [] : paragraphs.slice(-2);
  return (
    <>
      {head.map((line, index) => <div key={`a${index}`} className="w-review-row"><p className="w-review-prose">{line}</p></div>)}
      <div className="w-review-row"><button type="button" className="w-text-btn" onClick={() => setOpen(true)}>展开未改动的 {paragraphs.length - head.length - tail.length} 段</button></div>
      {tail.map((line, index) => <div key={`b${index}`} className="w-review-row"><p className="w-review-prose">{line}</p></div>)}
    </>
  );
}

function HunkRow({ hunk, order, summary, taken, pending, onDecide }: { hunk: LineDiff["hunks"][number]; order: number; summary: string; taken: boolean; pending: boolean; onDecide: (take: boolean) => void }) {
  const paired = hunk.before.length === hunk.after.length;
  return (
    <div className="w-review-row">
      <div className="w-review-prose-block">
        {!taken ? hunk.before.filter((line) => line.trim()).map((line, index) => <p key={index} className="w-review-prose">{line}</p>)
          : paired ? hunk.before.map((line, index) => <p key={index} className="w-review-prose">{readableInlineDiff(line, hunk.after[index]).map((part, at) => <span key={at} className={part.type === "insert" ? "w-ins" : part.type === "delete" ? "w-del" : ""}>{part.text}</span>)}</p>)
          : <>
            {hunk.before.filter((line) => line.trim()).map((line, index) => <p key={`d${index}`} className="w-review-prose"><span className="w-del">{line}</span></p>)}
            {hunk.after.filter((line) => line.trim()).map((line, index) => <p key={`i${index}`} className="w-review-prose"><span className="w-ins">{line}</span></p>)}
          </>}
      </div>
      <aside className="w-review-decide">
        <div className="w-zhu-tag">第 {order} 处</div>
        {summary ? <div className="w-zhu-body">{summary}</div> : null}
        {pending ? (
          <div className="w-segmented" role="group" aria-label={`第 ${order} 处`}>
            <button type="button" aria-pressed={taken} className={taken ? "active" : ""} onClick={() => onDecide(true)}>采纳</button>
            <button type="button" aria-pressed={!taken} className={taken ? "" : "active"} onClick={() => onDecide(false)}>保留原文</button>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
