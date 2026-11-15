import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeHost, uninstallFakeHost, type FakeHost } from "../test/fakeHost";
import { createProject, listProjects, loadChapterText, openProject, saveDraft } from "./projectStore";
import { createSnapshot, listSnapshots } from "./snapshots";
import { appendProposal, applyProposal, loadProposals, undoProposal } from "./proposalStore";
import { exportProject } from "./exporter";
import { recordWordTotal, wordsWrittenOn } from "./stats";
import { DEFAULT_PREFS, loadPrefs, savePrefs } from "./prefs";
import { normalizeChapterMeta, normalizeCharacter, OutdatedProjectError } from "../domain/normalize";
import { newProposal } from "../domain/proposals";
import { newThread, saveThread } from "../memory/operations";
import { MemoryStore } from "../memory/store";
import { emptyStoryPlan, normalizeSecret } from "../story/schema";
import { loadStoryPlan } from "../story/store";
import type { ProjectDraft, WriterProposal } from "../types";

let host: FakeHost;
beforeEach(() => { host = installFakeHost(); });
afterEach(() => uninstallFakeHost());

async function draftWithChapters(): Promise<ProjectDraft> {
  const project = await createProject({ title: "Test Novel" });
  const next: ProjectDraft = { project: structuredClone(project), texts: {} };
  const volumeId = project.volumes[0].id;
  next.project.chapters.push(normalizeChapterMeta({ id: "c1", volumeId, title: "第一章", rank: 1024 }), normalizeChapterMeta({ id: "c2", volumeId, title: "第二章", rank: 2048 }));
  next.texts = { c1: "一", c2: "二" };
  return (await saveDraft({ project, texts: {} }, next)).draft;
}

describe("project store v3", () => {
  it("stores chapter bodies in separate files and keeps project.json body-free", async () => {
    const draft = await draftWithChapters();
    expect(host.privateFiles.get(`projects/${draft.project.id}/chapters/c1.md`)).toBe("一");
    expect(host.privateFiles.get(`projects/${draft.project.id}/project.json`)).not.toContain("\"content\"");
    expect((await listProjects()).map((item) => item.id)).toEqual([draft.project.id]);
    const reopened = await openProject(draft.project.id);
    expect(reopened.chapters.map((chapter) => chapter.wordCount)).toEqual([1, 1]);
  });

  it("refuses projects from older Writers and lists them as outdated", async () => {
    host.privateFiles.set("projects/old/project.json", JSON.stringify({ schemaVersion: 2, id: "old", title: "旧作", chapters: [], createdAt: 1, updatedAt: 1 }));
    await expect(openProject("old")).rejects.toBeInstanceOf(OutdatedProjectError);
    expect(host.privateFiles.get("projects/old/project.json")).toContain("\"schemaVersion\":2");
    const listed = (await listProjects()).find((item) => item.id === "old");
    expect(listed?.outdated).toBe(true);
  });

  it("merges concurrent saves and snapshots the losing local text", async () => {
    const base = await draftWithChapters();
    const windowA = structuredClone(base);
    windowA.texts.c1 = "A 的修改";
    const windowB = structuredClone(base);
    windowB.texts.c2 = "B 的修改";
    windowB.texts.c1 = "B 也改了第一章";
    await saveDraft(base, windowA);
    const result = await saveDraft(base, windowB);
    expect(result.conflicts.map((item) => item.change)).toEqual([{ kind: "text", chapterId: "c1" }]);
    expect(await loadChapterText(base.project.id, "c1")).toBe("A 的修改");
    expect(await loadChapterText(base.project.id, "c2")).toBe("B 的修改");
    const snapshots = await listSnapshots(base.project.id, { kind: "chapter", id: "c1" });
    expect(snapshots[0].title).toContain("冲突");
  });

  it("removes chapter files when chapters are deleted", async () => {
    const base = await draftWithChapters();
    const next = structuredClone(base);
    next.project.chapters = next.project.chapters.filter((chapter) => chapter.id !== "c2");
    delete next.texts.c2;
    await saveDraft(base, next);
    expect(host.privateFiles.has(`projects/${base.project.id}/chapters/c2.md`)).toBe(false);
  });
});

describe("snapshots and stats", () => {
  it("throttles autosave snapshots and dedupes identical content", async () => {
    const ref = { kind: "outline" } as const;
    expect(await createSnapshot("p", ref, "大纲", "v1", "autosave")).toBeTruthy();
    expect(await createSnapshot("p", ref, "大纲", "v2", "autosave")).toBeNull();
    const manual = await createSnapshot("p", ref, "大纲", "v2", "manual");
    expect(await createSnapshot("p", ref, "大纲", "v2", "manual")).toBe(manual);
    expect((await listSnapshots("p", ref)).map((item) => item.reason)).toEqual(["manual", "autosave"]);
  });
  it("tracks words written today", async () => {
    await recordWordTotal("p", 100);
    const stats = await recordWordTotal("p", 160);
    expect(wordsWrittenOn(stats)).toBe(60);
  });
});

