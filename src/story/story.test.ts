import { describe, expect, it } from "vitest";
import { normalizePlan } from "../ai/pipelines/nextChapter";
import { normalizeChapterMeta, normalizeProject } from "../domain/normalize";
import { EntityRegistry, applyCardThreads } from "../memory/ledger";
import { emptyStatus, type ChapterCard, type StoryThread } from "../memory/schema";
import { MemoryView } from "../memory/view";
import { testCard, threadEvent } from "../test/fixtures";
import { diagnoseStory, type HealthRule } from "./health";
import { applyCardToStory, retractChapterFromStory } from "./ledger";
import { applyStoryOperation, inverseStoryOperation, isAdditiveStoryOperation } from "./operations";
import { lintPlan } from "./planLint";
import { emptyStoryPlan, normalizeSecret, normalizeStoryPlan, parseStoryOperation, type StoryPlan } from "./schema";
import { activeExpectations, knowledgeAt, relevantThreads } from "./selectors";

function project(chapters: number) {
  const value = normalizeProject({ schemaVersion: 3, id: "p", title: "书" });
  for (let index = 0; index < chapters; index += 1) value.chapters.push(normalizeChapterMeta({ id: `c${index}`, volumeId: value.volumes[0].id, title: `第${index + 1}章`, rank: (index + 1) * 1024, wordCount: 100 }));
  return value;
}

function view(cards: ChapterCard[], chapters = cards.length, mutate?: (threads: StoryThread[]) => StoryThread[]) {
  const registry = new EntityRegistry([]);
  for (const name of ["林舟", "苏晚", "赵烈"]) registry.upsert({ name, category: "character" });
  let threads: StoryThread[] = [];
  for (const card of cards) threads = applyCardThreads(threads, card);
  if (mutate) threads = mutate(threads);
  return new MemoryView(project(chapters), new Map(cards.map((card) => [card.chapterId, card])), registry.entities, threads, { arcs: [], volumes: [], book: null, worldview: null }, [], emptyStatus());
}

const rules = (plan: StoryPlan, memory: MemoryView | null) => diagnoseStory(plan, memory).map((issue) => issue.rule);
const has = (list: HealthRule[], rule: HealthRule) => list.includes(rule);

describe("story plan schema and operations", () => {
  it("normalizes bad JSON into an empty plan with default thresholds", () => {
    const plan = normalizeStoryPlan({ promise: "x", powers: [{}], relations: [{ a: "林舟" }], thresholds: { suppressMax: 99 } });
    expect(plan.promise.oneLiner).toBe("");
    expect(plan.powers[0].name).toBe("未命名能力");
    expect(plan.relations).toEqual([]);
    expect(plan.thresholds.suppressMax).toBe(20);
    expect(() => parseStoryOperation({ type: "dropTable" })).toThrow("未知的故事规划操作");
  });

  it("applies operations and reverts them with their inverses", () => {
    const plan = emptyStoryPlan();
    const operations = [
      parseStoryOperation({ type: "setPromise", promise: { oneLiner: "以弱胜强" } }),
      parseStoryOperation({ type: "upsertSecret", secret: { id: "s", title: "真相", truth: "t" } }),
      parseStoryOperation({ type: "upsertVolumePlan", plan: { volumeId: "v", endpoint: "进城" } }),
    ];
    const inverses = operations.flatMap((operation) => { const inverse = inverseStoryOperation(plan, operation); applyStoryOperation(plan, operation); return inverse; });
    expect(plan.promise.oneLiner).toBe("以弱胜强");
    expect(plan.secrets).toHaveLength(1);
    for (const inverse of inverses.reverse()) applyStoryOperation(plan, inverse);
    expect(plan.promise.oneLiner).toBe("");
    expect(plan.secrets).toEqual([]);
    expect(plan.volumes).toEqual([]);
  });

  it("treats appended knowledge as additive and rewritten truths as not", () => {
    const plan = emptyStoryPlan();
    plan.secrets.push(normalizeSecret({ id: "s", title: "真相", truth: "t" }));
    const appended = { ...plan.secrets[0], knownBy: [{ who: "林舟", chapterId: "c1", source: "偷听", origin: "extracted" as const }] };
    expect(isAdditiveStoryOperation(plan, { type: "upsertSecret", secret: appended })).toBe(true);
    expect(isAdditiveStoryOperation(plan, { type: "upsertSecret", secret: { ...appended, truth: "改了" } })).toBe(false);
  });
});

