// Publish steps that keep the story plan, bible and settings in step with the published chapter, check the story's
// health, simulate a reader and refresh the author's briefing.
import { invokeJson } from "../../ai/client";
import { checklistReview } from "../../ai/pipelines/checklistReview";
import { CHAPTER_REVIEW_GROUPS } from "../../ai/craft/checklist";
import { generateBriefing, simulateReaders } from "../../ai/pipelines/notebook";
import { resolvePrompt } from "../../ai/promptRegistry";
import { chapterLabel, orderedChapters } from "../../domain/documents";
import { uniqueId } from "../../domain/ids";
import { normalizeCharacter, normalizeFaction } from "../../domain/normalize";
import { newProposal } from "../../domain/proposals";
import { arrayValue, asRecord, finiteNumber, previewText, stringValue } from "../../domain/util";
import { newThread, threadOperationLabel } from "../../memory/operations";
import { THREAD_KIND_LABELS, type StoryThread } from "../../memory/schema";
import { threadKindValue, threadTierValue } from "../../memory/store";
import { MemoryView } from "../../memory/view";
import { verdictTally } from "../../notes/schema";
import { loadNotebook, updateNotebook } from "../../notes/store";
import { appendProposal, applyProposal } from "../../storage/proposalStore";
import { loadChapterText } from "../../storage/projectStore";
import { diagnoseStory, type HealthIssue } from "../../story/health";
import { storyOperationLabel, type StoryOperation } from "../../story/schema";
import { loadStoryPlan } from "../../story/store";
import type { ProposalChange, WriterCharacter, WriterFaction } from "../../types";
import type { StepContext, StepExecutor } from "./types";

const UPDATE_SCHEMA = `{
  "summary": "本章带来的核心设定与线索变化，一两句话总结",
  "threads": [{ "threadId": "已有线索的 id；新登记填 null", "title": "线索短标题", "description": "本章具体推进或埋设的内容", "kind": "foreshadow|expectation|mystery", "tier": "chapter|short|arc|volume|ultimate", "progress": 0.0, "status": "open|paid|abandoned", "plan": "后续兑现或反转规划", "successorOf": "若接替某条进度达50%-70%或已兑现的主期待，填其 id，否则填 null" }],
  "relations": [{ "a": "人物名", "b": "人物名", "social": "两人此刻的名分状态（如师徒、同盟、宿敌、各怀鬼胎的合作者）", "event": "由本章哪件不可逆事件触发" }],
  "characters": [{ "id": "设定库已有人物 id；新出场填 null", "name": "标准名", "role": "角色定位", "summary": "身份与特质档案", "minimalTag": "极简识别标签", "desire": "核心欲望与算计", "hiddenInner": "不愿示人的内在真核/软肋", "currentAction": "脱离主角视线时此刻在做什么" }],
  "factions": [{ "id": "已有势力 id；新势力填 null", "name": "势力名", "summary": "利益立场与底层运作账本", "motivation": "行动诉求与时间表" }],
  "worldviewAppend": "直接追加进世界观文档的硬规则/下层烟火器物/上层历史断层新段落；无则留空",
  "backgroundAppend": "直接追加进背景文档的新段落；无则留空"
}`;

export function triggerChapter(context: StepContext) {
  const chapters = orderedChapters(context.project);
  const position = chapters.findIndex((chapter) => chapter.id === context.run.trigger.chapterId);
  if (position < 0) throw new Error("触发流水线的章节已被删除。");
  return { chapter: chapters[position], position, chapters };
}

/** Additive memory/story updates are applied at once under the "auto-safe" gate; bible and document edits always wait for review. */
function isSafe(change: ProposalChange) { return change.kind === "thread" || change.kind === "story"; }

