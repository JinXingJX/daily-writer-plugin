// Chapter drafting steps the writing agent calls as tools: the plan it agreed with the author, scene-by-scene drafting
// with the dedicated writer prompt, and the continuity + craft review. The writer and the editor both get what readers
// remember of the cast, since the model works from the whole memory and readers only from the page.
import { chapterLabel } from "../../domain/documents";
import { uniqueId } from "../../domain/ids";
import { arrayValue, asRecord, finiteNumber, previewText, stringArray, stringValue, tailText } from "../../domain/util";
import { locateUnique } from "../../domain/anchors";
import { readabilityHints } from "../../domain/readability";
import { CHANGE_KIND_LABELS, CHANGE_KINDS, type ChangeKind } from "../../memory/schema";
import type { MemoryView } from "../../memory/view";
import type { StoryPlan } from "../../story/schema";
import { knowledgeLines, readerCues, sceneCast } from "../../story/selectors";
import type { WriterProject } from "../../types";
import { invokeJson, invokeText } from "../client";
import type { AssembledContext } from "../context";
import { resolvePrompt } from "../promptRegistry";
import { editorSystem, writerSystem } from "../prompts";
import { loadStyleSamples, samplesSection, type LoadedSample } from "../styleSamples";
import { cleanProse } from "../quick";

/**
 * One scene of the plan: what the POV character wants (`goal`) and stands to lose or gain (`stakes`), an optional
 * `deadline` with its cause, `obstacles` that change their move, the `events` readers could retell afterwards, the key
 * `choice`, what readers know that the character does not, where the emotion starts and ends, and what the scene
 * changes. `focal` is the scene's centre in ensemble scenes.
 */
export type PlanScene = {
  id: string; title: string; cause: string; goal: string; stakes: string; deadline: string; obstacles: string[]; events: string[];
  choice: string; turn: string; outcome: string; changes: ChangeKind[]; readerKnows: string; characterUnknown: string;
  emotion: { from: string; to: string }; characters: string[]; focal: string; location: string; words: number;
};
/** direct: delivers the book's core promise; support: sets it up; off: unrelated (should be rare and deliberate). */
export type PromiseAlignment = "direct" | "support" | "off";
/** Threads (by id or title) the chapter advances, plants and pays off. */
export type PlanThreads = { advance: string[]; plant: string[]; payoff: string[] };
/**
 * `core` is the one thing the chapter should make the reader feel; `reward` what readers get from it (or what is held
 * back, and until when); `hook` the expectation it hands to the next chapter. `logic` is the planner's offstage
 * reasoning for the writer (what every party wants, knows and is doing, which rules come into play); `kernel` is what
 * the chapter's events were drawn from (daily life, an absurd modern incident, the news, a classic trope) and how they
 * were rewritten into this world. `skim` lists what the prose passes over in a line or two.
 */
export type ChapterPlan = { title: string; core: string; reward: string; logic: string; kernel: string; summary: string; promiseAlignment: PromiseAlignment; promiseNote: string; scenes: PlanScene[]; threads: PlanThreads; skim: string[]; hook: string };
/**
 * What the editor checks, after the writing goal: logic (continuity, knowledge, logic), the world, the plan, reader
 * pull, whether readers follow it on one read (clarity) and voice.
 */
export type ReviewCategory = "continuity" | "knowledge" | "logic" | "world" | "plan" | "pacing" | "clarity" | "style";
export const REVIEW_CATEGORY_LABELS: Record<ReviewCategory, string> = { continuity: "连续性", knowledge: "知识越界", logic: "逻辑", world: "世界观", plan: "偏离计划", pacing: "追读", clarity: "读得懂", style: "文风" };
const REVIEW_CATEGORIES = Object.keys(REVIEW_CATEGORY_LABELS) as ReviewCategory[];
export type ReviewIssue = { id: string; quote: string; problem: string; suggestion: string; severity: "info" | "warning" | "error"; category: ReviewCategory; source: "rule" | "ai" };

export type GenerationSession = {
  project: WriterProject;
  memory: MemoryView | null;
  /** The work's story plan; supplies what each character knows for the review. */
  story: StoryPlan | null;
  /** Reading position of the chapter being generated. */
  position: number;
  context: AssembledContext;
};

