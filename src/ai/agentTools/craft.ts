// Craft tools: the writing methods as cards the assistant looks up, and the chapter planner, chapter review and block
// doctor the studio uses, so the assistant can reach for them when it decides they help. None of them edits the draft.
import { chapterLabel, orderedChapters } from "../../domain/documents";
import { arrayValue, previewText, stringValue, tailText, trimmedString } from "../../domain/util";
import { loadNotebook } from "../../notes/store";
import { lintPlan, type PlanWarning } from "../../story/planLint";
import { craftLabel } from "../craft";
import { CHECKLIST } from "../craft/checklist";
import { CRAFT_CARDS, craftCard, craftCardText, matchCraftCards } from "../craft/library";
import { prepareWritingContext } from "../contextPrep";
import { BLOCK_TYPE_LABELS, diagnoseBlock, normalizeBlockCard } from "../pipelines/blockDoctor";
import { checklistReview } from "../pipelines/checklistReview";
import { normalizePlan, planCast, planToText, readerCuesText, REVIEW_CATEGORY_LABELS, reviewDraft, type ChapterPlan, type ReviewCategory } from "../pipelines/nextChapter";
import { planChapter } from "../pipelines/planChapter";
import { saveStudioPlan } from "../studioPlan";
import { docRef, docText, storyOf, type RunState, type ToolHandler } from "./state";

/** Reading position of a chapter (chapters before it); the end of the book for other documents. */
function positionOf(state: RunState, chapterId: string | undefined): number {
  const chapters = orderedChapters(state.draft);
  const index = chapterId ? chapters.findIndex((chapter) => chapter.id === chapterId) : -1;
  return index >= 0 ? index : chapters.length;
}

function activeChapterId(state: RunState): string | undefined {
  return state.activeDoc.kind === "chapter" ? state.activeDoc.id : undefined;
}

async function conventionsFor(state: RunState, topic: string): Promise<string[]> {
  const notebook = await loadNotebook(state.projectId).catch(() => null);
  return (notebook?.notes ?? []).filter((note) => note.kind === "craft" && !note.done && note.topic === topic && note.text.trim()).map((note) => `- ${note.text}${note.plan ? `｜做法：${note.plan}` : ""}`);
}

const readCraft: ToolHandler = async ({ state, input }) => {
  const topic = trimmedString(input.topic);
  const symptom = trimmedString(input.symptom);
  if (!topic && !symptom) {
    return { observation: `写作方法目录（用 topic 读一张卡片，或用 symptom 描述作者遇到的问题）：\n${CRAFT_CARDS.map((card) => `- ${card.id}〔${card.label}〕${card.symptoms.slice(0, 4).join("、")}`).join("\n")}` };
  }
  const cards = topic ? [craftCard(topic)].filter((card) => card !== undefined) : matchCraftCards(symptom ?? "");
  if (!cards.length) {
    if (topic) throw new Error(`没有「${topic}」这张方法卡。不带参数调用 readCraft 看目录。`);
    return { observation: `没有找到和「${symptom}」对应的方法卡。不带参数调用 readCraft 看目录，自己挑。` };
  }
  const parts: string[] = [];
  for (const card of cards) {
    const own = await conventionsFor(state, card.id);
    // The work's own decisions come first and win over the general method.
    if (own.length) parts.push(`〔本作的写法约定·${craftLabel(card.id)}〕（优先于下面的通用方法）\n${own.join("\n")}`);
    parts.push(craftCardText(card));
  }
  return { observation: `${parts.join("\n\n")}\n\n这些是可选的做法，不是必须走的流程；作者的意图和本作约定优先。` };
};

/**
 * Plans a chapter with the planner prompt against the context at its position, or lints a plan the assistant edited
 * (`plan`). The plan stays on the run, so reviewing that chapter later checks it against the plan.
 */
const planChapterTool: ToolHandler = async ({ state, input, memory, signal }) => {
  const chapters = orderedChapters(state.draft);
  const rewrite = trimmedString(input.chapterId);
  if (rewrite && !chapters.some((chapter) => chapter.id === rewrite)) throw new Error("chapterId 无效，请先 readProjectIndex 查看章节 id。");
  const after = trimmedString(input.afterChapterId) ?? activeChapterId(state);
  const position = rewrite ? positionOf(state, rewrite) : after ? Math.min(positionOf(state, after) + 1, chapters.length) : chapters.length;
  const words = Math.round(Number(input.words)) || state.draft.settings.pipeline.nextWords;
  const story = await storyOf(state);
  let plan: ChapterPlan;
  let warnings: PlanWarning[];
  if (input.plan && typeof input.plan === "object") {
    plan = normalizePlan(input.plan, words);
    warnings = lintPlan(plan, { story, memory, position });
  } else {
    const direction = stringValue(input.direction).trim();
    const existing = rewrite ? await docText(state, { kind: "chapter", id: rewrite }) : "";
    const context = await prepareWritingContext({ project: state.draft, memory, position, focus: `${direction}\n${previewText(existing, 3_000)}`, texts: state.texts, scope: "chapter", budget: Math.min(40_000, state.draft.settings.contextBudgetChars), story });
    const brief = [direction, existing.trim() ? `（这是重写${chapterLabel(position)}。现有版本的开头，只作参考：\n${previewText(existing, 3_000)}）` : ""].filter(Boolean).join("\n\n");
    ({ plan, warnings } = await planChapter({ session: { project: state.draft, memory, story, position, context }, direction: brief, targetWords: words, signal }));
  }
  state.plan = { position, chapterId: rewrite ?? null, plan };
  // The studio shows this for the author to edit; losing it must not fail the tool.
  await saveStudioPlan(state.projectId, state.sessionId, plan, warnings).catch(() => undefined);
  return {
    observation: [
      `${chapterLabel(position)}${rewrite ? "（重写）" : "（新章）"}的章纲：\n${planToText(plan)}`,
      readerCuesText({ memory, position }, planCast(plan, memory)),
      warnings.length ? `自查提示（是提示，不是必须改；和作者商量过的写法照旧）：\n${warnings.map((warning) => `- ${warning.message}`).join("\n")}` : "自查没有发现问题。",
      "照章纲写：列出的事都写出来，一笔带过的只给一两句，篇幅照各场字数分。和作者的意图冲突时以作者为准；改过的章纲可以用 plan 再查一遍。写完用 reviewChapter 审，会对照这份章纲。",
    ].filter(Boolean).join("\n\n"),
    result: { plan },
  };
};

