// Scale check for 10M-character manuscripts. Opt-in: SCALE=1 npx vitest run src/scale.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { installFakeHost, uninstallFakeHost } from "./test/fakeHost";
import { splitManuscript } from "./ingest/splitter";
import { importManuscript } from "./ingest/import";
import { openProject, saveDraft, loadChapterTexts } from "./storage/projectStore";
import { runPipelineWork } from "./pipeline/engine";
import { startMemoryRun } from "./pipeline/templates";
import { MemoryView } from "./memory/view";
import { buildWritingContext } from "./ai/context";
import { byteLength, MAX_PROMPT_BYTES } from "./ai/client";

const CHAPTERS = 4_000;
const CHAPTER_CHARS = 2_500;

describe.skipIf(!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.SCALE)("10M-character manuscript", () => {
  afterEach(() => uninstallFakeHost());
  it("imports, builds memory, and keeps context packs within budget", async () => {
    const host = installFakeHost();
    host.setModel((prompt) => {
      if (prompt.includes("抽取故事记忆")) {
        const n = Number(prompt.match(/第 (\d+) 章/)?.[1] ?? 0);
        return JSON.stringify({ summary: `第${n}章摘要：林舟历练。`, scenes: [{ title: "s", time: "", location: "城", characters: ["林舟", `路人${n % 50}`], summary: "" }], characters: [{ name: "林舟", change: "成长" }], entities: [{ name: `路人${n % 50}`, category: "character", aliases: [], description: "" }], facts: [{ subject: "林舟", attribute: "境界", value: `第${Math.floor(n / 100)}层`, kind: "state", quote: "" }], threads: n % 97 === 0 ? [{ threadId: null, type: "plant", title: `伏笔${n}`, description: "" }] : [], hook: "" });
      }
      if (prompt.includes("情节弧")) return JSON.stringify({ title: "弧", summary: "弧摘要".repeat(30), conflicts: "", growth: "" });
      if (prompt.includes("卷大纲")) return JSON.stringify({ summary: "卷摘要".repeat(50), mainline: "", sublines: "" });
      if (prompt.includes("压缩")) return "压缩摘要".repeat(40);
      if (prompt.includes("全书大纲")) return JSON.stringify({ outline: "全书".repeat(500), mainline: "", characterArcs: "" });
      return JSON.stringify({ same: [] });
    });
    const paragraph = "林舟踏过青石长街，风从城外吹来。".repeat(Math.ceil(CHAPTER_CHARS / 16)).slice(0, CHAPTER_CHARS);
    const raw = Array.from({ length: CHAPTERS }, (_, index) => `${index % 400 === 0 ? `第${index / 400 + 1}卷 卷名\n` : ""}第${index + 1}章 标题${index + 1}\n${paragraph}`).join("\n");
    expect(raw.length).toBeGreaterThan(10_000_000);

    let started = performance.now();
    const split = splitManuscript(raw, { mode: "auto", targetLength: 4_000 });
    expect(split.chapters).toHaveLength(CHAPTERS);
    const project = await importManuscript(split, { title: "超长篇" });
    const importMs = performance.now() - started;

    started = performance.now();
    const reopened = await openProject(project.id);
    const openMs = performance.now() - started;
    expect(reopened.chapters).toHaveLength(CHAPTERS);
    expect(host.privateFiles.get(`projects/${project.id}/project.json`)!.length).toBeLessThan(3_000_000);

    started = performance.now();
    await startMemoryRun(project.id, ["extract", "resolve", "arcs", "volumes", "book", "conflicts"]);
    await runPipelineWork(project.id, "scale");
    const buildMs = performance.now() - started;

    started = performance.now();
    const view = await MemoryView.load(reopened);
    const loadMs = performance.now() - started;
    expect(view.staleChapterIds()).toHaveLength(0);
    expect(view.aggregates.volumes).toHaveLength(10);
    expect(view.aggregates.book).not.toBeNull();

    started = performance.now();
    const lin = view.resolve("林舟")!;
    const state = view.stateAt(lin.id, 3_500);
    const related = view.relatedChapters([lin.id], 3_500, 6);
    const hits = view.searchCards("伏笔 历练", 10, 3_500);
    const context = buildWritingContext({ project: reopened, memory: view, position: 3_500, focus: "林舟走进城门", previousChapterText: paragraph });
    const queryMs = performance.now() - started;
    expect(state["境界"].value).toBe("第35层");
    expect(related.length).toBeGreaterThan(0);
    expect(hits.length).toBeGreaterThan(0);
    expect(byteLength(context.text)).toBeLessThan(MAX_PROMPT_BYTES);
    expect(context.chars).toBeLessThanOrEqual(reopened.settings.contextBudgetChars + 500);

    const ids = view.orderedIds;
    const base = { project: reopened, texts: await loadChapterTexts(project.id, [ids[1234]]) };
    const next = structuredClone(base);
    next.texts[ids[1234]] += "改动";
    const saved = await saveDraft(base, next);
    expect((await MemoryView.load(saved.draft.project)).staleChapterIds()).toEqual([ids[1234]]);

    console.log(JSON.stringify({ chars: raw.length, importMs: Math.round(importMs), openMs: Math.round(openMs), buildMs: Math.round(buildMs), modelCalls: host.modelCalls.length, memoryLoadMs: Math.round(loadMs), queryAndContextMs: Math.round(queryMs), contextChars: context.chars }));
  }, 600_000);
});
