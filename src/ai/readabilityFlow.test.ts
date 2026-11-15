import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeChapterMeta, normalizeProject } from "../domain/normalize";
import { EntityRegistry } from "../memory/ledger";
import { emptyStatus } from "../memory/schema";
import { MemoryView } from "../memory/view";
import { addSample } from "../storage/sampleStore";
import { lintPlan } from "../story/planLint";
import { emptyStoryPlan } from "../story/schema";
import { lastSeenBefore, readerCues } from "../story/selectors";
import { installFakeHost, uninstallFakeHost, type FakeHost } from "../test/fakeHost";
import { testCard } from "../test/fixtures";
import { TOOL_HANDLERS, type RunState } from "./agentTools";
import { CHECKLIST, NOTE_TEMPLATES } from "./craft/checklist";
import { normalizePlan, planCast, readerCuesText, reviewDraft, writeScenes, type GenerationSession } from "./pipelines/nextChapter";
import { quickActionsFor, resolvePrompt } from "./promptRegistry";

let host: FakeHost;
beforeEach(() => { host = installFakeHost(); });
afterEach(() => uninstallFakeHost());

function session(position = 20): GenerationSession {
  const project = normalizeProject({ schemaVersion: 3, id: "p", title: "渡口" });
  project.chapters = Array.from({ length: 25 }, (_, index) => normalizeChapterMeta({ id: `c${index}`, volumeId: project.volumes[0].id, title: `第${index + 1}章`, rank: (index + 1) * 1024, wordCount: 100 }));
  const registry = new EntityRegistry([]);
  registry.upsert({ name: "林舟", aliases: ["小舟"], category: "character" });
  registry.upsert({ name: "苏晚", aliases: ["苏师父"], category: "character" });
  registry.upsert({ name: "赵烈", aliases: ["赵公子"], category: "character" });
  const cards = [
    testCard("c0", { mentions: { 苏师父: 1 } }),
    testCard("c19", { mentions: { 林舟: 1 } }),
    testCard("c20", { mentions: { 赵烈: 1 } }),
    testCard("c24", { mentions: { 赵公子: 1, 苏晚: 1 } }),
  ];
  const memory = new MemoryView(project, new Map(cards.map((card) => [card.chapterId, card])), registry.entities, [], { arcs: [], volumes: [], book: null, worldview: null }, [], emptyStatus());
  return { project, memory, story: null, position, context: { text: "前文资料", chars: 4, included: [], dropped: [] } };
}

const planFor = (cast: string[][]) => normalizePlan({ title: "渡口", reward: "拿回旧账", hook: "有人拦路", scenes: cast.map((characters, index) => ({ title: `会面${index}`, goal: "问清旧账", outcome: "拿到线索", characters, events: ["问出消息"], words: 300 })) });

describe("reader effort prompts", () => {
  it("keeps necessary connections and provides a clarity action without a cutting quota", () => {
    const { project } = session();
    expect(resolvePrompt(project, "writer.goal")).toContain("读者读一遍就懂");
    expect(resolvePrompt(project, "writer.goal")).toContain("不是读者跟上所需的字");
    expect(resolvePrompt(project, "task.review")).toContain("clarity 读得懂");
    const actions = quickActionsFor(project);
    expect(actions.find((action) => action.id === "clarify")?.instruction).toContain("事实");
    const shorten = actions.find((action) => action.id === "shorten")!.instruction;
    expect(shorten).toContain("不定比例");
    expect(shorten).not.toMatch(/\d+\s*[%％]/);
    expect(CHECKLIST.find((group) => group.id === "prose")?.topics).toContain("clarity");
    expect(CHECKLIST.find((group) => group.id === "prose")?.items.join("\n")).toContain("一遍就能分清谁在说");
    expect(NOTE_TEMPLATES.map((item) => item.text).join("\n")).not.toMatch(/交互器物|布景融调|不可逆位移/);
  });
});

