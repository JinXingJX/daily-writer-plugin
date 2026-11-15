import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { orderedChapters } from "../domain/documents";
import { importManuscript } from "../ingest/import";
import { splitManuscript } from "../ingest/splitter";
import { MemoryStore } from "../memory/store";
import { loadNotebook } from "../notes/store";
import { loadProposals } from "../storage/proposalStore";
import { mutateProject, openProject } from "../storage/projectStore";
import { installFakeHost, uninstallFakeHost, type FakeHost } from "../test/fakeHost";
import type { WriterProject } from "../types";
import { applyCommand, runPipelineWork } from "./engine";
import { newStep, type PipelineRun } from "./schema";
import type { DraftArtifact, ReviewArtifact } from "./steps/next";
import { listRuns, loadRun, readArtifact, sendCommand } from "./store";
import { publishSteps, startPublishRun } from "./templates";

let host: FakeHost;
beforeEach(() => { host = installFakeHost(); });
afterEach(() => uninstallFakeHost());

const BOOK = `书名\n\n第一卷 起风\n第一章 醒来\n林舟在青云宗醒来。\n第二章 拜师\n林舟拜苏晚为师，苏晚说三年后告诉他身世。`;

type ModelHook = (prompt: string) => string | undefined;

/** A fake model that answers every pipeline prompt; `hook` can override per test. */
function model(hook: ModelHook = () => undefined) {
  return (prompt: string) => {
    const custom = hook(prompt);
    if (custom !== undefined) return custom;
    if (prompt.includes("抽取故事记忆")) return JSON.stringify({ summary: "摘要", threads: prompt.includes("拜师") ? [{ threadId: null, type: "plant", kind: "mystery", tier: "volume", title: "林舟身世", description: "三年后告知" }] : [], changes: ["relation"], emotionBeats: [{ type: "rise", reason: "" }] });
    if (prompt.includes("归纳为一个情节弧")) return JSON.stringify({ title: "弧", summary: "弧摘要", conflicts: "", growth: "" });
    if (prompt.includes("写卷大纲")) return JSON.stringify({ summary: "卷摘要", mainline: "主线", sublines: "" });
    if (prompt.includes("写全书大纲")) return JSON.stringify({ outline: "# 全书", mainline: "主线", characterArcs: "" });
    if (prompt.includes("判断每一对")) return JSON.stringify({ same: [] });
    if (prompt.includes("【刚发布的章节】")) return JSON.stringify({ summary: "新人物与新期待", threads: [{ threadId: null, title: "三年之约", kind: "expectation", tier: "volume", description: "林舟要等三年", progress: 0.1 }], characters: [{ id: null, name: "苏晚", role: "师父", desire: "护住林舟" }], factions: [], relations: [{ a: "林舟", b: "苏晚", social: "师徒", event: "拜师" }], worldviewAppend: "青云宗收徒看缘分。", backgroundAppend: "" });
    if (prompt.includes("【读者试读反馈】")) return JSON.stringify({ worked: [], problems: [{ title: "拜师太顺", detail: "", quote: "" }], splits: [], intentGaps: [], actions: [{ title: "让身世线往前走一步", detail: "", scope: "next" }] });
    if (prompt.includes("【你刚读完】")) return JSON.stringify({ verdict: "keep", reason: "想知道身世", comment: "拜师了", marks: [], guesses: [], wants: [{ title: "身世揭开", detail: "" }], lost: [] });
    if (prompt.includes("替作者整理作家笔记")) return JSON.stringify({ progress: "开篇", storySoFar: "拜师", focus: ["身世"], next: [{ title: "写下山", detail: "", chapter: null }], threads: [], risks: [], promiseDrift: "", gaps: [] });
    if (prompt.includes("【这一章的方向】")) return JSON.stringify({ title: "下山", core: "离开的不舍", summary: "林舟下山", promiseAlignment: "direct", threads: { advance: ["林舟身世"], plant: ["山下的仇家"], payoff: [] }, hook: "山门外有人等他", scenes: [1, 2, 3].map((index) => ({ title: `场${index}`, goal: "下山", stakes: "错过时机", changes: ["info"], events: ["a", "b", "c"], words: 3000 })) });
    if (prompt.includes("【草稿】\n")) return prompt.split("【草稿】\n")[1].split("\n\n【任务】")[0];
    const scene = prompt.match(/写场景(\d+)/);
    if (scene) return `第${scene[1]}场的正文，林舟迈步。`;
    if (prompt.includes("【待审草稿】")) return JSON.stringify({ issues: [{ quote: "第2场的正文", problem: "太平", suggestion: "加点动作", severity: "warning", category: "prose" }] });
    if (prompt.includes("【需要修订的段落】")) return "第2场改过的正文，林舟一脚踢开门。";
    return "{}";
  };
}