/** Craft cards that help with each kind of review issue. */
const REVIEW_CRAFT: Record<ReviewCategory, string[]> = { pacing: ["payoff", "detail", "tension"], logic: ["logic"], knowledge: ["truth"], world: ["world", "voice"], clarity: ["clarity", "dialogue"], style: ["prose", "dialogue"], plan: [], continuity: [] };

function craftHints(categories: ReviewCategory[]): string {
  const topics = [...new Set(categories.flatMap((category) => REVIEW_CRAFT[category]))].slice(0, 4);
  return topics.length ? `\n对症的方法卡（需要时用 readCraft 查）：${topics.map((topic) => `${topic}〔${craftLabel(topic)}〕`).join("、")}` : "";
}

const reviewChapter: ToolHandler = async ({ state, input, memory, signal }) => {
  const ref = docRef(state, { doc: "chapter", chapterId: trimmedString(input.chapterId) ?? activeChapterId(state) });
  if (ref.kind !== "chapter") throw new Error("reviewChapter 只能审章节。");
  const text = await docText(state, ref);
  if (!text.trim()) return { observation: "这一章还没有正文。" };
  const position = positionOf(state, ref.id);
  const story = await storyOf(state);
  const groups = arrayValue(input.groups).map(String).filter((id) => CHECKLIST.some((group) => group.id === id));
  if (groups.length) {
    const result = await checklistReview({ project: state.draft, memory, story, chapterId: ref.id, position, text, groups, signal });
    const failed = result.verdicts.filter((verdict) => verdict.status === "fail");
    return { observation: failed.length ? `按检查表审读${chapterLabel(position)}，${failed.length} 项没做到：\n${failed.map((verdict) => `- ${verdict.item}：${verdict.problem}${verdict.quote ? `｜原文：「${verdict.quote}」` : ""}${verdict.suggestion ? `｜建议：${verdict.suggestion}` : ""}`).join("\n")}` : `按检查表审读${chapterLabel(position)}，没有发现没做到的项。` };
  }
  const context = await prepareWritingContext({ project: state.draft, memory, position, focus: previewText(text, 4_000), texts: state.texts, scope: "chapter", budget: Math.min(24_000, state.draft.settings.contextBudgetChars), story });
  const plan = state.plan?.position === position ? state.plan.plan : null;
  const issues = await reviewDraft({ project: state.draft, memory, story, position, context }, plan, text, signal);
  const against = plan ? "（对照本次的章纲）" : "";
  return { observation: issues.length ? `审读${chapterLabel(position)}${against}，${issues.length} 条意见（按作者的意图取舍，不必全改）：\n${issues.map((issue) => `- [${issue.severity}]〔${REVIEW_CATEGORY_LABELS[issue.category]}〕${issue.problem}${issue.quote ? `｜原文：「${issue.quote}」` : ""}${issue.suggestion ? `｜建议：${issue.suggestion}` : ""}`).join("\n")}${craftHints(issues.map((issue) => issue.category))}` : `审读${chapterLabel(position)}${against}，没有发现问题。` };
};

const diagnoseBlockTool: ToolHandler = async ({ state, input, memory, signal }) => {
  const card = normalizeBlockCard(input);
  const chapterId = activeChapterId(state);
  const position = positionOf(state, chapterId);
  const focus = state.selection?.text || (chapterId ? tailText(await docText(state, { kind: "chapter", id: chapterId }), 3_000) : "");
  const result = await diagnoseBlock({ project: state.draft, memory, story: await storyOf(state), position, card, focus, signal });
  return {
    observation: [
      `卡点：${BLOCK_TYPE_LABELS[result.type]}${result.analysis ? `。${result.analysis}` : ""}`,
      result.branches.length ? `可以走的方向：\n${result.branches.map((branch) => `- ${branch.title}：起因 ${branch.cause}；关键事件 ${branch.event}；引向 ${branch.leadsTo}`).join("\n")}` : "",
      result.emotion ? `这一段要渲染的情绪：${result.emotion}` : "",
      result.approaches.length ? `落地手段：\n${result.approaches.map((approach) => `- ${approach.title}：从${approach.entry}切入`).join("\n")}` : "",
      result.placeholder ? `占位：【待补：${result.placeholder.replace(/^【待补[:：]|】$/g, "")}】` : "",
      result.minimalTask ? `最小任务：${result.minimalTask}` : "",
    ].filter(Boolean).join("\n"),
  };
};

export const CRAFT_TOOLS: Record<string, ToolHandler> = {
  "writer.readCraft": readCraft,
  "writer.planChapter": planChapterTool,
  "writer.reviewChapter": reviewChapter,
  "writer.diagnoseBlock": diagnoseBlockTool,
};
