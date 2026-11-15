// Impact analysis: which chapters depend on a setting that is about to change.
import type { MemoryView } from "../../memory/view";

export type ImpactHit = { chapterId: string; position: number; reasons: string[] };

export function findImpact(memory: MemoryView, subject: string, keyword: string): ImpactHit[] {
  const hits = new Map<string, ImpactHit>();
  const add = (chapterId: string, reason: string) => {
    const position = memory.position(chapterId);
    if (position < 0) return;
    const hit = hits.get(chapterId) ?? { chapterId, position, reasons: [] };
    if (!hit.reasons.includes(reason)) hit.reasons.push(reason);
    hits.set(chapterId, hit);
  };
  const entity = subject ? memory.resolve(subject) : null;
  const term = keyword.trim();
  if (entity) {
    for (const fact of memory.facts(entity.id)) {
      if (!term || fact.attribute.includes(term) || fact.value.includes(term)) add(fact.chapterId, `${fact.attribute}=${fact.value}`);
    }
    if (!term) for (const chapterId of memory.chaptersOf(entity.id)) add(chapterId, "提及");
  } else if (term) {
    for (const card of memory.cards.values()) {
      for (const fact of card.facts) if (fact.subject.includes(term) || fact.attribute.includes(term) || fact.value.includes(term)) add(card.chapterId, `${fact.subject}·${fact.attribute}=${fact.value}`);
      if (card.summary.includes(term)) add(card.chapterId, "剧情摘要提及");
    }
  }
  return [...hits.values()].sort((left, right) => left.position - right.position);
}