const updateStory: StepExecutor = async (context) => {
  const { project } = context;
  const { chapter, position } = triggerChapter(context);
  const memory = await MemoryView.load(project);
  const card = memory.cards.get(chapter.id);
  if (!card) return { summary: "这一章还没有记忆卡片，跳过" };
  const [text, story] = await Promise.all([loadChapterText(project.id, chapter.id), loadStoryPlan(project.id)]);
  const open = memory.openThreads(position + 1).slice(0, 60);
  const prompt = [
    `【作品】《${project.title}》｜${project.genre}`,
    story.promise.oneLiner ? `【核心承诺】${story.promise.oneLiner}` : "",
    `【刚发布的章节】${chapterLabel(position)}「${chapter.title}」`,
    `【记忆卡片】\n${JSON.stringify({ summary: card.summary, characters: card.characters, facts: card.facts.slice(0, 60), threads: card.threads, hook: card.hook, payoffs: card.payoffs, newCast: card.newCast }, null, 1)}`,
    `【正文（节选）】\n${previewText(text, 16_000)}`,
    `【已有线索】\n${open.map((thread) => `- ${thread.id}〔${THREAD_KIND_LABELS[thread.kind]}·进度${Math.round(thread.progress * 100)}%〕${thread.title}：${previewText(thread.description, 60)}${thread.successorIds.length ? "（已有接棒）" : ""}`).join("\n") || "（暂无）"}`,
    `【设定库人物】${project.characters.slice(0, 120).map((character) => `${character.name}(id=${character.id})`).join("、") || "（暂无）"}`,
    `【设定库势力】${project.factions.slice(0, 60).map((faction) => `${faction.name}(id=${faction.id})`).join("、") || "（暂无）"}`,
    `【世界观文档末尾】\n${previewText(project.worldview.slice(-2_000), 2_000) || "（空）"}`,
    `【输出 JSON】只输出一个 JSON 对象，没有变化的数组给空数组：\n${UPDATE_SCHEMA}`,
  ].filter(Boolean).join("\n\n");
  const result = asRecord(await invokeJson({ task: "memory", system: resolvePrompt(project, "story.update"), prompt, effort: "medium", temperature: 0.2, maxOutputTokens: 6_000, signal: context.signal }, (value) => value));

  const changes: ProposalChange[] = [];
  const threads = new Map(memory.threads.map((thread) => [thread.id, structuredClone(thread)]));
  const touched = new Set<string>();
  for (const item of arrayValue(result.threads)) {
    const entry = asRecord(item);
    const title = stringValue(entry.title).trim();
    const id = stringValue(entry.threadId);
    const existing = id ? threads.get(id) : undefined;
    if (!existing && !title) continue;
    const thread: StoryThread = existing ?? newThread({ id: uniqueId("thread"), title, events: [{ chapterId: chapter.id, type: "plant", description: stringValue(entry.description) }], origin: "extracted" });
    thread.title = title || thread.title;
    thread.description = stringValue(entry.description) || thread.description;
    thread.kind = threadKindValue(entry.kind ?? thread.kind);
    thread.tier = threadTierValue(entry.tier ?? thread.tier);
    thread.progress = Math.max(thread.progress, Math.max(0, Math.min(1, finiteNumber(entry.progress, thread.progress))));
    if (entry.status === "paid" || entry.status === "abandoned") { thread.status = entry.status; if (entry.status === "paid") thread.progress = 1; }
    if (stringValue(entry.plan).trim() && !thread.plan.trim()) thread.plan = stringValue(entry.plan).trim();
    threads.set(thread.id, thread);
    touched.add(thread.id);
    const predecessor = threads.get(stringValue(entry.successorOf));
    if (predecessor && predecessor.id !== thread.id && !predecessor.successorIds.includes(thread.id)) { predecessor.successorIds.push(thread.id); touched.add(predecessor.id); }
  }
  for (const id of touched) {
    const thread = threads.get(id) as StoryThread;
    const before = memory.threads.find((item) => item.id === id);
    if (before && JSON.stringify(before) === JSON.stringify(thread)) continue;
    const operation = { type: "upsertThread" as const, thread };
    changes.push({ id: uniqueId("change"), kind: "thread", label: threadOperationLabel(operation, memory.threads), operation });
  }

  const relations = new Map(story.relations.map((relation) => [`${relation.a}|${relation.b}`, structuredClone(relation)]));
  for (const item of arrayValue(result.relations)) {
    const entry = asRecord(item);
    const a = memory.resolve(stringValue(entry.a))?.name ?? stringValue(entry.a).trim();
    const b = memory.resolve(stringValue(entry.b))?.name ?? stringValue(entry.b).trim();
    const social = stringValue(entry.social).trim();
    if (!a || !b || !social) continue;
    const track = relations.get(`${a}|${b}`) ?? relations.get(`${b}|${a}`) ?? { id: uniqueId("track"), a, b, social: [], intimacy: [] };
    if (track.social[track.social.length - 1]?.status === social) continue;
    track.social = [...track.social.filter((point) => point.chapterId !== chapter.id), { chapterId: chapter.id, status: social }];
    relations.set(`${track.a}|${track.b}`, track);
    const operation: StoryOperation = { type: "upsertRelation", relation: track };
    changes.push({ id: uniqueId("change"), kind: "story", label: `${storyOperationLabel(operation)}：${social}`, operation });
  }

  for (const item of arrayValue(result.characters)) {
    const entry = asRecord(item);
    const existing = project.characters.find((character) => character.id === stringValue(entry.id)) ?? project.characters.find((character) => character.name === stringValue(entry.name).trim());
    const fields = (["role", "summary", "minimalTag", "desire", "hiddenInner", "currentAction"] as const).filter((key) => stringValue(entry[key]).trim());
    if (!existing && !stringValue(entry.name).trim()) continue;
    if (existing && !fields.some((key) => stringValue(entry[key]).trim() !== existing[key])) continue;
    const character: WriterCharacter = existing ? { ...existing } : normalizeCharacter({ id: uniqueId("character"), name: stringValue(entry.name).trim() });
    for (const key of fields) character[key] = stringValue(entry[key]).trim();
    changes.push({ id: uniqueId("change"), kind: "entity", label: `${existing ? "更新" : "新增"}人物：${character.name}`, operation: { type: "upsertCharacter", character } });
  }
  for (const item of arrayValue(result.factions)) {
    const entry = asRecord(item);
    const existing = project.factions.find((faction) => faction.id === stringValue(entry.id)) ?? project.factions.find((faction) => faction.name === stringValue(entry.name).trim());
    if (!existing && !stringValue(entry.name).trim()) continue;
    const faction: WriterFaction = existing ? { ...existing } : normalizeFaction({ id: uniqueId("faction"), name: stringValue(entry.name).trim() });
    let changed = !existing;
    for (const key of ["summary", "motivation"] as const) { const value = stringValue(entry[key]).trim(); if (value && value !== faction[key]) { faction[key] = value; changed = true; } }
    if (changed) changes.push({ id: uniqueId("change"), kind: "entity", label: `${existing ? "更新" : "新增"}势力：${faction.name}`, operation: { type: "upsertFaction", faction } });
  }
  for (const [field, kind, label] of [["worldviewAppend", "worldview", "世界观"], ["backgroundAppend", "background", "背景"]] as const) {
    const append = stringValue(result[field]).trim();
    if (!append) continue;
    const before = project[kind];
    changes.push({ id: uniqueId("change"), kind: "text", doc: { kind }, title: label, summary: `${chapterLabel(position)}新增设定`, before, after: before.trim() ? `${before.trimEnd()}\n\n${append}` : append });
  }

  if (!changes.length) return { summary: "这一章没有需要更新的设定" };
  const source = { kind: "pipeline" as const, runId: context.run.id, stepId: context.step.id };
  const title = `${chapterLabel(position)}「${chapter.title}」设定更新`;
  const summary = stringValue(result.summary) || `${changes.length} 项更新`;
  if (project.settings.pipeline.storyGate === "auto-safe" && changes.some(isSafe)) {
    const safe = newProposal({ title: `${title}（已自动应用）`, summary, changes: changes.filter(isSafe), source });
    await appendProposal(project.id, safe);
    await applyProposal(project.id, safe.id);
    const rest = changes.filter((change) => !isSafe(change));
    if (!rest.length) return { summary: `已自动应用 ${safe.changes.length} 项线索/关系更新`, proposalId: safe.id };
    const pending = newProposal({ title, summary, changes: rest, source });
    await appendProposal(project.id, pending);
    return { summary: `已自动应用 ${safe.changes.length} 项；${rest.length} 项设定库/文档修改待审`, proposalId: pending.id };
  }
  const proposal = newProposal({ title, summary, changes, source });
  await appendProposal(project.id, proposal);
  return { summary: `${changes.length} 项更新待审：${summary}`, proposalId: proposal.id };
};

