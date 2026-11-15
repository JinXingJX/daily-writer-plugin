import { useEffect, useState } from "react";
import { cancelWriterTask } from "../../worker/taskClient";
import { dailyHost } from "../../host";
import { useWriter } from "../useWriter";

// A map generation outlives the view that started it, so leaving the lens neither stops it nor allows a second one.
export type AtlasJob = { projectId: string; message: string; controller: AbortController };
let current: AtlasJob | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export async function runAtlasJob<T>(projectId: string, label: string, run: (progress: (message: string) => void, signal: AbortSignal) => Promise<T>): Promise<T> {
  if (current) throw new Error("地图正在绘制中，请等这一次完成。");
  const job: AtlasJob = { projectId, message: label, controller: new AbortController() };
  current = job;
  emit();
  try { return await run((message) => { job.message = message; emit(); }, job.controller.signal); }
  finally { current = null; emit(); }
}

export function useAtlasJob(projectId: string | undefined) {
  const tasks = useWriter().tasks;
  const [job, setJob] = useState<{ message: string; cancel: () => void } | null>(null);
  useEffect(() => {
    const sync = () => setJob(current && current.projectId === projectId ? { message: current.message, cancel: () => { cancelWriterTask(current?.controller.signal); current?.controller.abort(); } } : null);
    sync();
    listeners.add(sync);
    return () => { listeners.delete(sync); };
  }, [projectId]);
  const durable = tasks.find((task) => task.scope === projectId && task.kind === "writer.generateAtlasDraft" && ["queued", "running", "cancelling"].includes(task.status));
  if (durable) return { message: (durable.progress as { message?: string } | null)?.message ?? "正在绘制地图", cancel: () => { void dailyHost().tasks.cancel(durable.id); } };
  return job;
}
