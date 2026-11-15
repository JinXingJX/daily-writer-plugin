// Turns raw setting material (a pasted "设定总稿", notes, a pitch) into structured documents and bible entries,
// delivered as one reviewable proposal.
import { uniqueId } from "../../domain/ids";
import { normalizeCharacter, normalizeCharacterRelation, normalizeFaction } from "../../domain/normalize";
import { describeOperation } from "../../domain/operations";
import { arrayValue, asRecord, stringArray, stringValue } from "../../domain/util";
import type { ProposalChange, WriterPatchOperation, WriterProject, WriterProposal } from "../../types";
import { invokeJson, invokeText } from "../client";
import { withGoal } from "../prompts";
import { splitChunks } from "../../memory/extract";

const SINGLE_PASS_CHARS = 50_000;

const JSON_ONLY = "只输出要求的 JSON，不要 Markdown 代码块。";

import { normalizePower, normalizePromise, normalizeSecret, storyOperationLabel, type StoryOperation } from "../../story/schema";

export type OrganizeProgress = (message: string) => void;

export async function organizeSettings(project: WriterProject, material: string, instruction: string, onProgress?: OrganizeProgress, signal?: AbortSignal): Promise<WriterProposal> {
  const architect = withGoal(project, "architect.system");
  const ARCHITECT_SYSTEM = `${architect}\n${JSON_ONLY}`;
  let source = material.trim();
  if (source.length > SINGLE_PASS_CHARS) {
    const chunks = splitChunks(source, 30_000);
    const notes: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      onProgress?.(`梳理材料 ${index + 1}/${chunks.length}`);
      notes.push(await invokeText({ task: "memory", system: architect, prompt: `把下面这部分设定材料整理成清楚的要点。按“世界观/背景/剧情/人物/势力/风格/其他”分组输出 Markdown，保留人名、名词、规则、代价、因果和原文关键说法；互相矛盾或还没定下来的地方照实记下，不替作者下结论：\n\n${chunk}`, temperature: 0.2, maxOutputTokens: 8_000, signal }));
    }
    source = notes.join("\n\n");
  }
  const existing = [
    project.worldview && `【已有世界观】\n${project.worldview.slice(0, 6_000)}`,
    project.background && `【已有背景】\n${project.background.slice(0, 4_000)}`,
    project.outline && `【已有大纲】\n${project.outline.slice(0, 6_000)}`,
    project.characters.length && `【已有人物】${project.characters.map((character) => character.name).join("、")}`,
  ].filter(Boolean).join("\n\n");
  const base = `【作者要求】${instruction || "整理这些设定，说清它们之间的关系，给出更适合这本书的安排"}\n\n${existing ? `${existing}\n\n` : ""}【设定材料】\n${source}`;

  // Smaller parallel calls finish much sooner than one huge call and fail independently.
  const sections = [
    { key: "architecture", label: "设定总览与大纲", run: () => invokeJson({ task: "memory", system: ARCHITECT_SYSTEM, prompt: `${base}\n\n【任务】整理设定和全书大纲。用平常的话说明改了什么、为什么，保留原材料中的事实和因果；有分歧就留给作者决定。输出 JSON：{"architecture":"Markdown：设定总览，按层列出每部分管什么、彼此怎样影响；这本书新在哪里、哪里像常见套路、可以怎样改，以及调整的理由","outline":"Markdown：一句话卖点、想让读者感到什么、主线和暗线怎样接起来；每卷从哪到哪、靠什么事反复推进、哪一步回不了头、高潮怎样兑现、结局往哪走","openQuestions":["仍需作者决定的问题"]}`, effort: "medium", temperature: 0.4, maxOutputTokens: 6_000, signal }, asRecord) },
    { key: "worldview", label: "世界观", run: () => invokeText({ task: "memory", system: `${architect}\n直接输出 Markdown 正文。`, prompt: `${base}\n\n【任务】写一份能直接查用的世界观设定。先说这世界最不一样的规则，再说明普通人怎样过日子、钱和物价怎样算、日常用什么东西、有哪些规矩；各势力争什么、资源怎么流动、能力怎样获得、有什么限制和代价；上层隐瞒了什么、过去发生了什么。最后列出重要地点和名词，并解释它们的关系。名词首次出现就说清是什么，不堆一串术语，不为补齐目录编造设定。`, effort: "medium", temperature: 0.4, maxOutputTokens: 7_000, signal }) },
    { key: "background", label: "背景与文风", run: () => invokeJson({ task: "memory", system: ARCHITECT_SYSTEM, prompt: `${base}\n\n【任务】输出 JSON：{"background":"Markdown：故事开始前发生了什么，怎样造成主角眼下的困境，冲突因何而起","styleGuide":"Markdown：先用一两句说清这本书讲故事的口气；再说明叙述者离人物多近、怎样称呼人和东西、句子怎样安排、对话怎样区分说话人，哪些写法会出戏。每条配一句本作的正文示例。读者要一遍跟得上谁在做什么、为什么；只删重复和空话，保留必要的主语和因果。描写多少由事情需要决定，不要求每场加器物、景物或感官描写，不照搬参考样章的内容"}`, effort: "medium", temperature: 0.4, maxOutputTokens: 4_000, signal }, asRecord) },
    { key: "story", label: "故事规划", run: () => invokeJson({ task: "memory", system: ARCHITECT_SYSTEM, prompt: `${base}\n\n【任务】整理这本书让读者期待什么、主角的能力与限制、尚未揭开的真相和第一卷的走向。材料里没有的字段留空，不硬编。输出 JSON：{"promise":{"oneLiner":"一句话说清主角凭什么、在什么处境里、能持续给读者什么体验","emotionalNeed":"读者追这本书想感到什么","advantage":"主角的优势从哪来、受什么限制","sceneTypes":["哪些场面能反复给读者这种体验"],"offPromise":["哪些写法会偏离这本书的卖点"],"opening":{"who":"主角是谁、什么处境让读者关心他","where":"开篇发生在哪里","asset":"主角手里有什么、有哪些限制","conflict":"眼前必须解决的麻烦","firstEvent":"什么事打破了原来的日子"}},"powers":[{"name":"能力名","trigger":"什么时候才能用或得到","reward":"能得到什么好处","rewardAnchor":"用什么让读者看出好处有多大","cost":"消耗什么、会有什么后患","cap":"最多能做到哪一步","cannotSolve":["哪些问题解决不了"],"payoffModes":["怎样用它赢下一场较量"],"amplifiedEmotion":"最能让读者感到什么","statusLadder":[{"level":"到了哪个阶段","newRivals":"会遇到什么新对手","newPressure":"会有什么新压力"}]}],"secrets":[{"title":"秘密标题","truth":"过去或幕后实际发生了什么","impacts":[{"tier":"upper|middle|lower|environment","interest":"牵动了谁的利益","misread":"他们误以为什么","action":"他们因此正在做什么"}],"revealPlan":"准备怎样逐步揭开"}],"firstVolume":{"endpoint":"第一卷走到哪里、哪一步之后回不去","reasons":["为什么必须进入下一阶段"],"coreLoop":["本卷反复推动故事的几步事"]}}`, effort: "medium", temperature: 0.3, maxOutputTokens: 6_000, signal }, asRecord) },
    { key: "cast", label: "人物与势力", run: () => invokeJson({ task: "memory", system: ARCHITECT_SYSTEM, prompt: `${base}\n\n【任务】整理人物、势力和关系。说清每个人对外什么样、心里想什么、知道和不知道什么；人物名分上的关系和实际的信任、利益分开说。输出 JSON：{"characters":[{"name":"人物名","aliases":["别名"],"role":"主角/反派/引路人/竞争者等","summary":"身份、让人记住的一点、表面和骨子里的差别、想要什么、打算怎样做、眼下不知道什么","arc":"以后可能怎样改变"}],"factions":[{"name":"势力名","summary":"替谁争利益、怎样运转、手里有什么人和资源","motivation":"想得到什么、准备什么时候行动"}],"relations":[{"source":"人物名","target":"人物名","relation":"名分上是什么关系、实际有哪些信任或利益牵扯"}]}`, effort: "medium", temperature: 0.3, maxOutputTokens: 6_000, signal }, asRecord) },
  ] as const;
  const state = new Map<string, string>(sections.map((section) => [section.key, "…"]));
  const report = () => onProgress?.(sections.map((section) => `${section.label} ${state.get(section.key)}`).join(" · "));
  report();
  const settled = await Promise.allSettled(sections.map(async (section) => {
    try { const value = await section.run(); state.set(section.key, "✓"); return value; }
    catch (error) { state.set(section.key, "✗"); throw error; }
    finally { report(); }
  }));
  const value = (index: number) => (settled[index].status === "fulfilled" ? (settled[index] as PromiseFulfilledResult<unknown>).value : null);
  const failed = sections.filter((_, index) => settled[index].status === "rejected").map((section) => section.label);
  if (failed.length === sections.length) throw (settled[0] as PromiseRejectedResult).reason;
  const architectureResult = asRecord(value(0));
  const backgroundResult = asRecord(value(2));
  const storyResult = asRecord(value(3));
  const result: Record<string, unknown> = { ...asRecord(value(4)), architecture: architectureResult.architecture, outline: architectureResult.outline, openQuestions: architectureResult.openQuestions, worldview: typeof value(1) === "string" ? value(1) : "", background: backgroundResult.background, styleGuide: backgroundResult.styleGuide };

  const changes: ProposalChange[] = [];
  const text = (doc: "worldview" | "background" | "outline" | "style", title: string, after: string, before: string) => {
    if (after.trim() && after.trim() !== before.trim()) changes.push({ id: uniqueId("change"), kind: "text", doc: { kind: doc }, title, summary: before.trim() ? "重构" : "新建", before, after: after.trim() });
  };
  const architecture = stringValue(result.architecture);
  text("worldview", "世界观", [architecture && `## 设定架构总览\n\n${architecture}`, stringValue(result.worldview)].filter(Boolean).join("\n\n"), project.worldview);
  text("background", "背景设定", stringValue(result.background), project.background);
  text("outline", "全书大纲", stringValue(result.outline), project.outline);
  text("style", "文风指南", stringValue(result.styleGuide), project.styleGuide);

  const entity = (operation: WriterPatchOperation) => changes.push({ id: uniqueId("change"), kind: "entity", label: describeOperation(operation), operation });
  const characterIds = new Map(project.characters.map((character) => [character.name, character.id]));
  for (const item of arrayValue(result.characters)) {
    const record = asRecord(item);
    const name = stringValue(record.name).trim();
    if (!name) continue;
    const existingCharacter = project.characters.find((character) => character.name === name);
    const id = existingCharacter?.id ?? uniqueId("character");
    characterIds.set(name, id);
    entity({ type: "upsertCharacter", character: normalizeCharacter({ ...existingCharacter, id, name, aliases: stringArray(record.aliases), role: stringValue(record.role), summary: stringValue(record.summary), arc: stringValue(record.arc) }) });
  }
  for (const item of arrayValue(result.factions)) {
    const record = asRecord(item);
    const name = stringValue(record.name).trim();
    if (!name) continue;
    const existingFaction = project.factions.find((faction) => faction.name === name);
    entity({ type: "upsertFaction", faction: normalizeFaction({ ...existingFaction, id: existingFaction?.id ?? uniqueId("faction"), name, summary: stringValue(record.summary), motivation: stringValue(record.motivation) }) });
  }
  for (const item of arrayValue(result.relations)) {
    const record = asRecord(item);
    const source = characterIds.get(stringValue(record.source).trim());
    const target = characterIds.get(stringValue(record.target).trim());
    if (source && target && source !== target) entity({ type: "upsertCharacterRelation", relation: normalizeCharacterRelation({ id: uniqueId("relation"), sourceCharacterId: source, targetCharacterId: target, relation: stringValue(record.relation) }) });
  }
  const story = (operation: StoryOperation) => changes.push({ id: uniqueId("change"), kind: "story", label: storyOperationLabel(operation), operation });
  const promise = normalizePromise(storyResult.promise);
  if (promise.oneLiner.trim()) story({ type: "setPromise", promise });
  for (const item of arrayValue(storyResult.powers)) { const power = normalizePower({ ...asRecord(item), id: uniqueId("power") }); if (asRecord(item).name) story({ type: "upsertPower", power }); }
  for (const item of arrayValue(storyResult.secrets)) { const secret = normalizeSecret({ ...asRecord(item), id: uniqueId("secret") }); if (secret.truth.trim()) story({ type: "upsertSecret", secret }); }
  const firstVolume = asRecord(storyResult.firstVolume);
  const volume = [...project.volumes].sort((left, right) => left.rank - right.rank)[0];
  if (volume && stringValue(firstVolume.endpoint).trim()) story({ type: "upsertVolumePlan", plan: { volumeId: volume.id, endpoint: stringValue(firstVolume.endpoint), threshold: { reasons: stringArray(firstVolume.reasons, 10), preparation: "", beyond: "" }, coreLoop: stringArray(firstVolume.coreLoop, 10), transition: { carriedRelations: [], carriedPromises: [], bridgeCharacters: [] } } });
  if (!changes.length) throw new Error("整理结果与现有设定相同，没有需要修改的内容。");

  const questions = stringArray(asRecord(result).openQuestions, 20);
  return {
    id: uniqueId("proposal"),
    title: "整理设定与大纲",
    instruction,
    summary: `已把设定稿整理为世界观、背景、大纲、文风指南，${changes.filter((change) => change.kind === "entity").length} 项人物/势力/关系设定，以及 ${changes.filter((change) => change.kind === "story").length} 项故事规划（卖点、能力、秘密、卷走向）。可逐项选择采用。`,
    previewMarkdown: [architecture && `### 架构总览\n\n${architecture}`, questions.length ? `### 待作者决定\n\n${questions.map((question) => `- ${question}`).join("\n")}` : ""].filter(Boolean).join("\n\n"),
    risks: failed.length ? [`以下部分生成失败，可再试一次：${failed.join("、")}`] : [],
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

/** Heuristic: a long message full of setting vocabulary and asking to organize/restructure. */
export function looksLikeSettingMaterial(text: string): boolean {
  if (text.length < 800) return false;
  const vocabulary = (text.match(/设定|世界观|势力|人物|主角|宗门|体系|大纲|背景|阵营|规则|修炼|境界/g) ?? []).length;
  return vocabulary >= 5 && /整理|重构|梳理|架构|抽丝剥茧|归纳|优化|完善|重新/.test(text.slice(-400));
}