export type HealthArtifact = { issues: HealthIssue[] };

const storyHealth: StepExecutor = async (context) => {
  const [story, memory] = await Promise.all([loadStoryPlan(context.project.id), MemoryView.load(context.project)]);
  const issues = diagnoseStory(story, memory);
  await context.writeArtifact({ issues } satisfies HealthArtifact);
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  return { summary: issues.length ? `发现 ${issues.length} 个提示（${warnings} 个需要注意）` : "没有发现结构问题" };
};

const readerSnapshot: StepExecutor = async (context) => {
  const { chapter } = triggerChapter(context);
  const memory = await MemoryView.load(context.project);
  const snapshot = await simulateReaders({ project: context.project, memory, chapterId: chapter.id, signal: context.signal, onProgress: (done, total) => void context.report(done, total, `${done}/${total} 位读者读完`).catch(() => undefined) });
  await updateNotebook(context.project.id, (notebook) => { notebook.readers[chapter.id] = snapshot; });
  const problem = snapshot.digest?.problems[0]?.title;
  return { summary: [
    `${verdictTally(snapshot).keep}/${snapshot.voices.length} 位继续追`,
    problem ? `最大问题：${previewText(problem, 40)}` : "",
    snapshot.failed.length ? `${snapshot.failed.join("、")}没读完` : "",
    snapshot.digest ? "" : "没有生成汇总",
  ].filter(Boolean).join("；") };
};

