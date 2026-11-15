import { stripImageMarkup } from "../images/schema";
import { invokeJson } from "../ai/client";
import { asRecord, previewText } from "../domain/util";
import { normalizeCard } from "./store";
import { countMentions } from "./text";
import { CARD_VERSION, THREAD_KIND_LABELS, type ChapterCard, type MemoryEntity, type StoryThread } from "./schema";

const CHUNK_CHARS = 12_000;

export type ExtractInput = {
  chapterId: string;
  chapterLabel: string;
  title: string;
  text: string;
  sourceHash: string;
  previousSummary: string;
  entities: MemoryEntity[];
  openThreads: StoryThread[];
  /** Hidden truths tracked in the story plan, so learned knowledge can be linked to them. */
  secrets?: { id: string; title: string }[];
  signal?: AbortSignal;
};

export const EXTRACTION_SYSTEM = `你是一位严谨的现象级长篇连载资料总编与记忆官，负责为作者建立精密的“故事记忆与认知账本”。
你只根据给定章节原文抽取事实，绝不凭空臆测，严禁把读者/作者上帝视角已知但角色未知的隐秘混淆为角色已知。
人名、地名、功法/器物、规矩等专有名词必须与原文一字不差；已知实体请严格沿用名单中的标准名称。
只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。`;

const SCHEMA = `{
  "summary": "本章剧情摘要，150-300字，交代起因、经过、结果与人物关键选择",
  "scenes": [{ "title": "场景名", "time": "故事内时间（原文可推断才写）", "location": "地点", "characters": ["出场人物"], "summary": "一两句场景内容" }],
  "characters": [{ "name": "人物标准名", "change": "本章中该人物的状态/关系/认知变化，无变化则省略该人物" }],
  "entities": [{ "name": "专有名词", "category": "character|location|faction|item|skill|term|other", "aliases": ["本章出现的别称"], "description": "一句话说明（仅限新出现或有新信息的实体）" }],
  "facts": [{ "subject": "实体标准名", "attribute": "属性，如 位置/伤势/境界/身份/持有物/知晓秘密/与某人关系/生死/年龄/外貌", "value": "取值", "kind": "state(会随剧情改变)|trait(固定特征)|event(发生的事)|rule(世界规则)", "quote": "原文依据，20字以内" }],
  "threads": [{ "threadId": "推进或回收已有线索时填写其 id，新埋设填 null", "type": "plant|advance|payoff", "kind": "foreshadow|expectation|mystery", "tier": "chapter|short|arc|volume|ultimate", "title": "线索短标题", "description": "内容与本章变化" }],
  "hook": "章末留下的悬念或钩子",
  "emotionBeats": [{ "type": "rise|fall|suppress|release", "reason": "读者情绪为什么在这里升、落、被压住或释放" }],
  "payoffs": [{ "type": "打脸|智取|守护|认可|揭穿|收获|反转|突破|其他（2-4字）", "description": "兑现了什么、靠什么" }],
  "changes": ["info|relation|resource|risk|judgment"],
  "knowledge": [{ "who": "人物标准名", "learns": "得知了什么", "source": "怎么知道的（亲见/听谁说/推断/读到…）", "secretId": "对应已知暗线时填其 id，否则 null" }],
  "intimacy": [{ "a": "人物", "b": "人物", "delta": "亲近程度变化，-3 到 3 的整数", "event": "因为哪件事" }],
  "newCast": ["本章第一次登场的人物"]
}`;

export async function extractChapterCard(raw: ExtractInput): Promise<ChapterCard> {
  const input = { ...raw, text: stripImageMarkup(raw.text) };
  const chunks = splitChunks(input.text, CHUNK_CHARS);
  const partials: ChapterCard[] = [];
  for (const [index, chunk] of chunks.entries()) {
    partials.push(await invokeJson({
      task: "memory",
      system: EXTRACTION_SYSTEM,
      prompt: extractionPrompt(input, chunk, chunks.length > 1 ? `（本章较长，这是第 ${index + 1}/${chunks.length} 段）` : ""),
      effort: "low", temperature: 0.1,
      maxOutputTokens: 6_000,
      signal: input.signal,
    }, (value) => {
      const card = normalizeCard({ ...asRecord(value), chapterId: input.chapterId });
      if (!card) throw new Error("Invalid chapter card.");
      return card;
    }));
  }
  const merged = mergePartials(input.chapterId, partials);
  const names = new Set<string>();
  for (const entity of input.entities) { names.add(entity.name); for (const alias of entity.aliases) names.add(alias); }
  for (const entity of merged.entities) { names.add(entity.name); for (const alias of entity.aliases) names.add(alias); }
  for (const character of merged.characters) names.add(character.name);
  return { ...merged, sourceHash: input.sourceHash, version: CARD_VERSION, mentions: countMentions(input.text, names), extractedAt: Math.floor(Date.now() / 1000) };
}

