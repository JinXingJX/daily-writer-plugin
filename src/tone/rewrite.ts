import type { Candidate, ToneScan, Verdict } from "./detect";

export type ToneEdit = { id: string; quote: string; replacement: string; reason: string };
export type AppliedToneEdit = ToneEdit & { start: number; end: number };

export function approvedCandidates(scan: ToneScan, verdicts: Verdict[], ids: string[]): Candidate[] {
  const approved = new Set(ids);
  if (!ids.length || approved.size !== ids.length) throw new Error("请选择已复核的拟改项。");
  const allowed = new Set(verdicts.filter((v) => v.disposition === "revise").map((v) => v.id));
  if (ids.some((id) => !allowed.has(id))) throw new Error("改写范围包含未确认或不可自动处理的项目。");
  return scan.candidates.filter((c) => approved.has(c.id));
}

/** Only exact, unique substrings inside approved candidates may change; everything else is copied verbatim. */
export function applyToneEdits(source: string, candidates: Candidate[], value: unknown, names: string[] = []): { text: string; edits: AppliedToneEdit[] } {
  const rows = (value as { edits?: unknown })?.edits;
  if (!Array.isArray(rows) || rows.length !== candidates.length) throw new Error("改写结果必须说明每个确认项的处理结果。");
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const edits: AppliedToneEdit[] = [];
  for (const row of rows) {
    const candidate = row && byId.get(row.id);
    if (!candidate || seen.has(row.id) || typeof row.quote !== "string" || typeof row.replacement !== "string" || typeof row.reason !== "string" || !row.reason.trim()) throw new Error("改写编号、引用或理由无效。");
    seen.add(row.id);
    if (source.slice(candidate.start, candidate.end) !== candidate.text) throw new Error("原稿已变化，请重新检测。");
    if (!row.quote && !row.replacement) { edits.push({ id: row.id, quote: "", replacement: "", reason: row.reason, start: candidate.start, end: candidate.start }); continue; }
    const at = candidate.text.indexOf(row.quote);
    if (!row.quote || at < 0 || candidate.text.indexOf(row.quote, at + 1) !== -1) throw new Error("改写引用不是候选中唯一的原文。");
    if (/[\r\n]/.test(row.quote + row.replacement) || /[`<>\[\]“”「」『』"*_#|]/.test(row.replacement)) throw new Error("改写不得改变段落或插入版式与引文。");
    const protectedTokens = (s: string) => s.match(/\d+(?:[.,]\d+)*|[零〇一二三四五六七八九十百千万亿两]+|可能|也许|或许|大概|似乎|未必|不一定|至少|至多|仅仅|只有|尚未|从未/g) ?? [];
    if (JSON.stringify(protectedTokens(row.quote)) !== JSON.stringify(protectedTokens(row.replacement))) throw new Error("改写改变了数字或限定词，请重试或手动处理。");
    for (const name of names.filter(Boolean)) if (row.quote.split(name).length !== row.replacement.split(name).length) throw new Error("改写改变了人物名称，请手动核对。");
    edits.push({ id: row.id, quote: row.quote, replacement: row.replacement, reason: row.reason, start: candidate.start + at, end: candidate.start + at + row.quote.length });
  }
  const changed = edits.filter((e) => e.quote !== e.replacement).sort((a, b) => a.start - b.start);
  for (let i = 1; i < changed.length; i += 1) if (changed[i].start < changed[i - 1].end) throw new Error("改写位置重叠，请减少确认项后重试。");
  let text = source;
  for (const edit of [...changed].reverse()) text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  return { text, edits };
}
