import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testCard } from "../test/fixtures";
import { installFakeHost, uninstallFakeHost, type FakeHost } from "../test/fakeHost";
import { assembleContext, buildWritingContext } from "./context";
import { extractJson } from "./client";
import { runAgent } from "./agent";
import { rewriteSelection } from "./quick";
import { normalizeProject, normalizeChapterMeta } from "../domain/normalize";
import { MemoryView } from "../memory/view";
import { emptyStatus, type ChapterCard } from "../memory/schema";
import { byteLength, invokeText, MAX_PROMPT_BYTES } from "./client";
import { normalizeRouting, saveModelRouting } from "./models";
import type { AgentTaskStartRequest } from "@daily/plugin-sdk";
import type { AgentTaskResponse } from "../types";

let host: FakeHost;
beforeEach(() => { host = installFakeHost(); });
afterEach(() => uninstallFakeHost());

function bigProject(chapters: number) {
  const project = normalizeProject({ schemaVersion: 3, id: "p", title: "长篇", styleGuide: "第三人称", outline: "大纲".repeat(20_000), worldview: "世界".repeat(20_000) });
  for (let index = 0; index < chapters; index += 1) project.chapters.push(normalizeChapterMeta({ id: `c${index}`, volumeId: project.volumes[0].id, title: `第${index + 1}章`, rank: (index + 1) * 1024, wordCount: 3000 }));
  return project;
}

function card(chapterId: string, summary: string): ChapterCard {
  return testCard(chapterId, { summary, facts: [{ subject: "林舟", attribute: "位置", value: `地点${chapterId}`, kind: "state", quote: "" }], mentions: { 林舟: 3 } });
}

describe("context builder", () => {
  it("admits blocks by priority, truncates trim-able blocks and keeps insertion order", () => {
    const result = assembleContext([
      { id: "a", title: "A", content: "x".repeat(50), priority: 3 },
      { id: "b", title: "B", content: "y".repeat(500), priority: 1, trim: "tail", minChars: 10 },
      { id: "c", title: "C", content: "z".repeat(100), priority: 0 },
    ], 300);
    expect(result.included).toEqual(["a", "b", "c"].filter((id) => result.included.includes(id)));
    expect(result.included).toContain("c");
    expect(result.chars).toBeLessThanOrEqual(320);
  });

  it("stays within budget for a 4000-chapter book and includes state as of the position", () => {
    const project = bigProject(4_000);
    const cards = new Map(project.chapters.map((chapter) => [chapter.id, card(chapter.id, `第${chapter.title}摘要`.repeat(20))]));
    const memory = new MemoryView(project, cards, [{ id: "e1", name: "林舟", aliases: [], category: "character", summary: "主角", origin: "extracted", bibleId: null, updatedAt: 0 }], [], { arcs: [], volumes: [], book: { inputHash: "", outline: "全书".repeat(30_000), mainline: "", characterArcs: "", generatedAt: 0 }, worldview: null }, [], emptyStatus());
    const context = buildWritingContext({ project, memory, position: 3_000, focus: "林舟走进城门", previousChapterText: "上一章".repeat(5_000), budget: 60_000 });
    expect(context.chars).toBeLessThanOrEqual(60_500);
    expect(byteLength(context.text)).toBeLessThan(MAX_PROMPT_BYTES);
    expect(context.text).toContain("地点c2999");
    expect(context.text).not.toContain("地点c3001");
    expect(context.included).toEqual(expect.arrayContaining(["style", "previous", "entities", "recent"]));
  });
});

