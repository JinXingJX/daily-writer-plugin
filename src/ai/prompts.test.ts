import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTaskStartRequest } from "@daily/plugin-sdk";
import { newProposal } from "../domain/proposals";
import { installFakeHost, uninstallFakeHost, type FakeHost } from "../test/fakeHost";
import { normalizeChapterMeta, normalizeProject } from "../domain/normalize";
import { diffDrafts } from "../domain/merge";
import { applyOperation, parsePatchOperation } from "../domain/operations";
import { createProject, openProject } from "../storage/projectStore";
import { appendProposal, applyProposal, undoProposal } from "../storage/proposalStore";
import { addSample, listSamples, removeSample } from "../storage/sampleStore";
import { loadIdeas, removeIdea, saveIdea } from "../storage/ideaStore";
import type { AgentTaskResponse, WriterProposal } from "../types";
import { runAgent } from "./agent";
import { inspireLenses, MAX_READERS, quickActionsFor, readerPanel, renderVars, resolvePrompt } from "./promptRegistry";
import { presetSample, PRESET_SAMPLES } from "./presetSamples";
import { agentSystem, editorSystem, writerSystem } from "./prompts";
import { planChapter } from "./pipelines/planChapter";
import { cutAtSentence, loadStyleSamples, samplesSection, SAMPLES_HEADING } from "./styleSamples";
import { inspire, pickLenses } from "./pipelines/inspire";
import { autoRevise, normalizePlan, planToText, type ReviewIssue } from "./pipelines/nextChapter";

let host: FakeHost;
beforeEach(() => { host = installFakeHost(); });
afterEach(() => uninstallFakeHost());

function project(extra: Record<string, unknown> = {}) {
  const value = normalizeProject({ schemaVersion: 3, id: "p", title: "雾港", genre: "悬疑", ...extra });
  value.chapters.push(normalizeChapterMeta({ id: "c0", volumeId: value.volumes[0].id, title: "第一章", rank: 1024, wordCount: 10 }));
  return value;
}

describe("prompt registry", () => {
  it("fills placeholders and leaves unknown ones visible", () => {
    expect(renderVars("《{{title}}》{{ missing }}", { title: "雾港" })).toBe("《雾港》{{ missing }}");
  });

  it("prefers the work's override over the built-in text", () => {
    const work = project();
    expect(resolvePrompt(work, "writer.role")).toContain("《雾港》（悬疑）");
    work.prompts.overrides["writer.role"] = "你在写{{genre}}。";
    expect(resolvePrompt(work, "writer.role")).toBe("你在写悬疑。");
    work.prompts.overrides["writer.role"] = "   ";
    expect(resolvePrompt(work, "writer.role")).toContain("执笔者");
  });

  it("reads the reader panel one member per line, capped, with a fallback reader", () => {
    const work = project();
    expect(readerPanel(work).map((reader) => reader.name)).toEqual(["追更党", "老白", "考据党", "角色党", "情绪党"]);
    expect(readerPanel(work)[1].description).toContain("悬疑的套路");
    work.prompts.overrides["reader.panel"] = "考据党：盯着账目：和规则\n\n  新读者：刚从推荐位点进来  ";
    expect(readerPanel(work)).toEqual([{ name: "考据党", description: "盯着账目：和规则" }, { name: "新读者", description: "刚从推荐位点进来" }]);
    work.prompts.overrides["reader.panel"] = Array.from({ length: 12 }, (_, index) => `读者${index}：x`).join("\n");
    expect(readerPanel(work)).toHaveLength(MAX_READERS);
    work.prompts.overrides["reader.panel"] = "：没有名字";
    expect(readerPanel(work)).toEqual([{ name: "读者", description: "普通的追更读者" }]);
  });

  it("parses lenses and falls back to the built-in quick actions", () => {
    const work = project();
    expect(inspireLenses(work)[0]).toEqual({ name: "欲望与代价", description: "谁想要什么，要付出什么" });
    expect(quickActionsFor(work).map((action) => action.id)).toContain("deai");
    work.prompts.quickActions = [{ id: "a", label: "只留对白", instruction: "删掉叙述", candidates: 1 }];
    expect(quickActionsFor(work)).toHaveLength(1);
  });
});

