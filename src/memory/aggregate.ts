// Map-reduce summaries: chapter cards -> arcs -> volumes -> book outline, plus worldview sections and entity profiles.
import { invokeJson, invokeText } from "../ai/client";
import { chapterLabel, orderedChapters, sortedVolumes } from "../domain/documents";
import { contentHash } from "../domain/ids";
import { arrayValue, asRecord, stringValue } from "../domain/util";
import type { WriterProject } from "../types";
import type { ArcSummary, BookSummary, ChapterCard, MemoryEntity, VolumeSummary, WorldSection, WorldviewSummary } from "./schema";
import type { MemoryView } from "./view";

export const ARC_SIZE = 15;
const REDUCE_BUDGET = 45_000;
const SECTION_BUDGET = 40_000;

const SUMMARIZER_SYSTEM = `你是精通百万字现象级长篇网文架构与连载追踪的总编，擅长从海量章节记忆中抽丝剥茧，提炼出因果咬合紧密、三层世界清晰、人物弧光立体的宏观大纲与设定集。
只使用给定材料中的硬事实，绝不凭空编造；人名、地名、器物、境界等专有名词保留原文原貌；严密用“第N章”标注出处。`;

export type ArcPlan = { id: string; volumeId: string; index: number; chapterIds: string[]; inputHash: string };

export function planArcs(project: WriterProject, cards: Map<string, ChapterCard>): ArcPlan[] {
  const plans: ArcPlan[] = [];
  const chapters = orderedChapters(project);
  for (const volume of sortedVolumes(project)) {
    const inVolume = chapters.filter((chapter) => chapter.volumeId === volume.id && cards.has(chapter.id));
    for (let start = 0, index = 0; start < inVolume.length; start += ARC_SIZE, index += 1) {
      const chapterIds = inVolume.slice(start, start + ARC_SIZE).map((chapter) => chapter.id);
      plans.push({ id: `arc-${volume.id}-${index}`, volumeId: volume.id, index, chapterIds, inputHash: contentHash(chapterIds.map((id) => `${id}:${cards.get(id)?.sourceHash}`).join("|")) });
    }
  }
  return plans;
}

export async function buildArc(view: MemoryView, plan: ArcPlan, signal?: AbortSignal): Promise<ArcSummary> {
  const material = plan.chapterIds.map((id) => {
    const card = view.cards.get(id);
    const chapter = view.project.chapters.find((item) => item.id === id);
    return `${chapterLabel(view.position(id))}「${chapter?.title ?? ""}」：${card?.summary ?? ""}${card?.hook ? `（钩子：${card.hook}）` : ""}`;
  }).join("\n");
  return invokeJson({
    task: "memory",
    system: SUMMARIZER_SYSTEM,
    prompt: `把下面连续章节归纳为一个情节弧。输出 JSON：{"title":"弧标题(10字内)","summary":"300-600字，按因果顺序讲清这段剧情","conflicts":"主要冲突与对立","growth":"主要人物的成长/关系变化"}\n\n${material}`,
    effort: "low", temperature: 0.2,
    maxOutputTokens: 2_000,
    signal,
  }, (value) => {
    const record = asRecord(value);
    return { id: plan.id, volumeId: plan.volumeId, index: plan.index, chapterIds: plan.chapterIds, inputHash: plan.inputHash, title: stringValue(record.title) || `情节弧 ${plan.index + 1}`, summary: stringValue(record.summary), conflicts: stringValue(record.conflicts), growth: stringValue(record.growth), generatedAt: Date.now() };
  });
}

/** Recursively condenses long material so every model call stays within budget. */
export async function reduceTexts(items: string[], combine: (material: string, partial: boolean) => Promise<string>, budget = REDUCE_BUDGET): Promise<string> {
  const joined = items.join("\n\n");
  if (joined.length <= budget || items.length <= 1) return combine(joined.slice(0, budget * 1.5), false);
  const batches: string[][] = [[]];
  let size = 0;
  for (const item of items) {
    if (size + item.length > budget && batches[batches.length - 1].length) { batches.push([]); size = 0; }
    batches[batches.length - 1].push(item);
    size += item.length + 2;
  }
  const partials: string[] = [];
  for (const batch of batches) partials.push(await combine(batch.join("\n\n"), true));
  return reduceTexts(partials, combine, budget);
}

export function volumeInputHash(arcs: ArcSummary[]) { return contentHash(arcs.map((arc) => `${arc.id}:${arc.inputHash}`).join("|")); }

