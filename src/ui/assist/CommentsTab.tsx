import { Check } from "lucide-react";
import { useState } from "react";
import { docKey, docTitle } from "../../domain/documents";
import { formatTime } from "../common";
import { useWriter } from "../useWriter";

export function CommentsTab({ onReveal }: { onReveal: (key: string, quote?: string) => void }) {
  const writer = useWriter();
  const [scope, setScope] = useState<"doc" | "all">("doc");
  const [showResolved, setShowResolved] = useState(false);
  const { project, active } = writer;
  if (!project) return null;
  const key = docKey(active);
  const comments = project.comments.filter((comment) => (scope === "all" || docKey(comment.doc) === key) && (showResolved || !comment.resolved)).slice().reverse();
  const setResolved = (id: string, resolved: boolean) => writer.mutateProject((draft) => { const comment = draft.comments.find((item) => item.id === id); if (comment) comment.resolved = resolved; });
  return (
    <div className="w-thread">
      <div className="w-row small">
        <select className="w-select small" value={scope} onChange={(event) => setScope(event.currentTarget.value as "doc" | "all")}><option value="doc">当前文档</option><option value="all">全部文档</option></select>
        <label className="w-check"><input type="checkbox" checked={showResolved} onChange={(event) => setShowResolved(event.currentTarget.checked)} />显示已解决</label>
        <span className="w-spacer" />
        {comments.some((comment) => !comment.resolved) ? <button type="button" className="w-link" onClick={() => writer.mutateProject((draft) => { for (const comment of draft.comments) if (scope === "all" || docKey(comment.doc) === key) comment.resolved = true; })}>全部标为已解决</button> : null}
      </div>
      {!comments.length ? <p className="w-muted pad">没有批注。可以让助手“审读本章”，它会把问题标在原文上。</p> : null}
      {comments.map((comment) => (
        <article key={comment.id} className={`w-comment ${comment.severity} ${comment.resolved ? "resolved" : ""}`}>
          <button type="button" className="w-comment-quote" onClick={() => onReveal(docKey(comment.doc), comment.quote)}>“{comment.quote.slice(0, 60)}”</button>
          <p>{comment.comment}</p>
          <div className="w-row small">
            <span className="w-muted">{scope === "all" ? `${docTitle(project, comment.doc)} · ` : ""}{comment.author === "ai" ? "AI" : "我"} · {formatTime(comment.createdAt)}</span>
            <span className="w-spacer" />
            <button type="button" className="w-link" onClick={() => setResolved(comment.id, !comment.resolved)}>{comment.resolved ? "重新打开" : <><Check size={12} />解决</>}</button>
          </div>
        </article>
      ))}
    </div>
  );
}
