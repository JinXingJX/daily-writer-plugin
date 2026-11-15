// Exercise domain behavior independently of task submission and finalization.
vi.mock("../worker/domainTask", () => ({ domainTask: () => null }));
import { vi, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWritingContext } from "../ai/context";
import { generateBriefing, simulateReaders } from "../ai/pipelines/notebook";
import { orderedChapters } from "../domain/documents";
import { importManuscript } from "../ingest/import";
import { splitManuscript } from "../ingest/splitter";
import { EntityRegistry, applyCardThreads } from "../memory/ledger";
import { emptyStatus, type ChapterCard, type StoryThread } from "../memory/schema";
import { MemoryView } from "../memory/view";
import { openProject } from "../storage/projectStore";
import { installFakeHost, uninstallFakeHost, type FakeHost } from "../test/fakeHost";
import type { WriterProject } from "../types";
import { chaptersBasis, readerKnowledge, unrevealedSecrets, writingProgress } from "./derive";
import { emptyNotebook, MAX_READER_SNAPSHOTS, normalizeReader, normalizeVoice, panelWants, verdictTally } from "./schema";
import { loadNotebook, updateNotebook } from "./store";
import { emptyStoryPlan, normalizeSecret } from "../story/schema";
import { testCard, threadEvent } from "../test/fixtures";

let host: FakeHost;
beforeEach(() => { host = installFakeHost(); });
afterEach(() => uninstallFakeHost());

const BOOK = `书名\n\n第一卷 起风\n第一章 醒来\n林舟在青云宗醒来，左臂受伤。\n第二章 拜师\n林舟拜苏晚为师。苏晚说：三年后告诉你身世。\n第三章 下山\n林舟下山。\n第四章 重逢\n苏晚告诉林舟身世。`;

const card = (chapterId: string, patch: Partial<ChapterCard>): ChapterCard => testCard(chapterId, patch);

/** Builds a memory view by hand: 苏晚 appears from chapter 2, the 身世 thread is planted in 2 and paid off in 4. */
async function setup(): Promise<{ project: WriterProject; memory: MemoryView; ids: string[] }> {
  const imported = await importManuscript(splitManuscript(BOOK, { mode: "auto", targetLength: 3000 }), { title: "测试" });
  const project = await openProject(imported.id);
  const ids = orderedChapters(project).map((chapter) => chapter.id);
  const cards = [
    card(ids[0], { summary: "林舟醒来", mentions: { 林舟: 1 }, entities: [{ name: "林舟", category: "character", aliases: [], description: "青云宗弟子" }], facts: [{ subject: "林舟", attribute: "伤势", value: "左臂受伤", kind: "state", quote: "左臂受伤" }, { subject: "青云宗", attribute: "门规", value: "弟子不得下山", kind: "rule", quote: "" }], hook: "谁救了他" }),
    card(ids[1], { summary: "拜师苏晚", mentions: { 林舟: 1, 苏晚: 2 }, entities: [{ name: "苏晚", category: "character", aliases: [], description: "林舟的师父" }], threads: [threadEvent("plant", "林舟身世", "苏晚承诺三年后告知", { kind: "mystery" })] }),
    card(ids[2], { summary: "下山", mentions: { 林舟: 1 }, facts: [{ subject: "林舟", attribute: "位置", value: "山下", kind: "state", quote: "林舟下山" }] }),
    card(ids[3], { summary: "苏晚说出林舟是世家之后", mentions: { 林舟: 1, 苏晚: 1 }, threads: [threadEvent("payoff", "林舟身世", "苏晚说出身世")] }),
  ];
  const registry = new EntityRegistry([]);
  registry.upsert({ name: "林舟", category: "character" });
  registry.upsert({ name: "苏晚", category: "character" });
  registry.upsert({ name: "青云宗", category: "faction" });
  let threads: StoryThread[] = [];
  for (const item of cards) threads = applyCardThreads(threads, item);
  const memory = new MemoryView(project, new Map(cards.map((item) => [item.chapterId, item])), registry.entities, threads, { arcs: [], volumes: [], book: null, worldview: null }, [], emptyStatus());
  return { project, memory, ids };
}

describe("writing progress", () => {
  it("finds the last written chapter and planned chapters after it", async () => {
    const { project } = await setup();
    const chapters = orderedChapters(project);
    const withPlan = structuredClone(project);
    withPlan.chapters.push({ ...chapters[3], id: "chapter-planned", rank: chapters[3].rank + 1, wordCount: 0, contentHash: "", title: "第五章" });
    const progress = writingProgress(withPlan);
    expect(progress.frontier?.id).toBe(chapters[3].id);
    expect(progress.frontierPosition).toBe(3);
    expect(progress.writtenCount).toBe(4);
    expect(progress.plannedAhead).toBe(1);
    expect(chaptersBasis(withPlan, 4)).toBe(chaptersBasis(project, 4));
  });
});