const ALIGNMENTS: PromiseAlignment[] = ["direct", "support", "off"];

export function normalizePlan(value: unknown, targetWords = 3_000): ChapterPlan {
  const record = asRecord(value);
  const scenes = arrayValue(record.scenes).map((item): PlanScene => {
    const scene = asRecord(item);
    const emotion = asRecord(scene.emotion);
    const list = (key: string) => stringArray(scene[key], 12).filter((entry) => entry.trim());
    return {
      id: stringValue(scene.id) || uniqueId("scene"), title: stringValue(scene.title), cause: stringValue(scene.cause),
      goal: stringValue(scene.goal), stakes: stringValue(scene.stakes), deadline: stringValue(scene.deadline), obstacles: list("obstacles"), events: list("events"),
      choice: stringValue(scene.choice), turn: stringValue(scene.turn), outcome: stringValue(scene.outcome),
      changes: [...new Set(stringArray(scene.changes, 10).filter((kind): kind is ChangeKind => CHANGE_KINDS.includes(kind as ChangeKind)))],
      readerKnows: stringValue(scene.readerKnows), characterUnknown: stringValue(scene.characterUnknown),
      emotion: { from: stringValue(emotion.from), to: stringValue(emotion.to) },
      characters: stringArray(scene.characters, 20), focal: stringValue(scene.focal), location: stringValue(scene.location),
      words: Math.round(finiteNumber(scene.words, 0)),
    };
  }).filter((scene) => scene.title || scene.goal);
  if (!scenes.length) throw new Error("计划中没有场景。");
  const share = Math.round(targetWords / scenes.length);
  for (const scene of scenes) if (scene.words < 200) scene.words = share;
  const threads = asRecord(record.threads);
  return {
    title: stringValue(record.title) || "新章节",
    core: stringValue(record.core),
    reward: stringValue(record.reward),
    logic: stringValue(record.logic),
    kernel: stringValue(record.kernel),
    summary: stringValue(record.summary),
    promiseAlignment: ALIGNMENTS.includes(record.promiseAlignment as PromiseAlignment) ? record.promiseAlignment as PromiseAlignment : "support",
    promiseNote: stringValue(record.promiseNote),
    scenes,
    threads: { advance: stringArray(threads.advance, 20), plant: stringArray(threads.plant, 20), payoff: stringArray(threads.payoff, 20) },
    skim: stringArray(record.skim, 12).filter((entry) => entry.trim()),
    hook: stringValue(record.hook),
  };
}

const ALIGNMENT_LABELS: Record<PromiseAlignment, string> = { direct: "直接兑现", support: "铺垫/辅助", off: "与承诺无关" };

export function planToText(plan: ChapterPlan) {
  return [
    `标题：${plan.title}`,
    plan.core ? `这一章想让读者感到：${plan.core}` : "",
    plan.reward ? `给读者的兑现：${plan.reward}` : "",
    plan.logic ? `推演（台面下，写给执笔者，不进正文）：${plan.logic}` : "",
    plan.kernel ? `取材内核（只取内核，表面全换成本作的）：${plan.kernel}` : "",
    `与核心承诺：${ALIGNMENT_LABELS[plan.promiseAlignment]}${plan.promiseNote ? `（${plan.promiseNote}）` : ""}`,
    `梗概：${plan.summary}`,
    ...plan.scenes.map((scene, index) => [
      `场景${index + 1}「${scene.title}」（约${scene.words}字，地点：${scene.location}，人物：${scene.characters.join("、")}${scene.focal ? `，焦点：${scene.focal}` : ""}）`,
      scene.cause ? `  起因：${scene.cause}` : "",
      `  目标：${scene.goal}${scene.stakes ? `｜代价/收益：${scene.stakes}` : ""}${scene.deadline ? `｜期限：${scene.deadline}` : ""}`,
      scene.obstacles.length ? `  阻力：${scene.obstacles.join("；")}` : "",
      scene.events.length ? `  发生的事：${scene.events.join(" → ")}` : "",
      scene.choice ? `  关键选择：${scene.choice}` : "",
      scene.turn ? `  转折：${scene.turn}` : "",
      scene.outcome ? `  结果：${scene.outcome}` : "",
      scene.changes.length ? `  改变了：${scene.changes.map((kind) => CHANGE_KIND_LABELS[kind]).join("、")}` : "",
      scene.readerKnows || scene.characterUnknown ? `  读者已知／人物未知：${scene.readerKnows || "—"}／${scene.characterUnknown || "—"}` : "",
      scene.emotion.from || scene.emotion.to ? `  情绪：${scene.emotion.from || "?"} → ${scene.emotion.to || "?"}` : "",
    ].filter(Boolean).join("\n")),
    plan.skim.length ? `一笔带过：${plan.skim.join("；")}` : "",
    plan.threads.advance.length ? `推进线索：${plan.threads.advance.join("；")}` : "",
    plan.threads.plant.length ? `新埋/引入：${plan.threads.plant.join("；")}` : "",
    plan.threads.payoff.length ? `兑现/回收：${plan.threads.payoff.join("；")}` : "",
    `章末钩子（接续的期待）：${plan.hook}`,
  ].filter(Boolean).join("\n");
}

