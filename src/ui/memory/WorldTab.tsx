import { Brain, FileOutput } from "lucide-react";
import { uniqueId } from "../../domain/ids";
import { appendProposal } from "../../storage/proposalStore";
import type { WriterProposal } from "../../types";
import { Empty, Markdown } from "../common";
import { useWriter } from "../useWriter";

export function WorldTab() {
  const writer = useWriter();
  const { project, memory } = writer;
  if (!project) return null;
  const world = memory?.aggregates.worldview;
  if (!world) return <Empty icon={<Brain size={20} />} title="还没有提炼世界观">在“概览”中勾选“世界观与人物档案”并建立记忆后，这里会按力量体系、地理、势力、人物、物品、年表整理设定集，每条都标注出处章节。</Empty>;
  const toProposal = async () => {
    await writer.flush();
    const content = world.sections.map((section) => `## ${section.title}\n\n${section.content}`).join("\n\n");
    const proposal: WriterProposal = { id: uniqueId("proposal"), title: "用提炼的设定集更新世界观", instruction: "", summary: "把记忆中整理的设定集写入“世界观”文档。", previewMarkdown: "", risks: [], changes: [{ id: uniqueId("change"), kind: "text", doc: { kind: "worldview" }, title: "世界观", summary: "自动整理", before: project.worldview, after: content }], status: "pending", createdAt: Math.floor(Date.now() / 1000), appliedAt: null, appliedChangeIds: [], undo: null, conversationId: null, source: null };
    writer.setProposals(await appendProposal(project.id, proposal));
    writer.notify("success", "已生成建议，可在“朱批”里逐段查看并应用。", { label: "去审核", run: () => writer.openAssist("notes") });
  };
  return (
    <div className="w-outline">
      <div className="w-row"><span className="w-muted">生成于 {new Date(world.generatedAt).toLocaleString()}</span><span className="w-spacer" /><button type="button" className="w-btn small" onClick={() => void toProposal()}><FileOutput size={12} />写入“世界观”文档</button></div>
      {world.sections.map((section) => <section key={section.key} className="w-card"><h3>{section.title}</h3><Markdown content={section.content} /></section>)}
    </div>
  );
}
