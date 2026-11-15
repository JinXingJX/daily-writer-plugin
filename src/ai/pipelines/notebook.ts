import { domainTask } from "../../worker/domainTask";
// AI help for the author notebook: a briefing on where the book stands and what to do next, and a panel of simulated
// readers who have just read a chapter, summed up by an editor. Readers see only what a reader would have by then, and
// retell the chapter from memory: where the retelling misses the chapter, the page did not get it across.
import { chapterLabel, orderedChapters } from "../../domain/documents";
import { arrayValue, asRecord, finiteNumber, previewText, stringValue, tailText } from "../../domain/util";
import type { MemoryView } from "../../memory/view";
import { chaptersBasis, readerKnowledge, unrevealedSecrets, writingProgress } from "../../notes/derive";
import { MARK_TONE_LABELS, normalizeBriefing, normalizeDigest, normalizeVoice, NOTE_KIND_LABELS, READER_VERDICT_LABELS, type AuthorBriefing, type Notebook, type ReaderDigest, type ReaderSnapshot, type ReaderVoice } from "../../notes/schema";
import { THREAD_KIND_LABELS, type ThreadEventType } from "../../memory/schema";
import { loadChapterText } from "../../storage/projectStore";
import { diagnoseStory, HEALTH_RULE_LABELS } from "../../story/health";
import type { StoryPlan } from "../../story/schema";
import { loadStoryPlan } from "../../story/store";
import type { WriterProject } from "../../types";
import { invokeJson } from "../client";
import { readerPanel, resolvePrompt, type Lens } from "../promptRegistry";
import { withGoal } from "../prompts";

const RECENT_CHAPTERS = 12;

export type BriefingRequest = { project: WriterProject; memory: MemoryView | null; notebook: Notebook; story?: StoryPlan | null; signal?: AbortSignal };