/** Planned words one drafting call writes: about a chapter, so a usual chapter is written in one go. */
export const SPAN_WORDS = 4_000;

/**
 * The scenes one drafting call writes, from `start`: consecutive scenes until their planned words reach SPAN_WORDS
 * (at least one). Writing a chapter scene by scene read worse than writing it in one go from the same plan: each call
 * opened and closed its scene like a short story and re-introduced people (scripts/prompt-eval/chapter.ts).
 */
export function sceneSpan(plan: ChapterPlan, start: number, skip: ReadonlySet<number> = new Set()): number[] {
  const span: number[] = [];
  let words = 0;
  for (let index = start; index < plan.scenes.length && !skip.has(index); index += 1) {
    if (span.length && words + plan.scenes[index].words > SPAN_WORDS) break;
    span.push(index);
    words += plan.scenes[index].words;
  }
  return span;
}

/** The plan's cast, for what readers remember of them. */
export function planCast(plan: ChapterPlan | null, memory: MemoryView | null = null): string[] {
  return [...new Set(plan?.scenes.flatMap((scene) => sceneCast(scene, memory)) ?? [])];
}

export const READER_CUES_HEADING = "【读者记得多少】";

/** What readers remember of the cast at `position`; empty when they know everyone well. */
export function readerCuesText(session: Pick<GenerationSession, "memory" | "position">, names: string[]): string {
  const cues = readerCues(session.memory, names, session.position);
  return cues.length ? `${READER_CUES_HEADING}（读者只知道前文写出来的东西，不知道设定和记忆）\n${cues.join("\n")}` : "";
}

/**
 * Writes a run of consecutive scenes (see sceneSpan) as one continuous passage; what this chapter already has is passed
 * back verbatim so the prose flows on. `brief` is the agent's note: what matters most and the craft decisions made
 * with the author.
 */
export async function writeScenes(session: GenerationSession, plan: ChapterPlan, span: number[], written: string, signal?: AbortSignal, brief = ""): Promise<string> {
  if (!span.length) throw new Error("没有要写的场景。");
  const first = span[0];
  const last = span[span.length - 1];
  const words = span.reduce((sum, index) => sum + plan.scenes[index].words, 0);
  const label = (index: number) => `场景${index + 1}「${plan.scenes[index].title}」`;
  const scenes = span.length === 1 ? label(first) : `${label(first)}到${label(last)}`;
  const cues = readerCuesText(session, [...new Set(span.flatMap((index) => sceneCast(plan.scenes[index], session.memory)))]);
  const text = await invokeText({
    task: "prose",
    system: await writerSystem(session.project),
    prompt: `${session.context.text}\n\n【本章计划】\n${planToText(plan)}\n\n${cues ? `${cues}\n\n` : ""}${written.trim() ? `【本章已写内容】\n${tailText(written, 12_000)}\n\n` : ""}${brief.trim() ? `【这次要写的要点（和作者商量过）】\n${brief.trim()}\n\n` : ""}【任务】${resolvePrompt(session.project, "task.scene", { scenes, words, position: spanPosition(first, last === plan.scenes.length - 1, plan.hook) })}`,
    effort: "medium", temperature: 0.85,
    maxOutputTokens: Math.min(16_000, Math.max(1_500, Math.round(words * 2.2))),
    signal,
  });
  return cleanProse(text);
}