describe("model helpers", () => {
  it("extracts JSON from fenced or chatty output", () => {
    expect(extractJson("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(extractJson("好的：{\"a\":[1,2,],}")).toEqual({ a: [1, 2] });
  });

  it("rewrites selections into candidates", async () => {
    host.setModel(() => JSON.stringify({ candidates: ["版本一", "版本二"] }));
    const project = bigProject(2);
    const result = await rewriteSelection({ project, memory: null, texts: { c0: "", c1: "他笑了。" }, position: 1, docText: "他笑了。", start: 0, end: 4, instruction: "润色", candidates: 2 });
    expect(result).toEqual(["版本一", "版本二"]);
  });

  it("stops waiting on a hung model call when the signal aborts", async () => {
    host.setModel(() => new Promise<string>(() => undefined));
    const controller = new AbortController();
    const pending = invokeText({ task: "prose", system: "s", prompt: "p", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("已取消");
  });

  it("retries a host timeout only once", async () => {
    let calls = 0;
    host.setModel(() => { calls += 1; throw new Error("Desktop command plugin_host_rpc timed out."); });
    await expect(invokeText({ task: "prose", system: "s", prompt: "p", retries: 3 })).rejects.toThrow("timed out");
    expect(calls).toBe(2);
  });

  it("sends the model chosen for the task and the default for unrouted tasks", async () => {
    await saveModelRouting({ prose: { authConfigId: "codex-default", model: "gpt-5.4-mini" } });
    await invokeText({ task: "prose", system: "s", prompt: "p" });
    await invokeText({ task: "memory", system: "s", prompt: "p" });
    expect(host.modelCalls.map((call) => call.model)).toEqual([{ authConfigId: "codex-default", model: "gpt-5.4-mini" }, undefined]);
  });
});

describe("agent", () => {
  it("advertises the volume contract and lets the model correct a malformed seven-volume call", async () => {
    const project = bigProject(0);
    const volumes = [
      { order: 1, title: "第一卷：青云试剑，寒门负雪", volumeId: "volume-main" },
      { order: 2, title: "第二卷：法契如天，折骨断剑", volumeId: "volume-02" },
      { order: 3, title: "第三卷：灰河星火，孤魂出壁", volumeId: "volume-03" },
      { order: 4, title: "第四卷：清泉重修，借身行古", volumeId: "volume-04" },
      { order: 5, title: "第五卷：正魔渡口，照骨辨伪", volumeId: "volume-05" },
      { order: 6, title: "第六卷：仙台照影，两界重逢", volumeId: "volume-06" },
      { order: 7, title: "第七卷：分地夺印，星汉通途", volumeId: "volume-07" },
    ];
    const corrected = volumes.map((volume) => ({ type: "upsertVolume", volume: { id: volume.volumeId, title: volume.title, rank: volume.order * 1024, summary: "" } }));
    const responses: AgentTaskResponse[] = [
      { status: "tool_call", runId: "bad-volumes", toolId: "writer.applyPatchOperations", toolName: "", pendingMessage: "", input: { operations: volumes }, metadata: {}, eventViews: [], iterationsUsed: 1, maxIterations: 1000 },
      { status: "tool_call", runId: "corrected-volumes", toolId: "writer.applyPatchOperations", toolName: "", pendingMessage: "", input: { operations: corrected }, metadata: {}, eventViews: [], iterationsUsed: 2, maxIterations: 1000 },
      { status: "completed", text: "", value: { reply: "请审核分卷", title: "分卷", summary: "设置七卷" }, eventViews: [], iterationsUsed: 3, maxIterations: 1000 },
    ];
    const deliveries: { ok: boolean; observation: string }[] = [];
    let started: AgentTaskStartRequest | undefined;
    Object.assign(host.api.agent.task, {
      start: async (payload: AgentTaskStartRequest) => { started = payload; return responses.shift(); },
      resume: async (payload: { ok: boolean; observation: string }) => { deliveries.push(payload); return responses.shift(); },
    });

    const result = await runAgent({ project, memory: null, texts: {}, sessionId: "volumes", instruction: "修改七卷标题和顺序", activeDoc: { kind: "outline" }, selection: null }, () => undefined);
    const patchTool = started?.tools?.find((tool) => tool.id === "writer.applyPatchOperations");
    expect(patchTool?.inputSchema).toMatchObject({
      properties: { operations: { maxItems: 200, items: {
        type: "object", required: ["type"], additionalProperties: false,
        properties: {
          type: { type: "string", enum: expect.arrayContaining(["upsertVolume", "upsertCharacter", "setProjectField"]) },
          volume: { required: ["id", "title", "rank", "summary"], additionalProperties: false, properties: { id: { type: "string" }, title: { type: "string" }, rank: { type: "number" }, summary: { type: "string" } } },
        },
      } } },
    });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0].ok).toBe(false);
    expect(deliveries[0].observation).toContain("operations[0]: Writer patch 缺少 type");
    expect(deliveries[0].observation).toContain('"type":"upsertVolume"');
    expect(deliveries[1]).toMatchObject({ ok: true, observation: "已在草稿中执行 7 个设定修改。" });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error(result.status);
    expect(result.proposal?.status).toBe("pending");
    expect(result.proposal?.changes.map((change) => change.kind === "entity" && change.operation)).toEqual(corrected);
    expect(project.volumes).toEqual([{ id: "volume-main", title: "正文", rank: 1024, summary: "" }]);
  });

  it("replaces the exact selection (not the first match) and produces a proposal", async () => {
    const project = bigProject(1);
    const text = "他笑了。她也笑了。他笑了。";
    const responses: AgentTaskResponse[] = [
      { status: "tool_call", runId: "r1", toolId: "writer.replaceText", toolName: "", pendingMessage: "", input: { doc: "chapter", chapterId: "c0", useSelection: true, replacement: "他终于笑了。" }, metadata: {}, eventViews: [], iterationsUsed: 1, maxIterations: 1000 },
      { status: "completed", text: "", value: { reply: "改好了", title: "润色", summary: "润色最后一句" }, eventViews: [], iterationsUsed: 2, maxIterations: 1000 },
    ];
    let observations: string[] = [];
    Object.assign(host.api.agent.task, {
      start: async () => responses.shift(),
      resume: async (payload: { observation: string }) => { observations.push(payload.observation); return responses.shift(); },
    });
    const result = await runAgent({ project, memory: null, texts: { c0: text }, sessionId: "session-1", instruction: "润色", activeDoc: { kind: "chapter", id: "c0" }, selection: { doc: { kind: "chapter", id: "c0" }, start: 9, end: 13, text: "他笑了。" } }, () => undefined);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    const change = result.proposal?.changes[0];
    expect(change?.kind === "text" && change.after).toBe("他笑了。她也笑了。他终于笑了。");
    expect(observations[0]).toContain("已在草稿中修改");
  });

  it("keeps the selection on what the author selected through edits, and rereads after a change", async () => {
    const project = bigProject(1);
    const call = (runId: string, toolId: string, input: unknown): AgentTaskResponse => ({ status: "tool_call", runId, toolId, toolName: "", pendingMessage: "", input, metadata: {}, eventViews: [], iterationsUsed: 1, maxIterations: 1000 });
    const read = { doc: "chapter", chapterId: "c0" };
    const responses: AgentTaskResponse[] = [
      call("r1", "writer.readDocument", read),
      call("r2", "writer.insertText", { doc: "chapter", chapterId: "c0", position: "start", text: "天黑了。" }),
      call("r3", "writer.readDocument", read),
      call("r4", "writer.replaceText", { doc: "chapter", chapterId: "c0", useSelection: true, replacement: "他终于笑了。" }),
      call("r5", "writer.replaceText", { doc: "chapter", chapterId: "c0", useSelection: true, replacement: "他终于笑出了声。" }),
      { status: "completed", text: "", value: { reply: "改好了" }, eventViews: [], iterationsUsed: 6, maxIterations: 1000 },
    ];
    const observations: string[] = [];
    Object.assign(host.api.agent.task, {
      start: async () => responses.shift(),
      resume: async (payload: { observation: string }) => { observations.push(payload.observation); return responses.shift(); },
    });
    const result = await runAgent({ project, memory: null, texts: { c0: "他笑了。她也笑了。他笑了。" }, sessionId: "session-1", instruction: "润色", activeDoc: { kind: "chapter", id: "c0" }, selection: { doc: { kind: "chapter", id: "c0" }, start: 9, end: 13, text: "他笑了。" } }, () => undefined);
    // The same read after an insert is read again, not answered with "unchanged".
    expect(observations[2]).toContain("天黑了。");
    expect(observations[3]).toContain("已在草稿中修改");
    expect(observations[4]).toContain("已在草稿中修改");
    if (result.status !== "completed") throw new Error(result.status);
    const change = result.proposal?.changes[0];
    expect(change?.kind === "text" && change.after).toBe("天黑了。他笑了。她也笑了。他终于笑出了声。");
  });
});

describe("agent stop and continue", () => {
  const toolCall = (runId: string, toolId: string, input: unknown = {}): AgentTaskResponse => ({ status: "tool_call", runId, toolId, toolName: "", pendingMessage: "", input, metadata: {}, eventViews: [], iterationsUsed: 1, maxIterations: 1000 });
  const done = (reply: string): AgentTaskResponse => ({ status: "completed", text: "", value: { reply, title: "改写", summary: reply }, eventViews: [], iterationsUsed: 3, maxIterations: 1000 });
  const replace = { doc: "chapter", chapterId: "c0", quote: "旧句子", replacement: "新句子" };

  it("pauses before the next tool and keeps the checkpoint instead of cancelling", async () => {
    const project = bigProject(1);
    const controller = new AbortController();
    const cancelled: string[] = [];
    let resumed = 0;
    Object.assign(host.api.agent.task, {
      start: async () => { controller.abort(); return toolCall("r9", "writer.readProjectIndex"); },
      resume: async () => { resumed += 1; return done(""); },
      cancel: async (runId: string) => { cancelled.push(runId); return { cancelled: true }; },
    });
    const result = await runAgent({ project, memory: null, texts: { c0: "正文" }, sessionId: "s", instruction: "看看", activeDoc: { kind: "chapter", id: "c0" }, selection: null, signal: controller.signal }, () => undefined);
    expect(result).toMatchObject({ status: "paused", runId: "r9" });
    expect(resumed).toBe(0);
    expect(cancelled).toEqual([]);
    const { listPendingRuns } = await import("./agent");
    expect(await listPendingRuns("p")).toEqual([expect.objectContaining({ runId: "r9", kind: "checkpoint", sessionId: "s" })]);
  });

  it("continues a failed resume from its checkpoint without redoing the edits", async () => {
    const { continueFromCheckpoint, ResumableRunError } = await import("./agent");
    const project = bigProject(1);
    const resumes: string[] = [];
    let failNext = true;
    Object.assign(host.api.agent.task, {
      start: async () => toolCall("r1", "writer.replaceText", replace),
      resume: async (payload: { runId: string; observation: string }) => {
        resumes.push(payload.observation);
        if (failNext) { failNext = false; throw new Error("upstream closed"); }
        return done("改好了");
      },
      // The host replays the failed resume.
      retry: async () => done("改好了"),
    });
    const error = await runAgent({ project, memory: null, texts: { c0: "开头。旧句子。结尾。" }, sessionId: "s", instruction: "改", activeDoc: { kind: "chapter", id: "c0" }, selection: null }, () => undefined).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ResumableRunError);
    expect((error as InstanceType<typeof ResumableRunError>).runId).toBe("r1");
    expect(resumes).toHaveLength(1);

    const result = await continueFromCheckpoint("r1", () => undefined, null);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    const change = result.proposal?.changes[0];
    expect(change?.kind === "text" && change.after).toBe("开头。新句子。结尾。");
    // The edit was applied once and the checkpoint is gone.
    expect(result.proposal?.changes).toHaveLength(1);
    expect(resumes).toHaveLength(1);
    expect([...host.privateFiles.keys()].filter((key) => key.includes("runs/"))).toEqual([]);
  });

  it("delivers the saved tool result when the host hands back a tool that already ran", async () => {
    const { continueFromCheckpoint } = await import("./agent");
    const project = bigProject(1);
    const controller = new AbortController();
    const observations: string[] = [];
    let calls = 0;
    Object.assign(host.api.agent.task, {
      start: async () => toolCall("r2", "writer.replaceText", replace),
      resume: async (payload: { observation: string }) => {
        observations.push(payload.observation);
        calls += 1;
        // Interrupted before the host recorded the result (e.g. the app closed).
        if (calls === 1) throw new Error("App closed");
        return done("好了");
      },
      retry: async () => toolCall("r2", "writer.replaceText", replace),
    });
    await runAgent({ project, memory: null, texts: { c0: "旧句子" }, sessionId: "s", instruction: "改", activeDoc: { kind: "chapter", id: "c0" }, selection: null, signal: controller.signal }, () => undefined).catch(() => undefined);
    const result = await continueFromCheckpoint("r2", () => undefined, null);
    expect(result.status).toBe("completed");
    expect(observations).toHaveLength(2);
    expect(observations[1]).toBe(observations[0]);
    if (result.status === "completed") expect(result.proposal?.changes).toHaveLength(1);
  });

  it("continues a run the host carried on after the bridge timed out, keeping earlier edits", async () => {
    const { continueFromCheckpoint } = await import("./agent");
    const project = bigProject(1);
    const resumed: string[] = [];
    Object.assign(host.api.agent.task, {
      start: async () => toolCall("r1", "writer.replaceText", replace),
      resume: async (payload: { runId: string }) => {
        resumed.push(payload.runId);
        // The host got the result and went on to pause at r3, but the bridge gave up first.
        if (payload.runId === "r1") throw new Error("Desktop command plugin_host_rpc timed out.");
        return done("改好了");
      },
      // r1 was consumed by the host; only the paused r3 can be continued.
      retry: async (payload: { runId: string }) => {
        if (payload.runId !== "r3") throw new Error("Agent task run not found.");
        return toolCall("r3", "writer.readProjectIndex");
      },
    });
    await runAgent({ project, memory: null, texts: { c0: "开头。旧句子。结尾。" }, sessionId: "s", instruction: "改", activeDoc: { kind: "chapter", id: "c0" }, selection: null }, () => undefined).catch(() => undefined);
    await expect(continueFromCheckpoint("r3", () => undefined, null)).rejects.toThrow("找不到");

    const result = await continueFromCheckpoint("r3", () => undefined, null, undefined, "s");
    expect(result.status).toBe("completed");
    // r3's own tool ran; r1's saved result was not sent again.
    expect(resumed).toEqual(["r1", "r3"]);
    if (result.status === "completed") expect(result.proposal?.changes[0]?.kind === "text" && result.proposal.changes[0].after).toBe("开头。新句子。结尾。");
    expect([...host.privateFiles.keys()].filter((key) => key.includes("runs/"))).toEqual([]);
  });

  it("applies live progress patches for its stream", async () => {
    const project = bigProject(1);
    const listeners: ((event: unknown) => void)[] = [];
    Object.assign(host.api, { on: (_event: string, listener: (event: unknown) => void) => { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1); } });
    const seen: string[] = [];
    Object.assign(host.api.agent.task, {
      start: async (payload: { streamId: string }) => {
        const view = { id: "t-ply-1-thought", parserId: "", kind: "llm_thought", status: "in_progress", role: null, title: "Agent 思考", content: "想", ply: 1, toolId: null, toolName: null, metadata: null, createdAt: 0, updatedAt: 0 };
        listeners.forEach((listener) => listener({ streamId: "other", patches: [{ view: { ...view, id: "x" }, merge: "replace" }] }));
        listeners.forEach((listener) => listener({ streamId: payload.streamId, patches: [{ view, merge: "replace" }] }));
        listeners.forEach((listener) => listener({ streamId: payload.streamId, patches: [{ view: { ...view, content: "法" }, merge: "append_content" }] }));
        return done("好");
      },
    });
    await runAgent({ project, memory: null, texts: { c0: "" }, sessionId: "s", instruction: "想想", activeDoc: { kind: "chapter", id: "c0" }, selection: null }, (views) => seen.push(views.map((view) => `${view.id}:${view.content}`).join(",")));
    expect(seen).toContain("t-ply-1-thought:想法");
    expect(seen.some((line) => line.includes("x:"))).toBe(false);
    expect(listeners).toHaveLength(0);
  });
});

