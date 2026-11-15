import { Target } from "lucide-react";
import { useMemo, useState } from "react";
import { friendlyAiError } from "../../ai/client";
import { batchRewrite } from "../../ai/pipelines/batchEdit";
import { findImpact } from "../../ai/pipelines/impact";
import { chapterLabel } from "../../domain/documents";
import { formatWordCount } from "../../domain/words";
import { appendProposal } from "../../storage/proposalStore";
import { Empty, Field, Spinner } from "../common";
import { useWriter } from "../useWriter";

export function ImpactTab({ onOpenChapter }: { onOpenChapter: (id: string) => void }) {
  const writer = useWriter();
  const { project, memory } = writer;
  const [subject, setSubject] = useState("");
  const [keyword, setKeyword] = useState("");
  const [instruction, setInstruction] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const hits = useMemo(() => (memory && (subject || keyword) ? findImpact(memory, subject, keyword) : []), [memory, subject, keyword]);
  if (!project || !memory) return <Empty title="还没有建立记忆" />;

  // Selections from an earlier query are ignored once those chapters no longer match.
  const chosen = hits.filter((hit) => selected.has(hit.chapterId)).map((hit) => hit.chapterId);
  const runBatch = async () => {
    const ids = chosen;
    if (!ids.length || !instruction.trim()) return;
    if (ids.length > 60) { writer.notify("error", "一次最多批量修改 60 章，请缩小范围。"); return; }
    await writer.flush();
    setBusy("0");
    try {
      const proposal = await batchRewrite(project, ids, instruction, (done, total) => setBusy(`${done}/${total}`));
      writer.setProposals(await appendProposal(project.id, proposal));
      writer.notify("success", `批量修改已生成（${proposal.changes.length} 章有改动），请在“朱批”里逐章审核。`, { label: "去审核", run: () => writer.openAssist("notes") });
    } catch (error) { writer.notify("error", friendlyAiError(error)); }
    finally { setBusy(null); }
  };

  return (
    <div className="w-outline">
      <p className="w-muted">修改某个设定前，先看看哪些章节依赖它；然后可以让 AI 对这些章节批量修订，结果会作为逐章可审的建议。</p>
      <div className="w-search-form">
        <input className="w-input" placeholder="实体（如：林舟）" value={subject} onChange={(event) => setSubject(event.currentTarget.value)} />
        <input className="w-input grow" placeholder="属性或关键词（如：年龄、左臂、青云宗）" value={keyword} onChange={(event) => setKeyword(event.currentTarget.value)} />
      </div>
      {hits.length ? (
        <>
          <div className="w-row small"><span>{hits.length} 章相关</span><button type="button" className="w-link" onClick={() => setSelected(new Set(hits.map((hit) => hit.chapterId)))}>全选</button><button type="button" className="w-link" onClick={() => setSelected(new Set())}>清空</button></div>
          {hits.slice(0, 300).map((hit) => (
            <label key={hit.chapterId} className="w-search-hit row">
              <input type="checkbox" checked={selected.has(hit.chapterId)} onChange={(event) => { const checked = event.currentTarget.checked; setSelected((current) => { const next = new Set(current); if (checked) next.add(hit.chapterId); else next.delete(hit.chapterId); return next; }); }} />
              <button type="button" className="w-link" onClick={() => onOpenChapter(hit.chapterId)}>{chapterLabel(hit.position)}</button>
              <span className="w-muted">{hit.reasons.slice(0, 3).join("；")}</span>
            </label>
          ))}
        </>
      ) : subject || keyword ? <p className="w-muted">没有找到相关章节。</p> : null}
      <Field label={`对选中的 ${chosen.length} 章批量修订`}>
        <textarea className="w-textarea" rows={2} placeholder="例如：林舟的年龄统一改为 19 岁，相关描写随之调整" value={instruction} onChange={(event) => setInstruction(event.currentTarget.value)} />
      </Field>
      <button type="button" className="w-btn primary" disabled={Boolean(busy) || !chosen.length || !instruction.trim()} onClick={() => void runBatch()}>{busy ? <><Spinner size={12} />{busy}</> : <><Target size={13} />生成批量修改建议</>}</button>
      <p className="w-muted">全书共 {formatWordCount(project.chapters.reduce((total, chapter) => total + chapter.wordCount, 0))}</p>
    </div>
  );
}
