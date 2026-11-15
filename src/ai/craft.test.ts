import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeChapterMeta, normalizeProject } from "../domain/normalize";
import { updateNotebook } from "../notes/store";
import { installFakeHost, uninstallFakeHost, type FakeHost } from "../test/fakeHost";
import type { AgentTaskResponse, WriterProject } from "../types";
import { runAgent } from "./agent";
import { TOOL_HANDLERS, type RunState } from "./agentTools";
import { CRAFT_TOPICS } from "./craft";
import { CRAFT_CARDS, craftCard, craftCardText, matchCraftCards } from "./craft/library";
import { agentSystem } from "./prompts";
import { writerTools } from "./tools";

let host: FakeHost;
beforeEach(() => { host = installFakeHost(); });
afterEach(() => uninstallFakeHost());

function project(): WriterProject {
  const value = normalizeProject({ schemaVersion: 3, id: "p", title: "雾港", genre: "悬疑" });
  value.chapters.push(normalizeChapterMeta({ id: "c0", volumeId: value.volumes[0].id, title: "第一章", rank: 1024, wordCount: 10 }));
  return value;
}

function state(work: WriterProject): RunState {
  return { projectId: work.id, sessionId: "s", instruction: "", supersedes: null, draft: work, base: {}, texts: {}, changes: [], comments: [], displays: [], eventViews: [], selection: null, activeDoc: { kind: "chapter", id: "c0" } };
}

const run = (work: WriterProject, toolId: string, input: Record<string, unknown>) => TOOL_HANDLERS[toolId]({ state: state(work), input, memory: null });

describe("craft cards", () => {
  it("covers every craft topic and says when a method does not apply", () => {
    expect(CRAFT_CARDS.map((card) => card.id).sort()).toEqual(CRAFT_TOPICS.map((topic) => topic.id).sort());
    for (const card of CRAFT_CARDS) {
      expect(card.label).toBe(CRAFT_TOPICS.find((topic) => topic.id === card.id)?.label);
      expect(card.limits.length, card.id).toBeGreaterThan(0);
      expect(card.symptoms.length, card.id).toBeGreaterThan(0);
      expect(craftCardText(card).length, card.id).toBeLessThan(900);
    }
  });

  it("finds cards by id, label or the author's description", () => {
    expect(craftCard("金手指")?.id).toBe("power");
    expect(craftCard("tension")?.label).toBe("紧张场景");
    expect(matchCraftCards("我卡文了").map((card) => card.id)).toContain("block");
    expect(matchCraftCards("这章很平").map((card) => card.id)).toContain("tension");
    expect(matchCraftCards("设定没新意").map((card) => card.id)).toContain("world");
    expect(matchCraftCards("文风和世界观不搭").map((card) => card.id)).toContain("voice");
    expect(matchCraftCards("想从新闻里取材").map((card) => card.id)).toContain("material");
    expect(matchCraftCards("这章描写太多，剧情太少").map((card) => card.id)).toContain("detail");
    expect(matchCraftCards("今天天气")).toEqual([]);
  });
});

