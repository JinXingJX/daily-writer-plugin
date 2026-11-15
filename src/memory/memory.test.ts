import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeHost, uninstallFakeHost, type FakeHost } from "../test/fakeHost";
import { splitManuscript, decodeManuscript } from "../ingest/splitter";
import { importManuscript } from "../ingest/import";
import { openProject, saveDraft, loadChapterTexts } from "../storage/projectStore";
import { runPipelineWork } from "../pipeline/engine";
import { listRuns } from "../pipeline/store";
import { startMemoryRun } from "../pipeline/templates";
import { testCard, threadEvent } from "../test/fixtures";
import { MemoryView } from "./view";
import { countMentions, Bm25Index } from "./text";
import { EntityRegistry, applyCardThreads } from "./ledger";
import type { ChapterCard } from "./schema";
import { normalizeSecret } from "../story/schema";
import { loadStoryPlan, mutateStoryPlan } from "../story/store";

let host: FakeHost;
beforeEach(() => { host = installFakeHost(); });
afterEach(() => uninstallFakeHost());

const BOOK = `书名\n\n第一卷 起风\n第一章 醒来\n林舟在青云宗醒来，左臂受伤。\n第二章 拜师\n林舟拜苏晚为师。苏晚说：三年后告诉你身世。\n第二卷 远行\n第三章 下山\n林舟下山。小舟，师父喊道。\n第四章 决战\n林舟击败赵烈，赵烈战死。\n第五章 重逢\n赵烈出现在城门口，冷笑。苏晚告诉林舟身世。`;

/** Deterministic fake model that "extracts" facts from the tiny test chapters. */
function fakeModel(prompt: string): string {
  if (prompt.includes("抽取故事记忆")) {
    const text = prompt.match(/「(.+?)」/)?.[1] ?? "";
    const card: Partial<ChapterCard> = { summary: `${text}摘要`, scenes: [], characters: [], entities: [], facts: [], threads: [], hook: "" };
    if (text.includes("醒来")) {
      card.entities = [{ name: "林舟", category: "character", aliases: [], description: "主角" }, { name: "青云宗", category: "faction", aliases: [], description: "宗门" }];
      card.facts = [{ subject: "林舟", attribute: "伤势", value: "左臂受伤", kind: "state", quote: "左臂受伤" }, { subject: "林舟", attribute: "出身", value: "孤儿", kind: "trait", quote: "" }];
    }
    if (text.includes("拜师")) {
      card.entities = [{ name: "苏晚", category: "character", aliases: [], description: "师父" }];
      card.threads = [threadEvent("plant", "林舟身世", "苏晚承诺三年后告知身世")];
    }
    if (text.includes("下山")) card.facts = [{ subject: "林舟", attribute: "位置", value: "山下", kind: "state", quote: "林舟下山" }, { subject: "林舟", attribute: "出身", value: "世家子弟", kind: "trait", quote: "" }];
    if (text.includes("决战")) card.facts = [{ subject: "赵烈", attribute: "生死", value: "战死", kind: "state", quote: "赵烈战死" }];
    if (text.includes("重逢")) {
      card.scenes = [{ title: "城门", time: "", location: "城门", characters: ["赵烈", "林舟"], summary: "赵烈出现" }];
      card.threads = [threadEvent("payoff", "林舟身世", "苏晚说出身世")];
    }
    return JSON.stringify(card);
  }
  if (prompt.includes("归纳为一个情节弧")) return JSON.stringify({ title: "弧", summary: "弧摘要", conflicts: "", growth: "" });
  if (prompt.includes("写卷大纲")) return JSON.stringify({ summary: "卷摘要", mainline: "主线", sublines: "" });
  if (prompt.includes("写全书大纲")) return JSON.stringify({ outline: "# 全书", mainline: "主线", characterArcs: "" });
  if (prompt.includes("判断每一对")) return JSON.stringify({ same: [] });
  if (prompt.includes("\"profiles\"")) return JSON.stringify({ profiles: [{ name: "林舟", summary: "青云宗弟子" }] });
  if (prompt.includes("设定集章节")) return "## 设定\n- 内容〔第1章〕";
  return "{}";
}

