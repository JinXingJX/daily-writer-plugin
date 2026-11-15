// Folds what chapter cards record about knowledge and closeness into the story plan, the same way thread events are
// folded into the thread ledger: re-extracting a chapter first retracts what it contributed.
import type { ChapterCard } from "../memory/schema";
import type { MemoryView } from "../memory/view";
import { uniqueId } from "../domain/ids";
import type { RelationTrack, StoryPlan } from "./schema";

/** Removes extracted knowledge and closeness points that came from `chapterId`. */
export function retractChapterFromStory(plan: StoryPlan, chapterId: string): void {
  for (const secret of plan.secrets) secret.knownBy = secret.knownBy.filter((entry) => !(entry.origin === "extracted" && entry.chapterId === chapterId));
  for (const relation of plan.relations) relation.intimacy = relation.intimacy.filter((point) => !(point.origin === "extracted" && point.chapterId === chapterId));
}

/**
 * Adds a card's knowledge (only entries linked to a tracked secret) and closeness shifts. Names are normalised to the
 * memory's canonical names when `memory` is given. Points are kept in reading order.
 */
export function applyCardToStory(plan: StoryPlan, card: ChapterCard, memory: MemoryView | null): void {
  retractChapterFromStory(plan, card.chapterId);
  const canonical = (name: string) => memory?.resolve(name)?.name ?? name;
  const order = (chapterId: string | null) => (chapterId && memory ? memory.position(chapterId) : -1);
  for (const entry of card.knowledge) {
    if (!entry.secretId) continue;
    const secret = plan.secrets.find((item) => item.id === entry.secretId);
    if (!secret) continue;
    const who = canonical(entry.who);
    if (secret.knownBy.some((known) => known.who === who && order(known.chapterId) <= order(card.chapterId))) continue;
    secret.knownBy.push({ who, chapterId: card.chapterId, source: entry.source, origin: "extracted" });
    secret.knownBy.sort((left, right) => order(left.chapterId) - order(right.chapterId));
  }
  for (const shift of card.intimacy) {
    const a = canonical(shift.a);
    const b = canonical(shift.b);
    let track: RelationTrack | undefined = plan.relations.find((relation) => (relation.a === a && relation.b === b) || (relation.a === b && relation.b === a));
    if (!track) {
      track = { id: uniqueId("track"), a, b, social: [], intimacy: [] };
      plan.relations.push(track);
    }
    const before = track.intimacy.filter((point) => order(point.chapterId) < order(card.chapterId)).pop();
    const level = Math.max(0, Math.min(10, (before?.level ?? 3) + shift.delta));
    track.intimacy.push({ chapterId: card.chapterId, level, event: shift.event, reason: "", origin: "extracted" });
    track.intimacy.sort((left, right) => order(left.chapterId) - order(right.chapterId));
  }
}