describe("craft tools", () => {
  it("lists the cards, puts the work's own conventions first and rejects unknown topics", async () => {
    const work = project();
    expect((await run(work, "writer.readCraft", {})).observation).toContain("tension〔紧张场景〕");
    await updateNotebook(work.id, (draft) => {
      draft.notes.push({ id: "n1", kind: "craft", text: "本书不写打脸，赢了也只淡淡带过", plan: "", topic: "payoff", chapterId: null, done: false, origin: "user", createdAt: 0, updatedAt: 0 });
    });
    const payoff = (await run(work, "writer.readCraft", { topic: "payoff" })).observation;
    expect(payoff.indexOf("本书不写打脸")).toBeGreaterThan(-1);
    expect(payoff.indexOf("本书不写打脸")).toBeLessThan(payoff.indexOf("【爽点与兑现】"));
    expect(payoff).toContain("何时不用");
    expect((await run(work, "writer.readCraft", { topic: "tension" })).observation).not.toContain("本书不写打脸");
    await expect(Promise.resolve().then(() => run(work, "writer.readCraft", { topic: "nope" }))).rejects.toThrow("readCraft");
  });

  it("lints a plan the assistant edited without changing anything", async () => {
    const work = project();
    const observation = (await run(work, "writer.planChapter", { plan: { title: "第二章", scenes: [{ title: "进门", words: 3000 }] } })).observation;
    expect(observation).toContain("没有写视角人物想要什么");
    expect(observation).toContain("没有章末钩子");
    expect(observation).toContain("一件也没有");
    expect(observation).toContain("没写读者这一章拿到什么");
    expect(host.modelCalls).toHaveLength(0);
    await expect(Promise.resolve().then(() => run(work, "writer.planChapter", { plan: {} }))).rejects.toThrow("场景");
  });

  it("plans a chapter with the planner, then reviews that chapter against the plan and points at craft cards", async () => {
    const work = project();
    const prompts: string[] = [];
    host.setModel((prompt) => {
      prompts.push(prompt);
      if (prompt.includes("【这一章的方向】")) return JSON.stringify({ title: "雾散", reward: "老周当众认栽", hook: "船没来", scenes: [{ title: "码头", goal: "拿回货", events: ["老周赖账", "他亮出提单"], words: 1200 }] });
      return JSON.stringify({ issues: [{ quote: "雾很大", problem: "写雾写了半页，事没动", suggestion: "删掉，只留雾挡住提单这一句", severity: "warning", category: "pacing" }] });
    });
    const runState = state(work);
    const planned = await TOOL_HANDLERS["writer.planChapter"]({ state: runState, input: { direction: "老周赖账，主角要当场拿回货" }, memory: null });
    expect(prompts[0]).toContain("老周赖账，主角要当场拿回货");
    expect(planned.observation).toContain("第 2 章（新章）的章纲");
    expect(planned.observation).toContain("发生的事：老周赖账 → 他亮出提单");
    expect(runState.plan).toMatchObject({ position: 1, chapterId: null, plan: { title: "雾散" } });
    await TOOL_HANDLERS["writer.createChapter"]({ state: runState, input: { title: "雾散", content: "雾很大。老周不认账。", afterChapterId: "c0" }, memory: null });
    const created = runState.draft.chapters.find((chapter) => chapter.title === "雾散")!;
    const { observation } = await TOOL_HANDLERS["writer.reviewChapter"]({ state: runState, input: { chapterId: created.id }, memory: null });
    expect(prompts[1]).toContain("【本章计划】");
    expect(prompts[1]).toContain("给读者的兑现：老周当众认栽");
    expect(observation).toContain("对照本次的章纲");
    expect(observation).toContain("detail〔细节〕");
    // The current chapter is not the planned one, so its review does not use the plan.
    expect((await TOOL_HANDLERS["writer.reviewChapter"]({ state: { ...runState, texts: { ...runState.texts, c0: "雾很大。" } }, input: { chapterId: "c0" }, memory: null })).observation).not.toContain("对照本次的章纲");
  });

  it("reviews the draft's text of a chapter and reports the editor's issues", async () => {
    const work = project();
    const prompts: string[] = [];
    host.setModel((prompt) => { prompts.push(prompt); return JSON.stringify({ issues: [{ quote: "雾很大", problem: "这场雾换进哪本书都一样", suggestion: "让雾港的雾挡住他的视线", severity: "warning", category: "world" }, { quote: "老周走进码头", problem: "神态俗套", severity: "info", category: "dialogue" }] }); });
    const runState = state(work);
    runState.texts.c0 = "雾很大。老周走进码头。";
    const { observation } = await TOOL_HANDLERS["writer.reviewChapter"]({ state: runState, input: {}, memory: null });
    expect(prompts.some((prompt) => prompt.includes("老周走进码头"))).toBe(true);
    expect(observation).toContain("〔世界观〕这场雾换进哪本书都一样");
    expect(observation).toContain("让雾港的雾挡住他的视线");
    // A category the editor made up is filed under voice.
    expect(observation).toContain("〔文风〕神态俗套");
  });

  it("are offered to the assistant, whose prompt says when to use them", () => {
    const ids = writerTools().map((tool) => tool.id);
    for (const id of ["writer.readCraft", "writer.planChapter", "writer.reviewChapter", "writer.diagnoseBlock"]) {
      expect(ids).toContain(id);
      expect(TOOL_HANDLERS[id]).toBeTypeOf("function");
    }
    for (const name of ["planChapter", "reviewChapter", "readCraft"]) expect(agentSystem(project())).toContain(name);
  });
});

describe("convention suggestions", () => {
  it("keeps suggestions with a known topic and text", async () => {
    const response: AgentTaskResponse = { status: "completed", text: "", value: { reply: "照你的意思写日常", conventions: [{ topic: "tension", text: "日常章不硬加冲突", plan: "靠小事推进关系" }, { topic: "nope", text: "丢掉" }, { topic: "humor", text: "" }] }, eventViews: [], iterationsUsed: 1, maxIterations: 1000 };
    Object.assign(host.api.agent.task, { start: async () => response });
    const result = await runAgent({ project: project(), memory: null, texts: {}, sessionId: "s", instruction: "这章写平淡日常", activeDoc: { kind: "outline" }, selection: null }, () => undefined);
    if (result.status !== "completed") throw new Error(result.status);
    expect(result.conventions).toEqual([{ topic: "tension", text: "日常章不硬加冲突", plan: "靠小事推进关系" }]);
  });
});
