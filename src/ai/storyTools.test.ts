import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeChapterMeta, normalizeProject } from "../domain/normalize";
import { newThread, saveThread } from "../memory/operations";
import { MemoryView } from "../memory/view";
import { createProject } from "../storage/projectStore";
import { addSample } from "../storage/sampleStore";
import { installFakeHost, uninstallFakeHost, type FakeHost } from "../test/fakeHost";
import type { WriterProject } from "../types";
import { TOOL_HANDLERS, type RunState } from "./agentTools";
import { diagnoseBlock, normalizeBlockCard } from "./pipelines/blockDoctor";
import { normalizePlan, sceneSpan, SPAN_WORDS, writeScenes, type GenerationSession } from "./pipelines/nextChapter";
import { resolvePrompt } from "./promptRegistry";
import { writerSystem } from "./prompts";
import { writerTools } from "./tools";

let host: FakeHost;
beforeEach(() => { host = installFakeHost(); });
afterEach(() => uninstallFakeHost());

function state(project: WriterProject): RunState {
  return { projectId: project.id, sessionId: "s", instruction: "", supersedes: null, draft: project, base: {}, texts: {}, changes: [], comments: [], displays: [], eventViews: [], selection: null, activeDoc: { kind: "outline" } };
}

describe("prompts and tools", () => {
  it("gives prose calls the role, the writing goal and the work's style samples", async () => {
    const value = normalizeProject({ schemaVersion: 3, id: "p", title: "书" });
    expect(await writerSystem(value)).not.toContain("【样章】");
    await addSample("p", "第六章", "居盈窗外观景。醒言暗吞口水。");
    const system = await writerSystem(value);
    expect(system).toContain("执笔者");
    expect(system).toContain("【样章】");
    expect(system.indexOf("【创作目标】")).toBeGreaterThan(-1);
    expect(system.indexOf("【创作目标】")).toBeLessThan(system.indexOf("【样章】"));
    expect(system).toContain("逻辑经得起盘");
    expect(system).toContain("〔第六章〕\n居盈窗外观景。醒言暗吞口水。");
    expect(resolvePrompt(value, "task.scene", { scenes: "场景1「s」", words: 800, position: "" })).toContain("接着写场景1「s」，约 800 字");
  });

  it("writes consecutive scenes as one passage, up to about a chapter per call", async () => {
    const plan = normalizePlan({ title: "章", hook: "门外有人", scenes: [{ title: "进门", goal: "a", words: 1500 }, { title: "翻账", goal: "b", words: 1500 }, { title: "撞见", goal: "c", words: 1200 }, { title: "收尾", goal: "d", words: 800 }] });
    expect(SPAN_WORDS).toBeGreaterThanOrEqual(2_700);
    expect(sceneSpan(plan, 0)).toEqual([0, 1]);
    expect(sceneSpan(plan, 2)).toEqual([2, 3]);
    expect(sceneSpan(plan, 0, new Set([1]))).toEqual([0]);
    const long = normalizePlan({ title: "章", scenes: [{ title: "长", goal: "a", words: 6000 }, { title: "短", goal: "b", words: 500 }] });
    expect(sceneSpan(long, 0)).toEqual([0]);
    const prompts: string[] = [];
    host.setModel((prompt) => { prompts.push(prompt); return "正文。"; });
    const value = normalizeProject({ schemaVersion: 3, id: "p", title: "书" });
    const session = { project: value, memory: null, story: null, position: 0, context: { text: "", included: [], dropped: [], chars: 0 } } satisfies GenerationSession;
    await writeScenes(session, plan, [2, 3], "前两场的正文。");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("接着写场景3「撞见」到场景4「收尾」，约 2000 字");
    expect(prompts[0]).toContain("不每场重新开头");
    expect(prompts[0]).toContain("停在钩子上：门外有人");
    expect(prompts[0]).toContain("【本章已写内容】\n前两场的正文。");
  });

  it("gives every tool but the author question a handler", () => {
    const ids = writerTools().map((tool) => tool.id);
    expect(ids).toEqual(expect.arrayContaining(["writer.readStoryPlan", "writer.updateStoryPlan", "writer.diagnoseStory", "writer.readStyleSamples"]));
    expect(ids).not.toEqual(expect.arrayContaining(["writer.proposePlan"]));
    for (const id of ids) if (id !== "writer.askUser") expect(TOOL_HANDLERS[id]).toBeTypeOf("function");
  });

  it("lists the samples and reads one in pages", async () => {
    const project = normalizeProject({ schemaVersion: 3, id: "p", title: "书" });
    const run = state(project);
    expect((await TOOL_HANDLERS["writer.readStyleSamples"]({ state: run, memory: null, input: {} })).observation).toContain("还没有样章");
    const sample = await addSample("p", "样一", "甲".repeat(25_000));
    expect((await TOOL_HANDLERS["writer.readStyleSamples"]({ state: run, memory: null, input: {} })).observation).toContain(`sampleId=${sample.id}`);
    const page = (await TOOL_HANDLERS["writer.readStyleSamples"]({ state: run, memory: null, input: { sampleId: sample.id, offset: 20_000 } })).observation;
    expect(page).toContain("返回 20000-25000");
  });
});

