import { dailyHost, waitForTask, type TaskContext, type TaskSnapshot } from "@daily/plugin-sdk";
import { uniqueId } from "../domain/ids";

const observedTasks = new WeakMap<AbortSignal, string>();
const explicitCancellations = new WeakSet<AbortSignal>();

/** UI teardown may abort observation; only an explicit Stop action calls this. */
export function cancelWriterTask(signal: AbortSignal | undefined): void {
  if (!signal) return;
  explicitCancellations.add(signal);
  const taskId = observedTasks.get(signal);
  if (taskId) void dailyHost().tasks.cancel(taskId).catch((error) => console.error("Could not stop Writer task", error));
}
const contexts = new WeakMap<AbortSignal, { context: TaskContext; calls: number; prefix: string }>();
export function bindTaskContext(context: TaskContext) { contexts.set(context.signal, { context, calls: 0, prefix: "" }); }
export function taskContext(signal?: AbortSignal) { return signal ? contexts.get(signal)?.context : undefined; }
/** A resumed tool gets the same operation identities, even when earlier tools are skipped. */
export function toolTaskSignal(signal: AbortSignal | undefined, toolRunId: string): AbortSignal | undefined {
  const entry = signal ? contexts.get(signal) : undefined;
  if (!entry || !signal) return signal;
  const scoped = AbortSignal.any([signal]);
  contexts.set(scoped, { context: entry.context, calls: 0, prefix: `${toolRunId}:` });
  return scoped;
}

/** Sidecar-journaled external calls keep their result even if this worker crashes. */
export function taskRpc<T>(signal: AbortSignal | undefined, method: string, payload: unknown, operationKey?: string): Promise<T> {
  const entry = signal ? contexts.get(signal) : undefined;
  if (!entry) return dailyHost().request(method, payload) as Promise<T>;
  return entry.context.call<T>(operationKey ?? `${entry.prefix}${method}-${entry.calls++}`, method, payload);
}

export async function submitWriterTask(kind: string, scope: string, input: unknown, exclusiveKey?: string): Promise<TaskSnapshot> {
  const names: Record<string,string> = { "writer.assistant": "写作助手", "writer.images": "生成图片", rewriteSelection: "改写选中文字", continueWriting: "续写正文", summarizeChapter: "章节摘要", inspire: "灵感", generateAtlasDraft: "绘制世界地图", batchRewrite: "批量改写", diagnoseBlock: "写作诊断", checklistReview: "检查章节", generateBriefing: "故事简报", simulateReaders: "读者反馈", digestReaders: "整理读者反馈", draftImagePrompt: "图片构思" };
  const name = kind === "writer.domain" ? (input as { name: string }).name : kind;
  return dailyHost().tasks.submit({ kind, title: names[name] ?? names[name.replace(/^writer\./, "")] ?? name, scope, input, exclusiveKey, requestKey: uniqueId("request") });
}

export async function runWriterTask<T>(kind: string, scope: string, input: unknown, options: { signal?: AbortSignal; onSnapshot?: (task: TaskSnapshot) => void; exclusiveKey?: string } = {}): Promise<T> {
  const task = await submitWriterTask(kind, scope, input, options.exclusiveKey);
  if (options.signal) {
    observedTasks.set(options.signal, task.id);
    if (explicitCancellations.has(options.signal)) await dailyHost().tasks.cancel(task.id);
  }
  const finished = await waitForTask(task.id, options);
  if (finished.status !== "completed") throw new Error(finished.error ?? (finished.status === "cancelled" ? "任务已停止。" : "任务已中断，可在任务列表中继续。"));
  return finished.result as T;
}
