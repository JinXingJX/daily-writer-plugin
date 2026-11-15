// Budgeted context assembly: picks the most useful memory for a position in the book, within a character budget.
import { chapterLabel, orderedChapters } from "../domain/documents";
import { previewText, tailText } from "../domain/util";
import { EMOTION_BEAT_LABELS, THREAD_KIND_LABELS, THREAD_TIER_LABELS, type MemoryEntity } from "../memory/schema";
import type { MemoryView } from "../memory/view";
import { NOTE_KIND_LABELS, panelWants, type Notebook } from "../notes/schema";
import type { StoryPlan } from "../story/schema";
import { activeExpectations, emotionTrend, knowledgeLines, pendingSuppression, recentPayoffTypes, relevantThreads } from "../story/selectors";
import type { WriterProject } from "../types";
import { craftLabel } from "./craft";

export type ContextBlock = {
  id: string;
  title: string;
  content: string;
  /** Lower is more important; blocks are admitted in priority order and emitted in insertion order. */
  priority: number;
  /** Allows truncation to fit; "head" keeps the start, "tail" keeps the end. */
  trim?: "head" | "tail";
  minChars?: number;
  /** Hard cap applied before admission so one large block cannot crowd out the rest. */
  maxChars?: number;
};

export type AssembledContext = { text: string; included: string[]; dropped: string[]; chars: number };

export function assembleContext(blocks: ContextBlock[], budget: number): AssembledContext {
  const order = new Map(blocks.map((block, index) => [block.id, index]));
  const chosen = new Map<string, string>();
  const dropped: string[] = [];
  let remaining = budget;
  const capped = blocks.map((block) => (block.maxChars && block.content.length > block.maxChars ? { ...block, content: block.trim === "tail" ? tailText(block.content, block.maxChars) : previewText(block.content, block.maxChars) } : block));
  for (const block of capped.filter((item) => item.content.trim()).sort((left, right) => left.priority - right.priority)) {
    const cost = block.content.length + block.title.length + 8;
    if (cost <= remaining) { chosen.set(block.id, block.content); remaining -= cost; continue; }
    const room = remaining - block.title.length - 10;
    if (block.trim && room >= (block.minChars ?? 400)) {
      chosen.set(block.id, block.trim === "tail" ? tailText(block.content, room) : previewText(block.content, room));
      remaining -= room + block.title.length + 10;
      continue;
    }
    dropped.push(block.id);
  }
  const included = [...chosen.keys()].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
  const byId = new Map(capped.map((block) => [block.id, block]));
  const text = included.map((id) => `【${byId.get(id)?.title}】\n${chosen.get(id)}`).join("\n\n");
  return { text, included, dropped, chars: text.length };
}

export type WritingContextInput = {
  project: WriterProject;
  memory: MemoryView | null;
  /** Reading position the writing happens at (index of the chapter being written, or chapters.length for a new one). */
  position: number;
  /** Text near the writing point; used to detect which entities matter. */
  focus: string;
  /** Previous chapter body (full text); the tail is included for continuity. */
  previousChapterText?: string;
  previousChapterTitle?: string;
  /** Entity names the plan or the user explicitly refers to. */
  entityNames?: string[];
  /** Sample passages of the author's own prose. */
  styleSamples?: string[];
  budget?: number;
  /** Omit large summaries for small local edits. */
  scope?: "local" | "chapter";
  /** The author's notebook: open focus/todo/craft notes and the latest simulated-reader snapshots. */
  notebook?: Notebook | null;
  /** The story plan: promise, powers, secrets, relation tracks, volume plans. */
  story?: StoryPlan | null;
};