describe("splitter", () => {
  it("splits volumes and chapters and decodes GB18030", () => {
    const split = splitManuscript(BOOK, { mode: "auto", targetLength: 3000 });
    expect(split.mode).toBe("heading");
    expect(split.volumes).toEqual(["第一卷 起风", "第二卷 远行"]);
    expect(split.chapters.map((chapter) => chapter.title)).toEqual(["第一章 醒来", "第二章 拜师", "第三章 下山", "第四章 决战", "第五章 重逢"]);
    expect(split.chapters[2].volumeTitle).toBe("第二卷 远行");
    const gbk = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]);
    expect(decodeManuscript(gbk.buffer)).toBe("你好");
  });
  it("falls back to length splitting without headings", () => {
    const text = Array.from({ length: 40 }, (_, index) => `段落${index}${"字".repeat(200)}`).join("\n");
    const split = splitManuscript(text, { mode: "auto", targetLength: 2000 });
    expect(split.mode).toBe("length");
    expect(split.chapters.length).toBeGreaterThan(2);
    expect(split.chapters.map((chapter) => chapter.content).join("\n")).toBe(text);
  });
});

describe("text indexes", () => {
  it("counts mentions with longest-name priority and ranks with BM25", () => {
    expect(countMentions("林舟和小舟，林舟。", ["林舟", "舟", "小舟"])).toEqual({ 林舟: 2, 小舟: 1 });
    const index = new Bm25Index();
    index.add("a", "林舟拜师学艺");
    index.add("b", "赵烈在城门");
    expect(index.search("拜师")[0].id).toBe("a");
  });
  it("merges aliases and links thread payoffs by title", () => {
    const registry = new EntityRegistry([]);
    const lin = registry.upsert({ name: "林舟", category: "character" });
    registry.upsert({ name: "林舟", category: "character", aliases: ["小舟"] });
    expect(registry.resolve("小舟")?.id).toBe(lin.id);
    const card = (id: string, threads: ChapterCard["threads"]) => testCard(id, { threads });
    let threads = applyCardThreads([], card("c1", [threadEvent("plant", "身世", "", { kind: "mystery", tier: "volume" })]));
    expect(threads[0]).toMatchObject({ kind: "mystery", tier: "volume", progress: 0.1 });
    threads = applyCardThreads(threads, card("c3", [threadEvent("advance", "身世")]));
    expect(threads[0].progress).toBeCloseTo(0.3);
    threads = applyCardThreads(threads, card("c5", [threadEvent("payoff", "身世")]));
    expect(threads).toHaveLength(1);
    expect(threads[0].status).toBe("paid");
    expect(threads[0].progress).toBe(1);
    threads = applyCardThreads(threads, card("c5", []));
    expect(threads[0].status).toBe("open");
    expect(threads[0].progress).toBeCloseTo(0.3);
  });
});

