import { RULES, TONE_VERSION, type RuleId } from "./rules";

export type Span = { start: number; end: number; text: string };
export type Candidate = Span & { id: string; rule: RuleId; line: number };
export type ToneScan = { version: number; chars: number; paragraphs: number; sentenceCV: number | null; candidates: Candidate[]; protected: Span[] };
export const MAX_TONE_CHARS = 40_000;
export const MAX_CANDIDATES = 600;

/** Offset-preserving conservative Markdown/quotation guard. Protected lines never enter a candidate. */
export function proseSpans(text: string): { prose: Span[]; protected: Span[] } {
  const prose: Span[] = [], protectedSpans: Span[] = [];
  const quoted = [...text.matchAll(/“[^”]*(?:”|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)/g)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
  let fence = "", offset = 0;
  const lines = text.split(/(?<=\n)/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.replace(/[\r\n]+$/, "");
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    let protect = /^\s*(?:={3,}|-{3,})\s*$/.test(lines[index + 1] ?? "") || Boolean(fence) || quoted.some((q) => q.start < offset + raw.length && q.end > offset);
    if (marker) {
      protect = true;
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = "";
    }
    // Lists, quotations, tables, code, links and inline markup are deliberately conservative.
    protect ||= /^\s*(?:#{1,6}\s|>|[-*+]\s|\d+[.)、]\s*|[一二三四五六七八九十]+[、．]|\|)/.test(line)
      || /^(?: {4}|\t)/.test(line) || /[`<>\[\]“”「」『』"*_]|https?:\/\//.test(line)
      || /\|/.test(line) || /^\s*[-=]{3,}\s*$/.test(line);
    if (line.trim()) {
      const start = offset + line.length - line.trimStart().length;
      const span = { start, end: offset + line.trimEnd().length, text: line.trim() };
      (protect ? protectedSpans : prose).push(span);
    }
    offset += raw.length;
  }
  return { prose, protected: protectedSpans };
}

function sentences(span: Span): Span[] {
  return [...span.text.matchAll(/[^。！？!?]+[。！？!?]?/g)].filter((m) => m[0].trim()).map((m) => ({ start: span.start + m.index!, end: span.start + m.index! + m[0].length, text: m[0] }));
}

export function scanTone(text: string): ToneScan {
  if (text.length > MAX_TONE_CHARS) throw new Error(`文风检测每次最多 ${MAX_TONE_CHARS} 字符，请分章检测。`);
  const { prose, protected: protectedSpans } = proseSpans(text);
  const candidates: Candidate[] = [];
  const add = (rule: RuleId, span: Span) => {
    candidates.push({ ...span, id: `${rule}:${span.start}:${span.end}`, rule, line: text.slice(0, span.start).split("\n").length });
    if (candidates.length > MAX_CANDIDATES) throw new Error("候选超过 600 条，请缩小检测范围；没有截断或漏检后继续。");
  };
  const lengths: number[] = [];
  prose.forEach((paragraph, index) => {
    if (/[\u3400-\u9fff]/.test(paragraph.text)) add("rename", paragraph);
    const sents = sentences(paragraph);
    for (const sentence of sents) {
      lengths.push([...sentence.text.trim()].length);
      if (/(?:不是|并非)[^。！？]*而是|与其说[^。！？]*不如说|看似[^。！？]*实则|你以为[^。！？]*其实/.test(sentence.text)) add("reversal", sentence);
      if (/(?:说白了|说穿了|先说结论)/.test(sentence.text)) add("opener", sentence);
      if ((sentence.text.match(/、/g)?.length ?? 0) >= 3) add("enumeration", sentence);
      if (/[—；;]/.test(sentence.text)) add("fingerprint", sentence);
      if (/[:：]/.test(sentence.text)) add("colon", sentence);
    }
    for (let n = 0; n + 2 < sents.length; n += 1) {
      const start = sents[n].start, end = sents[n + 2].end;
      add("triplet", { start, end, text: text.slice(start, end) });
    }
    const previous = prose[index - 1];
    // Do not create a fake interface across a heading, quotation or other protected block.
    if (previous && !text.slice(previous.end, paragraph.start).trim()) {
      const tail = sentences(previous).at(-1), head = sents[0];
      if (tail && head) add("transition", { start: tail.start, end: head.end, text: text.slice(tail.start, head.end) });
    }
  });
  const mean = lengths.reduce((sum, n) => sum + n, 0) / lengths.length;
  const cv = lengths.length >= 5 && mean ? Math.sqrt(lengths.reduce((sum, n) => sum + (n - mean) ** 2, 0) / lengths.length) / mean : null;
  return { version: TONE_VERSION, chars: [...text.replace(/\s/g, "")].length, paragraphs: prose.length, sentenceCV: cv, candidates, protected: protectedSpans };
}

export type Verdict = { id: string; label: string; confidence: "high" | "medium" | "low"; disposition: "revise" | "keep" | "false_positive" | "human"; reason: string; suggestion: string };
/** Missing/duplicate/unknown results fail the batch; model output must never silently erase candidates. */
export function parseVerdicts(value: unknown, candidates: Candidate[]): Verdict[] {
  const rows = (value as { verdicts?: unknown })?.verdicts;
  if (!Array.isArray(rows) || rows.length !== candidates.length) throw new Error("语义复核未覆盖全部候选，请重试。");
  const seen = new Set<string>();
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return rows.map((row) => {
    if (!row || typeof row !== "object") throw new Error("无效的判读结果。");
    const candidate = byId.get(row.id);
    if (!candidate || seen.has(row.id)) throw new Error("判读候选编号不匹配。");
    seen.add(row.id);
    const rule = RULES[candidate.rule];
    if (!(rule.labels as readonly unknown[]).includes(row.label) || !["high", "medium", "low"].includes(row.confidence)
      || !["revise", "keep", "false_positive", "human"].includes(row.disposition)
      || typeof row.reason !== "string" || !row.reason.trim() || typeof row.suggestion !== "string") throw new Error("判读标签或理由不完整。");
    const positive = (rule.positive as readonly string[]).includes(row.label);
    const disposition = row.confidence === "low" || row.label === "无法判断" ? "human"
      : row.disposition === "revise" && (!positive || rule.grade === "C") ? "keep" : row.disposition;
    if (disposition === "revise" && !row.suggestion.trim()) throw new Error("拟改项缺少具体改法。");
    return { id: row.id, label: row.label, confidence: row.confidence, disposition, reason: row.reason.slice(0, 1500), suggestion: row.suggestion.slice(0, 1500) };
  });
}

export function toneSummary(scan: ToneScan, verdicts: Verdict[]) {
  return (Object.keys(RULES) as RuleId[]).map((rule) => {
    const ids = new Set(scan.candidates.filter((c) => c.rule === rule).map((c) => c.id));
    const rows = verdicts.filter((v) => ids.has(v.id));
    return { rule, raw: ids.size, valid: rows.filter((v) => v.disposition !== "false_positive" && v.disposition !== "human" && (RULES[rule].positive as readonly string[]).includes(v.label)).length,
      revise: rows.filter((v) => v.disposition === "revise").length, keep: rows.filter((v) => v.disposition === "keep").length,
      falsePositive: rows.filter((v) => v.disposition === "false_positive").length, human: rows.filter((v) => v.disposition === "human").length };
  });
}

export function longestTransition(scan: ToneScan, verdicts: Verdict[]): number {
  const byId = new Map(verdicts.map((v) => [v.id, v.label]));
  let longest = 0, run = 0, previousEnd = -1;
  for (const c of scan.candidates.filter((c) => c.rule === "transition")) {
    // A protected block breaks the chain, even if the surrounding interfaces both match.
    if (scan.protected.some((s) => s.start >= previousEnd && s.end <= c.start)) run = 0;
    run = byId.get(c.id) === "明确承接" ? run + 1 : 0;
    longest = Math.max(longest, run); previousEnd = c.end;
  }
  return longest;
}