describe("story ledger", () => {
  it("folds knowledge of tracked secrets and closeness shifts, and retracts them on re-extraction", () => {
    const memory = view([testCard("c0"), testCard("c1")]);
    const plan = emptyStoryPlan();
    plan.secrets.push(normalizeSecret({ id: "s", title: "身世" }));
    const card = testCard("c1", { knowledge: [{ who: "林舟", learns: "身世", source: "苏晚说", secretId: "s" }, { who: "林舟", learns: "无关", source: "", secretId: null }], intimacy: [{ a: "林舟", b: "苏晚", delta: 2, event: "救命" }] });
    applyCardToStory(plan, card, memory);
    applyCardToStory(plan, card, memory);
    expect(plan.secrets[0].knownBy).toEqual([{ who: "林舟", chapterId: "c1", source: "苏晚说", origin: "extracted" }]);
    expect(plan.relations).toHaveLength(1);
    expect(plan.relations[0].intimacy).toEqual([{ chapterId: "c1", level: 5, event: "救命", reason: "", origin: "extracted" }]);
    retractChapterFromStory(plan, "c1");
    expect(plan.secrets[0].knownBy).toEqual([]);
    expect(plan.relations[0].intimacy).toEqual([]);
  });
});

describe("selectors", () => {
  it("knows which secrets a character knows before a position", () => {
    const memory = view([testCard("c0"), testCard("c1"), testCard("c2")]);
    const plan = emptyStoryPlan();
    plan.secrets.push(normalizeSecret({ id: "a", title: "身世", knownBy: [{ who: "林舟", chapterId: "c1", source: "", origin: "extracted" }] }), normalizeSecret({ id: "b", title: "内奸" }));
    expect(knowledgeAt(plan, memory, "林舟", 1).known).toEqual([]);
    expect(knowledgeAt(plan, memory, "林舟", 2).known.map((item) => item.secret.id)).toEqual(["a"]);
    expect(knowledgeAt(plan, memory, "林舟", 2).unknown.map((secret) => secret.id)).toEqual(["b"]);
  });

  it("ranks threads by shared names and a planned payoff close ahead", () => {
    const memory = view([
      testCard("c0", { threads: [threadEvent("plant", "赵烈的旧账", "赵烈欠下血债")] }),
      testCard("c1", { threads: [threadEvent("plant", "玉佩", "苏晚留下玉佩")] }),
      testCard("c2", { threads: [threadEvent("plant", "城门", "城门守卫换人", { kind: "expectation" })] }),
    ], 10, (threads) => threads.map((thread) => (thread.title === "城门" ? { ...thread, targetChapterId: "c4" } : thread)));
    expect(relevantThreads(memory, 3, ["苏晚"], 3)[0].title).toBe("玉佩");
    expect(relevantThreads(memory, 3, [], 3)[0].title).toBe("城门");
    expect(activeExpectations(memory, 3).map((thread) => thread.title)).toEqual(["城门"]);
  });
});

