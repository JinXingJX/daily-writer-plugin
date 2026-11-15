import { AlertTriangle } from "lucide-react";
import { chapterLabel } from "../../domain/documents";
import { MemoryStore } from "../../memory/store";
import { invalidateMemoryView } from "../../memory/view";
import { Empty } from "../common";
import { useWriter } from "../useWriter";

export function ConflictsTab({ onOpenChapter }: { onOpenChapter: (id: string, quote?: string) => void }) {
  const writer = useWriter();
  const { project, memory } = writer;
  if (!project || !memory) return <Empty title="还没有建立记忆" />;
  const setStatus = async (id: string, status: "ignored" | "resolved" | "open") => {
    const store = new MemoryStore(project.id);
    await store.withLock(async () => {
      const list = await store.loadConflicts();
      const conflict = list.find((item) => item.id === id);
      if (conflict) conflict.status = status;
      await store.saveConflicts(list);
      invalidateMemoryView(project.id);
    });
    await writer.refreshMemory(true);
  };
  const list = memory.conflicts.filter((conflict) => conflict.status === "open");
  if (!list.length) return <Empty icon={<AlertTriangle size={20} />} title="没有发现设定冲突">建立记忆时会自动检测：固定特征前后不一致、已死亡人物再次出场等。</Empty>;
  return (
    <div className="w-outline">
      {list.map((conflict) => (
        <article key={conflict.id} className="w-comment warning">
          <div className="w-row"><b>{conflict.subject} · {conflict.attribute}</b><span className="w-spacer" /><button type="button" className="w-link" onClick={() => void setStatus(conflict.id, "ignored")}>忽略</button><button type="button" className="w-link" onClick={() => void setStatus(conflict.id, "resolved")}>已处理</button></div>
          <p className="w-muted">{conflict.note}</p>
          <ul className="w-fact-list">{conflict.values.map((value, index) => <li key={index}><button type="button" className="w-link" onClick={() => onOpenChapter(value.chapterId, value.quote)}>{chapterLabel(memory.position(value.chapterId))}</button> {value.value}{value.quote ? <span className="w-muted">“{value.quote}”</span> : null}</li>)}</ul>
        </article>
      ))}
    </div>
  );
}