function spanPosition(first: number, last: boolean, hook: string) {
  const start = first === 0
    ? "开头直接咬住上一章结尾的动作、话头或器物余波切入，绝不写天气回顾或重新自我介绍。"
    : "紧接上方【本章已写内容】最后一句的气口与动作自然往下淌，不重复铺垫。";
  return `${start}${last ? `写到本章结尾，戛然而止停在钩子上：${hook}（严禁在钩子后加总结升华或下集预告）。` : "写到这几场的局势位移落定即停，不写阶段性总结，留给后面的场景一气呵成接着写。"}`;
}

const DEATH_VALUE = /死亡|已死|身亡|阵亡|战死|被杀|去世|陨落|殒命/;

/** Deterministic checks plus an editor review against the memory's hard facts and what each character may know. */
export async function reviewDraft(session: GenerationSession, plan: ChapterPlan | null, draft: string, signal?: AbortSignal): Promise<ReviewIssue[]> {
  const issues: ReviewIssue[] = [];
  const memory = session.memory;
  let facts = "";
  const present: string[] = [];
  if (memory) {
    for (const entity of memory.entitiesIn(draft, 20)) {
      if (entity.category === "character") present.push(entity.name);
      const state = memory.stateAt(entity.id, session.position - 1);
      const dead = Object.values(state).find((fact) => DEATH_VALUE.test(fact.value) && /生死|状态|结局|生命/.test(fact.attribute));
      if (dead && entity.category === "character") {
        const name = [entity.name, ...entity.aliases].find((alias) => draft.includes(alias)) ?? entity.name;
        issues.push({ id: uniqueId("issue"), quote: quoteAround(draft, name), problem: `${entity.name}在${chapterLabel(dead.position)}已${dead.value}，本章却再次出现。`, suggestion: "若是回忆/梦境请明确交代，否则删除或替换该人物。", severity: "error", category: "continuity", source: "rule" });
      }
      const lines = Object.values(state).map((fact) => `${fact.attribute}=${fact.value}（${chapterLabel(fact.position)}）`).join("；");
      if (lines) facts += `- ${entity.name}：${lines}\n`;
    }
  }
  for (const name of planCast(plan, memory)) if (!present.includes(name)) present.push(name);
  const knowledge = knowledgeLines(session.story, memory, present.slice(0, 16), session.position);
  const promise = session.story?.promise.oneLiner.trim();
  const samples = await loadStyleSamples(session.project.id);
  // The samples are the baseline: what the author's own pages do often is their voice, not a reading problem.
  const hints = readabilityHints(draft, samples.map((sample) => sample.text).join("\n"));
  const review = await invokeJson({
    task: "review",
    system: editorSystem(session.project),
    prompt: [
      previewText(session.context.text, 30_000),
      `【人物当前状态（硬事实）】\n${facts || "（无）"}`,
      knowledge.length ? `【人物所知／不知道的暗线（截至本章开头）】\n${knowledge.join("\n")}` : "",
      promise ? `【本书核心承诺】${promise}` : "",
      plan ? `【本章计划】\n${planToText(plan)}` : "",
      readerCuesText(session, present.slice(0, 24)),
      reviewVoice(samples),
      hints.length ? `【可能读着费劲的句子】（自动指标，仅供参考；读者确实要回读才懂的才提 clarity 意见，是作者有意的写法就放过）\n${hints.map((hint) => `- 「${hint.quote}」：${hint.message}`).join("\n")}` : "",
      `【待审草稿】\n${draft}`,
      `【任务】${resolvePrompt(session.project, "task.review")}\n输出 JSON：{"issues":[{"quote":"","problem":"","suggestion":"","severity":"info|warning|error","category":"${REVIEW_CATEGORIES.join("|")}"}]}`,
    ].filter(Boolean).join("\n\n"),
    // Catching contradictions and knowledge leaks takes careful reading; the review is worth the extra reasoning.
    effort: "high", temperature: 0.2,
    maxOutputTokens: 4_000,
    signal,
  }, (value) => arrayValue(asRecord(value).issues).map((item) => {
    const record = asRecord(item);
    const severity: ReviewIssue["severity"] = record.severity === "error" || record.severity === "info" ? record.severity : "warning";
    const category = REVIEW_CATEGORIES.includes(record.category as ReviewCategory) ? record.category as ReviewCategory : "style";
    return { id: uniqueId("issue"), quote: stringValue(record.quote), problem: stringValue(record.problem), suggestion: stringValue(record.suggestion), severity, category, source: "ai" as const };
  }).filter((issue) => issue.problem));
  return [...issues, ...review];
}