export async function generateBriefing({ project, memory, notebook, story = null, signal }: BriefingRequest): Promise<AuthorBriefing> {
  const task = domainTask<AuthorBriefing>("generateBriefing", [{ project, memory, notebook, story }], project.id, signal); if (task) return task;
  const chapters = orderedChapters(project);
  const progress = writingProgress(project);
  const position = progress.frontierPosition + 1;
  const summaryOf = (index: number) => memory?.cardAt(index)?.summary || chapters[index]?.summary || "";

  const recent: string[] = [];
  for (let index = Math.max(0, position - RECENT_CHAPTERS); index < position; index += 1) {
    const hook = memory?.cardAt(index)?.hook;
    recent.push(`${chapterLabel(index)}「${chapters[index].title}」（${chapters[index].wordCount} 字）：${summaryOf(index) || "（暂无摘要）"}${hook ? `｜章末钩子：${hook}` : ""}`);
  }
  const earlier = memory?.aggregates.arcs
    .filter((arc) => arc.chapterIds.every((id) => memory.position(id) < Math.max(0, position - RECENT_CHAPTERS)))
    .map((arc) => `【${arc.title}】${chapterLabel(memory.position(arc.chapterIds[0]))}起：${previewText(arc.summary, 300)}`) ?? [];
  const ahead = chapters.slice(position).filter((chapter) => chapter.title.trim() || chapter.summary.trim()).slice(0, 10).map((chapter, offset) => `${chapterLabel(position + offset)}「${chapter.title}」${chapter.summary ? `：${chapter.summary}` : ""}`);
  const threads = memory?.openThreads().slice(0, 30).map((thread) => `- [${thread.id}]〔${THREAD_KIND_LABELS[thread.kind]}·进度${Math.round(thread.progress * 100)}%〕${thread.title}：${previewText(thread.description, 100)}（${thread.plantedAt >= 0 ? `${chapterLabel(thread.plantedAt)}引入，已过 ${thread.age} 章` : "位置未知"}）${thread.plan ? `｜作者的计划：${thread.plan}` : ""}`) ?? [];
  const health = story ? diagnoseStory(story, memory, position).slice(0, 20).map((issue) => `- 〔${HEALTH_RULE_LABELS[issue.rule]}〕${issue.message}`) : [];
  const notes = notebook.notes.filter((note) => !note.done).slice(0, 60).map((note) => `- 〔${NOTE_KIND_LABELS[note.kind]}〕${note.text}${note.plan ? `｜计划：${note.plan}` : ""}${note.chapterId ? `（关于${chapterLabel(chapters.findIndex((chapter) => chapter.id === note.chapterId))}）` : ""}`);
  const conflicts = memory?.conflicts.filter((conflict) => conflict.status === "open").slice(0, 10).map((conflict) => `- ${conflict.subject}·${conflict.attribute}：${conflict.values.map((value) => `${value.value}（${chapterLabel(memory.position(value.chapterId))}）`).join(" / ")}`) ?? [];

  const block = (title: string, content: string, limit: number) => (content.trim() ? `【${title}】\n${previewText(content.trim(), limit)}` : "");
  const prompt = [
    `【作品】《${project.title}》｜类型：${project.genre}｜目标篇幅：${project.targetLength}`,
    story?.promise.oneLiner ? `【核心承诺】${story.promise.oneLiner}${story.promise.emotionalNeed ? `｜读者要的体验：${story.promise.emotionalNeed}` : ""}` : "【核心承诺】作者还没有写下。",
    `【进度】共 ${progress.chapterCount} 章，已写 ${progress.writtenCount} 章、${progress.totalWords} 字；写到${progress.frontier ? `${chapterLabel(progress.frontierPosition)}「${progress.frontier.title}」` : "开头"}${progress.volumeTitle ? `（${progress.volumeTitle}）` : ""}；定稿 ${progress.statusCounts.final} 章，待修改 ${progress.statusCounts.review} 章。`,
    block("作者大纲", project.outline, 6_000),
    block("全书主线（自动整理）", memory?.aggregates.book?.mainline ?? "", 1_500),
    block("较早的情节弧", earlier.join("\n"), 8_000),
    block("最近章节", recent.join("\n"), 12_000),
    block("作者已规划但未写的章节", ahead.join("\n"), 3_000),
    block("未兑现的线索（伏笔、期待、悬念）", threads.join("\n"), 6_000),
    block("故事体检", health.join("\n"), 3_000),
    block("作者自己的笔记", notes.join("\n"), 5_000),
    block("检测到的设定冲突", conflicts.join("\n"), 2_000),
    `【任务】替作者整理作家笔记。作者会照着它决定接下来写什么，每条都要读一遍就能照着做：先说结论，再说理由，用平常的话。
1. progress：一两句话说清写到了哪里，处在全书和本卷的什么阶段，离本卷的转折点还有多远。
2. storySoFar：200–400 字，按前因后果讲清已经写出来的主要剧情和局面变化。
3. focus：3–6 条接下来写作时要记住的事（谁知道什么、不知道什么，能力的限制和代价，正在发酵的危机，世界的规矩），每条一句话。
4. next：3–6 条下一步最该做的具体写作或修改动作；改旧章时 chapter 填章节序号数字，否则填 null。
5. threads：给最要紧的未兑现线索出主意：在哪段剧情、借谁的手兑现，怎样让读者回头一看恍然大悟；作者已有计划的，在计划上往深里想；threadId 照抄方括号里的 id。
6. risks：战力膨胀、前后矛盾、白拿好处、压得太久、桥段重复这类硬伤风险，没有就给空数组。
7. promiseDrift：最近几章是否偏离了全书的核心承诺，偏在哪、怎么拉回来；没有偏离就给空字符串。
8. gaps：读者没有可等之事的空档，或某个期待快兑现了却还没有下一个期待接上，每条一句话并说怎么补；没有就给空数组。`,
    `输出 JSON：{"progress":"","storySoFar":"","focus":[""],"next":[{"title":"","detail":"","chapter":null}],"threads":[{"threadId":"","title":"","plan":""}],"risks":[""],"promiseDrift":"","gaps":[""]}`,
  ].filter(Boolean).join("\n\n");

  return invokeJson({
    task: "ideas",
    system: `${withGoal(project, "notes.system")}\n只输出要求的 JSON。`,
    prompt,
    effort: "medium", temperature: 0.4,
    maxOutputTokens: 5_000,
    signal,
  }, (value) => {
    const record = asRecord(value);
    const next = arrayValue(record.next).map((item) => {
      const step = asRecord(item);
      const index = Math.round(finiteNumber(typeof step.chapter === "string" ? Number(step.chapter.replace(/\D/g, "")) : step.chapter, 0)) - 1;
      return { title: stringValue(step.title), detail: stringValue(step.detail), chapterId: chapters[index]?.id ?? null };
    });
    const briefing = normalizeBriefing({ ...record, next, basis: chaptersBasis(project, position), position, generatedAt: Date.now() });
    if (!briefing || (!briefing.storySoFar && !briefing.focus.length && !briefing.next.length)) throw new Error("模型没有给出笔记内容。");
    const known = new Set(memory?.threads.map((thread) => thread.id) ?? []);
    briefing.threads = briefing.threads.map((thread) => ({ ...thread, threadId: thread.threadId && known.has(thread.threadId) ? thread.threadId : null }));
    return briefing;
  });
}