describe("prompt config persistence", () => {
  it("drops the old writing prompt fields and keeps overrides", () => {
    const work = project({ prompts: { templateId: "x", templateName: "旧", writingPrompt: "自定义", overrides: { "task.plan": "x", bad: 3 } } });
    expect(work.prompts).toEqual({ overrides: { "task.plan": "x" }, quickActions: null, updatedAt: 0 });
    const next = structuredClone(work);
    next.prompts.overrides["task.plan"] = "改过";
    expect(diffDrafts({ project: work, texts: {} }, { project: next, texts: {} })).toContainEqual({ kind: "field", field: "prompts" });
  });

  it("creates works with an outline and no prompt to start from", async () => {
    const created = await createProject({ title: "新书", outline: "一句话故事：x" });
    const opened = await openProject(created.id);
    expect(opened.prompts.overrides).toEqual({});
    expect(opened.outline).toBe("一句话故事：x");
  });

  it("applies and undoes setPromptConfig proposals", async () => {
    const created = await createProject({ title: "新书" });
    const operation = parsePatchOperation({ type: "setPromptConfig", patch: { overrides: { "task.scene": "写" }, writingPrompt: "旧字段" } });
    expect(operation).toEqual({ type: "setPromptConfig", patch: { overrides: { "task.scene": "写" } } });
    const proposal: WriterProposal = newProposal({ id: "pp", title: "提示词", changes: [{ id: "e", kind: "entity", label: "提示词", operation }] });
    await appendProposal(created.id, proposal);
    const applied = await applyProposal(created.id, "pp");
    expect(applied.project.prompts.overrides).toEqual({ "task.scene": "写" });
    const undone = await undoProposal(created.id, "pp");
    expect(undone.project.prompts.overrides).toEqual({});
  });

  it("rejects empty prompt patches", () => {
    expect(() => parsePatchOperation({ type: "setPromptConfig", patch: {} })).toThrow();
    const work = project();
    applyOperation(work, { type: "setPromptConfig", patch: { overrides: { "task.scene": "写" } } });
    expect(work.prompts.overrides).toEqual({ "task.scene": "写" });
  });
});

describe("style samples", () => {
  it("shares the budget across samples and cuts at a sentence end", () => {
    expect(samplesSection([], 1_000)).toBe("");
    const long = `${"他推门进去。".repeat(40)}`;
    const section = samplesSection([{ title: "长", text: long }, { title: "短", text: "一句话。" }], 100);
    expect(section.startsWith(SAMPLES_HEADING)).toBe(true);
    expect(section).toContain("〔短〕\n一句话。");
    const cut = section.split("〔长〕\n")[1].split("\n\n")[0];
    // The short sample's unused share goes to the long one; the cut ends on a full sentence.
    expect(cut.length).toBeGreaterThan(50);
    expect(cut.length).toBeLessThanOrEqual(96);
    expect(cut.endsWith("。")).toBe(true);
    expect(cutAtSentence("没有标点的一长串文字没有标点的一长串文字", 8)).toBe("没有标点的一长串");
  });

  it("stores samples per work, in the order they were added", async () => {
    const first = await addSample("p", "", "第一篇。\r\n第二行。");
    await addSample("p", "第二篇", "正文。");
    expect((await listSamples("p")).map((sample) => sample.title)).toEqual(["样章 1", "第二篇"]);
    expect(first.chars).toBe("第一篇。\n第二行。".length);
    await expect(addSample("p", "空", "  ")).rejects.toThrow();
    await removeSample("p", first.id);
    expect((await loadStyleSamples("p")).map((sample) => sample.text)).toEqual(["正文。"]);
  });
});

describe("preset samples", () => {
  it("ships original samples and copies the chosen ones into a new work", async () => {
    expect(PRESET_SAMPLES.length).toBeGreaterThanOrEqual(5);
    expect(new Set(PRESET_SAMPLES.map((preset) => preset.id)).size).toBe(PRESET_SAMPLES.length);
    for (const preset of PRESET_SAMPLES) {
      expect(preset.text.trim().length).toBeGreaterThan(400);
      expect(preset.text).not.toMatch(/\u200b/);
    }
    expect(presetSample("classic-xianxia")).toBeUndefined();
    const created = await createProject({ title: "新书", presets: ["folk-horror", "era-rebirth", "missing"] });
    const samples = await loadStyleSamples(created.id);
    expect(samples.map((sample) => sample.title)).toEqual(["民俗诡事", "年代重生·市井"]);
    expect(samples[0].text).toBe(presetSample("folk-horror")!.text.trim());
  });
});

