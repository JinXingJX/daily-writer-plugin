// Readability proxies for Chinese prose, after "Why is AI-generated language so hard to understand?" (arXiv 2610.29162):
// long stretches without a pause (readers hold more before a clause closes), stacked 的-modifiers (several things
// pressed into one noun phrase), abstract nouns acting in place of people, and long runs of dialogue with no speaker.
// They point the editor at sentences that may be hard to follow on one read; they are not faults by themselves.

export type ReadabilityKind = "clause" | "modifiers" | "abstract" | "dialogue";
export type ReadabilityStats = { chars: number; longClauses: number; modifierChains: number; abstractSubjects: number; dialogueRuns: number };
/** `quote` is copied verbatim from the text. */
export type ReadabilityHint = { quote: string; kind: ReadabilityKind; message: string };

/** Characters between two pauses above which a clause is hard to take in at once. */
const LONG_CLAUSE = 35;
/** 的 in one clause from which modifiers are stacked. */
const MODIFIER_CHAIN = 3;
/** Consecutive speech-only paragraphs from which readers may lose track of who is talking. */
const DIALOGUE_RUN = 6;
/** Below this many characters the samples say too little about the author's habits to serve as a baseline. */
const MIN_BASELINE = 500;
/** A kind the samples use at least this close to the draft's rate is the author's voice, not a slip. */
const BASELINE_MARGIN = 1.5;

const PAUSES = /[，。！？；：、…—\n“”「」『』（）()《》,.!?;:]+/;
const DE = /(?<!目)的(?![确话士])/g;
const ABSTRACT_ACTOR = /(沉默|寂静|死寂|空气|气氛|恐惧|绝望|不安|寒意|时间|命运|目光|视线|黑暗|夜色)[^，。！？；\n]{0,3}?(吞没|吞噬|攫住|攥住|笼罩|凝固|蔓延|爬上|压在|撕裂|淹没|啃噬|扼住|裹住|漫过)/;
const QUOTED = /[“「『][^”」』]*[”」』]/g;

type Finding = { kind: ReadabilityKind; quote: string; weight: number; message: string };

function scan(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const raw of text.split(PAUSES)) {
    const clause = raw.trim();
    if (!clause) continue;
    const length = clause.replace(/\s/g, "").length;
    if (length > LONG_CLAUSE) findings.push({ kind: "clause", quote: clause, weight: length, message: `一口气 ${length} 字没有停顿` });
    const des = clause.match(DE)?.length ?? 0;
    if (des >= MODIFIER_CHAIN) findings.push({ kind: "modifiers", quote: clause, weight: des, message: `一个分句里叠了 ${des} 个“的”` });
    const actor = clause.match(ABSTRACT_ACTOR);
    if (actor) findings.push({ kind: "abstract", quote: clause, weight: 1, message: `“${actor[1]}”在替人行动` });
  }
  let run: string[] = [];
  const closeRun = () => {
    if (run.length >= DIALOGUE_RUN) findings.push({ kind: "dialogue", quote: run[0].slice(0, 30), weight: run.length, message: `连续 ${run.length} 段只有对白，读者可能分不清谁在说` });
    run = [];
  };
  for (const raw of text.split("\n")) {
    const paragraph = raw.trim();
    if (!paragraph) continue;
    if (/^[“「『]/.test(paragraph) && !paragraph.replace(QUOTED, "").trim()) run.push(paragraph); else closeRun();
  }
  closeRun();
  return findings;
}

// Figurative language is retained as telemetry, never an automatic rewriting hint.
const KINDS: ReadabilityKind[] = ["clause", "modifiers", "dialogue"];

function counts(findings: Finding[]): Record<ReadabilityKind, number> {
  const result: Record<ReadabilityKind, number> = { clause: 0, modifiers: 0, abstract: 0, dialogue: 0 };
  for (const finding of findings) result[finding.kind] += 1;
  return result;
}

function charCount(text: string) { return text.replace(/\s/g, "").length; }

export function readabilityStats(text: string): ReadabilityStats {
  const found = counts(scan(text));
  return { chars: charCount(text), longClauses: found.clause, modifierChains: found.modifiers, abstractSubjects: found.abstract, dialogueRuns: found.dialogue };
}

/** How many places the stats flag in all. */
export function hardSpots(stats: ReadabilityStats) { return stats.longClauses + stats.modifierChains + stats.dialogueRuns; }

/**
 * Up to `limit` places in `text` worth a second look, spread across the kinds, the most extreme first. A kind the
 * `baseline` (the work's style samples) uses about as often as the text is skipped: that is how the author writes.
 */
export function readabilityHints(text: string, baseline = "", limit = 8): ReadabilityHint[] {
  const findings = scan(text);
  const chars = Math.max(1, charCount(text));
  const baseChars = charCount(baseline);
  const base = baseChars >= MIN_BASELINE ? counts(scan(baseline)) : null;
  const own = counts(findings);
  const queues = KINDS
    .filter((kind) => own[kind] && !(base && base[kind] && own[kind] / chars <= (base[kind] / baseChars) * BASELINE_MARGIN))
    .map((kind) => findings.filter((finding) => finding.kind === kind).sort((left, right) => right.weight - left.weight));
  const hints: ReadabilityHint[] = [];
  const seen = new Set<string>();
  for (let round = 0; hints.length < limit && queues.some((queue) => queue.length > round); round += 1) {
    for (const queue of queues) {
      const finding = queue[round];
      if (!finding || hints.length >= limit || seen.has(finding.quote)) continue;
      seen.add(finding.quote);
      hints.push({ quote: finding.quote, kind: finding.kind, message: finding.message });
    }
  }
  return hints;
}