/** Characters seen within this many chapters stay fresh in a reader's mind; anyone older has to come back through the text. */
const RECENT_CAST_WINDOW = 10;
const CHAPTER_CHARS = 24_000;
const EVENT_LABELS: Record<ThreadEventType, string> = { plant: "埋下", advance: "推进", payoff: "兑现" };

export type ReaderRequest = { project: WriterProject; memory: MemoryView; chapterId: string; story?: StoryPlan | null; signal?: AbortSignal; onProgress?: (done: number, total: number) => void };

/**
 * The reader panel tries a chapter: each member reads the chapter text in a call of their own, remembering only what a
 * reader would by then and never the author's material. An editor then reads their reactions against the author's
 * threads, hidden lines and plans. A member whose call fails is listed in `failed`; a failed summary leaves `digest` null.
 */
export async function simulateReaders({ project, memory, chapterId, story, signal, onProgress }: ReaderRequest): Promise<ReaderSnapshot> {
  const task = domainTask<ReaderSnapshot>("simulateReaders", [{ project, memory, chapterId, story, onProgress }], project.id, signal); if (task) return task;
  const chapters = orderedChapters(project);
  const position = chapters.findIndex((chapter) => chapter.id === chapterId);
  if (position < 0) throw new Error("章节不存在。");
  const [text, previous, plan] = await Promise.all([
    loadChapterText(project.id, chapterId),
    position > 0 ? loadChapterText(project.id, chapters[position - 1].id).catch(() => "") : Promise.resolve(""),
    story !== undefined ? Promise.resolve(story) : loadStoryPlan(project.id).catch(() => null),
  ]);
  if (!text.trim()) throw new Error("这一章还没有正文。");
  const context = readerContext(project, memory, position, previous, plan);
  const panel = readerPanel(project);
  let done = 0;
  onProgress?.(0, panel.length);
  const settled = await Promise.allSettled(panel.map((persona) => readAs(project, persona, context, position, text, signal).finally(() => { done += 1; onProgress?.(done, panel.length); })));
  if (signal?.aborted) throw new Error("已停止。");
  const voices = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  if (!voices.length) throw (settled.find((result) => result.status === "rejected") as PromiseRejectedResult).reason;
  const digest = await digestReaders({ project, memory, chapterId, voices, story: plan, signal }).catch(() => null);
  if (signal?.aborted) throw new Error("已停止。");
  return {
    chapterId,
    basis: chaptersBasis(project, position + 1),
    voices,
    failed: panel.filter((_, index) => settled[index].status === "rejected").map((persona) => persona.name),
    digest,
    generatedAt: Date.now(),
  };
}

/** What a reader carries into the chapter: the selling point that drew them in, the story so far and the cast seen lately. */
function readerContext(project: WriterProject, memory: MemoryView, position: number, previous: string, story: StoryPlan | null): string {
  const chapters = orderedChapters(project);
  // Older chapters as fully-read arcs, the last stretch chapter by chapter; the chapter itself is read in full.
  const recentFrom = Math.max(0, position - 15);
  const arcs = memory.aggregates.arcs.filter((arc) => arc.chapterIds.length && arc.chapterIds.every((id) => { const at = memory.position(id); return at >= 0 && at < recentFrom; }));
  const read = [
    ...arcs.map((arc) => `【${arc.title}】${chapterLabel(memory.position(arc.chapterIds[0]))}起：${previewText(arc.summary, 400)}`),
    ...chapters.slice(recentFrom, position).map((chapter, offset) => `${chapterLabel(recentFrom + offset)}「${chapter.title}」：${memory.cardAt(recentFrom + offset)?.summary || chapter.summary || "（暂无摘要）"}`),
  ];
  // Only the cast seen lately before this chapter, so someone back after a long absence has to be recognised from the text.
  const cast = position > 0 ? readerKnowledge(memory, position - 1).characters.filter((item) => item.lastSeen >= position - RECENT_CAST_WINDOW).slice(0, 20) : [];
  return [
    story?.promise.oneLiner.trim() ? `【书页上的卖点】${story.promise.oneLiner.trim()}` : "",
    // A long book keeps its latest stretch: what a reader remembers least is the start.
    read.length ? `【你记得的前情】\n${tailText(read.join("\n"), 16_000)}` : "【你记得的前情】这是第一章，你刚点进这本书。",
    cast.length ? `【最近常出场的人物】\n${cast.map((item) => `- ${item.entity.name}${item.description ? `：${previewText(item.description, 60)}` : ""}`).join("\n")}` : "",
    previous.trim() ? `【上一章结尾】\n${tailText(previous.trim(), 800)}` : "",
  ].filter(Boolean).join("\n\n");
}

