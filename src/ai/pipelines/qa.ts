// Question answering over the whole book: retrieval over memory, optional evidence from raw text, cited answers.
import { chapterLabel } from "../../domain/documents";
import { arrayValue, asRecord, finiteNumber, stringValue } from "../../domain/util";
import type { MemoryView } from "../../memory/view";
import { loadChapterText } from "../../storage/projectStore";
import { invokeJson } from "../client";
import { resolvePrompt } from "../promptRegistry";

export type QaAnswer = { answer: string; citations: string[] };

export async function answerQuestion(memory: MemoryView, question: string, signal?: AbortSignal): Promise<QaAnswer> {
  const label = (chapterId: string) => chapterLabel(memory.position(chapterId));
  const entities = memory.entitiesIn(question, 6);
  const parts: string[] = [];
  for (const entity of entities) {
    const facts = memory.facts(entity.id).map((fact) => `${label(fact.chapterId)}：${fact.attribute}=${fact.value}${fact.quote ? `（“${fact.quote}”）` : ""}`);
    parts.push(`## ${entity.name}${entity.aliases.length ? `（${entity.aliases.join("、")}）` : ""}\n${entity.summary}\n${facts.slice(-80).join("\n")}`);
  }
  const chapterIds = new Set<string>([...memory.searchCards(question, 12).map((hit) => hit.id), ...memory.relatedChapters(entities.map((entity) => entity.id), Number.POSITIVE_INFINITY, 8)]);
  const cards = [...chapterIds].sort((left, right) => memory.position(left) - memory.position(right)).map((chapterId) => {
    const card = memory.cards.get(chapterId);
    return `${label(chapterId)}「${memory.project.chapters.find((chapter) => chapter.id === chapterId)?.title ?? ""}」：${card?.summary ?? ""}`;
  });
  const threads = memory.threads.filter((thread) => entities.some((entity) => thread.title.includes(entity.name) || thread.description.includes(entity.name)) || question.includes(thread.title)).slice(0, 10).map((thread) => `- ${thread.title}（${thread.status}）：${thread.description}；${thread.events.map((event) => `${label(event.chapterId)}${event.type}`).join("、")}`);

  // Evidence: original lines mentioning the asked entities in the top chapters.
  const evidence: string[] = [];
  const names = entities.flatMap((entity) => [entity.name, ...entity.aliases]).filter((name) => name.length >= 2);
  for (const chapterId of [...chapterIds].slice(0, 4)) {
    if (!names.length) break;
    const text = await loadChapterText(memory.project.id, chapterId);
    const lines = text.split("\n").filter((line) => names.some((name) => line.includes(name))).slice(0, 6).map((line) => line.slice(0, 200));
    if (lines.length) evidence.push(`${label(chapterId)}原文：\n${lines.join("\n")}`);
  }

  const outline = memory.aggregates.book?.outline ?? "";
  return invokeJson({
    task: "ideas",
    system: resolvePrompt(memory.project, "qa.system"),
    prompt: `【问题】${question}\n\n【全书大纲】\n${outline.slice(0, 6_000)}\n\n【相关实体与事实时间线】\n${parts.join("\n\n").slice(0, 30_000)}\n\n【相关章节摘要】\n${cards.join("\n").slice(0, 15_000)}\n\n【相关伏笔】\n${threads.join("\n")}\n\n【原文证据】\n${evidence.join("\n\n").slice(0, 8_000)}\n\n输出 JSON：{"answer":"回答（Markdown，事实后标注第N章）","citations":[章节序号数字]}`,
    effort: "medium", temperature: 0.1,
    maxOutputTokens: 2_000,
    signal,
  }, (value) => {
    const record = asRecord(value);
    const citations = arrayValue(record.citations).map((item) => Math.round(finiteNumber(typeof item === "string" ? Number(item.replace(/\D/g, "")) : item, 0)) - 1).filter((position) => position >= 0 && position < memory.orderedIds.length).map((position) => memory.orderedIds[position]);
    return { answer: stringValue(record.answer) || "资料中没有找到答案。", citations: [...new Set(citations)] };
  });
}
