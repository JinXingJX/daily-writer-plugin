// Publish steps that draft the next chapter: plan (optionally approved by the author), scene-by-scene drafting that
// resumes after a pause at the next unwritten scene, review with automatic revision, and the final draft proposal.
import { prepareWritingContext } from "../../ai/contextPrep";
import { autoRevise, planToText, reviewDraft, sceneSpan, writeScenes, type ChapterPlan, type GenerationSession, type ReviewIssue } from "../../ai/pipelines/nextChapter";
import { planChapter } from "../../ai/pipelines/planChapter";
import { chapterLabel } from "../../domain/documents";
import { uniqueId } from "../../domain/ids";
import { normalizeChapterMeta } from "../../domain/normalize";
import { newProposal } from "../../domain/proposals";
import { rankBetween } from "../../domain/ranks";
import { hardSpots, readabilityStats, type ReadabilityStats } from "../../domain/readability";
import { previewText } from "../../domain/util";
import { MemoryView } from "../../memory/view";
import { panelWants } from "../../notes/schema";
import { loadNotebook } from "../../notes/store";
import { appendProposal } from "../../storage/proposalStore";
import type { PlanWarning } from "../../story/planLint";
import { loadStoryPlan } from "../../story/store";
import { triggerChapter } from "./story";
import type { StepContext, StepExecutor } from "./types";

/** next.plan artifact. `approved` turns true when the author approves (or the plan gate is off). */
export type PlanArtifact = { plan: ChapterPlan; warnings: PlanWarning[]; direction: string; approved: boolean };
/** next.draft artifact, saved after every scene so a paused run resumes at the next scene. */
export type DraftArtifact = { text: string; written: number[] };
/** next.review artifact. `readability` holds heuristic counts before and after revision, not confirmed reader errors. */
export type ReviewArtifact = { text: string; issues: ReviewIssue[]; fixed: string[]; skipped: string[]; readability: { before: ReadabilityStats; after: ReadabilityStats } };

async function session(context: StepContext, focus: string, budget: number): Promise<GenerationSession> {
  const { project } = context;
  const { position } = triggerChapter(context);
  const [memory, story] = await Promise.all([MemoryView.load(project), loadStoryPlan(project.id)]);
  const target = position + 1;
  const contextPack = await prepareWritingContext({ project, memory, position: target, focus, scope: "chapter", budget: Math.min(budget, project.settings.contextBudgetChars), story });
  return { project, memory, story, position: target, context: contextPack };
}

async function approvedPlan(context: StepContext): Promise<ChapterPlan> {
  const artifact = await context.artifactOf<PlanArtifact>("next.plan");
  if (!artifact?.approved) throw new Error("下一章计划还没有确认。");
  return artifact.plan;
}

/** What the briefing and the simulated reader suggest for the next chapter. */
async function direction(context: StepContext) {
  const notebook = await loadNotebook(context.project.id).catch(() => null);
  const { chapter } = triggerChapter(context);
  const lines: string[] = [];
  for (const step of notebook?.briefing?.next.slice(0, 3) ?? []) lines.push(`- 作家简报建议：${step.title}${step.detail ? `（${step.detail}）` : ""}`);
  const reader = notebook?.readers[chapter.id];
  if (reader) {
    for (const want of panelWants(reader, 3)) lines.push(`- 读者最想看：${want.title}`);
    for (const voice of reader.voices.filter((item) => item.verdict !== "keep" && item.reason).slice(0, 2)) lines.push(`- ${voice.persona}${voice.verdict === "drop" ? "不想追了" : "在犹豫"}：${voice.reason}（这一章要化解）`);
    for (const action of reader.digest?.actions.filter((item) => item.scope === "next").slice(0, 3) ?? []) lines.push(`- 读者反馈建议：${action.title}${action.detail ? `（${action.detail}）` : ""}`);
  }
  if (notebook?.briefing?.promiseDrift) lines.push(`- 编辑提醒偏离核心承诺：${notebook.briefing.promiseDrift}`);
  return lines.join("\n");
}

const plan: StepExecutor = async (context) => {
  const hint = await direction(context);
  const generation = await session(context, hint, 40_000);
  const { plan: result, warnings } = await planChapter({ session: generation, direction: hint, targetWords: context.project.settings.pipeline.nextWords, signal: context.signal });
  const approved = context.project.settings.pipeline.planGate === "auto";
  await context.writeArtifact({ plan: result, warnings, direction: hint, approved } satisfies PlanArtifact);
  const summary = `「${result.title}」${result.scenes.length} 场${warnings.length ? `，${warnings.length} 条提醒` : ""}`;
  return approved ? { summary } : { summary: `${summary}，等你确认`, awaiting: true };
};