async function readAs(project: WriterProject, persona: Lens, context: string, position: number, text: string, signal?: AbortSignal): Promise<ReaderVoice> {
  const prompt = [
    `【你是】${persona.name}${persona.description ? `：${persona.description}` : ""}`,
    context,
    `【你刚读完】${chapterLabel(position)}「${orderedChapters(project)[position].title}」\n${previewText(text.trim(), CHAPTER_CHARS)}`,
    `【读完说说（照你的读者口味，说真实感受）】
- verdict：还会点开下一章吗？keep 会 / hesitate 犹豫 / drop 不追了；reason 一句话说为什么。
- retell：不回头看原文，凭记忆用两三句话说这一章发生了什么、主角为什么这么做。记错了也照实写。
- comment：你会在本章说或书评区里写的话，50–150 字。
- marks：3–8 条段评。quote 从正文里逐字复制你想评论的那一句（30 字以内），reaction 是你的即时反应，tone 填 up（好看）、down（出问题、出戏）或 aside（吐槽、玩梗、疑问）。
- guesses：你对后面剧情、人物真面目或幕后真相的推测。
- wants：你最想看到接下来发生的事，最迫切的在前，detail 说为什么。
- lost：没看懂、记不清是谁、要回头重读才明白、规矩算不通或前后对不上的地方；没有就给空数组。`,
    `输出 JSON：{"verdict":"keep|hesitate|drop","reason":"","retell":"","comment":"","marks":[{"quote":"","reaction":"","tone":"up|down|aside"}],"guesses":[""],"wants":[{"title":"","detail":""}],"lost":[{"title":"","detail":""}]}`,
  ].join("\n\n");
  return invokeJson({
    task: "ideas",
    system: `${resolvePrompt(project, "reader.system")}\n只输出要求的 JSON。`,
    prompt,
    effort: "low", temperature: 0.9,
    maxOutputTokens: 3_000,
    signal,
  }, (value) => {
    const voice = normalizeVoice({ ...asRecord(value), persona: persona.name });
    if (!voice || (!voice.comment && !voice.marks.length)) throw new Error(`${persona.name}没有给出反馈。`);
    voice.marks = voice.marks.map((mark) => (mark.quote && !text.includes(mark.quote) ? { ...mark, quote: "" } : mark));
    return voice;
  });
}

export type DigestRequest = { project: WriterProject; memory: MemoryView; chapterId: string; voices: ReaderVoice[]; story?: StoryPlan | null; signal?: AbortSignal };

