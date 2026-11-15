// Author-reviewed edits to story memory threads (foreshadowing, expectations, mysteries).
import { asRecord, stringValue } from "../domain/util";
import type { StoryThread, ThreadOperation } from "./schema";
import { MemoryStore, normalizeThread } from "./store";
import { invalidateMemoryView } from "./view";

export function parseThreadOperation(value: unknown): ThreadOperation {
  const operation = asRecord(value);
  if (operation.type === "upsertThread") {
    const thread = normalizeThread(operation.thread);
    if (!thread) throw new Error("线索缺少 id。");
    return { type: "upsertThread", thread };
  }
  if (operation.type === "removeThread") {
    const id = stringValue(operation.id).trim();
    if (!id) throw new Error("缺少线索 id。");
    return { type: "removeThread", id };
  }
  throw new Error(`未知的线索操作：${String(operation.type)}`);
}

export function applyThreadOperation(threads: StoryThread[], operation: ThreadOperation): StoryThread[] {
  if (operation.type === "removeThread") return threads.filter((thread) => thread.id !== operation.id);
  const next = threads.filter((thread) => thread.id !== operation.thread.id);
  const index = threads.findIndex((thread) => thread.id === operation.thread.id);
  const updated = { ...structuredClone(operation.thread), updatedAt: Date.now() };
  if (index >= 0) next.splice(index, 0, updated); else next.push(updated);
  return next;
}

export function inverseThreadOperation(threads: StoryThread[], operation: ThreadOperation): ThreadOperation[] {
  const id = operation.type === "removeThread" ? operation.id : operation.thread.id;
  const previous = threads.find((thread) => thread.id === id);
  if (previous) return [{ type: "upsertThread", thread: structuredClone(previous) }];
  return operation.type === "upsertThread" ? [{ type: "removeThread", id }] : [];
}

export function threadOperationLabel(operation: ThreadOperation, threads: StoryThread[] = []): string {
  if (operation.type === "upsertThread") return `${threads.some((thread) => thread.id === operation.thread.id) ? "更新" : "新增"}线索：${operation.thread.title}`;
  return `删除线索：${threads.find((thread) => thread.id === operation.id)?.title ?? operation.id}`;
}

/** New thread records start empty; callers fill title/description/kind. */
export function newThread(fields: Partial<StoryThread> & { id: string; title: string }): StoryThread {
  return { description: "", status: "open", events: [], origin: "user", updatedAt: Date.now(), kind: "foreshadow", tier: "short", plan: "", targetChapterId: null, progress: 0, successorIds: [], ...fields };
}

/** Saves an author's own edit of a thread right away (not an AI proposal). */
export async function saveThread(projectId: string, thread: StoryThread): Promise<StoryThread[]> {
  const store = new MemoryStore(projectId);
  const threads = await store.withLock(async () => {
    const next = applyThreadOperation(await store.loadThreads(), { type: "upsertThread", thread });
    await store.saveThreads(next);
    return next;
  });
  invalidateMemoryView(projectId);
  return threads;
}

export async function removeThread(projectId: string, id: string): Promise<void> {
  const store = new MemoryStore(projectId);
  await store.withLock(async () => { await store.saveThreads(applyThreadOperation(await store.loadThreads(), { type: "removeThread", id })); });
  invalidateMemoryView(projectId);
}
