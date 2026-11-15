import { domainTask } from "../worker/domainTask";
// Fast single-call actions used directly from the editor (selection rewrites, continuation, summaries).
import { previewText, tailText, arrayValue, asRecord, stringValue } from "../domain/util";
import type { MemoryView } from "../memory/view";
import type { ChapterTexts, QuickActionConfig, WriterProject } from "../types";
import { invokeJson, invokeText } from "./client";
import { resolvePrompt } from "./promptRegistry";
import { writerSystem } from "./prompts";
import { prepareWritingContext } from "./contextPrep";
import { cleanProse } from "./prose";

export type QuickAction = QuickActionConfig;

export type RewriteInput = {
  project: WriterProject;
  memory: MemoryView | null;
  texts: ChapterTexts;
  position: number;
  docText: string;
  start: number;
  end: number;
  instruction: string;
  candidates: number;
  signal?: AbortSignal;
};

/** Returns alternative rewrites of the selected range. */
export async function rewriteSelection(input: RewriteInput): Promise<string[]> {
  const task = domainTask<string[]>("rewriteSelection", [input], input.project.id, input.signal); if (task) return task;
  const selected = input.docText.slice(input.start, input.end);
  const before = tailText(input.docText.slice(0, input.start), 1_500);
  const after = previewText(input.docText.slice(input.end), 600);
  const context = await prepareWritingContext({ project: input.project, memory: input.memory, position: input.position, focus: `${before}${selected}${after}`, texts: input.texts, scope: "local", budget: Math.min(24_000, input.project.settings.contextBudgetChars) });
  const count = Math.max(1, Math.min(4, input.candidates));
  return invokeJson({
    task: "prose",
    system: await writerSystem(input.project),
    prompt: `${context.text}\n\n【前文】\n${before}\n\n【需要改写的段落】\n${selected}\n\n【后文】\n${after}\n\n【任务】${resolvePrompt(input.project, "task.rewrite", { instruction: input.instruction, count })}\n只输出 JSON：{"candidates":["版本1", ...]}`,
    effort: "medium", temperature: 0.85,
    maxOutputTokens: Math.min(12_000, 800 + selected.length * 3 * count),
    signal: input.signal,
  }, (value) => {
    const candidates = arrayValue(asRecord(value).candidates).map(stringValue).map((item) => item.trim()).filter(Boolean);
    if (!candidates.length) throw new Error("模型没有给出改写结果。");
    return candidates.slice(0, count);
  });
}

export type ContinueInput = { project: WriterProject; memory: MemoryView | null; texts: ChapterTexts; position: number; docText: string; cursor: number; hint?: string; length?: number; signal?: AbortSignal };

/** Continues writing at the cursor; returns only the new text. */
export async function continueWriting(input: ContinueInput): Promise<string> {
  const task = domainTask<string>("continueWriting", [input], input.project.id, input.signal); if (task) return task;
  const before = input.docText.slice(0, input.cursor);
  const after = previewText(input.docText.slice(input.cursor), 500);
  const context = await prepareWritingContext({ project: input.project, memory: input.memory, position: input.position, focus: tailText(before, 3_000), texts: input.texts, scope: "chapter", budget: Math.min(40_000, input.project.settings.contextBudgetChars) });
  const length = input.length ?? 300;
  const text = await invokeText({
    task: "prose",
    system: await writerSystem(input.project),
    prompt: `${context.text}\n\n【本章已写内容（光标前）】\n${tailText(before, 6_000)}\n\n${after.trim() ? `【光标后已有内容】\n${after}\n\n` : ""}【任务】${resolvePrompt(input.project, "task.continue", { length, hint: input.hint ? `，方向：${input.hint}` : "" })}`,
    effort: "medium", temperature: 0.9,
    maxOutputTokens: Math.max(600, length * 3),
    signal: input.signal,
  });
  return cleanProse(text);
}

export async function summarizeChapter(project: WriterProject, title: string, text: string, signal?: AbortSignal): Promise<string> {
  const task = domainTask<string>("summarizeChapter", [project, title, text], project.id, signal); if (task) return task;
  const summary = await invokeText({ task: "prose", system: resolvePrompt(project, "writer.role"), prompt: `${resolvePrompt(project, "task.summary", { chapterTitle: title })}\n\n${previewText(text, 60_000)}`, effort: "low", temperature: 0.3, maxOutputTokens: 800, signal });
  return cleanProse(summary);
}

export { cleanProse } from "./prose";
