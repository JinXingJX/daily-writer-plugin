import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskContext, TaskSnapshot } from "@daily/plugin-sdk";
import { createProject } from "../storage/projectStore";
import { MemoryView } from "../memory/view";
import { installFakeHost } from "../test/fakeHost";
import { bindTaskContext, taskRpc, toolTaskSignal, runWriterTask, cancelWriterTask } from "./taskClient";
import { domainTask, decodeTaskArgs } from "./domainTask";
import { domainHandler } from "./domainHandlers";
import { openProject } from "../storage/projectStore";

function context(): TaskContext {
  return { task: { id: "task-test" } as TaskSnapshot, input: null, checkpoint: null, resume: null, signal: new AbortController().signal, update: vi.fn(async () => undefined), call: vi.fn(async () => ({ text: "done" })) as TaskContext["call"] };
}

describe("Writer task handoff", () => {
  beforeEach(() => installFakeHost());

  it("serializes UI inputs and restores memory in the worker, without sending functions or signals", async () => {
    const host = installFakeHost();
    const project = await createProject({ title: "handoff" });
    const memory = await MemoryView.load(project);
    let wire: unknown;
    host.api.tasks = {
      submit: vi.fn(async (input) => { wire = input.input; return { id: "task-1" } as TaskSnapshot; }),
      get: vi.fn(async () => ({ status: "completed", result: ["result"] } as TaskSnapshot)),
    } as unknown as typeof host.api.tasks;
    const result = domainTask<string[]>("rewriteSelection", [{ project, memory, onProgress: () => undefined, signal: new AbortController().signal }], project.id);
    expect(await result).toEqual(["result"]);
    const input = wire as { args: unknown[] };
    expect(JSON.stringify(input)).not.toContain('"signal"');
    const args = await decodeTaskArgs(input.args, context());
    const decoded = args[0] as { memory: MemoryView; signal: AbortSignal; onProgress: () => void };
    expect(decoded.memory).toBeInstanceOf(MemoryView);
    expect(decoded.signal).toBeInstanceOf(AbortSignal);
    expect(decoded.onProgress).toBeTypeOf("function");
  });

  it("keeps operation keys stable when a later tool resumes without earlier tools", async () => {
    const original = context(); bindTaskContext(original);
    await taskRpc(toolTaskSignal(original.signal, "tool-first"), "image.generate", { prompt: "first" });
    await taskRpc(toolTaskSignal(original.signal, "tool-second"), "image.generate", { prompt: "second" });
    const restarted = context(); bindTaskContext(restarted);
    await taskRpc(toolTaskSignal(restarted.signal, "tool-second"), "image.generate", { prompt: "second" });
    expect(restarted.call).toHaveBeenCalledWith("tool-second:image.generate-0", "image.generate", { prompt: "second" });
    expect(original.call).toHaveBeenLastCalledWith("tool-second:image.generate-0", "image.generate", { prompt: "second" });
  });

  it("executes inside a task without resubmitting while another UI call still queues", async () => {
    const host = installFakeHost();
    const submit = vi.spyOn(host.api.tasks, "submit");
    const job = context();
    bindTaskContext(job);
    expect(domainTask("summarizeChapter", [], "book", job.signal)).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    host.api.tasks.get = vi.fn(async () => ({ status: "completed", result: "summary" } as TaskSnapshot));
    submit.mockResolvedValue({ id: "other-task" } as TaskSnapshot);
    expect(await domainTask("summarizeChapter", [], "book")).toBe("summary");
    expect(submit).toHaveBeenCalledOnce();
  });

  it("finalizes review comments without a page and can repeat finalization safely", async () => {
    const project = await createProject({ title: "review" });
    const job = context();
    job.task.scope = project.id;
    job.input = { name: "checklistReview", args: [{ project }] };
    const comment = { id: "comment-1", doc: { kind: "outline" }, quote: "原文", start: 0, comment: "建议", severity: "info", author: "ai", resolved: false, createdAt: 1 };
    job.checkpoint = { stage: "finalize", result: { comments: [comment], verdicts: [] } };
    await domainHandler(job);
    await domainHandler(job);
    expect((await openProject(project.id)).comments).toHaveLength(1);
    expect(job.call).not.toHaveBeenCalled();
  });

  it("separates observer teardown from an explicit Stop action", async () => {
    const host = installFakeHost();
    const controller = new AbortController();
    const cancel = vi.fn(async () => ({ status: "cancelled" } as TaskSnapshot));
    host.api.tasks = {
      submit: async () => ({ id: "task-1" } as TaskSnapshot),
      get: async () => { controller.abort(); return { status: "completed", result: "done" } as TaskSnapshot; },
      cancel,
    } as unknown as typeof host.api.tasks;
    await expect(runWriterTask("writer.test", "book", {}, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).not.toHaveBeenCalled();
    cancelWriterTask(controller.signal);
    expect(cancel).toHaveBeenCalledWith("task-1");
  });
});
