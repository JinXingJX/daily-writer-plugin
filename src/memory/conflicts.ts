// Deterministic continuity checks over the fact ledger.
import { contentHash } from "../domain/ids";
import type { MemoryConflict } from "./schema";
import { normalizeName } from "./text";
import type { MemoryView } from "./view";

const DEATH_ATTRIBUTE = /生死|存活|状态|下场|结局|生命/;
const DEATH_VALUE = /死亡|已死|身亡|阵亡|战死|被杀|去世|陨落|殒命|毙命/;
const DEATH_UNCERTAIN = /假死|疑似|传闻|生死未卜|复活|重生|未死/;

export function detectConflicts(view: MemoryView, previous: MemoryConflict[] = []): MemoryConflict[] {
  const found: MemoryConflict[] = [];
  for (const entity of view.entities) {
    const facts = view.facts(entity.id);
    const traits = new Map<string, typeof facts>();
    for (const fact of facts) {
      if (fact.kind !== "trait") continue;
      const key = normalizeName(fact.attribute);
      traits.set(key, [...(traits.get(key) ?? []), fact]);
    }
    for (const list of traits.values()) {
      const distinct = new Map<string, (typeof facts)[number]>();
      for (const fact of list) if (!distinct.has(normalizeName(fact.value))) distinct.set(normalizeName(fact.value), fact);
      if (distinct.size < 2) continue;
      const values = [...distinct.values()];
      found.push({ id: `trait-${contentHash(`${entity.id}|${list[0].attribute}|${values.map((fact) => fact.value).join("|")}`)}`, kind: "trait", subject: entity.name, attribute: list[0].attribute, values: values.map((fact) => ({ value: fact.value, chapterId: fact.chapterId, quote: fact.quote })), note: "固定特征前后不一致", status: "open", detectedAt: Date.now() });
    }

    if (entity.category !== "character") continue;
    const death = facts.find((fact) => DEATH_ATTRIBUTE.test(fact.attribute) && DEATH_VALUE.test(fact.value) && !DEATH_UNCERTAIN.test(fact.value + fact.quote));
    if (!death) continue;
    const revived = facts.some((fact) => fact.position > death.position && DEATH_UNCERTAIN.test(fact.value));
    if (revived) continue;
    const names = new Set([entity.name, ...entity.aliases].map(normalizeName));
    for (const card of view.cards.values()) {
      const position = view.position(card.chapterId);
      if (position <= death.position) continue;
      const appears = card.scenes.some((scene) => scene.characters.some((name) => names.has(normalizeName(name)))) || card.characters.some((character) => names.has(normalizeName(character.name)) && character.change);
      if (!appears) continue;
      found.push({ id: `death-${contentHash(`${entity.id}|${card.chapterId}`)}`, kind: "death", subject: entity.name, attribute: "生死", values: [{ value: death.value, chapterId: death.chapterId, quote: death.quote }, { value: "再次出场", chapterId: card.chapterId, quote: "" }], note: "已死亡人物在之后的场景中出场（若为回忆/梦境可忽略）", status: "open", detectedAt: Date.now() });
    }
  }
  const previousStatus = new Map(previous.map((conflict) => [conflict.id, conflict.status]));
  return found.map((conflict) => ({ ...conflict, status: previousStatus.get(conflict.id) === "ignored" ? "ignored" : conflict.status })).slice(0, 500);
}
