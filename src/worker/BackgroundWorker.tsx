import { uniqueId } from "../domain/ids";
import { runPipelineWork } from "../pipeline/engine";
import { activeProjects } from "../pipeline/store";
import { startWriterTasks } from "./jobs";

/** Plugin activation owns task execution independently of the mounted workbench. */
export function startBackgroundWorker(): () => void {
  const owner = uniqueId("worker");
  const stopTasks = startWriterTasks();
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      for (const projectId of await activeProjects()) {
        if (stopped) break;
        await runPipelineWork(projectId, owner);
      }
    } catch { /* retried on the next tick */ }
    busy = false;
  };
  const interval = globalThis.setInterval(() => { void tick(); }, 5_000);
  void tick();
  return () => { stopped = true; stopTasks(); globalThis.clearInterval(interval); };
}