function extractionPrompt(input: ExtractInput, text: string, chunkNote: string) {
  const known = relevantEntities(input.entities, text, 300).map((entity) => `${entity.name}${entity.aliases.length ? `（又名：${entity.aliases.slice(0, 6).join("、")}）` : ""}[${entity.category}]`).join("；");
  const threads = input.openThreads.slice(-60).map((thread) => `- ${thread.id}［${THREAD_KIND_LABELS[thread.kind]}］：${thread.title}——${previewText(thread.description, 60)}`).join("\n");
  const secrets = (input.secrets ?? []).slice(0, 60).map((secret) => `- ${secret.id}：${secret.title}`).join("\n");
  return [
    `【任务】为 ${input.chapterLabel}「${input.title}」抽取故事记忆。${chunkNote}`,
    `【上一章摘要】${input.previousSummary || "（无）"}`,
    `【已知实体（请沿用标准名）】${known || "（暂无）"}`,
    `【未回收的线索】\n${threads || "（暂无）"}`,
    ...(secrets ? [`【作者设定的暗线（人物得知时挂接其 id）】\n${secrets}`] : []),
    `【输出 JSON 格式】\n${SCHEMA}`,
    `【要求】
- facts：只记录对后续连载有硬约束力的事实（人物生死伤势、位置、筹码/货币账目变动、金手指使用代价与边界、世界硬规则、制度契约），每条必须有 20 字以内原文依据，不记琐碎过渡动作。
- threads：只记录具有持续张力的真正线索，严格区分：
  * foreshadow：新埋下的草蛇灰线、日后会引爆的闲笔器物或伏笔话语；
  * expectation：读者已经在急迫等着看的预期事件（约战、考核、兑现底牌、打脸清算、危机倒计时）；
  * mystery：尚未揭晓的悬念或谜团。tier 评估预计在几章或本卷兑现。
- emotionBeats：按场次顺序记录读者的核心情绪起伏；suppress 专用于“情绪与反击冲动快要爆发时，因现实算计、制度成本或蓄力谋划而不得不强行忍住/压住”。
- payoffs：只记录本章真正干净利落兑现爽点或揭晓谜团的时刻，没有则留空。
- changes：记录本章结束时局势相比开始时发生的不可逆位移（info 信息、relation 关系、resource 资源、risk 风险、judgment 人物判断）。
- knowledge：严格记录人物通过何种可信渠道得知了什么，人物绝不可能获知的上帝视角信息严禁计入。
- intimacy：只记录有实打实事件支撑的内心亲疏度变化。`,
    `【章节原文】\n${text}`,
  ].join("\n\n");
}

/** Entities mentioned in the text first, then the rest, capped. */
function relevantEntities(entities: MemoryEntity[], text: string, limit: number) {
  const mentioned: MemoryEntity[] = [];
  const others: MemoryEntity[] = [];
  for (const entity of entities) ([entity.name, ...entity.aliases].some((name) => name.length >= 2 && text.includes(name)) ? mentioned : others).push(entity);
  return [...mentioned, ...others.filter((entity) => entity.category === "character")].slice(0, limit);
}

export function splitChunks(text: string, size: number): string[] {
  if (text.length <= size * 1.2) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const breakAt = text.lastIndexOf("\n", end);
      if (breakAt > start + size / 2) end = breakAt + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function mergePartials(chapterId: string, partials: ChapterCard[]): ChapterCard {
  if (partials.length === 1) return partials[0];
  const characters = new Map<string, string>();
  for (const partial of partials) for (const character of partial.characters) characters.set(character.name, [characters.get(character.name), character.change].filter(Boolean).join("；"));
  const entities = new Map<string, ChapterCard["entities"][number]>();
  for (const partial of partials) for (const entity of partial.entities) entities.set(entity.name, entities.has(entity.name) ? { ...entity, aliases: [...new Set([...(entities.get(entity.name)?.aliases ?? []), ...entity.aliases])] } : entity);
  return {
    chapterId,
    sourceHash: "",
    version: CARD_VERSION,
    summary: partials.map((partial) => partial.summary).join(""),
    scenes: partials.flatMap((partial) => partial.scenes),
    characters: [...characters].map(([name, change]) => ({ name, change })),
    entities: [...entities.values()],
    facts: partials.flatMap((partial) => partial.facts),
    threads: partials.flatMap((partial) => partial.threads),
    hook: partials[partials.length - 1].hook,
    emotionBeats: partials.flatMap((partial) => partial.emotionBeats),
    payoffs: partials.flatMap((partial) => partial.payoffs),
    changes: [...new Set(partials.flatMap((partial) => partial.changes))],
    knowledge: partials.flatMap((partial) => partial.knowledge),
    intimacy: partials.flatMap((partial) => partial.intimacy),
    newCast: [...new Set(partials.flatMap((partial) => partial.newCast))],
    mentions: {},
    extractedAt: 0,
  };
}