describe("writing agent", () => {
  it("starts with a short system prompt, the samples as context and sub-agents allowed", async () => {
    const work = project();
    await addSample("p", "样", "雾里有人咳嗽。");
    let started: AgentTaskStartRequest | null = null;
    Object.assign(host.api.agent.task, {
      start: async (payload: AgentTaskStartRequest) => { started = payload; return { status: "completed", text: "", value: { reply: "好" }, eventViews: [], iterationsUsed: 1, maxIterations: 1000 } satisfies AgentTaskResponse; },
    });
    const result = await runAgent({ project: work, memory: null, texts: {}, sessionId: "s", instruction: "写下一章", activeDoc: { kind: "outline" }, selection: null }, () => undefined);
    expect(result.status).toBe("completed");
    const payload = started! as AgentTaskStartRequest;
    expect(payload.systemPrompt).toBe(agentSystem(work));
    expect(payload.systemPrompt.length).toBeLessThan(800);
    expect(payload.systemPrompt).toContain("agent.create");
    expect(payload.finalInstructions).toContain("先说改了什么或发现了什么");
    expect(payload.finalInstructions).toContain("不为缩短而省掉解释");
    expect(payload.subAgents).toEqual({ allowCreate: true });
    expect(payload.context?.find((block) => block.title === "样章")?.content).toContain("雾里有人咳嗽。");
    expect(payload.context?.map((block) => block.title)).toEqual(["创作目标", "写作上下文（记忆检索结果；供查证，不照搬进正文）", "样章"]);
    expect(payload.context?.find((block) => block.title === "创作目标")?.content).toContain("读者追更买的是事");
    expect(payload.context?.find((block) => block.title === "样章")?.content).toContain("样章的内容一概不进本作");
    expect(payload.userPrompt).toContain("【作者的要求】写下一章");
  });

  it("runs tools a sub-agent calls against the same draft", async () => {
    const work = project();
    const responses: AgentTaskResponse[] = [
      { status: "tool_call", runId: "r1", toolId: "writer.createChapter", toolName: "", pendingMessage: "", input: { title: "第二章", content: "雾散了。" }, metadata: {}, subAgent: { id: "drafter", name: "执笔" }, eventViews: [], iterationsUsed: 1, maxIterations: 1000 },
      { status: "completed", text: "", value: { reply: "写好了", title: "第二章", summary: "新章" }, eventViews: [], iterationsUsed: 2, maxIterations: 1000 },
    ];
    const observations: string[] = [];
    Object.assign(host.api.agent.task, {
      start: async () => responses.shift(),
      resume: async (payload: { observation: string }) => { observations.push(payload.observation); return responses.shift(); },
    });
    const result = await runAgent({ project: work, memory: null, texts: {}, sessionId: "s", instruction: "写第二章", activeDoc: { kind: "outline" }, selection: null }, () => undefined);
    if (result.status !== "completed") throw new Error(result.status);
    expect(observations[0]).toContain("新建章节「第二章」");
    expect(result.proposal?.changes[0]).toMatchObject({ kind: "text", title: "第二章", after: "雾散了。" });
  });
});

describe("inspiration", () => {
  it("rotates lenses and sends avoid/seed/base to the model", async () => {
    expect(pickLenses([{ name: "a", description: "" }, { name: "b", description: "" }, { name: "c", description: "" }], 4, () => 0.5).map((lens) => lens.name)).toEqual(["b", "c", "a", "b"]);
    host.setModel(() => JSON.stringify({ ideas: [{ title: "一", content: "甲" }, { title: "二", content: "乙", lens: "反常规" }, { title: "三", content: "丙" }] }));
    const ideas = await inspire({ project: project(), memory: null, target: "character", seed: "要一个账房", avoid: ["旧点子"], mode: "expand", base: [{ id: "x", title: "盲人", content: "看不见", lens: "" }], count: 2 });
    expect(ideas.map((idea) => idea.title)).toEqual(["一", "二"]);
    expect(ideas[0].lens).not.toBe("");
    const call = host.modelCalls.at(-1)!;
    expect(call.prompt).toContain("要一个账房");
    expect(call.prompt).toContain("旧点子");
    expect(call.prompt).toContain("盲人：看不见");
    expect(call.system).toContain("三个套路");
  });

  it("stores ideas per work", async () => {
    await saveIdea("p", { id: "i1", title: "t", content: "c", lens: "" }, "outline");
    expect(await loadIdeas("p")).toMatchObject([{ id: "i1", target: "outline" }]);
    expect(await removeIdea("p", "i1")).toEqual([]);
  });
});