describe("setting material", () => {
  it("keeps long-material notes as Markdown and preserves unresolved facts before organization", async () => {
    const { organizeSettings } = await import("./pipelines/organizeSettings");
    const notes: string[] = [];
    host.setModel((prompt, system) => {
      if (prompt.startsWith("把下面这部分设定材料整理成清楚的要点")) {
        notes.push(prompt);
        expect(system).not.toContain("只输出要求的 JSON");
        expect(prompt).toContain("互相矛盾或还没定下来的地方照实记下");
        return "## 世界观\n渡河先付船钱，能否赊账仍待作者决定。";
      }
      if (prompt.includes("写一份能直接查用的世界观设定")) return "渡河要付船钱。";
      return JSON.stringify({ architecture: "渡口和船行的关系", openQuestions: ["能否赊账？"] });
    });
    const proposal = await organizeSettings(bigProject(0), "渡河要付船钱，能否赊账还没定。\n".repeat(4_000), "保留未决问题");
    expect(notes.length).toBeGreaterThan(1);
    expect(host.modelCalls.find((call) => call.prompt.includes("【设定材料】"))?.prompt).toContain("能否赊账仍待作者决定");
    expect(proposal.previewMarkdown).toContain("能否赊账？");
  });

  it("restructures a pasted setting draft into a reviewable proposal", async () => {
    const { organizeSettings, looksLikeSettingMaterial } = await import("./pipelines/organizeSettings");
    const material = `《天账司》设定：世界观是后庭时代，旧天庭崩塌。主角陈砚是旧阴司残衙账房。主要势力：太玄宗、金灯寺。主要人物：陈砚、裴明月。修炼体系为凭证修炼，境界分九品。${"背景说明。".repeat(160)}\n将以上设定重新抽丝剥茧，全部重构，给出更加合适的架构`;
    expect(looksLikeSettingMaterial(material)).toBe(true);
    expect(looksLikeSettingMaterial("帮我润色这一段")).toBe(false);
    host.setModel(() => JSON.stringify({ architecture: "三层架构", worldview: "## 世界本源\n后庭时代", background: "背景", outline: "大纲", styleGuide: "冷峻", characters: [{ name: "陈砚", role: "主角", summary: "账房" }, { name: "裴明月", role: "女捕头", summary: "" }], factions: [{ name: "太玄宗", summary: "功德认证" }], relations: [{ source: "陈砚", target: "裴明月", relation: "搭档" }], openQuestions: ["昊玄何时揭露"] }));
    const project = bigProject(0);
    const proposal = await organizeSettings(project, material, "全部重构");
    const kinds = proposal.changes.map((change) => (change.kind === "text" ? change.doc.kind : change.operation.type));
    expect(kinds).toEqual(["worldview", "background", "outline", "style", "upsertCharacter", "upsertCharacter", "upsertFaction", "upsertCharacterRelation"]);
    expect(proposal.previewMarkdown).toContain("昊玄何时揭露");
    expect(host.modelCalls[0].prompt).toContain("后庭时代");
    const style = host.modelCalls.find((call) => call.prompt.includes('"styleGuide"'))!;
    expect(style.prompt).toContain("描写多少由事情需要决定");
    expect(style.prompt).not.toMatch(/交互式布景|叙述体温|生存账本/);
    expect(style.system).toContain("读者读一遍就懂");
  });

  it("hands history to the host session instead of pasting it into the prompt", async () => {
    const project = bigProject(1);
    let payload: AgentTaskStartRequest | null = null;
    Object.assign(host.api.agent.task, { start: async (value: AgentTaskStartRequest) => { payload = value; return { status: "completed", text: "", value: { reply: "好" }, eventViews: [], iterationsUsed: 1, maxIterations: 1000, sessionId: "s1", entryId: "e1" }; } });
    const result = await runAgent({ project, memory: null, texts: { c0: "" }, sessionId: "s1", instruction: "继续", activeDoc: { kind: "outline" }, selection: null }, () => undefined);
    const sent = payload as AgentTaskStartRequest | null;
    expect(sent?.sessionId).toBe("s1");
    expect(sent?.model).toBeUndefined();
    expect(sent?.displayMessage).toBe("继续");
    expect(sent?.maxIterations).toBe(1000);
    expect(sent?.userPrompt).not.toContain("对话记录");
    expect(result.status === "completed" && result.entryId).toBe("e1");
  });
});

