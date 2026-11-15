import type { TaskContext, TaskOutcome } from "@daily/plugin-sdk";
import { rewriteSelection, continueWriting, summarizeChapter } from "../ai/quick";
import { inspire } from "../ai/pipelines/inspire";
import { generateAtlasDraft } from "../ai/pipelines/atlas";
import { batchRewrite } from "../ai/pipelines/batchEdit";
import { diagnoseBlock } from "../ai/pipelines/blockDoctor";
import { checklistReview } from "../ai/pipelines/checklistReview";
import { generateBriefing, simulateReaders, digestReaders } from "../ai/pipelines/notebook";
import { draftImagePrompt } from "../images/prompt";
import { bindTaskContext } from "./taskClient";
import { decodeTaskArgs } from "./domainTask";
import { appendProposal } from "../storage/proposalStore";
import type { WriterProposal } from "../types";
import { updateNotebook } from "../notes/store";
import type { AuthorBriefing, ReaderSnapshot, ReaderDigest } from "../notes/schema";
import { mutateProject } from "../storage/projectStore";
import { diagnoseTone, reviseTone, saveToneReport, type ToneReport } from "../tone/pipeline";
import type { ChecklistResult } from "../ai/pipelines/checklistReview";

const functions = { rewriteSelection, continueWriting, summarizeChapter, inspire, generateAtlasDraft, batchRewrite, diagnoseBlock, checklistReview, generateBriefing, simulateReaders, digestReaders, draftImagePrompt, diagnoseTone, reviseTone };
export const domainTaskNames = Object.keys(functions);

export async function domainHandler(context: TaskContext): Promise<TaskOutcome> {
  bindTaskContext(context);
  const input = context.input as { name: keyof typeof functions; args: unknown[] };
  const fn = functions[input.name];
  if (!fn) throw new Error("Unknown Writer task.");
  const saved = context.checkpoint as { stage?: string; result?: unknown } | null;
  const args = await decodeTaskArgs(input.args, context);
  // Positional APIs use their final parameter for cancellation.
  if (input.name === "summarizeChapter") args[3] = context.signal;
  if (input.name === "batchRewrite") args[4] = context.signal;
  if (input.name === "draftImagePrompt") args[4] = context.signal;
  if (input.name === "diagnoseTone") args[3] = context.signal;
  if (input.name === "reviseTone") args[4] = context.signal;
  const result = saved?.stage === "finalize" ? saved.result : await (fn as (...args: unknown[]) => Promise<unknown>)(...args);
  if (saved?.stage !== "finalize") await context.update({ checkpoint: { stage: "finalize", result } });
  if (result && typeof result === "object" && "changes" in result && "status" in result) {
    await appendProposal(context.task.scope, result as WriterProposal);
  }
  if (input.name === "checklistReview") await mutateProject(context.task.scope, (project) => {
    const existing = new Set(project.comments.map((comment) => comment.id));
    project.comments.push(...(result as ChecklistResult).comments.filter((comment) => !existing.has(comment.id)));
  });
  if (input.name === "generateBriefing") await updateNotebook(context.task.scope, (notebook) => { notebook.briefing = result as AuthorBriefing; });
  if (input.name === "simulateReaders") await updateNotebook(context.task.scope, (notebook) => { const value = result as ReaderSnapshot; notebook.readers[value.chapterId] = value; });
  if (input.name === "digestReaders") await updateNotebook(context.task.scope, (notebook) => {
    const request = args[0] as { chapterId: string; voices: unknown };
    const current = notebook.readers[request.chapterId];
    if (current && JSON.stringify(current.voices) === JSON.stringify(request.voices)) current.digest = result as ReaderDigest;
  });
  if (input.name === "diagnoseTone") await saveToneReport(result as ToneReport);
  if (input.name === "reviseTone") await appendProposal(context.task.scope, (result as { proposal: WriterProposal }).proposal);
  return { status: "completed", result };
}