describe("writing goal", () => {
  it("starts every call that writes, plans or judges the story, and a work can rewrite it", async () => {
    const work = project();
    expect(await writerSystem(work)).toContain("【创作目标】");
    expect(editorSystem(work)).toContain("诡秘之主");
    work.prompts.overrides["writer.goal"] = "写一部克制的群像长篇。";
    expect(editorSystem(work)).toContain("写一部克制的群像长篇。");
    expect(editorSystem(work)).not.toContain("诡秘之主");
    host.setModel(() => JSON.stringify({ ideas: [{ title: "一", content: "甲" }] }));
    await inspire({ project: work, memory: null, target: "worldview", count: 1 });
    expect(host.modelCalls.at(-1)!.system).toContain("写一部克制的群像长篇。");
    host.setModel(() => JSON.stringify({ title: "雾散", logic: "码头帮在等货", kernel: "排队抢号的焦虑", scenes: [{ title: "s", goal: "上船" }] }));
    const { plan } = await planChapter({ session: { project: work, memory: null, story: null, position: 1, context: { text: "", included: [], dropped: [], chars: 0 } }, direction: "", targetWords: 3_000 });
    expect(host.modelCalls.at(-1)!.system).toContain("写一部克制的群像长篇。");
    expect(plan).toMatchObject({ logic: "码头帮在等货", kernel: "排队抢号的焦虑" });
  });
});

describe("chapter plan", () => {
  it("parses what happens, what readers get and what is skimmed, and lists them in the plan text", () => {
    const plan = normalizePlan({ title: "t", core: "他第一次撒谎", reward: "掌柜当众认栽", skim: ["赶路", ""], scenes: [{ title: "s", cause: "当票到期", events: ["拿出当票", "掌柜变脸", ""], material: ["旧字段被丢掉"] }] });
    expect(plan).toMatchObject({ core: "他第一次撒谎", reward: "掌柜当众认栽", skim: ["赶路"] });
    expect(plan.scenes[0]).toMatchObject({ cause: "当票到期", events: ["拿出当票", "掌柜变脸"] });
    expect(plan.scenes[0]).not.toHaveProperty("material");
    const text = planToText(plan);
    expect(text).toContain("给读者的兑现：掌柜当众认栽");
    expect(text).toContain("发生的事：拿出当票 → 掌柜变脸");
    expect(text).toContain("一笔带过：赶路");
  });

  it("hands the offstage reasoning and the kernel the chapter was drawn from to the writer", () => {
    const plan = normalizePlan({ title: "t", logic: "掌柜早知道当票是假的", kernel: "裁员通知的内核：体面地被抛下", scenes: [{ title: "s", goal: "赎回玉佩" }] });
    const text = planToText(plan);
    expect(text).toContain("推演（台面下，写给执笔者，不进正文）：掌柜早知道当票是假的");
    expect(text).toContain("取材内核（只取内核，表面全换成本作的）：裁员通知的内核：体面地被抛下");
    expect(planToText(normalizePlan({ title: "t", scenes: [{ title: "s", goal: "g" }] }))).not.toContain("推演");
  });
});

describe("automatic revision", () => {
  const issue = (quote: string, category: ReviewIssue["category"]): ReviewIssue => ({ id: quote, quote, problem: "p", suggestion: "s", severity: "warning", category, source: "ai" });
  const session = () => ({ project: project(), memory: null, story: null, position: 1, context: { text: "", included: [], dropped: [], chars: 0 } });

  it("removes a paragraph the reviser marks for deletion and lets pacing fixes shrink a paragraph to a line", async () => {
    host.setModel((prompt) => (prompt.includes("灯光昏黄") ? "【删除】" : "雾挡住了提单。"));
    const draft = "他推开门。\n\n灯光昏黄，墙皮剥落，桌上摆着三只缺口的茶碗，碗沿积着一圈褐色的茶垢。\n\n雾很大很大，大得像一堵墙，又像一锅煮沸了的米汤，从码头的每一道缝里漫上来，把所有东西都泡软了。\n\n老周不认账。";
    const result = await autoRevise(session(), draft, [issue("灯光昏黄", "pacing"), issue("雾很大很大", "pacing")]);
    expect(result.text).toBe("他推开门。\n\n雾挡住了提单。\n\n老周不认账。");
    expect(result.fixed).toHaveLength(2);
  });

  it("keeps a paragraph when a non-pacing fix loses most of it", async () => {
    host.setModel(() => "短。");
    const draft = "雾很大很大，大得像一堵墙，又像一锅煮沸了的米汤，从码头的每一道缝里漫上来。";
    const result = await autoRevise(session(), draft, [issue("雾很大很大", "style")]);
    expect(result.text).toBe(draft);
    expect(result.skipped).toHaveLength(1);
  });
});
