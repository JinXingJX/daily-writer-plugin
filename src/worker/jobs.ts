import { runTaskHandlers, type TaskContext, type TaskOutcome } from "@daily/plugin-sdk";
import { runAgent, resumeAgent, continueFromCheckpoint, type AgentInput, type AgentRunResult } from "../ai/agent";
import { answerQuestion } from "../ai/pipelines/qa";
import { organizeSettings } from "../ai/pipelines/organizeSettings";
import { appendMessages, updateEntry, stopSession } from "../ai/sessions";
import { chapterLabel } from "../domain/documents";
import { asRecord } from "../domain/util";
import { generateImages, type GenerateImageOptions } from "../images/generate";
import { MemoryView } from "../memory/view";
import { appendProposal } from "../storage/proposalStore";
import { mutateProject } from "../storage/projectStore";
import { rewriteSelection, type RewriteInput } from "../ai/quick";
import { inspire, type InspireRequest } from "../ai/pipelines/inspire";
import { bindTaskContext } from "./taskClient";
import { domainHandler, domainTaskNames } from "./domainHandlers";

export type AssistantTaskInput = Omit<AgentInput, "memory" | "signal"> & {
  mode: "agent" | "qa" | "organize";
  material?: string;
  runId?: string;
};

async function finalize(projectId: string, result: AgentRunResult) {
  if (result.status !== "completed") return;
  if (result.comments.length) await mutateProject(projectId, (project) => {
    const existing = new Set(project.comments.map((comment) => comment.id));
    project.comments.push(...result.comments.filter((comment) => !existing.has(comment.id)));
  });
  if (result.proposal) await appendProposal(projectId, result.proposal, result.supersedes ?? undefined);
  const reply = `${result.reply}${result.comments.length ? `\n\n已写下 ${result.comments.length} 条朱批，在页边。` : ""}${result.limitNotice ? `\n\n> ${result.limitNotice}` : ""}`;
  const meta = { kind: result.proposal ? "proposal" as const : "text" as const, proposalId: result.proposal?.id, displays: result.displays, conventions: result.conventions };
  if (result.entryId) await updateEntry(result.sessionId, result.entryId, { content: reply, meta });
  else await appendMessages(result.sessionId, [{ role: "assistant", content: reply, meta }]);
}

async function assistant(context: TaskContext): Promise<TaskOutcome> {
  bindTaskContext(context);
  const input = context.input as AssistantTaskInput;
  const saved = asRecord(context.checkpoint);
  if (saved.stage === "finalize") {
    const result = saved.result as AgentRunResult;
    await finalize(input.project.id, result);
    return { status: "completed", result };
  }
  const memory = await MemoryView.load(input.project);
  let lastProgress = 0;
  const events = (eventViews: unknown) => {
    if (Date.now() - lastProgress < 250) return;
    lastProgress = Date.now();
    const compact = Array.isArray(eventViews) ? eventViews.slice(-40).map((view) => ({ ...view, content: String(view.content ?? "").slice(-8_000) })) : [];
    void context.update({ progress: { sessionId: input.sessionId, eventViews: compact } }).catch(() => undefined);
  };
  const onCancel = () => { if (context.signal.reason?.name === "TaskCancelledError") void stopSession(input.sessionId).catch(() => undefined); };
  context.signal.addEventListener("abort", onCancel, { once: true });
  try {
    let result: AgentRunResult;
    if (input.mode === "qa" || input.mode === "organize") {
      // A recorded checkpoint prevents duplicate transcript messages after a worker restart.
      if (!saved.authorRecorded) {
        const entries = await appendMessages(input.sessionId, [
          { role: "user", content: input.instruction, meta: { kind: "text" }, idempotencyKey: `${context.task.id}:author` },
          { role: "assistant", content: "", meta: { kind: "status" }, idempotencyKey: `${context.task.id}:reply` },
        ]);
        await context.update({ checkpoint: { authorRecorded: true, entryId: entries[entries.length - 1].id } });
      }
      const checkpoint = asRecord(context.checkpoint);
      if (input.mode === "organize") {
        const proposal = await organizeSettings(input.project, input.material ?? input.instruction, "", (message) => events([{ id: "status", title: message }]), context.signal);
        // Use the task identity for repeatable finalization.
        proposal.id = `proposal-${context.task.id}`;
        result = { status: "completed", sessionId: input.sessionId, entryId: String(checkpoint.entryId), reply: "设定稿已整理完成，可以逐段审核并采用。", proposal, comments: [], displays: [], conventions: [], eventViews: [], supersedes: null };
      } else {
        if (memory.isEmpty) throw new Error("问全书需要先在“档案”里建立故事记忆。");
        const answer = await answerQuestion(memory, input.instruction, context.signal);
        const cites = answer.citations.map((id) => `[${chapterLabel(memory.position(id))}](#chapter:${id})`).join(" ");
        result = { status: "completed", sessionId: input.sessionId, entryId: String(checkpoint.entryId), reply: `${answer.answer}${cites ? `\n\n出处：${cites}` : ""}`, proposal: null, comments: [], displays: [], conventions: [], eventViews: [], supersedes: null };
      }
    } else if (saved.stage === "waiting" && context.resume != null) {
      const reply = asRecord(context.resume);
      result = await resumeAgent(String(saved.runId), reply.result, reply.ok !== false, events, memory, context.signal);
    } else if (saved.stage === "agent" || input.runId) {
      result = await continueFromCheckpoint(String(saved.runId ?? input.runId), events, memory, context.signal, input.sessionId);
    } else {
      result = await runAgent({ ...input, memory, signal: context.signal }, events);
    }
    if (result.status === "pending_interaction") {
      await context.update({ checkpoint: { stage: "waiting", runId: result.runId } });
      return { status: "waiting_input", result };
    }
    if (result.status === "paused") throw new Error("任务已停止，断点已保存。");
    await context.update({ checkpoint: { stage: "finalize", result } });
    await finalize(input.project.id, result);
    return { status: "completed", result };
  } finally { context.signal.removeEventListener("abort", onCancel); }
}

export function startWriterTasks() {
  return runTaskHandlers({
    "writer.domain": domainHandler,
    ...Object.fromEntries(domainTaskNames.map((name) => [`writer.${name}`, domainHandler])),
    "writer.assistant": assistant,
    "writer.images": async (context) => {
      bindTaskContext(context);
      const input = context.input as { projectId: string; options: GenerateImageOptions };
      return { status: "completed", result: await generateImages(input.projectId, { ...input.options, signal: context.signal }) };
    },
    "writer.rewrite": async (context) => {
      bindTaskContext(context);
      const input = context.input as Omit<RewriteInput, "memory" | "signal">;
      return { status: "completed", result: await rewriteSelection({ ...input, memory: await MemoryView.load(input.project), signal: context.signal }) };
    },
    "writer.inspire": async (context) => {
      bindTaskContext(context);
      const input = context.input as Omit<InspireRequest, "memory" | "signal">;
      return { status: "completed", result: await inspire({ ...input, memory: await MemoryView.load(input.project), signal: context.signal }) };
    },
  }, (error) => console.error("Writer task runtime", error));
}