describe("memory build", () => {
  it("imports a book, builds memory end-to-end and answers state queries", async () => {
    host.setModel(fakeModel);
    const project = await importManuscript(splitManuscript(BOOK, { mode: "auto", targetLength: 3000 }), { title: "测试" });
    expect(project.volumes.map((volume) => volume.title)).toEqual(["第一卷 起风", "第二卷 远行"]);
    expect(project.chapters).toHaveLength(5);

    await startMemoryRun(project.id);
    expect(await runPipelineWork(project.id, "test-owner")).toBe(true);
    expect((await listRuns(project.id))[0]).toMatchObject({ state: "done", template: "memory" });
    const view = await MemoryView.load(await openProject(project.id));
    expect(view.staleChapterIds()).toEqual([]);
    expect(view.status.state).toBe("done");
    const lin = view.resolve("林舟");
    expect(lin).toBeTruthy();
    const ids = view.orderedIds;
    expect(view.stateAt(lin!.id, 0)["伤势"].value).toBe("左臂受伤");
    expect(view.stateAt(lin!.id, 2)["位置"].value).toBe("山下");
    expect(view.stateAt(lin!.id, 1)["位置"]).toBeUndefined();
    expect(view.threads.find((thread) => thread.title === "林舟身世")?.status).toBe("paid");
    expect(view.aggregates.arcs).toHaveLength(2);
    expect(view.aggregates.book?.outline).toBe("# 全书");
    expect(view.aggregates.worldview?.sections.length).toBeGreaterThan(0);
    expect(view.entity(lin!.id)?.summary).toBe("青云宗弟子");
    expect(view.conflicts.map((conflict) => conflict.kind).sort()).toEqual(["death", "trait"]);
    expect(view.relatedChapters([lin!.id], 4)[0]).toBeDefined();

    // Editing one chapter makes only that chapter stale; a rerun re-extracts only it.
    const loaded = await openProject(project.id);
    const base = { project: loaded, texts: await loadChapterTexts(project.id, [ids[1]]) };
    const next = structuredClone(base);
    next.texts[ids[1]] += "\n补充一句。";
    const saved = await saveDraft(base, next);
    const stale = (await MemoryView.load(saved.draft.project)).staleChapterIds();
    expect(stale).toEqual([ids[1]]);
    const before = host.modelCalls.length;
    await startMemoryRun(project.id, ["extract", "arcs"]);
    await runPipelineWork(project.id, "test-owner");
    const extractCalls = host.modelCalls.slice(before).filter((call) => call.prompt.includes("抽取故事记忆"));
    expect(extractCalls).toHaveLength(1);
    expect(host.modelCalls.slice(before).filter((call) => call.prompt.includes("归纳为一个情节弧"))).toHaveLength(1);
  });

  it("does nothing without queued runs and respects an existing lease", async () => {
    host.setModel(fakeModel);
    const project = await importManuscript(splitManuscript(BOOK, { mode: "auto", targetLength: 3000 }), { title: "测试" });
    expect(await runPipelineWork(project.id, "a")).toBe(true);
    expect(host.modelCalls).toHaveLength(0);
    await startMemoryRun(project.id, ["extract"]);
    host.storage.set(`writer.pipeline.lease.${project.id}`, { owner: "other", expiresAt: Date.now() + 60_000 });
    expect(await runPipelineWork(project.id, "a")).toBe(false);
    expect(host.modelCalls).toHaveLength(0);
  });

  it("stores card v2 fields and folds knowledge of tracked secrets into the story plan", async () => {
    const project = await importManuscript(splitManuscript(BOOK, { mode: "auto", targetLength: 3000 }), { title: "测试" });
    await mutateStoryPlan(project.id, (plan) => { plan.secrets.push(normalizeSecret({ id: "secret-origin", title: "林舟的身世", truth: "林舟是世家之后" })); });
    host.setModel((prompt) => {
      if (!prompt.includes("抽取故事记忆")) return fakeModel(prompt);
      expect(prompt).toContain("secret-origin");
      const reveal = prompt.includes("重逢");
      return JSON.stringify({ summary: "s", emotionBeats: [{ type: "suppress", reason: "师命难违" }], payoffs: reveal ? [{ type: "揭穿", description: "身世揭开" }] : [], changes: ["info", "nope"], knowledge: reveal ? [{ who: "林舟", learns: "身世", source: "苏晚亲口说", secretId: "secret-origin" }] : [], intimacy: reveal ? [{ a: "林舟", b: "苏晚", delta: 2, event: "说出身世" }] : [], newCast: [] });
    });
    await startMemoryRun(project.id, ["extract"]);
    await runPipelineWork(project.id, "a");
    const view = await MemoryView.load(await openProject(project.id));
    const last = view.cardAt(4)!;
    expect(last.changes).toEqual(["info"]);
    expect(last.payoffs[0].type).toBe("揭穿");
    expect(last.emotionBeats[0]).toEqual({ type: "suppress", reason: "师命难违" });
    const plan = await loadStoryPlan(project.id);
    expect(plan.secrets[0].knownBy).toEqual([{ who: "林舟", chapterId: view.orderedIds[4], source: "苏晚亲口说", origin: "extracted" }]);
    expect(plan.relations[0]).toMatchObject({ a: "林舟", b: "苏晚" });
    expect(plan.relations[0].intimacy[0]).toMatchObject({ level: 5, origin: "extracted" });
  });
});
