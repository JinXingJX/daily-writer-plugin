import { observeTasks, type TaskSnapshot } from "@daily/plugin-sdk";

/** Refresh shared project files once per batch, including completions during a refresh. */
export function observeWriterTasks(
  projectId: string,
  onChange: (tasks: TaskSnapshot[]) => void,
  refresh: () => Promise<void>,
  onError: (error: unknown) => void,
): () => void {
  const completedAttempts = new Map<string, number>();
  let stopped = false;
  let refreshing = false;
  let pending = false;

  const refreshResults = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      while (pending && !stopped) {
        pending = false;
        try { await refresh(); }
        catch (error) { if (!stopped) onError(error); }
      }
    } finally { refreshing = false; }
  };

  const stop = observeTasks({ scope: projectId }, (tasks) => {
    onChange(tasks);
    for (const task of tasks) {
      if (task.status !== "completed" || completedAttempts.get(task.id) === task.attempt) continue;
      completedAttempts.set(task.id, task.attempt);
      pending = true;
    }
    void refreshResults();
  }, onError);

  return () => { stopped = true; stop(); };
}
