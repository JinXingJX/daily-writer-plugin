import { domainTask } from "../../worker/domainTask";
// Reviews a chapter against groups of the writing checklist and turns what fails into margin comments.
import { uniqueId } from "../../domain/ids";
import { arrayValue, asRecord, previewText, stringValue, unixTimestamp } from "../../domain/util";
import type { MemoryView } from "../../memory/view";
import type { StoryPlan } from "../../story/schema";
import type { WriterComment, WriterProject } from "../../types";
import { CHECKLIST, OPENING_ITEMS } from "../craft/checklist";
import { invokeJson } from "../client";
import { prepareWritingContext } from "../contextPrep";
import { resolvePrompt } from "../promptRegistry";

export type ChecklistVerdict = { item: string; status: "pass" | "fail" | "na"; quote: string; problem: string; suggestion: string };
export type ChecklistResult = { verdicts: ChecklistVerdict[]; comments: WriterComment[] };

export async function checklistReview(input: { project: WriterProject; memory: MemoryView | null; story: StoryPlan | null; chapterId: string; position: number; text: string; groups: string[]; signal?: AbortSignal }): Promise<ChecklistResult> {
  const task = domainTask<ChecklistResult>("checklistReview", [input], input.project.id, input.signal); if (task) return task;
  const { project, chapterId, position, text } = input;
  const groups = CHECKLIST.filter((group) => input.groups.includes(group.id));
  const items = [...groups.flatMap((group) => group.items.map((item) => `〔${group.title}〕${item}`)), ...(position < 3 ? OPENING_ITEMS.map((item) => `〔开篇〕${item}`) : [])];
  if (!items.length) throw new Error("没有选择检查项。");
  const context = await prepareWritingContext({ project, memory: input.memory, position, focus: previewText(text, 4_000), scope: "chapter", budget: Math.min(24_000, project.settings.contextBudgetChars), story: input.story });
  const verdicts = await invokeJson({
    task: "review",
    system: resolvePrompt(project, "checklist.system"),
    prompt: `${context.text}\n\n【待审章节】\n${text}\n\n【检查表（龙空创作方法论 × 现象级网文六维标准）】\n${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\n请逐条严格核验：做到的填 pass，本章不涉及的填 na，没做到的填 fail 并从【待审章节】中一字不差地复制 10-40 字病灶原文作为 quote，直指问题本质（problem）并给出可落地的改法（suggestion）。\n输出 JSON：{"verdicts":[{"item":"检查项原文","status":"pass|fail|na","quote":"没做到时逐字引用原文 10-40 字","problem":"","suggestion":""}]}`,
    effort: "medium", temperature: 0.2,
    maxOutputTokens: 4_000,
    signal: input.signal,
  }, (value) => arrayValue(asRecord(value).verdicts).map((item): ChecklistVerdict => {
    const verdict = asRecord(item);
    const status = verdict.status === "fail" || verdict.status === "na" ? verdict.status : "pass";
    return { item: stringValue(verdict.item), status, quote: stringValue(verdict.quote), problem: stringValue(verdict.problem), suggestion: stringValue(verdict.suggestion) };
  }));
  const comments = verdicts.filter((verdict) => verdict.status === "fail" && verdict.problem).map((verdict): WriterComment => {
    const start = verdict.quote ? text.indexOf(verdict.quote) : -1;
    return { id: uniqueId("comment"), doc: { kind: "chapter", id: chapterId }, quote: start >= 0 ? verdict.quote : "", start: Math.max(0, start), comment: `〔检查表〕${verdict.item.replace(/^〔[^〕]*〕/, "")}\n${verdict.problem}${verdict.suggestion ? `\n建议：${verdict.suggestion}` : ""}`, severity: "warning", author: "ai", resolved: false, createdAt: unixTimestamp() };
  });
  return { verdicts, comments };
}