export async function buildVolume(view: MemoryView, volumeId: string, arcs: ArcSummary[], signal?: AbortSignal): Promise<VolumeSummary> {
  const volume = view.project.volumes.find((item) => item.id === volumeId);
  const items = arcs.map((arc) => `【${arc.title}】（${arc.chapterIds.length ? `${chapterLabel(view.position(arc.chapterIds[0]))}-${chapterLabel(view.position(arc.chapterIds[arc.chapterIds.length - 1]))}` : ""}）\n${arc.summary}\n冲突：${arc.conflicts}\n成长：${arc.growth}`);
  let mainline = "";
  let sublines = "";
  const summary = await reduceTexts(items, async (material, partial) => {
    if (partial) return invokeText({ task: "memory", system: SUMMARIZER_SYSTEM, prompt: `把以下情节弧压缩为一段 800 字以内的连续剧情概述，保留关键转折与出处：\n\n${material}`, effort: "low", temperature: 0.2, maxOutputTokens: 2_000, signal });
    return invokeJson({
      task: "memory",
      system: SUMMARIZER_SYSTEM,
      prompt: `为分卷「${volume?.title ?? ""}」写卷大纲。输出 JSON：{"summary":"600-1200字卷大纲，按阶段分段","mainline":"本卷主线一句话","sublines":"支线列表，每条一行"}\n\n${material}`,
      effort: "low", temperature: 0.2,
      maxOutputTokens: 3_000,
      signal,
    }, (value) => { const record = asRecord(value); mainline = stringValue(record.mainline); sublines = stringValue(record.sublines); return stringValue(record.summary); });
  });
  return { volumeId, inputHash: volumeInputHash(arcs), summary, mainline, sublines, generatedAt: Date.now() };
}

export function bookInputHash(volumes: VolumeSummary[]) { return contentHash(volumes.map((volume) => `${volume.volumeId}:${volume.inputHash}`).join("|")); }

export async function buildBook(view: MemoryView, volumes: VolumeSummary[], signal?: AbortSignal): Promise<BookSummary> {
  const order = new Map(sortedVolumes(view.project).map((volume, index) => [volume.id, index]));
  const sorted = [...volumes].sort((left, right) => (order.get(left.volumeId) ?? 0) - (order.get(right.volumeId) ?? 0));
  const items = sorted.map((volume) => `## ${view.project.volumes.find((item) => item.id === volume.volumeId)?.title ?? "卷"}\n主线：${volume.mainline}\n${volume.summary}`);
  let mainline = "";
  let characterArcs = "";
  const outline = await reduceTexts(items, async (material, partial) => {
    if (partial) return invokeText({ task: "memory", system: SUMMARIZER_SYSTEM, prompt: `把以下分卷大纲压缩为 1000 字以内的连续概述，保留每卷标题与关键转折：\n\n${material}`, effort: "low", temperature: 0.2, maxOutputTokens: 2_500, signal });
    return invokeJson({
      task: "memory",
      system: SUMMARIZER_SYSTEM,
      prompt: `根据分卷大纲写全书大纲。输出 JSON：{"outline":"Markdown 格式：先一段全书梗概，再按卷列出要点（## 卷名 + 列表）","mainline":"全书主线与核心矛盾","characterArcs":"主要人物的完整弧光，每人一行"}\n\n${material}`,
      effort: "low", temperature: 0.2,
      maxOutputTokens: 5_000,
      signal,
    }, (value) => { const record = asRecord(value); mainline = stringValue(record.mainline); characterArcs = stringValue(record.characterArcs); return stringValue(record.outline); });
  });
  return { inputHash: bookInputHash(volumes), outline, mainline, characterArcs, generatedAt: Date.now() };
}

export function worldviewInputHash(view: MemoryView) {
  return contentHash([...view.cards.values()].map((card) => card.sourceHash).sort().join("|") + view.entities.length);
}

type SectionPlan = { key: string; title: string; instruction: string; lines: string[] };

