import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { docKey, docTitle, readDoc } from "../../domain/documents";
import { createSnapshot, listSnapshots, readSnapshot, SNAPSHOT_REASON_LABELS } from "../../storage/snapshots";
import type { WriterSnapshot, WriterSnapshotSummary } from "../../types";
import { formatTime, Spinner, useDialogs } from "../common";
import { useWriter } from "../useWriter";
import { DiffView } from "./DiffView";

export function HistoryTab() {
  const writer = useWriter();
  const dialogs = useDialogs();
  const { project, draft, active } = writer;
  const [items, setItems] = useState<WriterSnapshotSummary[] | null>(null);
  const [selected, setSelected] = useState<WriterSnapshot | null>(null);
  const key = docKey(active);
  const projectId = project?.id;

  useEffect(() => {
    if (!projectId) return;
    setItems(null);
    setSelected(null);
    void writer.flush("manual").then(() => listSnapshots(projectId, active)).then(setItems).catch(() => setItems([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, key]);

  if (!project || !draft) return null;
  const current = readDoc(project, draft.texts, active) ?? "";

  const restore = async () => {
    if (!selected) return;
    if (!(await dialogs.confirm("恢复历史版本", `用 ${formatTime(selected.createdAt)} 的版本替换当前「${docTitle(project, active)}」？当前内容会先存为一个历史版本。`))) return;
    await createSnapshot(project.id, active, docTitle(project, active), current, "before-restore", { force: true });
    writer.editText(active, selected.content);
    await writer.flush();
    setItems(await listSnapshots(project.id, active));
    writer.notify("success", "已恢复。");
  };

  return (
    <div className="w-thread">
      <p className="w-muted">「{docTitle(project, active)}」的历史版本。编辑时每 10 分钟自动保存一版，手动保存（⌘S）、AI 修改前、替换和删除前也会保存。</p>
      {items === null ? <div className="w-loading-inline"><Spinner />加载中…</div> : null}
      {items?.length === 0 ? <p className="w-muted pad">还没有历史版本。</p> : null}
      <div className="w-history-list">
        {items?.map((item) => (
          <button key={item.id} type="button" className={`w-history-item ${selected?.id === item.id ? "active" : ""}`} onClick={async () => setSelected(await readSnapshot(project.id, active, item.id))}>
            <span>{formatTime(item.createdAt)}</span>
            <span className="w-pill">{SNAPSHOT_REASON_LABELS[item.reason]}</span>
            <span className="w-muted">{item.wordCount} 字</span>
          </button>
        ))}
      </div>
      {selected ? (
        <section className="w-history-preview">
          <div className="w-row">
            <strong>与当前版本的差异</strong>
            <span className="w-spacer" />
            <button type="button" className="w-btn small" onClick={() => void restore()}><RotateCcw size={12} />恢复此版本</button>
          </div>
          <DiffView before={current} after={selected.content} />
        </section>
      ) : null}
    </div>
  );
}
