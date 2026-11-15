// Applying and reverting story plan operations. Pure functions over a StoryPlan.
import type { StoryOperation, StoryPlan } from "./schema";

export function applyStoryOperation(plan: StoryPlan, operation: StoryOperation): void {
  switch (operation.type) {
    case "setPromise": plan.promise = structuredClone(operation.promise); break;
    case "upsertPower": upsert(plan.powers, operation.power, (item) => item.id === operation.power.id); break;
    case "removePower": plan.powers = plan.powers.filter((item) => item.id !== operation.id); break;
    case "upsertSecret": upsert(plan.secrets, operation.secret, (item) => item.id === operation.secret.id); break;
    case "removeSecret": plan.secrets = plan.secrets.filter((item) => item.id !== operation.id); break;
    case "upsertRelation": upsert(plan.relations, operation.relation, (item) => item.id === operation.relation.id); break;
    case "removeRelation": plan.relations = plan.relations.filter((item) => item.id !== operation.id); break;
    case "upsertVolumePlan": upsert(plan.volumes, operation.plan, (item) => item.volumeId === operation.plan.volumeId); break;
    case "removeVolumePlan": plan.volumes = plan.volumes.filter((item) => item.volumeId !== operation.volumeId); break;
    case "setThresholds": plan.thresholds = { ...operation.thresholds }; break;
  }
  plan.updatedAt = Date.now();
}

export function applyStoryOperations(plan: StoryPlan, operations: StoryOperation[]): void {
  for (const operation of operations) applyStoryOperation(plan, operation);
}

/** Operations that restore the plan to its state before `operation` (computed before applying it). */
export function inverseStoryOperation(plan: StoryPlan, operation: StoryOperation): StoryOperation[] {
  const clone = <T>(value: T) => structuredClone(value);
  switch (operation.type) {
    case "setPromise": return [{ type: "setPromise", promise: clone(plan.promise) }];
    case "upsertPower": { const previous = plan.powers.find((item) => item.id === operation.power.id); return [previous ? { type: "upsertPower", power: clone(previous) } : { type: "removePower", id: operation.power.id }]; }
    case "removePower": { const previous = plan.powers.find((item) => item.id === operation.id); return previous ? [{ type: "upsertPower", power: clone(previous) }] : []; }
    case "upsertSecret": { const previous = plan.secrets.find((item) => item.id === operation.secret.id); return [previous ? { type: "upsertSecret", secret: clone(previous) } : { type: "removeSecret", id: operation.secret.id }]; }
    case "removeSecret": { const previous = plan.secrets.find((item) => item.id === operation.id); return previous ? [{ type: "upsertSecret", secret: clone(previous) }] : []; }
    case "upsertRelation": { const previous = plan.relations.find((item) => item.id === operation.relation.id); return [previous ? { type: "upsertRelation", relation: clone(previous) } : { type: "removeRelation", id: operation.relation.id }]; }
    case "removeRelation": { const previous = plan.relations.find((item) => item.id === operation.id); return previous ? [{ type: "upsertRelation", relation: clone(previous) }] : []; }
    case "upsertVolumePlan": { const previous = plan.volumes.find((item) => item.volumeId === operation.plan.volumeId); return [previous ? { type: "upsertVolumePlan", plan: clone(previous) } : { type: "removeVolumePlan", volumeId: operation.plan.volumeId }]; }
    case "removeVolumePlan": { const previous = plan.volumes.find((item) => item.volumeId === operation.volumeId); return previous ? [{ type: "upsertVolumePlan", plan: clone(previous) }] : []; }
    case "setThresholds": return [{ type: "setThresholds", thresholds: clone(plan.thresholds) }];
  }
}

/** Additive operations are safe to apply without review: they only add records or append knowledge/intimacy points. */
export function isAdditiveStoryOperation(plan: StoryPlan, operation: StoryOperation): boolean {
  switch (operation.type) {
    case "upsertSecret": {
      const previous = plan.secrets.find((item) => item.id === operation.secret.id);
      if (!previous) return true;
      const { knownBy: _a, ...rest } = operation.secret;
      const { knownBy: _b, ...before } = previous;
      return JSON.stringify(rest) === JSON.stringify(before) && previous.knownBy.every((entry, index) => JSON.stringify(entry) === JSON.stringify(operation.secret.knownBy[index]));
    }
    case "upsertRelation": {
      const previous = plan.relations.find((item) => item.id === operation.relation.id);
      if (!previous) return true;
      return previous.social.every((point, index) => JSON.stringify(point) === JSON.stringify(operation.relation.social[index]))
        && previous.intimacy.every((point, index) => JSON.stringify(point) === JSON.stringify(operation.relation.intimacy[index]));
    }
    case "upsertPower": return !plan.powers.some((item) => item.id === operation.power.id);
    default: return false;
  }
}

function upsert<T>(items: T[], item: T, match: (candidate: T) => boolean) {
  const index = items.findIndex(match);
  if (index >= 0) items[index] = structuredClone(item); else items.push(structuredClone(item));
}