export function buildWritingContext(input: WritingContextInput): AssembledContext {
  const { project, memory, position, story } = input;
  const budget = input.budget ?? project.settings.contextBudgetChars;
  const local = input.scope === "local";
  const blocks: ContextBlock[] = [];
  const label = (chapterId: string) => (memory ? chapterLabel(memory.position(chapterId)) : "");

  blocks.push({ id: "project", title: "作品", priority: 0, content: `《${project.title}》｜类型：${project.genre}｜读者：${project.audience}｜篇幅：${project.targetLength}｜语言：${project.language}` });
  const promise = story?.promise;
  if (promise?.oneLiner.trim()) {
    blocks.push({ id: "promise", title: "核心承诺（全书反复兑现的阅读体验）", priority: 0, content: [promise.oneLiner, promise.emotionalNeed && `读者要的体验：${promise.emotionalNeed}`, promise.sceneTypes.length ? `兑现它的场景：${promise.sceneTypes.join("、")}` : "", promise.offPromise.length ? `会跑偏的写法：${promise.offPromise.join("、")}` : ""].filter(Boolean).join("\n") });
  }
  if (project.styleGuide.trim()) blocks.push({ id: "style", title: "文风指南（必须遵守）", priority: 0, trim: "head", maxChars: 4_000, content: project.styleGuide });
  if (input.styleSamples?.length) blocks.push({ id: "samples", title: "作者原文风格样本（模仿语感，不要照抄内容）", priority: 6, trim: "head", maxChars: 3_000, content: input.styleSamples.map((sample, index) => `样本${index + 1}：\n${sample}`).join("\n\n") });

  const book = memory?.aggregates.book;
  const outline = [project.outline.trim() ? `作者大纲：\n${project.outline}` : "", book?.outline ? `已写内容大纲（自动整理）：\n${book.outline}` : ""].filter(Boolean).join("\n\n");
  if (outline) blocks.push({ id: "outline", title: "全书大纲", priority: local ? 7 : 2, trim: "head", minChars: 800, maxChars: 12_000, content: outline });
  if (project.worldview.trim()) blocks.push({ id: "worldview", title: "世界观设定（参考：写作时不违背；正文只露影响人物选择的那一点，不搬机制和术语）", priority: local ? 8 : 4, trim: "head", maxChars: 8_000, content: project.worldview });
  if (project.background.trim()) blocks.push({ id: "background", title: "背景设定（参考：不照搬进正文）", priority: 8, trim: "head", maxChars: 5_000, content: project.background });

  const chapters = orderedChapters(project);
  const current = chapters[position] ?? chapters[position - 1];
  if (current && !local) {
    const volumePlan = story?.volumes.find((plan) => plan.volumeId === current.volumeId);
    if (volumePlan && (volumePlan.endpoint || volumePlan.threshold.reasons.length || volumePlan.coreLoop.length)) {
      blocks.push({ id: "volumePlan", title: "本卷规划", priority: 3, content: [volumePlan.endpoint && `阶段终点：${volumePlan.endpoint}`, volumePlan.threshold.reasons.length ? `主角跨进下一阶段的理由：${volumePlan.threshold.reasons.join("；")}` : "", volumePlan.threshold.beyond && `门后：${volumePlan.threshold.beyond}`, volumePlan.coreLoop.length ? `核心循环：${volumePlan.coreLoop.join(" → ")}` : "", volumePlan.transition.carriedRelations.length ? `要带进下一阶段的关系：${volumePlan.transition.carriedRelations.join("、")}` : ""].filter(Boolean).join("\n") });
    }
  }
  if (memory && current && !local) {
    const volumeSummary = memory.aggregates.volumes.find((volume) => volume.volumeId === current.volumeId);
    const volume = project.volumes.find((item) => item.id === current.volumeId);
    if (volumeSummary) blocks.push({ id: "volume", title: `当前卷「${volume?.title ?? ""}」大纲`, priority: 3, trim: "head", maxChars: 5_000, content: volumeSummary.summary });
    const arc = [...memory.aggregates.arcs].reverse().find((item) => item.chapterIds.some((id) => memory.position(id) < position && memory.position(id) >= position - 30));
    if (arc) blocks.push({ id: "arc", title: `近期情节弧「${arc.title}」`, priority: 3, content: `${arc.summary}\n冲突：${arc.conflicts}\n人物变化：${arc.growth}` });
  }

  if (memory) {
    const recent: string[] = [];
    for (let index = Math.max(0, position - project.settings.recentCardCount); index < position; index += 1) {
      const card = memory.cardAt(index);
      const chapter = chapters[index];
      if (card && chapter) recent.push(`${chapterLabel(index)}「${chapter.title}」：${card.summary}${card.hook ? `｜章末钩子：${card.hook}` : ""}`);
    }
    if (recent.length) blocks.push({ id: "recent", title: "最近章节回顾", priority: 2, trim: "tail", maxChars: 12_000, content: recent.join("\n") });
  }

  if (input.previousChapterText?.trim()) {
    blocks.push({ id: "previous", title: `上一章「${input.previousChapterTitle ?? ""}」结尾原文（衔接用）`, priority: 1, trim: "tail", minChars: 1_200, content: tailText(input.previousChapterText, 4_000) });
  }

  let entityNames: string[] = input.entityNames ?? [];
  if (memory) {
    const entities = involvedEntities(memory, input);
    entityNames = [...new Set([...entityNames, ...entities.map((entity) => entity.name)])];
    if (entities.length) {
      const lines = entities.map((entity) => {
        const state = Object.values(memory.stateAt(entity.id, position - 1)).map((fact) => `${fact.attribute}：${fact.value}（${chapterLabel(fact.position)}）`).join("；");
        const relations = bibleRelations(project, entity);
        const character = entity.bibleId ? project.characters.find((item) => item.id === entity.bibleId) : undefined;
        const inner = character ? [character.minimalTag && `标签：${character.minimalTag}`, character.desire && `想要：${character.desire}`, character.hiddenInner && `不愿承认：${character.hiddenInner}`, character.currentAction && `此刻在做：${character.currentAction}`, character.independentGoal && `独立目标：${character.independentGoal}`].filter(Boolean).join("；") : "";
        const knowledge = entity.category === "character" ? knowledgeLines(story ?? null, memory, [entity.name], position)[0]?.replace(/^- [^：]+：/, "") : "";
        return `◆ ${entity.name}${entity.aliases.length ? `（又名${entity.aliases.slice(0, 4).join("、")}）` : ""}\n  档案：${previewText(entity.summary, 240) || "暂无"}${inner ? `\n  人物：${inner}` : ""}${state ? `\n  截至目前的状态：${state}` : ""}${knowledge ? `\n  所知：${knowledge}` : ""}${relations ? `\n  关系：${relations}` : ""}`;
      });
      blocks.push({ id: "entities", title: "相关人物与设定（以下状态与所知是硬约束，不得矛盾）", priority: 1, trim: "head", minChars: 1_000, maxChars: 16_000, content: lines.join("\n") });

      const related = memory.relatedChapters(entities.map((entity) => entity.id), position - Math.min(position, project.settings.recentCardCount), 6);
      if (related.length && !local) {
        blocks.push({ id: "related", title: "相关往事（检索自前文）", priority: 5, trim: "head", maxChars: 5_000, content: related.map((chapterId) => `${label(chapterId)}：${memory.cards.get(chapterId)?.summary ?? ""}`).join("\n") });
      }
    }

    if (!local) {
      const handoff = story?.thresholds.expectationHandoffProgress ?? 0.5;
      const expectations = activeExpectations(memory, position).slice(0, 10);
      if (expectations.length) {
        blocks.push({ id: "expectations", title: "读者正在等的事（期待与悬念）", priority: 2, trim: "head", maxChars: 4_000, content: expectations.map((thread) => `- [${thread.id}]〔${THREAD_KIND_LABELS[thread.kind]}·${THREAD_TIER_LABELS[thread.tier]}〕${thread.title}：进度 ${Math.round(thread.progress * 100)}%${thread.plan ? `｜计划：${previewText(thread.plan, 100)}` : ""}${thread.progress >= handoff && !thread.successorIds.length ? "｜⚠ 快兑现了，还没有接棒的下一个期待" : ""}`).join("\n") });
      }
    }
    const threads = relevantThreads(memory, position, [...entityNames, ...tokens(input.focus)], local ? 6 : 15);
    if (threads.length) blocks.push({ id: "threads", title: "与这里相关的未回收线索", priority: local ? 9 : 4, trim: "head", maxChars: 5_000, content: threads.map((thread) => `- [${thread.id}]〔${THREAD_KIND_LABELS[thread.kind]}〕${thread.title}：${previewText(thread.description, 80)}（${thread.plantedAt >= 0 ? `${chapterLabel(thread.plantedAt)}引入，已过 ${Math.max(0, position - thread.plantedAt)} 章` : "未知"}）${thread.plan ? `｜作者计划：${previewText(thread.plan, 120)}` : ""}${thread.targetChapterId ? `｜计划在${label(thread.targetChapterId)}兑现` : ""}`).join("\n") });

    if (!local) {
      const payoffs = recentPayoffTypes(memory, position, 6);
      const trend = emotionTrend(memory, position, 4);
      const suppressed = pendingSuppression(memory, position);
      const rhythm = [
        payoffs.length ? `最近的兑现：${payoffs.map((item) => `${chapterLabel(item.position)} ${item.types.join("/")}`).join("；")}。下一次换一种。` : "",
        trend.length ? `最近的情绪：${trend.map((item) => `${chapterLabel(item.position)} ${item.beats.map((beat) => EMOTION_BEAT_LABELS[beat.type]).join("")}`).join("；")}` : "",
        suppressed.length ? `情绪已经连续压了 ${suppressed.length} 次还没有释放${suppressed.length >= (story?.thresholds.suppressMax ?? 3) ? "，该兑现了" : ""}。` : "",
      ].filter(Boolean).join("\n");
      if (rhythm) blocks.push({ id: "rhythm", title: "近期节奏", priority: 4, content: rhythm });
    }
    const world = memory.aggregates.worldview;
    if (world && !local) blocks.push({ id: "memoryWorld", title: "设定集（自动整理；参考，不照搬进正文）", priority: 7, trim: "head", maxChars: 10_000, content: world.sections.map((section) => `## ${section.title}\n${section.content}`).join("\n\n") });
  }

  if (story && !local) {
    if (story.powers.length) blocks.push({ id: "powers", title: "金手指规则（不能越过上限，代价要兑现）", priority: 3, trim: "head", maxChars: 3_000, content: story.powers.map((power) => `- ${power.name}：${[power.trigger && `条件 ${power.trigger}`, power.reward && `收获 ${power.reward}`, power.cost && `代价 ${power.cost}`, power.cap && `上限 ${power.cap}`, power.cannotSolve.length ? `解决不了 ${power.cannotSolve.join("、")}` : ""].filter(Boolean).join("；")}`).join("\n") });
    const names = new Set(entityNames);
    const tracks = story.relations.filter((relation) => names.has(relation.a) || names.has(relation.b)).slice(0, 8);
    if (tracks.length) blocks.push({ id: "relations", title: "关系双轨（名分／亲近程度）", priority: 3, content: tracks.map((relation) => `- ${relation.a} × ${relation.b}：名分「${relation.social[relation.social.length - 1]?.status ?? "未定"}」｜亲近 ${relation.intimacy[relation.intimacy.length - 1]?.level ?? "?"}/10${relation.intimacy.length ? `（上一次变化：${relation.intimacy[relation.intimacy.length - 1].event}）` : ""}`).join("\n") });
  }

  const reader = latestReader(input.notebook ?? null, memory, position);
  if (reader && !local) {
    const wants = panelWants(reader, 6);
    const guesses = reader.voices.flatMap((voice) => voice.guesses.slice(0, 2).map((guess) => `${guess}（${voice.persona}）`)).slice(0, 6);
    const lost = [...new Set(reader.voices.flatMap((voice) => voice.lost.slice(0, 2).map((item) => item.title)))].slice(0, 5);
    const doubts = reader.voices.filter((voice) => voice.verdict !== "keep" && voice.reason).map((voice) => `${voice.persona}：${voice.reason}`);
    const content = [
      wants.length ? `最想看到：${wants.map((item) => item.title).join("；")}` : "",
      guesses.length ? `读者在猜（不一定对）：${guesses.join("；")}` : "",
      lost.length ? `读者没看懂或记不清：${lost.join("；")}` : "",
      doubts.length ? `犹豫或不想追的原因：${doubts.join("；")}` : "",
    ].filter(Boolean).join("\n");
    if (content) blocks.push({ id: "reader", title: `模拟读者读完${memory ? label(reader.chapterId) : "最近一章"}后`, priority: 5, trim: "head", maxChars: 2_500, content });
  }

  const notes = (input.notebook?.notes ?? []).filter((note) => !note.done && note.kind !== "memo" && note.text.trim());
  if (notes.length && !local) blocks.push({ id: "authorNotes", title: "作者笔记（作者正在关注的事和商量好的写法，写作时照顾到）", priority: 3, trim: "head", maxChars: 4_000, content: notes.map((note) => `- 〔${NOTE_KIND_LABELS[note.kind]}${note.topic ? `·${craftLabel(note.topic)}` : ""}〕${note.text}${note.plan ? `｜计划：${note.plan}` : ""}`).join("\n") });
  return assembleContext(blocks, budget);
}