const briefing: StepExecutor = async (context) => {
  const [memory, story] = await Promise.all([MemoryView.load(context.project), loadStoryPlan(context.project.id)]);
  const notebook = await loadNotebook(context.project.id);
  const generated = await generateBriefing({ project: context.project, memory, notebook, story, signal: context.signal });
  await updateNotebook(context.project.id, (current) => { current.briefing = generated; });
  return { summary: generated.promiseDrift ? `偏离承诺：${previewText(generated.promiseDrift, 40)}` : generated.next[0]?.title ? `下一步：${generated.next[0].title}` : "简报已更新" };
};

/** Reads the published chapter against the checklist; what fails lands in the margin next to the quoted text. */
const chapterNotes: StepExecutor = async (context) => {
  const { chapter, position } = triggerChapter(context);
  const [memory, story, text] = await Promise.all([MemoryView.load(context.project), loadStoryPlan(context.project.id), loadChapterText(context.project.id, chapter.id)]);
  if (!text.trim()) return { summary: "这一章没有正文，跳过" };
  const { comments } = await checklistReview({ project: context.project, memory, story, chapterId: chapter.id, position, text, groups: CHAPTER_REVIEW_GROUPS, signal: context.signal });
  const anchored = comments.filter((comment) => comment.quote);
  await updateNotebook(context.project.id, (notebook) => { notebook.marginNotes[chapter.id] = anchored; });
  return { summary: anchored.length ? `写了 ${anchored.length} 条朱批，在这一章的页边` : "没有要标的地方" };
};

export const STORY_STEPS = { "story.update": updateStory, "story.health": storyHealth, "reader.snapshot": readerSnapshot, briefing, "chapter.notes": chapterNotes } satisfies Record<string, StepExecutor>;