describe("reader knowledge", () => {
  it("only uses what the reader has read up to the position", async () => {
    const { memory } = await setup();
    const first = readerKnowledge(memory, 0);
    expect(first.characters.map((item) => item.entity.name)).toEqual(["林舟"]);
    expect(first.characters[0].state.map((fact) => fact.value)).toEqual(["左臂受伤"]);
    expect(first.rules.map((fact) => fact.value)).toEqual(["弟子不得下山"]);
    expect(first.openQuestions).toEqual([]);
    expect(first.hook).toBe("谁救了他");

    const second = readerKnowledge(memory, 1);
    expect(second.characters.map((item) => item.entity.name).sort()).toEqual(["林舟", "苏晚"]);
    expect(second.characters.find((item) => item.entity.name === "苏晚")?.description).toBe("林舟的师父");
    // The thread is paid off in chapter 4, but a reader at chapter 2 still has the open question.
    expect(second.openQuestions.map((item) => item.thread.title)).toEqual(["林舟身世"]);
    expect(second.resolved).toEqual([]);

    const last = readerKnowledge(memory, 3);
    expect(last.openQuestions).toEqual([]);
    expect(last.resolved[0].resolvedAt).toBe(3);
    expect(last.characters.find((item) => item.entity.name === "林舟")?.state.map((fact) => fact.value).sort()).toEqual(["山下", "左臂受伤"]);
  });

  it("keeps a hidden line from the reader until its reveal chapter", async () => {
    const { memory, ids } = await setup();
    const story = emptyStoryPlan();
    story.secrets.push(
      normalizeSecret({ id: "s1", title: "林舟的真实身份", truth: "世家之后", readerRevealChapterId: ids[3], status: "revealed" }),
      normalizeSecret({ id: "s2", title: "苏晚的伤", truth: "旧伤未愈", status: "partial" }),
      normalizeSecret({ id: "s3", title: "宗门旧案", truth: "早已公开", status: "revealed" }),
    );
    expect(unrevealedSecrets(story, memory, 1).map((item) => [item.secret.id, item.partial])).toEqual([["s1", false], ["s2", true]]);
    expect(unrevealedSecrets(story, memory, 3).map((item) => item.secret.id)).toEqual(["s2"]);
    expect(unrevealedSecrets(null, memory, 3)).toEqual([]);
  });
});

describe("notebook store", () => {
  it("round-trips notes and caps reader snapshots", async () => {
    const { project } = await setup();
    expect(await loadNotebook(project.id)).toEqual(emptyNotebook());
    await updateNotebook(project.id, (draft) => {
      draft.notes.push({ id: "n1", kind: "craft", text: "玉佩", plan: "第十章揭开", chapterId: null, done: false, origin: "user", createdAt: 1, updatedAt: 1 });
      for (let index = 0; index < MAX_READER_SNAPSHOTS + 5; index += 1) {
        draft.readers[`c${index}`] = { chapterId: `c${index}`, basis: "", voices: [], failed: [], digest: null, generatedAt: index };
      }
    });
    const loaded = await loadNotebook(project.id);
    expect(loaded.notes[0]).toMatchObject({ kind: "craft", text: "玉佩", plan: "第十章揭开" });
    expect(Object.keys(loaded.readers)).toHaveLength(MAX_READER_SNAPSHOTS);
    expect(loaded.readers.c0).toBeUndefined();
  });

  it("normalizes and persists reader retellings without inventing one when absent", async () => {
    expect(normalizeVoice({ persona: "读者", retell: 42 })?.retell).toBe("");
    expect(normalizeVoice({ persona: "读者" })?.retell).toBe("");
    const snapshot = normalizeReader({ chapterId: "c1", voices: [{ persona: "读者", retell: "  林舟拜师，为了查身世。  " }] })!;
    expect(snapshot.voices[0].retell).toBe("林舟拜师，为了查身世。");
    await updateNotebook("p", (draft) => { draft.readers.c1 = snapshot; });
    expect((await loadNotebook("p")).readers.c1.voices[0].retell).toBe("林舟拜师，为了查身世。");
  });

  it("drops reader snapshots from before the reader panel", () => {
    expect(normalizeReader({ chapterId: "c1", basis: "", summary: "旧版读者", knows: [], wants: [], generatedAt: 1 })).toBeNull();
  });
});