describe("proposals", () => {
  function proposal(changes: WriterProposal["changes"]): WriterProposal {
    return newProposal({ title: "t", changes, createdAt: 1 });
  }
  it("applies selected hunks, isolates stale changes, and undoes cleanly", async () => {
    const base = await draftWithChapters();
    const id = base.project.id;
    const item = proposal([
      { id: "t1", kind: "text", doc: { kind: "chapter", id: "c1" }, title: "第一章", summary: "", before: "一", after: "一\n新增" },
      { id: "t2", kind: "text", doc: { kind: "chapter", id: "c2" }, title: "第二章", summary: "", before: "过期原文", after: "x" },
      { id: "e1", kind: "entity", label: "人物", operation: { type: "upsertCharacter", character: normalizeCharacter({ id: "lin", name: "林舟" }) } },
    ]);
    await appendProposal(id, item);
    const applied = await applyProposal(id, item.id);
    expect(applied.failures.map((failure) => failure.changeId)).toEqual(["t2"]);
    expect(await loadChapterText(id, "c1")).toBe("一\n新增");
    expect(applied.project.characters.map((character) => character.name)).toEqual(["林舟"]);
    expect(applied.proposals.at(-1)?.status).toBe("partially_applied");
    expect(host.privateFiles.get(`projects/${id}/project.json`)).not.toContain("partially_applied");
    expect((await loadProposals(id)).at(-1)?.status).toBe("partially_applied");
    const undone = await undoProposal(id, item.id);
    expect(undone.skipped).toEqual([]);
    expect(await loadChapterText(id, "c1")).toBe("一");
    expect(undone.project.characters).toHaveLength(0);
    expect(undone.proposals.at(-1)?.status).toBe("reverted");
  });
  it("applies and undoes story plan and thread changes", async () => {
    const base = await draftWithChapters();
    const id = base.project.id;
    await saveThread(id, newThread({ id: "th1", title: "玉佩", kind: "foreshadow" }));
    const item = proposal([
      { id: "s1", kind: "story", label: "承诺", operation: { type: "setPromise", promise: { ...emptyStoryPlan().promise, oneLiner: "以弱胜强" } } },
      { id: "s2", kind: "story", label: "暗线", operation: { type: "upsertSecret", secret: normalizeSecret({ id: "sec", title: "真相" }) } },
      { id: "t1", kind: "thread", label: "线索", operation: { type: "upsertThread", thread: newThread({ id: "th1", title: "玉佩", kind: "expectation", plan: "第十章揭开" }) } },
      { id: "t2", kind: "thread", label: "新线索", operation: { type: "upsertThread", thread: newThread({ id: "th2", title: "约战" }) } },
    ]);
    await appendProposal(id, item);
    const applied = await applyProposal(id, item.id);
    expect(applied.failures).toEqual([]);
    const plan = await loadStoryPlan(id);
    expect(plan.promise.oneLiner).toBe("以弱胜强");
    expect(plan.secrets.map((secret) => secret.id)).toEqual(["sec"]);
    const threads = await new MemoryStore(id).loadThreads();
    expect(threads.map((thread) => [thread.id, thread.kind, thread.plan])).toEqual([["th1", "expectation", "第十章揭开"], ["th2", "foreshadow", ""]]);
    await undoProposal(id, item.id);
    expect((await loadStoryPlan(id)).promise.oneLiner).toBe("");
    expect((await loadStoryPlan(id)).secrets).toEqual([]);
    expect((await new MemoryStore(id).loadThreads()).map((thread) => [thread.id, thread.kind])).toEqual([["th1", "foreshadow"]]);
  });
  it("creates new chapters from proposals", async () => {
    const base = await draftWithChapters();
    const meta = normalizeChapterMeta({ id: "c3", volumeId: base.project.volumes[0].id, title: "第三章", rank: 3072 });
    const item = proposal([{ id: "n", kind: "text", doc: { kind: "chapter", id: "c3" }, title: "第三章", summary: "", before: "", after: "三", createChapter: meta }]);
    await appendProposal(base.project.id, item);
    const applied = await applyProposal(base.project.id, item.id);
    expect(applied.project.chapters.map((chapter) => chapter.id)).toContain("c3");
    expect(await loadChapterText(base.project.id, "c3")).toBe("三");
  });
});

describe("export", () => {
  it("writes chapter, manuscript and setting files and cleans only generated files", async () => {
    const base = await draftWithChapters();
    const result = await exportProject(base.project);
    expect(result.files).toContain("writing/test-novel/manuscript/01-volume-main.txt");
    expect(host.workspaceFiles.get("writing/test-novel/manuscript/01-volume-main.txt")).toContain("第二章\n\n二");
    host.workspaceFiles.set("writing/test-novel/notes.md", "user file");
    const next = structuredClone(base);
    next.project.chapters = next.project.chapters.filter((chapter) => chapter.id !== "c2");
    const saved = await saveDraft(base, next);
    await exportProject(saved.draft.project);
    expect([...host.workspaceFiles.keys()].some((path) => path.includes("0002-"))).toBe(false);
    expect(host.workspaceFiles.has("writing/test-novel/notes.md")).toBe(true);
  });
});

describe("editor prefs", () => {
  it("defaults to the writing-first layout and round-trips layout and preview", async () => {
    expect(await loadPrefs()).toEqual(DEFAULT_PREFS);
    await savePrefs({ ...DEFAULT_PREFS, markdownPreview: true });
    expect(await loadPrefs()).toMatchObject({ markdownPreview: true });
  });

  it("falls back to the writing-first layout for unknown values", async () => {
    host.storage.set("writer.prefs.v1", { markdownPreview: "yes" });
    expect(await loadPrefs()).toMatchObject({ markdownPreview: false });
  });
});