describe("story health", () => {
  it("asks for the promise and the missing opening elements", () => {
    const plan = emptyStoryPlan();
    expect(rules(plan, null)).toEqual(["promise-missing"]);
    plan.promise.oneLiner = "x";
    plan.promise.opening.who = "林舟";
    expect(rules(plan, null)).toEqual(["opening-elements"]);
  });

  it("finds expectation gaps, missing successors and handoff gaps", () => {
    const cards = Array.from({ length: 12 }, (_, index) => testCard(`c${index}`, { changes: ["info"] }));
    cards[1].threads = [threadEvent("plant", "约战", "", { kind: "expectation" })];
    cards[4].threads = [threadEvent("payoff", "约战")];
    cards[6].threads = [threadEvent("plant", "大比", "", { kind: "expectation" })];
    cards[7].threads = [threadEvent("advance", "大比"), threadEvent("advance", "大比")];
    cards[8].threads = [threadEvent("advance", "大比")];
    const found = diagnoseStory({ ...emptyStoryPlan(), promise: { ...emptyStoryPlan().promise, oneLiner: "x" } }, view(cards));
    const gap = found.find((issue) => issue.rule === "expectation-gap");
    expect(gap?.chapterId).toBe("c4");
    expect(found.some((issue) => issue.rule === "handoff-gap" && issue.chapterId === "c4")).toBe(true);
    expect(found.some((issue) => issue.rule === "no-successor" && issue.message.includes("大比"))).toBe(true);
  });

  it("flags stale foreshadowing, repeated payoffs, long suppression, unchanged chapters and big casts", () => {
    const cards = Array.from({ length: 8 }, (_, index) => testCard(`c${index}`, { changes: ["info"] }));
    cards[0].threads = [threadEvent("plant", "钥匙")];
    for (const index of [1, 2, 3]) cards[index].payoffs = [{ type: "打脸", description: "" }];
    for (const index of [4, 5]) cards[index].emotionBeats = [{ type: "suppress", reason: "师命" }, { type: "suppress", reason: "" }];
    cards[7].changes = [];
    cards[7].newCast = ["甲", "乙", "丙", "丁", "戊", "己"];
    const plan = { ...emptyStoryPlan(), promise: { ...emptyStoryPlan().promise, oneLiner: "x" } };
    plan.thresholds = { ...plan.thresholds, foreshadowStaleChapters: 5 };
    const list = rules(plan, view(cards));
    for (const rule of ["stale-foreshadow", "payoff-repeat", "suppress-overload", "suppress-reason", "scene-no-change", "cast-overload"] as HealthRule[]) expect(has(list, rule)).toBe(true);
    // A release resets the suppression count.
    cards[5].emotionBeats = [{ type: "release", reason: "" }];
    expect(has(rules(plan, view(cards)), "suppress-overload")).toBe(false);
  });

  it("flags relationship jumps, weak thresholds and early reveals", () => {
    const memory = view(Array.from({ length: 6 }, (_, index) => testCard(`c${index}`, { changes: ["info"] })));
    const plan = { ...emptyStoryPlan(), promise: { ...emptyStoryPlan().promise, oneLiner: "x" } };
    plan.relations.push({ id: "r", a: "林舟", b: "苏晚", social: [], intimacy: [{ chapterId: "c0", level: 2, event: "初见", reason: "", origin: "user" }, { chapterId: "c1", level: 9, event: "双修", reason: "", origin: "user" }] });
    plan.volumes.push({ volumeId: "v", endpoint: "进京", threshold: { reasons: ["好奇京城"], preparation: "", beyond: "" }, coreLoop: [], transition: { carriedRelations: [], carriedPromises: [], bridgeCharacters: [] } });
    plan.secrets.push(normalizeSecret({ id: "s", title: "内奸", readerRevealChapterId: "c5", knownBy: [{ who: "林舟", chapterId: "c2", source: "", origin: "extracted" }] }));
    const list = rules(plan, memory);
    for (const rule of ["intimacy-jump", "threshold-weak", "reveal-early"] as HealthRule[]) expect(has(list, rule)).toBe(true);
  });
});

describe("plan lint", () => {
  const plan = (patch: Record<string, unknown> = {}, scene: Record<string, unknown> = {}) => normalizePlan({ title: "第五章", hook: "谁在门外", reward: "师父当众认他", scenes: [{ title: "对峙", goal: "拿回玉佩", stakes: "失去师门信物", changes: ["relation"], events: ["a", "b", "c"], words: 3000, ...scene }], ...patch });

  it("flags scenes that want nothing or change nothing, missing hooks and off-promise chapters, and nothing else", () => {
    expect(lintPlan(plan())).toEqual([]);
    // Stakes, deadlines and obstacles are the plan's to use when they help.
    expect(lintPlan(plan({}, { stakes: "", deadline: "天黑", obstacles: ["门锁", "门锁"] }))).toEqual([]);
    const messages = lintPlan(plan({ hook: "", promiseAlignment: "off" }, { goal: "", changes: [], outcome: "" })).map((warning) => warning.message).join("\n");
    expect(messages).toContain("想要什么");
    expect(messages).toContain("没有改变");
    expect(messages).toContain("核心承诺无关");
    expect(messages).toContain("章末钩子");
  });

  it("flags chapters where too little happens for the length or readers get nothing", () => {
    const messages = lintPlan(plan({ reward: "" }, { events: ["a"], words: 3000 })).map((warning) => warning.message).join("\n");
    expect(messages).toContain("只有 1 件");
    expect(messages).toContain("没写读者这一章拿到什么");
  });

  it("checks handoff, repeated payoffs and long suppression against memory", () => {
    const cards = Array.from({ length: 4 }, (_, index) => testCard(`c${index}`, { payoffs: [{ type: "打脸", description: "" }], emotionBeats: index > 0 ? [{ type: "suppress", reason: "x" }] : [] }));
    cards[0].threads = [threadEvent("plant", "约战", "", { kind: "expectation" })];
    cards[1].threads = [threadEvent("advance", "约战"), threadEvent("advance", "约战")];
    const memory = view(cards, 5);
    const warnings = lintPlan(plan({ reward: "", threads: { payoff: ["约战"] } }, { events: ["打脸：当众扇回去", "b", "c"] }), { memory, position: 4 }).map((warning) => warning.message).join("\n");
    expect(warnings).toContain("接棒");
    expect(warnings).toContain("「打脸」");
    expect(warnings).toContain("该让它兑现了");
  });
});
