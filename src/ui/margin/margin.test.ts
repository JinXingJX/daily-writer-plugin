import { describe, expect, it } from "vitest";
import type { MemoryConflict } from "../../memory/schema";
import type { HealthIssue } from "../../story/health";
import { readableInlineDiff } from "../../domain/textDiff";
import { buildScore } from "../../story/score";
import type { PositionedThread } from "../../story/selectors";
import type { WriterComment } from "../../types";
import { buildMarginNotes, stackNotes } from "./notes";

function comment(patch: Partial<WriterComment>): WriterComment {
  return { id: "c1", doc: { kind: "chapter", id: "ch" }, quote: "", start: 0, comment: "", severity: "warning", author: "ai", resolved: false, createdAt: 0, ...patch };
}

const base = { docKey: "chapter:ch", chapterId: "ch", comments: [], publishNotes: [], conflicts: [], health: [], positionOf: () => 0 };

describe("margin notes", () => {
  const text = "退潮是在寅时。沈婆拄着那根船桨。潮水只记该还的。";

  it("anchors comments to their quote and lists them in reading order", () => {
    const notes = buildMarginNotes({ ...base, text, comments: [comment({ id: "late", quote: "潮水只记", comment: "后面" }), comment({ id: "early", quote: "寅时", comment: "前面" })] });
    expect(notes.map((note) => note.sourceId)).toEqual(["early", "late"]);
    expect(notes[0].from).toBe(text.indexOf("寅时"));
  });

  it("reads the leading label as the tag", () => {
    const [note] = buildMarginNotes({ ...base, text, comments: [comment({ quote: "寅时", comment: "〔检查表〕这场没有变化\n建议：加一步" })] });
    expect(note.tag).toBe("检查表");
    expect(note.body).toBe("这场没有变化\n建议：加一步");
  });

  it("leaves out resolved notes and keeps a note whose quote is gone, unanchored", () => {
    const notes = buildMarginNotes({ ...base, text, comments: [comment({ id: "done", quote: "寅时", resolved: true }), comment({ id: "lost", quote: "这段已经删掉了" })] });
    expect(notes.map((note) => note.sourceId)).toEqual(["lost"]);
    expect(notes[0].from).toBeNull();
  });

  it("shows an open conflict on the chapter that holds one side of it", () => {
    const conflict: MemoryConflict = { id: "m1", kind: "trait", subject: "沈婆", attribute: "船桨", note: "", status: "open", detectedAt: 0, values: [{ value: "还在", chapterId: "ch", quote: "那根船桨" }, { value: "烧了", chapterId: "old", quote: "桨身" }] };
    const [note] = buildMarginNotes({ ...base, text, conflicts: [conflict], positionOf: (id) => (id === "old" ? 38 : 46) });
    expect(note.source).toBe("conflict");
    expect(note.from).toBe(text.indexOf("那根船桨"));
    expect(note.body).toContain("第 39 章");
    expect(buildMarginNotes({ ...base, text, chapterId: "other", conflicts: [conflict] })).toEqual([]);
  });

  it("puts whole-chapter findings after anchored notes", () => {
    const issue: HealthIssue = { id: "h", rule: "cast-overload", severity: "info", chapterId: "ch", message: "新人物太多", refs: [] };
    const notes = buildMarginNotes({ ...base, text, health: [issue], comments: [comment({ quote: "寅时" })] });
    expect(notes.map((note) => note.source)).toEqual(["comment", "health"]);
  });

  it("stacks notes at their anchors and pushes overlapping ones down", () => {
    expect(stackNotes([{ id: "b", top: 110, height: 40 }, { id: "a", top: 100, height: 40 }, { id: "c", top: 400, height: 40 }], 10)).toEqual({ a: 100, b: 150, c: 400 });
  });
});

function thread(patch: Partial<PositionedThread>): PositionedThread {
  return { id: "t", title: "第七行", description: "", kind: "foreshadow", tier: "arc", status: "open", progress: 0.5, events: [], plan: "", targetChapterId: null, successorIds: [], origin: "extracted", plantedAt: 0, lastAt: 0, paidAt: null, age: 0, ...patch } as PositionedThread;
}

describe("thread score", () => {
  const positionOf = (id: string) => Number(id.slice(1));

  it("lists open threads first and stretches the axis to a planned payoff", () => {
    const score = buildScore([
      thread({ id: "done", status: "paid", plantedAt: 2, lastAt: 8, paidAt: 8 }),
      thread({ id: "later", plantedAt: 6, lastAt: 9 }),
      thread({ id: "first", plantedAt: 1, lastAt: 9, targetChapterId: "c14" }),
    ], 10, 30, positionOf);
    expect(score.rows.map((row) => row.id)).toEqual(["first", "later", "done"]);
    expect(score.rows[0].planEnd).toBe(14);
    expect(score.horizon).toBe(15);
    expect(score.current).toBe(9);
  });

  it("flags a silent open plant, and ignores threads with no located event", () => {
    const score = buildScore([thread({ id: "quiet", plantedAt: 1, lastAt: 2 }), thread({ id: "nowhere", plantedAt: -1, lastAt: -1 })], 40, 30, positionOf);
    expect(score.rows.map((row) => row.id)).toEqual(["quiet"]);
    expect(score.rows[0]).toMatchObject({ silent: 37, stale: true });
  });

  it("ignores a planned payoff that is already behind the thread", () => {
    const [row] = buildScore([thread({ plantedAt: 1, lastAt: 9, targetChapterId: "c3" })], 10, 30, positionOf).rows;
    expect(row.planEnd).toBeNull();
  });
});

describe("readable inline diff", () => {
  const join = (parts: { type: string; text: string }[], skip: string) => parts.filter((part) => part.type !== skip).map((part) => part.text).join("");

  it("merges fragments of a rewritten clause into one replacement", () => {
    const before = "潮水没有写错过账，这是渡口城三百年来唯一没人争过的事。";
    const after = "潮水三百年没写错过一笔账，渡口城里只有这件事没人争过。";
    const parts = readableInlineDiff(before, after);
    expect(parts.filter((part) => part.type === "delete").length).toBeLessThanOrEqual(2);
    expect(join(parts, "insert")).toBe(before);
    expect(join(parts, "delete")).toBe(after);
  });

  it("keeps a one-word change tight", () => {
    expect(readableInlineDiff("用桨头轻轻碰了一下", "用竿头轻轻碰了一下").filter((part) => part.type !== "equal").map((part) => part.text)).toEqual(["桨", "竿"]);
  });
});