/** The editor's pass over the panel: what landed, what is wrong, where readers split and where they missed the author's intent. */
export async function digestReaders({ project, memory, chapterId, voices, story, signal }: DigestRequest): Promise<ReaderDigest> {
  const task = domainTask<ReaderDigest>("digestReaders", [{ project, memory, chapterId, voices, story }], project.id, signal); if (task) return task;
  const chapters = orderedChapters(project);
  const position = chapters.findIndex((chapter) => chapter.id === chapterId);
  if (position < 0) throw new Error("章节不存在。");
  const [text, plan] = await Promise.all([loadChapterText(project.id, chapterId), story !== undefined ? Promise.resolve(story) : loadStoryPlan(project.id).catch(() => null)]);
  const card = memory.cardAt(position);
  const design = [
    ...(card?.threads ?? []).map((event) => `- ${EVENT_LABELS[event.type]}〔${THREAD_KIND_LABELS[event.kind]}〕${event.title}${event.description ? `：${event.description}` : ""}`),
    ...(card?.payoffs ?? []).map((payoff) => `- 兑现〔${payoff.type}〕${payoff.description}`),
  ];
  const secrets = unrevealedSecrets(plan, memory, position).slice(0, 15).map(({ secret, partial }) => {
    const revealAt = secret.readerRevealChapterId ? memory.position(secret.readerRevealChapterId) : -1;
    return `- ${secret.title}${partial ? "（已部分揭示）" : ""}：${previewText(secret.truth, 200)}${revealAt >= 0 ? `｜计划在${chapterLabel(revealAt)}揭示` : ""}`;
  });
  const threads = memory.openThreads(position + 1).filter((thread) => thread.plan.trim()).slice(0, 15).map((thread) => `- ${thread.title}：${thread.plan}`);
  const ahead = chapters.map((chapter, index) => ({ chapter, index })).slice(position + 1).filter(({ chapter }) => chapter.title.trim() || chapter.summary.trim()).slice(0, 5).map(({ chapter, index }) => `${chapterLabel(index)}「${chapter.title}」${chapter.summary ? `：${chapter.summary}` : ""}`);
  const promise = plan?.promise;
  const prompt = [
    `【作品】《${project.title}》｜${project.genre}${promise?.oneLiner ? `｜核心承诺：${promise.oneLiner}` : ""}${promise?.emotionalNeed ? `｜读者要的体验：${promise.emotionalNeed}` : ""}`,
    `【这一章】${chapterLabel(position)}「${chapters[position].title}」：${card?.summary || chapters[position].summary || "（暂无摘要）"}`,
    `【本章正文（核对复述用）】\n${previewText(text.trim(), CHAPTER_CHARS)}`,
    design.length ? `【这一章埋下、推进和兑现的】\n${design.join("\n")}` : "",
    secrets.length ? `【读者此时还不知道的真相】\n${secrets.join("\n")}` : "",
    threads.length ? `【作者对在途线索的计划】\n${threads.join("\n")}` : "",
    ahead.length ? `【后面的章节】\n${ahead.join("\n")}` : "",
    `【读者试读反馈】\n${voices.map(voiceText).join("\n\n")}`,
    `【任务】把这组反馈对照作者的设计，整理成作者能直接照着改的简报。先说结论，再说依据，用平常的话。
1. worked：几位读者都买账的写法和段落，以后继续这样写。
2. problems：真正的问题（人物知道了不该知道的事、对手降智、俗套、AI 套话、读不懂、前后矛盾），最严重的在前；detail 说哪几位读者提到、根子在哪。
3. splits：读者意见相反的地方（比如有人嫌慢、有人嫌不够爽），按本书的核心承诺和主要读者给出取舍。
4. intentGaps：读者读到的和作者想写的对不上的地方：底牌被提前看穿、关键伏笔没人注意、世界的规矩被读歪、期待对不上号。拿各位的复述对照【本章正文（核对复述用）】，核对关键事件、人物动机和因果；摘要没提到不代表正文没写。复述有错漏时，指出对应原句和可能让人误读的地方；有意留的悬念与普通的复述省略不算没写清，证据不够时说明需要作者判断。
5. actions：最多 4 条最要紧的修改或后续动作；scope 填 chapter（回头改这一章）或 next（在后面的章节里跟进）。
worked 和 problems 能落到正文某一句的，quote 照抄读者段评引用的那句原文，否则留空。没有的项给空数组。`,
    `输出 JSON：{"worked":[{"title":"","detail":"","quote":""}],"problems":[{"title":"","detail":"","quote":""}],"splits":[{"title":"","detail":""}],"intentGaps":[{"title":"","detail":""}],"actions":[{"title":"","detail":"","scope":"chapter|next"}]}`,
  ].filter(Boolean).join("\n\n");
  return invokeJson({
    task: "ideas",
    system: `${withGoal(project, "reader.digest")}\n只输出要求的 JSON。`,
    prompt,
    effort: "medium", temperature: 0.3,
    maxOutputTokens: 4_000,
    signal,
  }, (value) => {
    const digest = normalizeDigest(value);
    if (!digest.worked.length && !digest.problems.length && !digest.actions.length) throw new Error("模型没有给出汇总。");
    for (const item of [...digest.worked, ...digest.problems]) if (item.quote && !text.includes(item.quote)) item.quote = "";
    return digest;
  });
}

function voiceText(voice: ReaderVoice): string {
  const items = (list: { title: string; detail: string }[]) => list.map((item) => `${item.title}${item.detail ? `（${item.detail}）` : ""}`).join("；");
  return [
    `### ${voice.persona}（${READER_VERDICT_LABELS[voice.verdict]}${voice.reason ? `：${voice.reason}` : ""}）`,
    voice.comment ? `本章说：${voice.comment}` : "",
    voice.retell ? `复述：${voice.retell}` : "",
    voice.marks.length ? `段评：\n${voice.marks.map((mark) => `- ${mark.quote ? `“${mark.quote}” ` : ""}${mark.reaction}（${MARK_TONE_LABELS[mark.tone]}）`).join("\n")}` : "",
    voice.guesses.length ? `猜测：${voice.guesses.join("；")}` : "",
    voice.wants.length ? `想看：${items(voice.wants)}` : "",
    voice.lost.length ? `没看懂：${items(voice.lost)}` : "",
  ].filter(Boolean).join("\n");
}
