// Small builders for test data.
import { CARD_VERSION, type CardThreadEvent, type ChapterCard, type ThreadEventType } from "../memory/schema";

export function testCard(chapterId: string, patch: Partial<ChapterCard> = {}): ChapterCard {
  return { chapterId, sourceHash: "", version: CARD_VERSION, summary: "", scenes: [], characters: [], entities: [], facts: [], threads: [], hook: "", emotionBeats: [], payoffs: [], changes: [], knowledge: [], intimacy: [], newCast: [], mentions: {}, extractedAt: 0, ...patch };
}

export function threadEvent(type: ThreadEventType, title: string, description = "", extra: Partial<CardThreadEvent> = {}): CardThreadEvent {
  return { threadId: null, type, title, description, kind: "foreshadow", tier: "short", ...extra };
}