describe("what readers remember before the target chapter", () => {
  it("resolves aliases and excludes current and later appearances", () => {
    const { memory } = session();
    expect(lastSeenBefore(memory!, "小舟", 20)).toBe(19);
    expect(lastSeenBefore(memory!, "苏晚", 20)).toBe(0);
    expect(lastSeenBefore(memory!, "赵公子", 20)).toBe(-1);
    expect(lastSeenBefore(memory!, "赵烈", 21)).toBe(20);
    expect(lastSeenBefore(memory!, "陌生人", 20)).toBe(-1);
  });

  it("reminds at twenty chapters, deduplicates aliases and leaves familiar people out", () => {
    const { memory } = session();
    const cues = readerCues(memory, [" 苏晚 ", "苏师父", "林舟", "小舟", "赵烈", "赵公子", "", "新客"], 20);
    expect(cues).toHaveLength(3);
    expect(cues[0]).toContain("苏晚：上次出场在第 1 章，隔了 20 章");
    expect(cues[1]).toContain("赵烈：读者第一次见");
    expect(cues[2]).toContain("新客：读者第一次见");
    expect(readerCues(memory, ["苏晚"], 19)).toEqual([]);
    expect(readerCuesText({ memory, position: 20 }, ["林舟"])).toBe("");
    expect(readerCues(null, ["新客"], 20)).toEqual([]);
    expect(readerCues(new MemoryView(memory!.project, new Map(), [], [], memory!.aggregates, [], emptyStatus()), ["新客"], 20)).toEqual([]);
  });

  it("passes cast reminders to drafting, review and the assistant's plan result", async () => {
    const generation = session();
    const plan = planFor([["林舟", "赵烈"]]);
    plan.scenes[0].focal = "苏晚";
    expect(planCast(plan, generation.memory)).toEqual(["林舟", "赵烈", "苏晚"]);
    host.setModel(() => "林舟把旧账放在桌上。");
    await writeScenes(generation, plan, [0], "");
    expect(host.modelCalls.at(-1)!.prompt).toContain("【读者记得多少】");
    expect(host.modelCalls.at(-1)!.prompt).toContain("苏晚：上次出场");
    host.setModel(() => JSON.stringify({ issues: [] }));
    await reviewDraft(generation, plan, "林舟翻开旧账。");
    expect(host.modelCalls.at(-1)!.prompt).toContain("赵烈：读者第一次见");
    expect(host.modelCalls.at(-1)!.prompt).toContain("苏晚：上次出场");
    const state: RunState = { projectId: "p", sessionId: "s", instruction: "", supersedes: null, draft: generation.project, base: {}, texts: {}, changes: [], comments: [], displays: [], eventViews: [], selection: null, activeDoc: { kind: "chapter", id: "c19" } };
    const result = await TOOL_HANDLERS["writer.planChapter"]({ state, memory: generation.memory, input: { plan } });
    expect(result.observation).toContain("【读者记得多少】");
    expect(result.observation).toContain("赵烈：读者第一次见");
  });
});

describe("new faces in a chapter plan", () => {
  const warnings = (cast: string[][], max = 5) => {
    const { memory, position } = session();
    const story = emptyStoryPlan();
    story.thresholds.maxNewCastPerChapter = max;
    return lintPlan(planFor(cast), { memory, position, story }).filter((item) => item.message.includes("新面孔"));
  };

  it("warns at three new faces in a scene but not at two", () => {
    expect(warnings([["甲", "乙"]])).toEqual([]);
    expect(warnings([["林舟", "小舟", "甲", "乙", "丙"]])).toMatchObject([{ sceneIndex: 0 }]);
  });

  it("counts aliases once across scenes and includes a focal character outside the cast list", () => {
    expect(warnings([["赵烈", "赵公子", "甲"], ["赵公子", "甲", "乙"]])).toEqual([]);
    const { memory, position } = session();
    const plan = planFor([["甲", "乙"]]);
    plan.scenes[0].focal = "赵公子";
    expect(lintPlan(plan, { memory, position }).some((item) => item.message.includes("3 个新面孔"))).toBe(true);
  });

  it("checks both scene and chapter limits and respects the chapter setting", () => {
    expect(warnings([["甲", "乙"], ["丙", "丁"], ["戊"]])).toEqual([]);
    expect(warnings([["甲", "乙"], ["丙", "丁"], ["戊", "己"]])).toMatchObject([{ sceneIndex: null }]);
    expect(warnings([["甲", "乙"], ["丙", "丁"]], 3)[0].message).toContain("每章 3 人");
    expect(warnings([["甲", "乙", "丙"], ["丁", "戊", "己"]]).map((item) => item.sceneIndex)).toEqual([0, 1, null]);
  });

  it("does not mistake a free-form focal description for another new face", () => {
    const { memory, position } = session();
    const plan = planFor([["林舟", "甲", "乙"]]);
    plan.scenes[0].focal = "林舟与掌柜围绕退换范围、凭据和责任的讨价还价";
    expect(planCast(plan, memory)).toEqual(["林舟", "甲", "乙"]);
    expect(lintPlan(plan, { memory, position }).filter((item) => item.message.includes("新面孔"))).toEqual([]);
    expect(readerCuesText({ memory, position }, planCast(plan, memory))).not.toContain(plan.scenes[0].focal);
  });
});

describe("readability hints in editor review", () => {
  it("does not turn heuristic hints into issues without the editor's judgement", async () => {
    host.setModel(() => JSON.stringify({ issues: [] }));
    const draft = "那个三天前在城西当铺里用半块碎银换走了他父亲临终前留给他唯一一件旧物的瘦高男人此刻正站在门口。";
    expect(await reviewDraft(session(), null, draft)).toEqual([]);
    const call = host.modelCalls.at(-1)!;
    expect(call.prompt).toContain("【可能读着费劲的句子】");
    expect(call.prompt).toContain("自动指标，仅供参考");
    expect(call.prompt).toContain("瘦高男人");
  });

  it("suppresses familiar style hints and keeps a quoted clarity issue as clarity", async () => {
    await addSample("p", "样章", "沉默吞没了屋子。林舟等在门外，等苏晚把旧账送来。".repeat(30));
    const quote = "沉默吞没了屋子";
    host.setModel(() => JSON.stringify({ issues: [{ quote, problem: "读者分不清是谁不再说话", suggestion: "苏晚不再说话，林舟也没出声。", category: "clarity", severity: "warning" }] }));
    const issues = await reviewDraft(session(), null, `${quote}。林舟等在门外，等苏晚把旧账送来。`);
    expect(host.modelCalls.at(-1)!.prompt).not.toContain("【可能读着费劲的句子】");
    expect(issues).toMatchObject([{ quote, category: "clarity", source: "ai" }]);
  });
});