/** Builds categorized worldview sections from entities and facts, every claim tagged with its source chapter. */
export async function buildWorldview(view: MemoryView, signal?: AbortSignal): Promise<WorldviewSummary> {
  const label = (chapterId: string) => chapterLabel(view.position(chapterId));
  const ranked = [...view.entities].sort((left, right) => view.mentionCount(right.id) - view.mentionCount(left.id));
  const entityLines = (category: MemoryEntity["category"][], limit: number) => ranked.filter((entity) => category.includes(entity.category)).slice(0, limit).map((entity) => {
    const facts = view.facts(entity.id).slice(-12).map((fact) => `${fact.attribute}=${fact.value}〔${label(fact.chapterId)}〕`).join("；");
    return `- ${entity.name}${entity.aliases.length ? `（${entity.aliases.slice(0, 4).join("、")}）` : ""}：${entity.summary}${facts ? ` | ${facts}` : ""}`;
  });
  const rules = new Map<string, string>();
  for (const card of view.cards.values()) for (const fact of card.facts) if (fact.kind === "rule" && !rules.has(fact.value)) rules.set(fact.value, `- ${fact.subject}：${fact.value}〔${label(card.chapterId)}〕`);
  const history = view.aggregates.arcs.map((arc) => `- ${arc.title}（${arc.chapterIds.length ? label(arc.chapterIds[0]) : ""}起）：${arc.summary.slice(0, 160)}`);
  const plans: SectionPlan[] = [
    { key: "rules", title: "力量体系与世界规则", instruction: "归纳世界的运行规则、力量/修炼/科技体系的等级与限制、代价", lines: [...rules.values(), ...entityLines(["skill"], 80)] },
    { key: "geography", title: "地理与场景", instruction: "归纳主要地域、城市、场景及其关系与特点", lines: entityLines(["location"], 120) },
    { key: "factions", title: "势力格局", instruction: "归纳各势力的立场、实力、核心人物、相互关系及变化", lines: entityLines(["faction"], 80) },
    { key: "characters", title: "主要人物", instruction: "为主要人物写一段档案：身份、性格、能力、关系、当前状态", lines: entityLines(["character"], 60) },
    { key: "items", title: "物品与专有名词", instruction: "归纳重要物品、术语的含义与作用", lines: entityLines(["item", "term", "other"], 120) },
    { key: "timeline", title: "历史与大事年表", instruction: "按时间顺序整理故事中的重大事件（含背景历史）", lines: history },
  ];
  const sections: WorldSection[] = [];
  for (const plan of plans) {
    if (!plan.lines.length) continue;
    let material = "";
    for (const line of plan.lines) { if (material.length + line.length > SECTION_BUDGET) break; material += `${line}\n`; }
    const content = await invokeText({
      task: "memory",
      system: SUMMARIZER_SYSTEM,
      prompt: `根据材料撰写设定集章节「${plan.title}」：${plan.instruction}。用 Markdown（小标题 + 要点），每条结论后用〔第N章〕标注出处；材料矛盾时并列写出并注明“存疑”。\n\n${material}`,
      effort: "medium", temperature: 0.2,
      maxOutputTokens: 4_000,
      signal,
    });
    sections.push({ key: plan.key, title: plan.title, content, sources: [] });
  }
  return { inputHash: worldviewInputHash(view), sections, generatedAt: Date.now() };
}

/** Generates dossiers for the most important extracted entities from their fact timelines. Returns id -> summary. */
export async function buildProfiles(view: MemoryView, limit = 40, signal?: AbortSignal): Promise<Map<string, string>> {
  const targets = [...view.entities].filter((entity) => entity.origin === "extracted").sort((left, right) => view.mentionCount(right.id) - view.mentionCount(left.id)).slice(0, limit);
  const profiles = new Map<string, string>();
  for (let start = 0; start < targets.length; start += 6) {
    const batch = targets.slice(start, start + 6);
    const material = batch.map((entity) => {
      const facts = view.facts(entity.id).slice(-40).map((fact) => `${chapterLabel(fact.position)}：${fact.attribute}=${fact.value}`).join("\n");
      return `### ${entity.name}（${entity.category}；别名：${entity.aliases.join("、") || "无"}）\n已知简介：${entity.summary}\n${facts}`;
    }).join("\n\n");
    await invokeJson({
      task: "memory",
      system: SUMMARIZER_SYSTEM,
      prompt: `为以下实体各写一段 80-200 字的档案（身份、特点、关键经历、最新状态）。输出 JSON：{"profiles":[{"name":"实体名","summary":"档案"}]}\n\n${material}`,
      effort: "low", temperature: 0.2,
      maxOutputTokens: 3_000,
      signal,
    }, (value) => {
      for (const item of arrayValue(asRecord(value).profiles)) {
        const record = asRecord(item);
        const entity = batch.find((candidate) => candidate.name === stringValue(record.name));
        if (entity && stringValue(record.summary)) profiles.set(entity.id, stringValue(record.summary));
      }
      return null;
    });
  }
  return profiles;
}

/** Asks the model which candidate pairs are the same entity. Returns pairs to merge as [keepId, dropId]. */
export async function judgeMerges(pairs: [MemoryEntity, MemoryEntity][], view: MemoryView, signal?: AbortSignal): Promise<[string, string][]> {
  if (!pairs.length) return [];
  const describe = (entity: MemoryEntity) => `${entity.name}（别名：${entity.aliases.slice(0, 5).join("、") || "无"}；${entity.summary.slice(0, 60)}；出现 ${view.mentionCount(entity.id)} 次）`;
  const list = pairs.map((pair, index) => `${index + 1}. A=${describe(pair[0])} | B=${describe(pair[1])}`).join("\n");
  return invokeJson({
    task: "memory",
    system: SUMMARIZER_SYSTEM,
    prompt: `判断每一对是否指同一个对象（例如昵称、简称、全名）。只有很确定时才判定为同一。输出 JSON：{"same":[编号,...]}\n\n${list}`,
    effort: "low", temperature: 0,
    maxOutputTokens: 800,
    signal,
  }, (value) => arrayValue(asRecord(value).same).flatMap((item) => {
    const pair = pairs[Number(item) - 1];
    if (!pair) return [];
    const [left, right] = pair;
    return [view.mentionCount(left.id) >= view.mentionCount(right.id) ? [left.id, right.id] as [string, string] : [right.id, left.id] as [string, string]];
  }));
}