/** The latest simulated-reader snapshot taken before `position`. */
function latestReader(notebook: Notebook | null, memory: MemoryView | null, position: number) {
  const snapshots = Object.values(notebook?.readers ?? {});
  if (!snapshots.length) return null;
  const before = memory ? snapshots.filter((snapshot) => { const at = memory.position(snapshot.chapterId); return at >= 0 && at < position; }) : snapshots;
  return before.sort((left, right) => (memory ? memory.position(right.chapterId) - memory.position(left.chapterId) : right.generatedAt - left.generatedAt))[0] ?? null;
}

/** Two-character and longer runs of CJK or letters from the focus text, for matching thread titles. */
function tokens(text: string): string[] {
  return [...new Set(text.slice(0, 2_000).match(/[\u4e00-\u9fa5]{2,4}|[A-Za-z]{3,}/g) ?? [])].slice(0, 80);
}

function involvedEntities(memory: MemoryView, input: WritingContextInput): MemoryEntity[] {
  const explicit = (input.entityNames ?? []).flatMap((name) => memory.resolve(name) ?? []);
  const detected = memory.entitiesIn(`${input.focus}\n${tailText(input.previousChapterText ?? "", 3_000)}`, 24);
  const chapters = orderedChapters(input.project);
  const pov = chapters[input.position]?.povCharacterId;
  const povEntity = pov ? memory.entities.find((entity) => entity.bibleId === pov) : undefined;
  const all = [...explicit, ...(povEntity ? [povEntity] : []), ...detected];
  return [...new Map(all.map((entity) => [entity.id, entity])).values()].slice(0, 24);
}

function bibleRelations(project: WriterProject, entity: MemoryEntity) {
  if (!entity.bibleId) return "";
  const names = new Map(project.characters.map((character) => [character.id, character.name]));
  return project.characterRelations
    .filter((relation) => relation.sourceCharacterId === entity.bibleId || relation.targetCharacterId === entity.bibleId)
    .map((relation) => `${names.get(relation.sourceCharacterId) ?? ""}→${names.get(relation.targetCharacterId) ?? ""}：${relation.relation}`)
    .join("；");
}

/** Picks a few representative passages from the author's latest finished chapters. */
export function pickStyleSamples(texts: string[], count = 2, length = 700): string[] {
  return texts.filter((text) => text.length > length).slice(-count).map((text) => {
    const start = Math.max(0, text.indexOf("\n", Math.floor(text.length / 3)) + 1);
    return text.slice(start, start + length);
  });
}
