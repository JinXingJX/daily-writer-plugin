// Craft topics the author notebook files writing decisions under.
import { CRAFT_TOPIC_DEFS } from "./topics";

export type CraftTopic = string;
export const CRAFT_TOPICS = CRAFT_TOPIC_DEFS;
const TOPICS = new Map(CRAFT_TOPICS.map((topic) => [topic.id, topic]));

export function craftTopic(value: unknown): CraftTopic | null {
  return typeof value === "string" && TOPICS.has(value) ? value : null;
}

export function craftLabel(topic: string): string { return TOPICS.get(topic)?.label ?? topic; }
