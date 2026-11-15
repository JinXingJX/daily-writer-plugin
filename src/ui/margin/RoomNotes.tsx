import { useMemo } from "react";
import { chapterLabel } from "../../domain/documents";
import { diagnoseStory, HEALTH_RULE_LABELS } from "../../story/health";
import { useWriter } from "../useWriter";

type OpenChapter = (chapterId: string, quote?: string) => void;

/** The margin of the story room: story health for the whole book. */
export function HealthNotes({ onOpenChapter }: { onOpenChapter: OpenChapter }) {
  const writer = useWriter();
  const { story, memory } = writer;
  const stamp = memory?.status.updatedAt;
  const issues = useMemo(() => (story ? diagnoseStory(story, memory) : []), [story, stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!issues.length) return <p className="w-margin-empty">{memory && !memory.isEmpty ? "体检没有发现结构问题。" : "建立故事记忆后，这里会提示期待空档、伏笔沉寂、爽点重复。"}</p>;
  return (
    <div className="w-margin-list">
      {issues.slice(0, 40).map((issue) => (
        <article key={issue.id} className="w-zhu">
          <div className="w-zhu-main static"><span className="w-zhu-tag">{HEALTH_RULE_LABELS[issue.rule]}</span><span className="w-zhu-body">{issue.message}</span></div>
          <div className="w-zhu-actions">
            {issue.chapterId ? <button type="button" className="w-text-btn" onClick={() => onOpenChapter(issue.chapterId ?? "")}>打开那一章</button> : null}
            <button type="button" className="w-text-btn" onClick={() => writer.openAssist("chat", true, { text: `故事体检提示：${issue.message}\n\n结合这部作品，给几种具体到人物和章节的补法。` })}>想想怎么补</button>
          </div>
        </article>
      ))}
    </div>
  );
}

/** The margin of the archive: continuity conflicts still open. */
export function ConflictNotes({ onOpenChapter }: { onOpenChapter: OpenChapter }) {
  const writer = useWriter();
  const { memory } = writer;
  const open = memory?.conflicts.filter((conflict) => conflict.status === "open") ?? [];
  if (!memory || !open.length) return <p className="w-margin-empty">{memory && !memory.isEmpty ? "没有未处理的设定矛盾。" : "建立故事记忆后，这里会列出前后矛盾的设定。"}</p>;
  return (
    <div className="w-margin-list">
      {open.slice(0, 40).map((conflict) => (
        <article key={conflict.id} className="w-zhu">
          <div className="w-zhu-main static">
            <span className="w-zhu-tag">{conflict.subject} · {conflict.attribute}</span>
            <span className="w-zhu-body">{conflict.values.map((value) => `${chapterLabel(memory.position(value.chapterId))}：${value.value}`).join("；")}</span>
          </div>
          <div className="w-zhu-actions">
            {conflict.values.slice(0, 3).map((value, index) => <button key={index} type="button" className="w-text-btn" onClick={() => onOpenChapter(value.chapterId, value.quote)}>{chapterLabel(memory.position(value.chapterId))}</button>)}
            <button type="button" className="w-text-btn" onClick={() => writer.openArchive("conflicts")}>处理</button>
          </div>
        </article>
      ))}
    </div>
  );
}