describe("model routing", () => {
  it("drops unknown tasks and malformed selections", () => {
    expect(normalizeRouting({ prose: { authConfigId: "a", model: "m" }, review: { model: "m" }, bogus: { authConfigId: "a", model: "m" } })).toEqual({ prose: { authConfigId: "a", model: "m" } });
  });

  it("runs the assistant on its chosen model", async () => {
    await saveModelRouting({ assistant: { authConfigId: "codex-default", model: "gpt-5.5" } });
    let payload: AgentTaskStartRequest | null = null;
    Object.assign(host.api.agent.task, { start: async (value: AgentTaskStartRequest) => { payload = value; return { status: "completed", text: "", value: { reply: "好" }, eventViews: [], iterationsUsed: 1, maxIterations: 1000, sessionId: "s1", entryId: "e1" }; } });
    await runAgent({ project: bigProject(1), memory: null, texts: { c0: "" }, sessionId: "s1", instruction: "继续", activeDoc: { kind: "outline" }, selection: null }, () => undefined);
    expect((payload as AgentTaskStartRequest | null)?.model).toEqual({ authConfigId: "codex-default", model: "gpt-5.5" });
  });
});

describe("agent sessions", () => {
  it("splits large appends into requests under the host payload limit", async () => {
    const { appendMessages, createSession } = await import("./sessions");
    const session = await createSession("p");
    let calls = 0;
    const original = host.api.agent.session.appendMessages;
    host.api.agent.session.appendMessages = async (id, messages) => { calls += 1; return original(id, messages); };
    const big = "字".repeat(100_000);
    const entries = await appendMessages(session.id, [{ role: "user", content: big }, { role: "user", content: big }, { role: "assistant", content: "短" }]);
    expect(entries).toHaveLength(3);
    expect(calls).toBeGreaterThan(1);
    expect(entries[0].content.length).toBeLessThan(big.length);
  });
});
