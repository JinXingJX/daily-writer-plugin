// Exercise domain behavior independently of task submission and finalization.
vi.mock("../worker/domainTask", () => ({ domainTask: () => null }));
import { vi, afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeHost, uninstallFakeHost, type FakeHost } from "../test/fakeHost";
import { normalizeProject } from "../domain/normalize";
import { diagnoseTone, reportMarkdown, reviseTone, saveToneReport } from "./pipeline";
import { createProject, openProject } from "../storage/projectStore";
import { appendProposal, applyProposal, undoProposal } from "../storage/proposalStore";
import { RULES, type RuleId } from "./rules";

let host: FakeHost;
beforeEach(() => { host = installFakeHost(); });
afterEach(() => uninstallFakeHost());
const project = () => normalizeProject({ schemaVersion: 3, id: "p", title: "渡口", styleGuide: "保留冷峻的长句。" });
const text = "说白了，林舟可能只剩12枚铜钱。";
function model(prompt: string) {
  if (prompt.includes("候选 JSON：")) {
    const rows = JSON.parse(prompt.split("候选 JSON：\n")[1].split("\n每条候选")[0]) as { id: string; rule: RuleId }[];
    return JSON.stringify({ verdicts: rows.map((c) => ({ id: c.id, label: c.rule === "opener" ? "空提示" : RULES[c.rule].labels[0], confidence: "high", disposition: c.rule === "opener" ? "revise" : "keep", reason: "此处是空提示或正常叙述。", suggestion: c.rule === "opener" ? "仅删说白了及逗号。" : "" })) });
  }
  const rows = JSON.parse(prompt.split("已确认的候选与改法：\n")[1].split("\n每个候选")[0]);
  return JSON.stringify({ edits: rows.map((c: { id: string }) => ({ id: c.id, quote: "说白了，", replacement: "", reason: "已确认删除空提示" })) });
}

describe("tone workflow", () => {
  it("diagnoses without writing, archives evidence, then revises and retests into a proposal", async () => {
    host.setModel(model);
    const report = await diagnoseTone(project(), { kind: "outline" }, text);
    expect(host.privateFiles.size).toBe(0);
    expect(host.modelCalls.every((c) => c.prompt.includes("候选 JSON"))).toBe(true);
    const path = await saveToneReport(report);
    expect(host.privateFiles.get(path)).toContain("空提示");
    const ids = report.verdicts.filter((v) => v.disposition === "revise").map((v) => v.id);
    const result = await reviseTone(project(), report, text, ids);
    expect(result.proposal.status).toBe("pending");
    expect(result.proposal.changes[0]).toMatchObject({ before: text, after: "林舟可能只剩12枚铜钱。" });
    expect(result.after.scan.candidates.some((c) => c.rule === "opener")).toBe(false);
    expect(result.proposal.previewMarkdown).toContain("复核命中 前→后");
    expect([...host.privateFiles.keys()].every((path) => path.includes("tone-reports"))).toBe(true);
    expect(reportMarkdown(report)).toContain("不计算 AI 率");
  });
  it("uses the existing apply and undo path without losing the original manuscript", async () => {
    host.setModel(model);
    const work = await createProject({ title: "渡口", outline: text });
    const report = await diagnoseTone(work, { kind: "outline" }, text);
    await saveToneReport(report);
    const ids = report.verdicts.filter((v) => v.disposition === "revise").map((v) => v.id);
    const { proposal } = await reviseTone(work, report, text, ids);
    await appendProposal(work.id, proposal);
    expect((await openProject(work.id)).outline).toBe(text);
    const applied = await applyProposal(work.id, proposal.id);
    expect(applied.failures).toEqual([]);
    expect(applied.project.outline).toBe("林舟可能只剩12枚铜钱。");
    const undone = await undoProposal(work.id, proposal.id);
    expect(undone.skipped).toEqual([]);
    expect(undone.project.outline).toBe(text);
  });
  it("blocks stale text and unapproved candidates before any rewrite call", async () => {
    host.setModel(model);
    const report = await diagnoseTone(project(), { kind: "outline" }, text);
    const before = host.modelCalls.length;
    await expect(reviseTone(project(), report, text + "新", [report.verdicts[0].id])).rejects.toThrow("原稿已变化");
    await expect(reviseTone(project(), report, text, [report.verdicts.find((v) => v.disposition === "keep")!.id])).rejects.toThrow("未确认");
    expect(host.modelCalls.length).toBe(before);
  });
  it("cancellation never produces a proposal or writes a manuscript", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(diagnoseTone(project(), { kind: "outline" }, text, controller.signal)).rejects.toThrow();
    expect(host.modelCalls).toHaveLength(0);
    expect(host.privateFiles.size).toBe(0);
  });
  it("invalid model output fails visibly instead of inventing a clean report", async () => {
    host.setModel(() => '{"verdicts":[]}');
    await expect(diagnoseTone(project(), { kind: "outline" }, text)).rejects.toThrow("全部候选");
    expect(host.privateFiles.size).toBe(0);
  });
});
