// Name matching and lightweight Chinese-friendly tokenization for retrieval.

export function normalizeName(name: string) { return name.replace(/[\s·・•．.,，。:：、"'“”‘’()（）[\]【】]/g, "").toLowerCase(); }

/** Counts occurrences of each name (≥2 chars, or 1 char for latin words ≥3) in `text`; longer names win overlaps. */
export function countMentions(text: string, names: Iterable<string>): Record<string, number> {
  const unique = [...new Set([...names].map((name) => name.trim()).filter((name) => name.length >= 2))].sort((left, right) => right.length - left.length);
  const counts: Record<string, number> = {};
  const covered = new Uint8Array(text.length);
  for (const name of unique) {
    let index = text.indexOf(name);
    let count = 0;
    while (index >= 0) {
      if (!covered[index]) {
        count += 1;
        covered.fill(1, index, index + name.length);
      }
      index = text.indexOf(name, index + name.length);
    }
    if (count) counts[name] = count;
  }
  return counts;
}

const CJK_RUN = /[\p{Script=Han}]+/gu;
const WORD = /[\p{L}\p{N}]+/gu;

/** CJK text becomes overlapping bigrams (plus unigrams for single characters); other scripts become lowercase words. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const run of text.match(CJK_RUN) ?? []) {
    if (run.length === 1) { tokens.push(run); continue; }
    for (let index = 0; index < run.length - 1; index += 1) tokens.push(run.slice(index, index + 2));
  }
  for (const word of text.replace(CJK_RUN, " ").match(WORD) ?? []) if (word.length > 1) tokens.push(word.toLowerCase());
  return tokens;
}

export class Bm25Index {
  private postings = new Map<string, { doc: number; tf: number }[]>();
  private lengths: number[] = [];
  private averageLength = 1;
  readonly ids: string[] = [];

  add(id: string, text: string) {
    const doc = this.ids.length;
    this.ids.push(id);
    const tokens = tokenize(text);
    this.lengths.push(tokens.length);
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const [token, tf] of counts) {
      const list = this.postings.get(token);
      if (list) list.push({ doc, tf }); else this.postings.set(token, [{ doc, tf }]);
    }
    this.averageLength = this.lengths.reduce((total, length) => total + length, 0) / Math.max(1, this.lengths.length);
  }

  search(query: string, limit = 10): { id: string; score: number }[] {
    const k1 = 1.4;
    const b = 0.75;
    const scores = new Map<number, number>();
    const total = this.ids.length;
    for (const token of new Set(tokenize(query))) {
      const list = this.postings.get(token);
      if (!list) continue;
      const idf = Math.log(1 + (total - list.length + 0.5) / (list.length + 0.5));
      for (const { doc, tf } of list) {
        const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * this.lengths[doc] / this.averageLength));
        scores.set(doc, (scores.get(doc) ?? 0) + idf * norm);
      }
    }
    return [...scores].sort((left, right) => right[1] - left[1]).slice(0, limit).map(([doc, score]) => ({ id: this.ids[doc], score }));
  }
}