async function setup(configure?: (project: WriterProject) => void): Promise<{ project: WriterProject; chapterId: string }> {
  const imported = await importManuscript(splitManuscript(BOOK, { mode: "auto", targetLength: 3000 }), { title: "测试" });
  if (configure) await mutateProject(imported.id, configure);
  const project = await openProject(imported.id);
  return { project, chapterId: orderedChapters(project)[1].id };
}

async function run(projectId: string): Promise<PipelineRun> {
  await runPipelineWork(projectId, "test");
  const latest = (await listRuns(projectId))[0];
  return (await loadRun(projectId, latest.id)) as PipelineRun;
}

const statuses = (value: PipelineRun) => Object.fromEntries(value.steps.map((step) => [step.kind, step.status]));

describe("publish pipeline", () => {
  it("writes what the checklist finds into the margin, keeping only notes it can anchor", async () => {
    const review = JSON.stringify({ verdicts: [
      { item: "〔场景〕这场有改变", status: "fail", quote: "苏晚说三年后告诉他身世", problem: "拜师太顺", suggestion: "加一道阻力" },
      { item: "〔场景〕对不上原文", status: "fail", quote: "正文里没有这句话", problem: "找不到位置", suggestion: "" },
      { item: "〔文字〕做到了", status: "pass", quote: "", problem: "", suggestion: "" },
    ] });
    host.setModel(model((prompt) => (prompt.includes("【待审章节】") ? review : undefined)));
    const { project, chapterId } = await setup((draft) => { draft.settings.pipeline.steps = ["notes"]; });
    await startPublishRun(project, chapterId);
    const current = await run(project.id);
    expect(statuses(current)["chapter.notes"]).toBe("done");
    const notes = (await loadNotebook(project.id)).marginNotes[chapterId];
    expect(notes.map((note) => note.quote)).toEqual(["苏晚说三年后告诉他身世"]);
    expect(notes[0].comment).toContain("拜师太顺");
  });

  it("builds steps from the work's settings", async () => {
    const { project } = await setup((draft) => { draft.settings.pipeline.steps = ["story"]; });
    expect(publishSteps(project).map((step) => step.kind)).toEqual(["memory.extract", "memory.resolve", "memory.arcs", "memory.volumes", "memory.book", "memory.conflicts", "story.update", "story.health"]);
  });

  it("runs memory, story, reader and briefing steps, waits for plan approval, then drafts, revises and proposes the next chapter", async () => {
    host.setModel(model());
    const { project, chapterId } = await setup();
    await startPublishRun(project, chapterId);
    let current = await run(project.id);
    expect(current.state).toBe("awaiting");
    expect(statuses(current)["next.plan"]).toBe("awaiting");
    expect(statuses(current)["next.draft"]).toBe("pending");
    expect(statuses(current)["briefing"]).toBe("done");

    // Story update became a pending proposal with thread, story, entity and text changes.
    const storyProposal = (await loadProposals(project.id)).find((proposal) => proposal.title.includes("设定更新"));
    expect(storyProposal?.source).toMatchObject({ kind: "pipeline", runId: current.id });
    expect(storyProposal?.changes.map((change) => change.kind).sort()).toEqual(["entity", "story", "text", "thread"]);
    // Every reader on the default panel read the chapter, and the summary's next-chapter action steers the plan.
    const reader = (await loadNotebook(project.id)).readers[chapterId];
    expect(reader.voices).toHaveLength(5);
    expect(reader.voices[0].wants[0].title).toBe("身世揭开");
    expect(current.steps.find((step) => step.kind === "reader.snapshot")?.summary).toBe("5/5 位继续追；最大问题：拜师太顺");
    expect((await new MemoryStore(project.id).loadThreads()).find((thread) => thread.title === "林舟身世")?.kind).toBe("mystery");

    // The author edits the plan title and approves.
    const planStep = current.steps.find((step) => step.kind === "next.plan")!;
    const artifact = await readArtifact<{ plan: { title: string }; direction: string }>(project.id, current.id, planStep.id);
    expect(artifact?.direction).toContain("读者最想看：身世揭开");
    expect(artifact?.direction).toContain("读者反馈建议：让身世线往前走一步");
    await sendCommand(project.id, { runId: current.id, type: "approve", stepId: planStep.id, payload: { plan: { ...artifact!.plan, title: "下山（改）" } } });
    current = await run(project.id);
    expect(current.state).toBe("done");
    const review = await readArtifact<ReviewArtifact>(project.id, current.id, current.steps.find((step) => step.kind === "next.review")!.id);
    expect(review?.text).toContain("第2场改过的正文");
    expect(review?.fixed).toHaveLength(1);
    const draft = (await loadProposals(project.id)).find((proposal) => proposal.title.startsWith("下一章草稿"));
    expect(draft?.title).toBe("下一章草稿：下山（改）");
    const change = draft?.changes[0];
    expect(change?.kind === "text" && change.createChapter?.title).toBe("下山（改）");
    expect(change?.kind === "text" && change.after).toContain("第1场的正文");
  });

  it("records readability counts before and after an editor-approved clarity revision", async () => {
    const quote = "他想起掌柜的侄子的那间铺子的账本";
    host.setModel(model((prompt) => {
      if (prompt.includes("【待审草稿】")) return JSON.stringify({ issues: [{ quote, problem: "几层关系叠在一起", suggestion: "分开交代是谁的账本", severity: "warning", category: "clarity" }] });
      if (prompt.includes("【需要修订的段落】")) return "他想起那本账。账本在掌柜侄子的铺子里。";
      if (prompt.includes("写场景")) return prompt.includes("写场景1") ? `${quote}。` : "林舟合上旧账。";
      return undefined;
    }));
    const { project, chapterId } = await setup((draft) => { draft.settings.pipeline.planGate = "auto"; });
    await startPublishRun(project, chapterId);
    const current = await run(project.id);
    expect(current.state).toBe("done");
    const step = current.steps.find((item) => item.kind === "next.review")!;
    const artifact = await readArtifact<ReviewArtifact>(project.id, current.id, step.id);
    expect(artifact?.readability.before.modifierChains).toBe(1);
    expect(artifact?.readability.after.modifierChains).toBe(0);
    expect(artifact?.issues[0].category).toBe("clarity");
    expect(artifact?.fixed).toHaveLength(1);
    expect(step.summary).toContain("难读提示 1→0（自动检测）");
    expect(artifact?.text).toContain("账本在掌柜侄子的铺子里");
  });

  it("auto-applies thread and relation updates under the auto-safe gate and skips the plan gate when off", async () => {
    host.setModel(model());
    const { project, chapterId } = await setup((draft) => { draft.settings.pipeline.storyGate = "auto-safe"; draft.settings.pipeline.planGate = "auto"; });
    await startPublishRun(project, chapterId);
    const current = await run(project.id);
    expect(current.state).toBe("done");
    const proposals = await loadProposals(project.id);
    expect(proposals.find((proposal) => proposal.title.includes("已自动应用"))?.status).toBe("applied");
    expect(proposals.find((proposal) => proposal.title.endsWith("设定更新"))?.changes.map((change) => change.kind).sort()).toEqual(["entity", "text"]);
    expect((await new MemoryStore(project.id).loadThreads()).some((thread) => thread.title === "三年之约")).toBe(true);
  });

  it("pauses between scenes and resumes at the next unwritten scene", async () => {
    let projectId = "";
    let runId = "";
    let paused = false;
    host.setModel(model((prompt) => {
      if (prompt.includes("写场景2") && !paused) { paused = true; void sendCommand(projectId, { runId, type: "pause" }); }
      return undefined;
    }));
    const { project, chapterId } = await setup((draft) => { draft.settings.pipeline.planGate = "auto"; });
    projectId = project.id;
    runId = (await startPublishRun(project, chapterId)).id;
    let current = await run(project.id);
    expect(current.state).toBe("paused");
    expect(statuses(current)["next.draft"]).toBe("pending");
    const saved = await readArtifact<DraftArtifact>(project.id, runId, current.steps.find((step) => step.kind === "next.draft")!.id);
    expect(saved?.written).toEqual([0, 1]);
    const before = host.modelCalls.length;
    await sendCommand(project.id, { runId, type: "resume" });
    current = await run(project.id);
    expect(current.state).toBe("done");
    const scenes = host.modelCalls.slice(before).map((call) => call.prompt.match(/写场景(\d+)/)?.[1]).filter(Boolean);
    expect(scenes).toEqual(["3"]);
  });

  it("re-runs one step and marks finished dependants stale, or re-runs them too with cascade", async () => {
    host.setModel(model());
    const { project, chapterId } = await setup((draft) => { draft.settings.pipeline.steps = ["story", "reader"]; });
    const { id } = await startPublishRun(project, chapterId);
    let current = await run(project.id);
    expect(current.state).toBe("done");
    const resolve = current.steps.find((step) => step.kind === "memory.resolve")!;
    await sendCommand(project.id, { runId: id, type: "rerun", stepId: resolve.id });
    current = await run(project.id);
    expect(current.state).toBe("done");
    expect(statuses(current)["memory.resolve"]).toBe("done");
    expect(statuses(current)["story.health"]).toBe("stale");
    const before = host.modelCalls.length;
    await sendCommand(project.id, { runId: id, type: "rerun", stepId: current.steps.find((step) => step.kind === "story.update")!.id, cascade: true });
    current = await run(project.id);
    expect(statuses(current)["story.health"]).toBe("done");
    expect(host.modelCalls.slice(before).some((call) => call.prompt.includes("【刚发布的章节】"))).toBe(true);
  });

  it("stops at a failed step, keeps independent work going, and continues after skipping it", async () => {
    host.setModel(model((prompt) => { if (prompt.includes("【你刚读完】")) throw new Error("401 unauthorized api key"); return undefined; }));
    const { project, chapterId } = await setup((draft) => { draft.settings.pipeline.steps = ["story", "reader", "briefing"]; });
    const { id } = await startPublishRun(project, chapterId);
    let current = await run(project.id);
    expect(current.state).toBe("error");
    expect(statuses(current)["reader.snapshot"]).toBe("failed");
    expect(statuses(current)["story.update"]).toBe("done");
    expect(statuses(current)["briefing"]).toBe("pending");
    await sendCommand(project.id, { runId: id, type: "skip", stepId: current.steps.find((step) => step.kind === "reader.snapshot")!.id });
    current = await run(project.id);
    expect(current.state).toBe("done");
    expect(statuses(current)["briefing"]).toBe("done");
  });

  it("cancels an unfinished publish run when the chapter is published again, and leaves the lease to one runner", async () => {
    host.setModel(model());
    const { project, chapterId } = await setup();
    const first = await startPublishRun(project, chapterId);
    const second = await startPublishRun(project, chapterId);
    host.storage.set(`writer.pipeline.lease.${project.id}`, { owner: "other", expiresAt: Date.now() + 60_000 });
    expect(await runPipelineWork(project.id, "test")).toBe(false);
    host.storage.delete(`writer.pipeline.lease.${project.id}`);
    await runPipelineWork(project.id, "test");
    expect((await loadRun(project.id, first.id))?.state).toBe("cancelled");
    expect((await loadRun(project.id, second.id))?.state).toBe("awaiting");
  });

  it("counts model usage per step", async () => {
    host.setModel(model());
    const { project, chapterId } = await setup((draft) => { draft.settings.pipeline.steps = ["reader"]; });
    await startPublishRun(project, chapterId);
    const current = await run(project.id);
    // Five readers on the default panel, then one summary.
    expect(current.steps.find((step) => step.kind === "reader.snapshot")?.usage.calls).toBe(6);
    expect(current.steps.find((step) => step.kind === "memory.conflicts")?.usage.calls).toBe(0);
  });
});

describe("commands", () => {
  const base = (): PipelineRun => ({ id: "r", projectId: "p", template: "publish", title: "", trigger: { kind: "publish", chapterId: null, chapterIds: null }, state: "done", steps: [newStep("s1", "memory.extract"), newStep("s2", "memory.resolve", ["s1"]), newStep("s3", "memory.arcs", ["s2"])], message: "", createdAt: 0, updatedAt: 0 });

  it("re-runs with and without cascade", () => {
    const value = base();
    for (const step of value.steps) step.status = "done";
    expect(applyCommand(value, { id: "c", runId: "r", type: "rerun", stepId: "s1", at: 0 })).toEqual(["s1"]);
    expect(value.steps.map((step) => step.status)).toEqual(["pending", "stale", "stale"]);
    expect(value.state).toBe("queued");
    const cascade = base();
    for (const step of cascade.steps) step.status = "done";
    expect(applyCommand(cascade, { id: "c", runId: "r", type: "rerun", stepId: "s2", cascade: true, at: 0 })).toEqual(["s2", "s3"]);
    expect(cascade.steps.map((step) => step.status)).toEqual(["done", "pending", "pending"]);
  });
});
