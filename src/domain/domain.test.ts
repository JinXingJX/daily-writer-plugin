import { describe, expect, it } from "vitest";
import { applyOperations, parsePatchOperations } from "./operations";
import { normalizeProject, OutdatedProjectError } from "./normalize";
import { countWords } from "./words";
import { slugify, contentHash, isSafeId } from "./ids";
import { applyHunks, diffLines, inlineDiff } from "./textDiff";
import { locateUnique, relocateSelection, resolveAnchor } from "./anchors";
import { diffDrafts, mergeDraft } from "./merge";
import { rankBetween, needsRebalance, rebalance } from "./ranks";
import { coalesceTextChanges, selectedTextResult } from "./proposals";
import { docTitle, orderedChapters } from "./documents";
import { EMPTY_MAP_FILTER, filterRelations, filterStoryMap } from "./mapFilter";
import type { ProjectDraft, ProposalTextChange } from "../types";

const SAMPLE_TEXTS: Record<string, string> = { c1: "林舟醒来。", c2: "苏晚出现。" };

function sampleProject() {
  return {
    schemaVersion: 3,
    id: "writer-test",
    title: "测试项目",
    worldview: "旧世界观",
    volumes: [{ id: "v", title: "正文", rank: 1024 }],
    characters: [{ id: "lin", name: "林舟" }, { id: "su", name: "苏晚" }],
    characterRelations: [{ id: "r1", sourceCharacterId: "lin", targetCharacterId: "su", relation: "师徒" }],
    storyNodes: [{ id: "n1", title: "开端", characterIds: ["lin", "su"], chapterId: "c1" }],
    chapters: [
      { id: "c1", volumeId: "v", title: "第一章", rank: 1024, povCharacterId: "lin", wordCount: 4, contentHash: contentHash(SAMPLE_TEXTS.c1) },
      { id: "c2", volumeId: "v", title: "第二章", rank: 2048, wordCount: 4, contentHash: contentHash(SAMPLE_TEXTS.c2) },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("words and ids", () => {
  it("counts CJK characters and non-CJK word sequences", () => {
    expect(countWords("你好 world 2026")).toBe(4);
    expect(countWords("hello-world don't")).toBe(2);
    expect(countWords("，。！？")).toBe(0);
  });
  it("produces safe slugs and stable hashes", () => {
    expect(slugify("长篇项目", "writer-safe")).toBe("writer-safe");
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
  });
});

describe("normalize projects", () => {
  it("reads v3 projects and fills new fields with defaults", () => {
    const project = normalizeProject(sampleProject());
    expect(project.schemaVersion).toBe(3);
    expect(orderedChapters(project).map((chapter) => chapter.id)).toEqual(["c1", "c2"]);
    expect(isSafeId(project.chapters[0].id)).toBe(true);
    expect(project.characters[0]).toMatchObject({ desire: "", minimalTag: "", currentAction: "" });
    expect(project.settings.pipeline).toEqual({ steps: ["story", "reader", "briefing", "notes", "next"], storyGate: "review", planGate: "approve", nextWords: 3_000 });
    expect("proposals" in project).toBe(false);
  });

  it("rejects projects saved by an older Writer", () => {
    expect(() => normalizeProject({ ...sampleProject(), schemaVersion: 2 })).toThrow(OutdatedProjectError);
    expect(() => normalizeProject({ id: "p", title: "无版本" })).toThrow(OutdatedProjectError);
  });
});

describe("operations", () => {
  it("validates every patch before mutating and cascades character removal", () => {
    const project = normalizeProject(sampleProject());
    expect(() => applyOperations(project, [{ type: "setProjectField", field: "worldview", value: "x" }, { type: "nope" }])).toThrow("Unknown Writer patch operation");
    expect(project.worldview).toBe("旧世界观");
    expect(() => parsePatchOperations([{ type: "setProjectField", field: "id", value: "hijack" }])).toThrow("Unsupported Writer project field");
    const next = applyOperations(project, [{ type: "removeCharacter", id: "lin" }]);
    expect(next.characters.map((item) => item.id)).toEqual(["su"]);
    expect(next.characterRelations).toHaveLength(0);
    expect(next.storyNodes[0].characterIds).toEqual(["su"]);
    expect(next.chapters.every((chapter) => chapter.povCharacterId !== "lin")).toBe(true);
    expect(project.characters).toHaveLength(2);
  });

  it("identifies the invalid operation and gives a retryable volume example", () => {
    const operations = [
      { type: "setProjectField", field: "title", value: "新书名" },
      { order: 1, title: "第一卷：青云试剑，寒门负雪", volumeId: "volume-main" },
    ];
    expect(() => parsePatchOperations(operations)).toThrow('operations[1]: Writer patch 缺少 type');
    expect(() => parsePatchOperations(operations)).toThrow('"type":"upsertVolume","volume":{"id":"volume-main"');
    expect(() => parsePatchOperations(operations)).toThrow("volume.rank");
  });

  it("still rejects missing nested payloads, missing entity ids and unsupported types", () => {
    expect(() => parsePatchOperations([{ type: "upsertVolume", volumeId: "volume-main", title: "第一卷", order: 1 }])).toThrow("operations[0]: Writer patch volume must be an object");
    expect(() => parsePatchOperations([{ type: "upsertVolume", volume: { volumeId: "volume-main", title: "第一卷", order: 1 } }])).toThrow("operations[0]: Writer patch volume requires a stable non-empty id");
    expect(() => parsePatchOperations([{ type: "renameVolume", id: "volume-main" }])).toThrow("operations[0]: Unknown Writer patch operation renameVolume");
  });
});

describe("text diff", () => {
  it("splits paragraph hunks and rebuilds text from a hunk selection", () => {
    const before = "第一段\n第二段\n第三段\n第四段";
    const after = "第一段\n第二段（改）\n第三段\n第四段\n新增段";
    const diff = diffLines(before, after);
    expect(diff.hunks).toHaveLength(2);
    expect(applyHunks(diff, [0, 1])).toBe(after);
    expect(applyHunks(diff, [])).toBe(before);
    expect(applyHunks(diff, [1])).toBe("第一段\n第二段\n第三段\n第四段\n新增段");
  });
  it("highlights inline changes", () => {
    expect(inlineDiff("他走了", "他慢慢走了")).toEqual([{ type: "equal", text: "他" }, { type: "insert", text: "慢慢" }, { type: "equal", text: "走了" }]);
  });
});

describe("anchors", () => {
  it("requires unique quotes and re-resolves moved anchors", () => {
    const text = "他笑了。她也笑了。他笑了。";
    expect(locateUnique(text, "他笑了").ok).toBe(false);
    const located = locateUnique(text, "他笑了", "她也笑了。");
    expect(located.ok && located.range.start).toBe(9);
    expect(resolveAnchor(`前言${text}`, { start: 9, end: 12, quote: "他笑了" })).toEqual({ start: 11, end: 14 });
  });
});

describe("three-way merge", () => {
  function draft(): ProjectDraft {
    return { project: normalizeProject(sampleProject()), texts: { ...SAMPLE_TEXTS } };
  }
  it("merges edits of different chapters and reports same-chapter conflicts", () => {
    const base = draft();
    const [c1, c2] = orderedChapters(base.project);
    const mine = structuredClone(base);
    mine.texts[c1.id] = "林舟醒来，天已大亮。";
    const theirs = structuredClone(base);
    theirs.texts[c2.id] = "苏晚推门而入。";
    const result = mergeDraft(base, mine, theirs);
    expect(result.conflicts).toHaveLength(0);
    expect(result.merged.texts[c1.id]).toBe("林舟醒来，天已大亮。");
    expect(result.merged.texts[c2.id]).toBe("苏晚推门而入。");
    expect(result.merged.project.chapters.find((chapter) => chapter.id === c1.id)?.wordCount).toBe(8);

    const clash = structuredClone(base);
    clash.texts[c1.id] = "另一个窗口的修改";
    const conflict = mergeDraft(base, mine, clash);
    expect(conflict.conflicts.map((item) => item.label)).toEqual(["章节正文「第一章」"]);
    expect(conflict.merged.texts[c1.id]).toBe("另一个窗口的修改");
  });
  it("detects metadata edits without treating derived fields as conflicts", () => {
    const base = draft();
    const mine = structuredClone(base);
    mine.project.chapters[0].summary = "新摘要";
    const theirs = structuredClone(base);
    theirs.project.chapters[0].wordCount = 999;
    expect(diffDrafts(base, mine)).toEqual([{ kind: "entity", collection: "chapters", id: base.project.chapters[0].id }]);
    expect(mergeDraft(base, mine, theirs).conflicts).toHaveLength(0);
  });
});

describe("ranks and proposals", () => {
  it("inserts between ranks and rebalances dense ranks", () => {
    expect(rankBetween(1024, 2048)).toBe(1536);
    expect(needsRebalance([1, 1 + 1e-9])).toBe(true);
    expect(rebalance([{ rank: 5 }, { rank: 1 }]).map((item) => item.rank)).toEqual([1024, 2048]);
  });
  it("coalesces edits of one document and applies hunk selections", () => {
    const first: ProposalTextChange = { id: "a", kind: "text", doc: { kind: "outline" }, title: "大纲", summary: "一", before: "A\nB", after: "A1\nB" };
    const second: ProposalTextChange = { id: "b", kind: "text", doc: { kind: "outline" }, title: "大纲", summary: "二", before: "A1\nB", after: "A1\nB1" };
    const [merged] = coalesceTextChanges([first, second]) as ProposalTextChange[];
    expect(merged.before).toBe("A\nB");
    expect(merged.after).toBe("A1\nB1");
    expect(selectedTextResult(merged, { a: { accepted: true, hunks: [] } })).toBeNull();
    expect(selectedTextResult(merged, { a: { accepted: false } })).toBeNull();
    expect(selectedTextResult(merged, undefined)).toBe("A1\nB1");
  });
});

describe("map filters", () => {
  function mapProject() {
    return normalizeProject({
      schemaVersion: 3,
      id: "map-test",
      title: "地图",
      volumes: [{ id: "v1", title: "第一卷", rank: 1 }, { id: "v2", title: "第二卷", rank: 2 }],
      chapters: [
        { id: "c1", volumeId: "v1", title: "一", rank: 1, povCharacterId: "lin" },
        { id: "c2", volumeId: "v1", title: "二", rank: 2, storyNodeIds: ["n2"] },
        { id: "c3", volumeId: "v2", title: "三", rank: 3 },
      ],
      characters: [{ id: "lin", name: "林舟" }, { id: "su", name: "苏晚" }, { id: "gu", name: "顾川" }, { id: "mo", name: "墨离" }],
      characterRelations: [
        { id: "r1", sourceCharacterId: "lin", targetCharacterId: "su", relation: "师徒" },
        { id: "r2", sourceCharacterId: "su", targetCharacterId: "gu", relation: "宿敌" },
        { id: "r3", sourceCharacterId: "gu", targetCharacterId: "mo", relation: "盟友", storyNodeIds: ["n3"] },
      ],
      storyNodes: [
        { id: "n1", kind: "plot_key", title: "开端", chapterId: "c1", characterIds: ["su"] },
        { id: "n2", kind: "scene", title: "试炼", characterIds: ["gu"] },
        { id: "n3", kind: "plot_key", title: "结盟", chapterId: "c3", characterIds: ["gu", "mo"] },
      ],
      storyEdges: [{ id: "e1", source: "n1", target: "n2", relation: "causal" }, { id: "e2", source: "n2", target: "n3", relation: "foreshadow" }],
    });
  }

  it("filters story nodes by volume, chapter range, character and kind", () => {
    const project = mapProject();
    const byVolume = filterStoryMap(project, { ...EMPTY_MAP_FILTER, volumeId: "v1" });
    expect([...byVolume.nodeIds]).toEqual(["n1", "n2"]);
    expect([...byVolume.edgeIds]).toEqual(["e1"]);
    expect([...filterStoryMap(project, { ...EMPTY_MAP_FILTER, fromChapterId: "c2", toChapterId: "c3" }).nodeIds]).toEqual(["n2", "n3"]);
    // POV of the node's chapter counts as the character being involved.
    expect([...filterStoryMap(project, { ...EMPTY_MAP_FILTER, characterId: "lin" }).nodeIds]).toEqual(["n1"]);
    expect([...filterStoryMap(project, { ...EMPTY_MAP_FILTER, kinds: ["plot_key"] }).nodeIds]).toEqual(["n1", "n3"]);
    expect([...filterStoryMap(project, { ...EMPTY_MAP_FILTER, relations: ["foreshadow"] }).edgeIds]).toEqual(["e2"]);
  });

  it("focuses the relation graph on a character and limits it to a chapter scope", () => {
    const project = mapProject();
    expect([...filterRelations(project, { ...EMPTY_MAP_FILTER, characterId: "su" }).characterIds].sort()).toEqual(["gu", "lin", "su"]);
    expect([...filterRelations(project, { ...EMPTY_MAP_FILTER, characterId: "lin", depth: 2 }).relationIds]).toEqual(["r1", "r2"]);
    const volumeOne = filterRelations(project, { ...EMPTY_MAP_FILTER, volumeId: "v1" });
    expect([...volumeOne.characterIds].sort()).toEqual(["gu", "lin", "su"]);
    expect([...volumeOne.relationIds]).toEqual(["r1", "r2"]);
    // Memory mentions bring characters into scope; relations tied to out-of-scope nodes stay hidden.
    const withMemory = filterRelations(project, { ...EMPTY_MAP_FILTER, volumeId: "v1" }, (id) => (id === "mo" ? ["c2"] : []));
    expect(withMemory.characterIds.has("mo")).toBe(true);
    expect(withMemory.relationIds.has("r3")).toBe(false);
    expect([...filterRelations(project, { ...EMPTY_MAP_FILTER, query: "宿敌" }).relationIds]).toEqual(["r2"]);
  });
});

describe("selection relocation", () => {
  it("keeps the range when the text is unchanged and follows a unique shifted match", () => {
    expect(relocateSelection("甲乙丙丁", { from: 1, to: 3 }, "乙丙")).toEqual({ from: 1, to: 3 });
    expect(relocateSelection("新增甲乙丙丁", { from: 1, to: 3 }, "乙丙")).toEqual({ from: 3, to: 5 });
  });
  it("gives up when the selection was edited away or is ambiguous", () => {
    expect(relocateSelection("甲乙X丁", { from: 1, to: 3 }, "乙丙")).toBeNull();
    expect(relocateSelection("乙丙乙丙", { from: 5, to: 7 }, "乙丙")).toBeNull();
  });
});

describe("document titles", () => {
  it("labels chapters with a blank title instead of showing nothing", () => {
    const project = normalizeProject({ schemaVersion: 3, id: "p", title: "书", volumes: [{ id: "v", title: "卷一", rank: 1 }], chapters: [{ id: "c", volumeId: "v", title: "  ", rank: 1 }] });
    expect(docTitle(project, { kind: "chapter", id: "c" })).toBe("未命名章节");
  });
});
