import { setDailyHost, type DailyPluginApi } from "@daily/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskSnapshot } from "@daily/plugin-sdk";
import { observeWriterTasks } from "./taskObserver";

function task(id: string, status: TaskSnapshot["status"] = "completed", cursor = 1, attempt = 1): TaskSnapshot {
  return { id, title: "Write", pluginId: "daily.writer", kind: "writer.domain", scope: "book", requestKey: id, exclusiveKey: null, status, attempt, cursor, progress: null, result: null, error: null, createdAt: 1, updatedAt: cursor };
}

function host(tasks: TaskSnapshot[]) {
  vi.useFakeTimers();
  const changes: TaskSnapshot[] = [];
  const list = vi.fn(async () => ({ tasks, cursor: 1 }));
  const events = vi.fn(async (after: number) => {
    const next = changes.splice(0).map((task) => ({ seq: task.cursor, task }));
    return { events: next, cursor: next.at(-1)?.seq ?? after };
  });
  setDailyHost({ tasks: { list, events } } as unknown as DailyPluginApi);
  return { changes, list, events };
}

afterEach(() => { setDailyHost(null); vi.useRealTimers(); });

describe("Writer task result refresh", () => {
  it("loads shared files once when reopening a book with many completed tasks", async () => {
    const tasks = Array.from({ length: 100 }, (_, index) => task(String(index)));
    const api = host(tasks);
    const onChange = vi.fn();
    const refresh = vi.fn(async () => undefined);
    const onError = vi.fn();
    const stop = observeWriterTasks("book", onChange, refresh, onError);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.list).toHaveBeenCalledWith({ scope: "book" });
    expect(onChange).toHaveBeenCalledWith(tasks);
    expect(refresh).toHaveBeenCalledTimes(1);
    // Replayed completions and unrelated state changes must not reread the project.
    api.changes.push(task("0", "completed", 2), task("failed", "failed", 3));
    await vi.advanceTimersByTimeAsync(750);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    stop();
  });

  it("coalesces completions received during slow reads into one later refresh", async () => {
    const api = host([task("first")]);
    let release!: () => void;
    const reading = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let peak = 0;
    const refresh = vi.fn(async () => {
      peak = Math.max(peak, ++active);
      await reading;
      active -= 1;
    });
    const stop = observeWriterTasks("book", vi.fn(), refresh, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    api.changes.push(task("second", "completed", 2));
    await vi.advanceTimersByTimeAsync(750);
    api.changes.push(task("third", "completed", 3));
    await vi.advanceTimersByTimeAsync(750);
    expect(refresh).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
    stop();
  });

  it("reports read failures and refreshes a retried task even if polling missed its running state", async () => {
    const api = host([task("retry")]);
    const error = new Error("Read failed");
    const refresh = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const onError = vi.fn();
    const stop = observeWriterTasks("book", vi.fn(), refresh, onError);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(error);
    api.changes.push(task("retry", "completed", 2, 2));
    await vi.advanceTimersByTimeAsync(750);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it("discards queued refreshes and late errors when leaving the book", async () => {
    const api = host([task("first")]);
    let reject!: (error: Error) => void;
    const refresh = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    const onError = vi.fn();
    const stop = observeWriterTasks("book", vi.fn(), refresh, onError);
    await vi.advanceTimersByTimeAsync(0);
    api.changes.push(task("second", "completed", 2));
    await vi.advanceTimersByTimeAsync(750);
    stop();
    reject(new Error("Late read failure"));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(api.events).toHaveBeenCalledTimes(2);
  });
});
