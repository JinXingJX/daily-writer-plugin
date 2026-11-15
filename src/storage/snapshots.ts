import { docKey } from "../domain/documents";
import { uniqueId } from "../domain/ids";
import { arrayValue, asRecord, finiteNumber, stringValue } from "../domain/util";
import { countWords } from "../domain/words";
import type { DocRef, SnapshotReason, WriterSnapshot, WriterSnapshotSummary } from "../types";
import { readJson, writeJson } from "./io";
import { snapshotFile } from "./paths";

const AUTOSAVE_INTERVAL_SECONDS = 10 * 60;
const KEEP_AUTOSAVE = 30;
const KEEP_OTHER = 50;
const REASONS: SnapshotReason[] = ["autosave", "manual", "before-ai", "before-replace", "before-delete", "before-restore", "import"];

export const SNAPSHOT_REASON_LABELS: Record<SnapshotReason, string> = { autosave: "自动", manual: "手动保存", "before-ai": "AI 修改前", "before-replace": "替换前", "before-delete": "删除前", "before-restore": "恢复前", import: "导入" };

async function readSnapshots(projectId: string, ref: DocRef): Promise<WriterSnapshot[]> {
  const stored = asRecord(await readJson(snapshotFile(projectId, ref)).catch(() => undefined));
  return arrayValue(stored.snapshots).flatMap((value) => {
    const snapshot = asRecord(value);
    if (typeof snapshot.id !== "string" || typeof snapshot.content !== "string") return [];
    const reason = REASONS.includes(snapshot.reason as SnapshotReason) ? snapshot.reason as SnapshotReason : "manual";
    return [{ id: snapshot.id, docKey: stringValue(snapshot.docKey) || docKey(ref), title: stringValue(snapshot.title), content: snapshot.content, wordCount: finiteNumber(snapshot.wordCount, 0), reason, createdAt: finiteNumber(snapshot.createdAt, 0) }];
  });
}

/**
 * Records a snapshot. Autosave snapshots are throttled; identical consecutive content is never stored twice.
 * Returns the snapshot id (existing id when the latest snapshot already holds this content), or null when throttled.
 */
export async function createSnapshot(projectId: string, ref: DocRef, title: string, content: string, reason: SnapshotReason, options: { force?: boolean } = {}): Promise<string | null> {
  const snapshots = await readSnapshots(projectId, ref);
  const latest = snapshots[snapshots.length - 1];
  if (latest && latest.content === content) return latest.id;
  const now = Math.floor(Date.now() / 1000);
  if (reason === "autosave" && !options.force) {
    const lastAuto = [...snapshots].reverse().find((snapshot) => snapshot.reason === "autosave");
    if (lastAuto && now - lastAuto.createdAt < AUTOSAVE_INTERVAL_SECONDS) return null;
  }
  const snapshot: WriterSnapshot = { id: uniqueId("snap"), docKey: docKey(ref), title, content, wordCount: countWords(content), reason, createdAt: now };
  snapshots.push(snapshot);
  await writeJson(snapshotFile(projectId, ref), { snapshots: prune(snapshots) });
  return snapshot.id;
}

export async function listSnapshots(projectId: string, ref: DocRef): Promise<WriterSnapshotSummary[]> {
  return (await readSnapshots(projectId, ref)).map(({ content: _content, ...summary }) => summary).reverse();
}

export async function readSnapshot(projectId: string, ref: DocRef, snapshotId: string): Promise<WriterSnapshot | null> {
  return (await readSnapshots(projectId, ref)).find((snapshot) => snapshot.id === snapshotId) ?? null;
}

function prune(snapshots: WriterSnapshot[]) {
  const autos = snapshots.filter((snapshot) => snapshot.reason === "autosave").slice(-KEEP_AUTOSAVE);
  const others = snapshots.filter((snapshot) => snapshot.reason !== "autosave").slice(-KEEP_OTHER);
  const keep = new Set([...autos, ...others].map((snapshot) => snapshot.id));
  return snapshots.filter((snapshot) => keep.has(snapshot.id));
}