describe("notebook AI", () => {
  it("feeds open notes, thread plans, the promise, expectations and what characters know into the writing context", async () => {
    const { project, memory: full, ids } = await setup();
    const threads = full.threads.map((item) => ({ ...item, plan: "借师兄之口说破", progress: 0.6 }));
    const memory = new MemoryView(project, full.cards, full.entities, threads, full.aggregates, [], full.status);
    const notebook = { ...emptyNotebook(), notes: [
      { id: "a", kind: "focus" as const, text: "林舟的伤要一直疼", plan: "", chapterId: null, done: false, origin: "user" as const, createdAt: 0, updatedAt: 0 },
      { id: "b", kind: "todo" as const, text: "已经改完的事", plan: "", chapterId: null, done: true, origin: "user" as const, createdAt: 0, updatedAt: 0 },
    ] };
    const story = emptyStoryPlan();
    story.promise.oneLiner = "孤儿凭师门旧账翻身";
    story.secrets.push(normalizeSecret({ id: "s1", title: "林舟的真实身份", truth: "世家之后", knownBy: [{ who: "苏晚", chapterId: null, source: "当年亲历", origin: "user" }] }));
    // Position 2: the 身世 thread is planted in chapter 2 and still open there.
    const context = buildWritingContext({ project, memory: memory.withProject(project), position: 2, focus: "林舟和苏晚", notebook, story });
    expect(context.text).toContain("林舟的伤要一直疼");
    expect(context.text).not.toContain("已经改完的事");
    expect(context.text).toContain("借师兄之口说破");
    expect(context.text).toContain("孤儿凭师门旧账翻身");
    expect(context.text).toContain("读者正在等的事");
    expect(context.text).toContain("快兑现了，还没有接棒");
    expect(context.text).toMatch(/◆ 林舟[\s\S]*不知道 林舟的真实身份/);
    expect(context.text).toMatch(/◆ 苏晚[\s\S]*已知 林舟的真实身份/);
    // After the payoff in chapter 4 the thread no longer counts as open.
    expect(buildWritingContext({ project, memory: memory.withProject(project), position: 4, focus: "", notebook, story }).text).not.toContain("读者正在等的事");
    expect(ids).toHaveLength(4);
  });

  it("generates a briefing with chapter links and known thread ids only", async () => {
    const { project, memory, ids } = await setup();
    host.setModel(() => JSON.stringify({ progress: "第一卷收尾", storySoFar: "林舟拜师下山", focus: ["伤势"], next: [{ title: "补写师徒对话", detail: "", chapter: 2 }, { title: "写第五章", detail: "", chapter: null }], threads: [{ threadId: memory.threads[0].id, title: "身世", plan: "回收" }, { threadId: "made-up", title: "x", plan: "y" }], risks: [], promiseDrift: "最近两章在写宗门内斗，离复仇主线远了", gaps: ["第3章没有新的期待"] }));
    const briefing = await generateBriefing({ project, memory, notebook: emptyNotebook() });
    expect(briefing.position).toBe(4);
    expect(briefing.basis).toBe(chaptersBasis(project, 4));
    expect(briefing.next.map((step) => step.chapterId)).toEqual([ids[1], null]);
    expect(briefing.threads.map((thread) => thread.threadId)).toEqual([memory.threads[0].id, null]);
    expect(briefing.promiseDrift).toContain("复仇主线");
    expect(briefing.gaps).toEqual(["第3章没有新的期待"]);
  });

  it("has each panel member read the chapter text alone, then sums the panel up against the author's intent", async () => {
    const { project, memory, ids } = await setup();
    project.prompts.overrides["reader.panel"] = "追更党：每天看一章\n考据党：盯着账目和规则";
    const story = emptyStoryPlan();
    story.promise.oneLiner = "孤儿凭师门旧账翻身";
    story.secrets.push(normalizeSecret({ id: "s1", title: "林舟的真实身份", truth: "世家之后", readerRevealChapterId: ids[3] }));
    host.setModel((prompt) => {
      if (prompt.includes("【读者试读反馈】")) return JSON.stringify({ worked: [{ title: "三年之约勾人", detail: "", quote: "三年后告诉你身世" }], problems: [{ title: "拜师太快", detail: "追更党觉得没铺垫", quote: "原文里没有这句" }], splits: [], intentGaps: [{ title: "读者已经猜到世家身份", detail: "" }], actions: [{ title: "补一场拜师前的试探", detail: "", scope: "chapter" }, { title: "下一章让身世线往前走一步", detail: "", scope: "next" }] });
      if (prompt.includes("【你是】考据党")) return "看不下去了";
      return JSON.stringify({ verdict: "keep", reason: "想知道身世", retell: "林舟拜苏晚为师，苏晚答应三年后告诉他身世。", comment: "师父说三年后告诉身世，这个钩子我吃了。", marks: [{ quote: "三年后告诉你身世", reaction: "三年？作者你认真的？", tone: "aside" }, { quote: "原文里没有这句", reaction: "编的", tone: "down" }], guesses: ["林舟是世家之后"], wants: [{ title: "身世揭开", detail: "" }, { title: "苏晚的来历", detail: "" }], lost: [] });
    });
    const progress: number[] = [];
    const snapshot = await simulateReaders({ project, memory, chapterId: ids[1], story, onProgress: (done) => progress.push(done) });

    // A member whose answer never parses is listed as failed; the rest of the panel stands.
    expect(snapshot.voices.map((voice) => voice.persona)).toEqual(["追更党"]);
    expect(snapshot.failed).toEqual(["考据党"]);
    expect(snapshot.voices[0].retell).toBe("林舟拜苏晚为师，苏晚答应三年后告诉他身世。");
    expect(progress).toEqual([0, 1, 2]);
    expect(snapshot.voices[0].marks.map((mark) => mark.quote)).toEqual(["三年后告诉你身世", ""]);
    expect(verdictTally(snapshot)).toEqual({ keep: 1, hesitate: 0, drop: 0 });
    expect(panelWants(snapshot, 5).map((item) => item.title)).toEqual(["身世揭开", "苏晚的来历"]);
    expect(snapshot.basis).toBe(chaptersBasis(project, 2));
    expect(snapshot.digest?.worked[0].quote).toBe("三年后告诉你身世");
    expect(snapshot.digest?.problems[0].quote).toBe("");
    expect(snapshot.digest?.actions.map((action) => action.scope)).toEqual(["chapter", "next"]);

    // The reader reads the chapter itself and remembers what a reader would; no author material, no later chapters.
    const reader = host.modelCalls.find((call) => call.prompt.includes("【你是】追更党"))!;
    expect(reader.prompt).toContain("苏晚说：三年后告诉你身世");
    expect(reader.prompt).toContain("林舟在青云宗醒来");
    expect(reader.prompt).toContain("孤儿凭师门旧账翻身");
    expect(reader.prompt).toContain("- 林舟：青云宗弟子");
    for (const leak of ["世家之后", "林舟下山", "苏晚告诉林舟身世", "弟子不得下山"]) expect(reader.prompt).not.toContain(leak);
    expect(reader.system).toContain("真实的网文读者");
    expect(reader.prompt).toContain("凭记忆用两三句话");
    expect(reader.system).not.toContain("【创作目标】");

    // The editor sees the panel next to what the author planted and keeps hidden.
    const editor = host.modelCalls.find((call) => call.prompt.includes("【读者试读反馈】"))!;
    expect(editor.prompt).toContain("### 追更党（继续追：想知道身世）");
    expect(editor.prompt).toContain("埋下〔悬念〕林舟身世");
    expect(editor.prompt).toContain("复述：林舟拜苏晚为师，苏晚答应三年后告诉他身世。");
    expect(editor.prompt).toContain("【本章正文（核对复述用）】\n林舟拜苏晚为师。苏晚说：三年后告诉你身世。");
    expect(editor.prompt).toContain("摘要没提到不代表正文没写");
    expect(editor.prompt).toContain("林舟的真实身份：世家之后｜计划在第 4 章揭示");
    expect(editor.system).toContain("【创作目标】");
  });

  it("fails when no panel member finishes, and keeps the voices when the summary fails", async () => {
    const { project, memory, ids } = await setup();
    project.prompts.overrides["reader.panel"] = "追更党：每天看一章";
    host.setModel(() => "看不下去了");
    await expect(simulateReaders({ project, memory, chapterId: ids[1], story: null })).rejects.toThrow();
    host.setModel((prompt) => (prompt.includes("【读者试读反馈】") ? "{}" : JSON.stringify({ verdict: "drop", reason: "太慢", comment: "弃了", marks: [], guesses: [], wants: [], lost: [] })));
    const snapshot = await simulateReaders({ project, memory, chapterId: ids[1], story: null });
    expect(snapshot.voices[0].verdict).toBe("drop");
    expect(snapshot.digest).toBeNull();
  });
});
