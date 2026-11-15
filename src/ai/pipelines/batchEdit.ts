import { domainTask } from "../../worker/domainTask";
// AI edits across many chapters, produced as one reviewable proposal with a change per chapter.
import { chapterLabel, chapterPositions } from "../../domain/documents";
import { locateUnique, replaceRange } from "../../domain/anchors";
import { uniqueId } from "../../domain/ids";
import { arrayValue, asRecord, stringValue } from "../../domain/util";
import { loadChapterText } from "../../storage/projectStore";
import type { ProposalChange, WriterProject, WriterProposal } from "../../types";
import { invokeJson } from "../client";
import { resolvePrompt } from "../promptRegistry";
import { writerSystem } from "../prompts";

export type BatchProgress = (done: number, total: number, title: string) => void;

export async function batchRewrite(project: WriterProject, chapterIds: string[], instruction: string, onProgress?: BatchProgress, signal?: AbortSignal): Promise<WriterProposal> {
  const task = domainTask<WriterProposal>("batchRewrite", [project, chapterIds, instruction, onProgress], project.id, signal); if (task) return task;
  const positions = chapterPositions(project);
  const changes: ProposalChange[] = [];
  const notes: string[] = [];
  const ordered = [...chapterIds].sort((left, right) => (positions.get(left) ?? 0) - (positions.get(right) ?? 0));
  for (const [index, chapterId] of ordered.entries()) {
    if (signal?.aborted) break;
    const chapter = project.chapters.find((item) => item.id === chapterId);
    if (!chapter) continue;
    onProgress?.(index, ordered.length, chapter.title);
    const before = await loadChapterText(project.id, chapterId);
    const edits = await invokeJson({
      task: "prose",
      system: await writerSystem(project),
      prompt: `【修改要求】${instruction}\n\n【章节】${chapterLabel(positions.get(chapterId) ?? 0)}「${chapter.title}」\n${before}\n\n【任务】${resolvePrompt(project, "task.batch")}\n输出 JSON：{"edits":[{"quote":"原文","replacement":"新文本"}]}`,
      effort: "medium", temperature: 0.4,
      maxOutputTokens: 6_000,
      signal,
    }, (value) => arrayValue(asRecord(value).edits).map((item) => ({ quote: stringValue(asRecord(item).quote), replacement: stringValue(asRecord(item).replacement) })).filter((edit) => edit.quote));
    let after = before;
    let failed = 0;
    for (const edit of edits) {
      const located = locateUnique(after, edit.quote);
      if (located.ok) after = replaceRange(after, located.range, edit.replacement);
      else failed += 1;
    }
    if (after !== before) changes.push({ id: uniqueId("change"), kind: "text", doc: { kind: "chapter", id: chapterId }, title: chapter.title, summary: `${edits.length - failed} 处修改`, before, after });
    if (failed) notes.push(`${chapter.title}：${failed} 处修改无法定位，已跳过`);
  }
  onProgress?.(ordered.length, ordered.length, "");
  return {
    id: uniqueId("proposal"),
    title: `批量修改 ${ordered.length} 章`,
    instruction,
    summary: `${changes.length} 章有修改。${instruction}`,
    previewMarkdown: notes.map((note) => `- ${note}`).join("\n"),
    risks: notes,
    changes,
    status: "pending",
    createdAt: Math.floor(Date.now() / 1000),
    appliedAt: null,
    appliedChangeIds: [],
    undo: null,
    conversationId: null,
    source: null,
  };
}