describe("agent story tools", () => {
  it("turns thread edits, plan edits and thread payoff plans into proposal changes instead of writing directly", async () => {
    const project = await createProject({ title: "书" });
    project.chapters.push(normalizeChapterMeta({ id: "c1", volumeId: project.volumes[0].id, title: "一", rank: 1024 }));
    await saveThread(project.id, newThread({ id: "t1", title: "玉佩", kind: "foreshadow" }));
    const memory = await MemoryView.load(project);
    const run = state(project);
    await TOOL_HANDLERS["writer.updateThread"]({ state: run, memory, input: { title: "三年之约", kind: "expectation", successorOf: "t1" } });
    await TOOL_HANDLERS["writer.updateStoryPlan"]({ state: run, memory, input: { operations: [{ type: "setPromise", promise: { oneLiner: "以弱胜强" } }] } });
    expect(run.changes.map((change) => change.kind)).toEqual(["thread", "thread", "story"]);
    // Nothing reached the stores yet.
    expect((await MemoryView.load(project)).threads.map((thread) => thread.id)).toEqual(["t1"]);
    const plan = (await TOOL_HANDLERS["writer.readStoryPlan"]({ state: run, memory, input: {} })).observation;
    expect(plan).toContain("【核心承诺】（未写）");
    const health = (await TOOL_HANDLERS["writer.diagnoseStory"]({ state: run, memory, input: {} })).observation;
    expect(health).toContain("核心承诺");
  });
});

describe("block doctor", () => {
  it("normalizes the block card and routes by the model's verdict", async () => {
    expect(normalizeBlockCard({ type: "nope", facts: "x" })).toEqual({ type: null, facts: "x", want: "", emotion: "", note: "" });
    const project = normalizeProject({ schemaVersion: 3, id: "p", title: "书" });
    host.setModel((prompt) => {
      expect(prompt).toContain("卡点类型：缺切口");
      expect(prompt).toContain("analysis 用一两句先说卡在哪、为什么");
      expect(prompt).toContain("保留前文事实和人物此刻知道的事");
      expect(prompt).not.toMatch(/局势位移|核心阅读情绪|破冰衔接/);
      return JSON.stringify({ type: "entry", analysis: "知道要决裂，不知道从哪切", emotion: "压抑后的爆发", approaches: [{ title: "旧账", entry: "从账本切入" }], branches: [] });
    });
    const result = await diagnoseBlock({ project, memory: null, story: null, position: 0, card: normalizeBlockCard({ type: "entry", want: "离开师门" }), focus: "" });
    expect(result.type).toBe("entry");
    expect(result.approaches[0].entry).toBe("从账本切入");
    host.setModel(() => JSON.stringify({ type: "unknown" }));
    expect((await diagnoseBlock({ project, memory: null, story: null, position: 0, card: normalizeBlockCard({ type: "energy" }), focus: "" })).type).toBe("energy");
  });
});