/**
 * The work's style samples for the editor: a voice may do what generic rules call a fault (a narrator who chimes in,
 * dialogue led by gestures, long fight sentences). Without them the review flags the voice and autoRevise rewrites it away.
 */
export function reviewVoice(samples: LoadedSample[]): string {
  const section = samplesSection(samples, 6_000);
  return section ? `${section}\n\n（审稿基准：草稿跟样章的叙述声音走——叙述者站在哪、离人物多近、句子长短、对白怎么起怎么收；和样章一致的个人语感不算毛病。style 只抓样章之外的 AI 套话、说明书式描写、多余的解释和与本作世界不搭的词。clarity 不看像不像样章，只看读者能不能一遍跟上。）` : "";
}

export type RevisionResult = { text: string; fixed: ReviewIssue[]; skipped: ReviewIssue[] };

/** What task.revise answers when the paragraph should go entirely. */
export const DELETE_MARK = "【删除】";

/**
 * Revises the paragraphs that warning- and error-level issues point at, one call per paragraph, using the work's
 * writer prompt; a paragraph the reviser marks for deletion is removed. Issues whose quote cannot be found once in the
 * draft are skipped.
 */
export async function autoRevise(session: GenerationSession, draft: string, issues: ReviewIssue[], signal?: AbortSignal): Promise<RevisionResult> {
  let text = draft;
  const fixed: ReviewIssue[] = [];
  const skipped: ReviewIssue[] = [];
  const system = await writerSystem(session.project);
  for (const issue of issues) {
    if (issue.severity === "info") continue;
    if (signal?.aborted) break;
    const located = issue.quote ? locateUnique(text, issue.quote) : null;
    if (!located?.ok) { skipped.push(issue); continue; }
    const start = text.lastIndexOf("\n", located.range.start - 1) + 1;
    const endBreak = text.indexOf("\n", located.range.end);
    const end = endBreak < 0 ? text.length : endBreak;
    const paragraph = text.slice(start, end);
    const revised = cleanProse(await invokeText({
      task: "prose",
      system,
      prompt: `【前文】\n${tailText(text.slice(0, start), 1_500)}\n\n【需要修订的段落】\n${paragraph}\n\n【后文】\n${previewText(text.slice(end), 600)}\n\n【任务】${resolvePrompt(session.project, "task.revise", { problem: issue.problem, suggestion: issue.suggestion || "按问题修改" })}`,
      effort: "medium", temperature: 0.6,
      maxOutputTokens: Math.min(6_000, Math.max(800, paragraph.length * 3)),
      signal,
    }));
    if (revised.trim() === DELETE_MARK) {
      const after = text.slice(end).replace(/^\n+/, "");
      text = after ? `${text.slice(0, start)}${after}` : text.slice(0, start).trimEnd();
      fixed.push(issue);
      continue;
    }
    // A fix that balloons a paragraph pads the chapter and drifts from it; keep the paragraph and report the issue.
    // Pacing fixes cut padding, so they may shrink a paragraph to a line; other fixes that do usually lost content.
    const floor = issue.category === "pacing" ? 0 : paragraph.length * 0.3;
    if (!revised.trim() || revised.length < floor || revised.length > Math.max(paragraph.length * 1.8, paragraph.length + 120)) { skipped.push(issue); continue; }
    text = `${text.slice(0, start)}${revised.trim()}${text.slice(end)}`;
    fixed.push(issue);
  }
  return { text, fixed, skipped };
}

function quoteAround(text: string, term: string) {
  const index = text.indexOf(term);
  if (index < 0) return term;
  return text.slice(index, Math.min(text.length, index + 24)).split("\n")[0];
}
