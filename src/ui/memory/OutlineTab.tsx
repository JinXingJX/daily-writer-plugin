import { Brain, FileOutput } from "lucide-react";
import { chapterLabel, sortedVolumes } from "../../domain/documents";
import { uniqueId } from "../../domain/ids";
import { appendProposal } from "../../storage/proposalStore";
import type { WriterProposal } from "../../types";
import { Empty, Markdown } from "../common";
import { useWriter } from "../useWriter";

export function OutlineTab({ onOpenChapter }: { onOpenChapter: (id: string) => void }) {
  const writer = useWriter();
  const { project, memory } = writer;
  if (!project) return null;
  if (!memory?.aggregates.book && !memory?.aggregates.arcs.length) return <Empty icon={<Brain size={20} />} title="还没有大纲">在“概览”中建立记忆后，这里会出现从正文自动提炼的全书大纲、分卷大纲和情节弧。</Empty>;
  const book = memory.aggregates.book;
  const toProposal = async () => {
    if (!book) return;
    await writer.flush();
    const proposal: WriterProposal = { id: uniqueId("proposal"), title: "用提炼的大纲更新全书大纲", instruction: "", summary: "把记忆中提炼的全书大纲写入“全书大纲”文档。可以逐段选择采用。", previewMarkdown: "", risks: [], changes: [{ id: uniqueId("change"), kind: "text", doc: { kind: "outline" }, title: "全书大纲", summary: "自动提炼", before: project.outline, after: `${book.outline}\n\n## 主线\n${book.mainline}\n\n## 人物弧光\n${book.characterArcs}` }], status: "pending", createdAt: Math.floor(Date.now() / 1000), appliedAt: null, appliedChangeIds: [], undo: null, conversationId: null, source: null };
    writer.setProposals(await appendProposal(project.id, proposal));
    writer.notify("success", "已生成建议，可在“朱批”里逐段查看并应用。", { label: "去审核", run: () => writer.openAssist("notes") });
  };
  return (
    <div className="w-outline">
      {book ? (
        <section className="w-card">
          <div className="w-row"><h3>全书大纲</h3><span className="w-spacer" /><button type="button" className="w-btn small" onClick={() => void toProposal()}><FileOutput size={12} />写入“全书大纲”文档</button></div>
          <Markdown content={book.outline} />
          {book.mainline ? <><h4>主线</h4><Markdown content={book.mainline} /></> : null}
          {book.characterArcs ? <><h4>人物弧光</h4><Markdown content={book.characterArcs} /></> : null}
        </section>
      ) : null}
      {sortedVolumes(project).map((volume) => {
        const summary = memory.aggregates.volumes.find((item) => item.volumeId === volume.id);
        const arcs = memory.aggregates.arcs.filter((arc) => arc.volumeId === volume.id).sort((left, right) => left.index - right.index);
        if (!summary && !arcs.length) return null;
        return (
          <section key={volume.id} className="w-card">
            <h3>{volume.title}</h3>
            {summary ? <Markdown content={summary.summary} /> : null}
            {arcs.map((arc) => (
              <details key={arc.id} className="w-arc">
                <summary><b>{arc.title}</b> <span className="w-muted">{arc.chapterIds.length ? `${chapterLabel(memory.position(arc.chapterIds[0]))} – ${chapterLabel(memory.position(arc.chapterIds[arc.chapterIds.length - 1]))}` : ""}</span></summary>
                <p>{arc.summary}</p>
                {arc.conflicts ? <p className="w-muted">冲突：{arc.conflicts}</p> : null}
                <div className="w-chips">{arc.chapterIds.map((id) => <button key={id} type="button" className="w-chip small" onClick={() => onOpenChapter(id)}>{memory.position(id) + 1}</button>)}</div>
              </details>
            ))}
          </section>
        );
      })}
    </div>
  );
}