const draft: StepExecutor = async (context) => {
  const chapterPlan = await approvedPlan(context);
  const saved = await context.ownArtifact<DraftArtifact>();
  let text = saved?.text ?? "";
  const written = new Set(saved?.written ?? []);
  const total = chapterPlan.scenes.length;
  for (let index = 0; index < total; index += 1) {
    if (written.has(index)) continue;
    if (await context.checkStop(true)) throw new DOMException("Aborted", "AbortError");
    const span = sceneSpan(chapterPlan, index, written);
    const last = span[span.length - 1];
    await context.report(written.size, total, span.length > 1 ? `写第 ${index + 1}-${last + 1}/${total} 场` : `写第 ${index + 1}/${total} 场「${chapterPlan.scenes[index].title}」`);
    const generation = await session(context, `${planToText(chapterPlan)}\n${text.slice(-3_000)}`, 40_000);
    const part = await writeScenes(generation, chapterPlan, span, text, context.signal);
    if (!part.trim()) throw new Error(`第 ${index + 1} 场没有写出内容。`);
    text = text.trim() ? `${text.trimEnd()}\n\n${part}` : part;
    for (const item of span) written.add(item);
    await context.writeArtifact({ text, written: [...written] } satisfies DraftArtifact);
    index = last;
  }
  await context.report(total, total, "全部场景已写完");
  return { summary: `${total} 场，${text.length} 字` };
};

const review: StepExecutor = async (context) => {
  const chapterPlan = await approvedPlan(context);
  const drafted = await context.artifactOf<DraftArtifact>("next.draft");
  if (!drafted?.text.trim()) throw new Error("没有可审读的草稿。");
  const generation = await session(context, `${planToText(chapterPlan)}\n${previewText(drafted.text, 4_000)}`, 40_000);
  await context.report(0, 2, "审读中");
  const issues = await reviewDraft(generation, chapterPlan, drafted.text, context.signal);
  await context.report(1, 2, `修订 ${issues.filter((issue) => issue.severity !== "info").length} 处`);
  const revision = await autoRevise(generation, drafted.text, issues, context.signal);
  const readability = { before: readabilityStats(drafted.text), after: readabilityStats(revision.text) };
  await context.writeArtifact({ text: revision.text, issues, fixed: revision.fixed.map((issue) => issue.id), skipped: revision.skipped.map((issue) => issue.id), readability } satisfies ReviewArtifact);
  return { summary: `${issues.length} 个问题，自动修订 ${revision.fixed.length} 处${revision.skipped.length ? `，${revision.skipped.length} 处留给你` : ""}；难读提示 ${hardSpots(readability.before)}→${hardSpots(readability.after)}（自动检测）` };
};

const propose: StepExecutor = async (context) => {
  const { project } = context;
  const [planned, reviewed, drafted] = await Promise.all([context.artifactOf<PlanArtifact>("next.plan"), context.artifactOf<ReviewArtifact>("next.review"), context.artifactOf<DraftArtifact>("next.draft")]);
  if (!planned) throw new Error("没有下一章计划。");
  const text = reviewed?.text ?? drafted?.text ?? "";
  if (!text.trim()) throw new Error("没有草稿。");
  const { chapter, position, chapters } = triggerChapter(context);
  const sameVolume = chapters.filter((item) => item.volumeId === chapter.volumeId);
  const next = sameVolume[sameVolume.indexOf(chapter) + 1];
  const meta = normalizeChapterMeta({ id: uniqueId("chapter"), volumeId: chapter.volumeId, title: planned.plan.title, summary: planned.plan.summary, rank: rankBetween(chapter.rank, next?.rank), status: "draft", notes: planToText(planned.plan), targetWords: project.settings.pipeline.nextWords });
  // Info-level issues are the ones left to the author (whole-chapter changes a paragraph fix cannot make), so they stay listed.
  const open = (reviewed?.issues ?? []).filter((issue) => !reviewed?.fixed.includes(issue.id));
  const proposal = newProposal({
    title: `下一章草稿：${planned.plan.title}`,
    summary: `接在${chapterLabel(position)}「${chapter.title}」之后。${planned.plan.core ? `这一章想让读者感到：${planned.plan.core}` : ""}`,
    risks: [...open.map((issue) => `${issue.severity === "info" ? "建议：" : ""}“${issue.quote}”：${issue.problem}`), ...planned.warnings.map((warning) => warning.message)].slice(0, 30),
    changes: [{ id: uniqueId("change"), kind: "text", doc: { kind: "chapter", id: meta.id }, title: meta.title, summary: "新章节草稿", before: "", after: text, createChapter: meta }],
    source: { kind: "pipeline", runId: context.run.id, stepId: context.step.id },
  });
  await appendProposal(project.id, proposal);
  return { summary: `草稿已生成，待你审阅（${text.length} 字）`, proposalId: proposal.id };
};

export const NEXT_STEPS = { "next.plan": plan, "next.draft": draft, "next.review": review, "next.propose": propose } satisfies Record<string, StepExecutor>;
