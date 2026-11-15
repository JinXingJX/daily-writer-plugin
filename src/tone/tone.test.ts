import { describe, expect, it } from "vitest";
import { parseVerdicts, scanTone, toneSummary } from "./detect";
import { applyToneEdits, approvedCandidates } from "./rewrite";

const source = "说白了，林舟可能只剩12枚铜钱。\n\n不是走得慢，而是腿受了伤。";
const verdict = (id: string, label = "空提示", disposition = "revise") => ({ id, label, confidence: "high", disposition, reason: "提示语不承担额外信息。", suggestion: "只删除提示语及逗号。" });

describe("evidence-first tone diagnostics", () => {
  it("keeps exact offsets for repeated text, emoji and CRLF", () => {
    const text = "😀说白了，钱少。\r\n\r\n说白了，钱少。";
    const scan = scanTone(text);
    for (const c of scan.candidates) expect(text.slice(c.start, c.end)).toBe(c.text);
    const openers = scan.candidates.filter((c) => c.rule === "opener");
    expect(openers.map((c) => c.line)).toEqual([1, 3]);
    expect(new Set(openers.map((c) => c.id)).size).toBe(2);
  });
  it("does not review quotes, code, headings, tables or lists, and breaks transitions at them", () => {
    const text = "普通正文。\n\n# 说白了：第一节\n\n“说白了，没钱。”\n\n> 不是甲，而是乙。\n\n```js\n说白了，代码。\n```\n\n| 说白了 | 表格 |\n\n1. 说白了，列表。\n\n末尾正文。";
    const scan = scanTone(text);
    expect(scan.candidates.map((c) => c.rule)).toEqual(["rename", "rename"]);
  });
  it("protects setext headings", () => {
    expect(scanTone("说白了，标题\n======\n").candidates).toEqual([]);
  });
  it("protects multiline and unfinished dialogue", () => {
    expect(scanTone("“第一句。\n说白了，没钱。\n最后一句。”").candidates).toEqual([]);
    expect(scanTone("「第一句。\n说白了，没钱。").candidates).toEqual([]);
  });
  it("rejects oversized input without silently truncating", () => {
    expect(() => scanTone("甲".repeat(40_001))).toThrow("分章");
    expect(() => scanTone("甲。乙。丙。\n".repeat(210))).toThrow("候选超过");
  });
  it("preserves every candidate and rejects duplicate, missing and invented labels", () => {
    const candidates = scanTone(source).candidates.filter((c) => c.rule === "opener");
    expect(() => parseVerdicts({ verdicts: [] }, candidates)).toThrow();
    expect(() => parseVerdicts({ verdicts: [verdict(candidates[0].id, "AI味很浓")] }, candidates)).toThrow();
    expect(() => parseVerdicts({ verdicts: [verdict("invented")] }, candidates)).toThrow();
    expect(() => parseVerdicts({ verdicts: [verdict(candidates[0].id), verdict(candidates[0].id)] }, [...candidates, { ...candidates[0], id: "second" }])).toThrow();
    expect(parseVerdicts({ verdicts: [{ ...verdict(candidates[0].id), confidence: "low" }] }, candidates)[0].disposition).toBe("human");
  });
  it("never authorizes a negative label or distribution metric for rewriting", () => {
    const scan = scanTone(source);
    const c = scan.candidates.find((c) => c.rule === "transition")!;
    const v = parseVerdicts({ verdicts: [verdict(c.id, "关系不成立")] }, [c]);
    expect(v[0].disposition).toBe("keep");
    expect(() => approvedCandidates(scan, v, [c.id])).toThrow();
    const opener = scan.candidates.find((c) => c.rule === "opener")!;
    expect(parseVerdicts({ verdicts: [verdict(opener.id, "承担信息")] }, [opener])[0].disposition).toBe("keep");
  });
  it("accounts for all dispositions rather than deleting false positives", () => {
    const scan = scanTone(source);
    const c = scan.candidates.find((c) => c.rule === "opener")!;
    const v = parseVerdicts({ verdicts: [verdict(c.id, "承担信息", "false_positive")] }, [c]);
    expect(toneSummary(scan, v).find((r) => r.rule === "opener")).toMatchObject({ raw: 1, valid: 0, falsePositive: 1 });
  });
});

describe("bounded tone patches", () => {
  const c = scanTone(source).candidates.find((c) => c.rule === "opener")!;
  const edit = { id: c.id, quote: "说白了，", replacement: "", reason: "移除空提示" };
  it("changes only the approved substring and preserves every other byte", () => {
    expect(applyToneEdits(source, [c], { edits: [edit] }).text).toBe(source.replace("说白了，", ""));
  });
  it("rejects out-of-scope, ambiguous, overlapping and stale edits", () => {
    expect(() => applyToneEdits(source, [c], { edits: [{ ...edit, quote: "腿受了伤" }] })).toThrow();
    expect(() => applyToneEdits(source + "x", [{ ...c, text: "changed" }], { edits: [edit] })).toThrow();
    const twin = { ...c, id: "twin" };
    expect(() => applyToneEdits(source, [c, twin], { edits: [edit, { ...edit, id: twin.id }] })).toThrow("重叠");
    const repeated = { ...c, text: "甲甲", start: 0, end: 2 };
    expect(() => applyToneEdits("甲甲", [repeated], { edits: [{ ...edit, quote: "甲" }] })).toThrow("唯一");
  });
  it("rejects changed numbers, uncertainty, registered names and paragraph structure", () => {
    for (const [quote, replacement] of [["12", "13"], ["可能", "肯定"], ["林舟", "林江"], ["说白了，", "\n"]]) {
      expect(() => applyToneEdits(source, [c], { edits: [{ ...edit, quote, replacement }] }, ["林舟"])).toThrow();
    }
  });
  it("records safe no-ops with a reason and requires complete coverage", () => {
    expect(applyToneEdits(source, [c], { edits: [{ ...edit, quote: "", replacement: "", reason: "保留人物语气" }] }).text).toBe(source);
    expect(() => applyToneEdits(source, [c], { edits: [] })).toThrow();
  });
});
