// Story plan: the structural decisions behind a long serial that chapter text alone does not hold — the promise the book
// keeps to its readers, the power that drives its plot, the hidden truths and who knows them, how relationships move,
// and where each volume is heading. Stored per work in `story.json`, outside the draft merge.
import { uniqueId } from "../domain/ids";
import { arrayValue, asRecord, clampNumber, finiteNumber, nullableString, stringArray, stringValue } from "../domain/util";

/** What readers keep coming back for, and the first chapter's must-haves. */
export type CorePromise = {
  /** One sentence: what the protagonist's edge is, where it plays out, and which experience it keeps delivering. */
  oneLiner: string;
  /** The emotional need served (superiority, solving the puzzle, comfort, dread, beauty…). */
  emotionalNeed: string;
  /** Where the protagonist's edge comes from (ability, knowledge, status, contrast…). */
  advantage: string;
  /** Kinds of scenes that deliver the promise. */
  sceneTypes: string[];
  /** Examples of plot that would drift away from it. */
  offPromise: string[];
  opening: OpeningChecklist;
};
/** Who, where, what edge, why (the conflict) and what happens first. */
export type OpeningChecklist = { who: string; where: string; asset: string; conflict: string; firstEvent: string };

/** A rung of the status ladder: each step up brings new rivals and new pressure. */
export type StatusRung = { level: string; newRivals: string; newPressure: string };
/** A power or "golden finger": its rules decide what plot it can generate and where it would break the book. */
export type StoryPower = {
  id: string;
  name: string;
  /** What the protagonist must do to use or feed it. */
  trigger: string;
  reward: string;
  /** What makes the reward visible to readers (money, rank, recognition…). */
  rewardAnchor: string;
  cost: string;
  cap: string;
  /** Problems it cannot solve. */
  cannotSolve: string[];
  /** Ways it produces payoff scenes; vary them. */
  payoffModes: string[];
  amplifiedEmotion: string;
  statusLadder: StatusRung[];
};

export type ImpactTier = "upper" | "middle" | "lower" | "environment";
export const IMPACT_TIERS: ImpactTier[] = ["upper", "middle", "lower", "environment"];
export const IMPACT_TIER_LABELS: Record<ImpactTier, string> = { upper: "上层", middle: "中层", lower: "下层", environment: "社会环境" };
export type SecretImpact = { tier: ImpactTier; interest: string; misread: string; action: string };
/** `chapterId` is where the character learned it; `origin` tells extracted records from the author's. */
export type SecretKnowledge = { who: string; chapterId: string | null; source: string; origin: "extracted" | "user" };
export type SecretStatus = "hidden" | "partial" | "revealed";
export const SECRET_STATUS_LABELS: Record<SecretStatus, string> = { hidden: "未揭示", partial: "部分揭示", revealed: "已揭示" };
/** A hidden line: the truth behind events, how it ripples through society, who knows it and when readers learn it. */
export type StorySecret = {
  id: string;
  title: string;
  /** The full truth; never written into the text as is. */
  truth: string;
  impacts: SecretImpact[];
  knownBy: SecretKnowledge[];
  readerRevealChapterId: string | null;
  revealPlan: string;
  status: SecretStatus;
};

export type SocialPoint = { chapterId: string | null; status: string };
export type IntimacyPoint = { chapterId: string | null; level: number; event: string; reason: string; origin: "extracted" | "user" };
/** Two tracks of a relationship: the public status and how close the two actually are (0-10). */
export type RelationTrack = { id: string; a: string; b: string; social: SocialPoint[]; intimacy: IntimacyPoint[] };

/** Why the protagonist must (or wants to) step into the next stage, and what waits there. */
export type Threshold = { reasons: string[]; preparation: string; beyond: string };
/** What a map change carries over from the previous stage. */
export type Transition = { carriedRelations: string[]; carriedPromises: string[]; bridgeCharacters: string[] };
export type VolumePlan = { volumeId: string; endpoint: string; threshold: Threshold; coreLoop: string[]; transition: Transition };

/** Diagnostic thresholds. The craft notes stress these numbers are examples; every work tunes its own. */
export type StoryThresholds = {
  foreshadowStaleChapters: number;
  suppressMax: number;
  payoffRepeatWindow: number;
  expectationHandoffProgress: number;
  maxNewCastPerChapter: number;
  intimacyJumpMax: number;
};
export const DEFAULT_THRESHOLDS: StoryThresholds = { foreshadowStaleChapters: 50, suppressMax: 3, payoffRepeatWindow: 3, expectationHandoffProgress: 0.5, maxNewCastPerChapter: 5, intimacyJumpMax: 3 };
export const THRESHOLD_LABELS: Record<keyof StoryThresholds, string> = {
  foreshadowStaleChapters: "伏笔多少章没有回响算沉寂",
  suppressMax: "连续积压情绪几次后应该兑现",
  payoffRepeatWindow: "连续几章同一种爽点算重复",
  expectationHandoffProgress: "期待推进到多少（0-1）时应已有后继",
  maxNewCastPerChapter: "单章新登场人物上限",
  intimacyJumpMax: "单次亲密度跳变上限（0-10）",
};

export type StoryPlan = {
  promise: CorePromise;
  powers: StoryPower[];
  secrets: StorySecret[];
  relations: RelationTrack[];
  volumes: VolumePlan[];
  thresholds: StoryThresholds;
  updatedAt: number;
};

export type StoryOperation =
  | { type: "setPromise"; promise: CorePromise }
  | { type: "upsertPower"; power: StoryPower }
  | { type: "removePower"; id: string }
  | { type: "upsertSecret"; secret: StorySecret }
  | { type: "removeSecret"; id: string }
  | { type: "upsertRelation"; relation: RelationTrack }
  | { type: "removeRelation"; id: string }
  | { type: "upsertVolumePlan"; plan: VolumePlan }
  | { type: "removeVolumePlan"; volumeId: string }
  | { type: "setThresholds"; thresholds: StoryThresholds };

export function emptyPromise(): CorePromise {
  return { oneLiner: "", emotionalNeed: "", advantage: "", sceneTypes: [], offPromise: [], opening: { who: "", where: "", asset: "", conflict: "", firstEvent: "" } };
}

export function emptyStoryPlan(): StoryPlan {
  return { promise: emptyPromise(), powers: [], secrets: [], relations: [], volumes: [], thresholds: { ...DEFAULT_THRESHOLDS }, updatedAt: 0 };
}

export function normalizeStoryPlan(value: unknown): StoryPlan {
  const plan = asRecord(value);
  return {
    promise: normalizePromise(plan.promise),
    powers: arrayValue(plan.powers).map(normalizePower).slice(0, 50),
    secrets: arrayValue(plan.secrets).map(normalizeSecret).slice(0, 200),
    relations: arrayValue(plan.relations).flatMap((item) => normalizeRelation(item) ?? []).slice(0, 300),
    volumes: arrayValue(plan.volumes).flatMap((item) => normalizeVolumePlan(item) ?? []).slice(0, 500),
    thresholds: normalizeThresholds(plan.thresholds),
    updatedAt: finiteNumber(plan.updatedAt, 0),
  };
}

export function normalizePromise(value: unknown): CorePromise {
  const promise = asRecord(value);
  const opening = asRecord(promise.opening);
  return {
    oneLiner: stringValue(promise.oneLiner),
    emotionalNeed: stringValue(promise.emotionalNeed),
    advantage: stringValue(promise.advantage),
    sceneTypes: stringArray(promise.sceneTypes, 30),
    offPromise: stringArray(promise.offPromise, 30),
    opening: { who: stringValue(opening.who), where: stringValue(opening.where), asset: stringValue(opening.asset), conflict: stringValue(opening.conflict), firstEvent: stringValue(opening.firstEvent) },
  };
}

export function normalizePower(value: unknown): StoryPower {
  const power = asRecord(value);
  return {
    id: stringValue(power.id) || uniqueId("power"),
    name: stringValue(power.name) || "未命名能力",
    trigger: stringValue(power.trigger),
    reward: stringValue(power.reward),
    rewardAnchor: stringValue(power.rewardAnchor),
    cost: stringValue(power.cost),
    cap: stringValue(power.cap),
    cannotSolve: stringArray(power.cannotSolve, 30),
    payoffModes: stringArray(power.payoffModes, 30),
    amplifiedEmotion: stringValue(power.amplifiedEmotion),
    statusLadder: arrayValue(power.statusLadder).map((item) => { const rung = asRecord(item); return { level: stringValue(rung.level), newRivals: stringValue(rung.newRivals), newPressure: stringValue(rung.newPressure) }; }).filter((rung) => rung.level).slice(0, 30),
  };
}

export function normalizeSecret(value: unknown): StorySecret {
  const secret = asRecord(value);
  const status = secret.status === "partial" || secret.status === "revealed" ? secret.status : "hidden";
  return {
    id: stringValue(secret.id) || uniqueId("secret"),
    title: stringValue(secret.title) || "未命名暗线",
    truth: stringValue(secret.truth),
    impacts: arrayValue(secret.impacts).map((item) => { const impact = asRecord(item); return { tier: IMPACT_TIERS.includes(impact.tier as ImpactTier) ? impact.tier as ImpactTier : "middle", interest: stringValue(impact.interest), misread: stringValue(impact.misread), action: stringValue(impact.action) }; }).slice(0, 12),
    knownBy: arrayValue(secret.knownBy).flatMap((item) => { const entry = asRecord(item); const who = stringValue(entry.who).trim(); return who ? [{ who, chapterId: nullableString(entry.chapterId), source: stringValue(entry.source), origin: entry.origin === "extracted" ? "extracted" as const : "user" as const }] : []; }).slice(0, 100),
    readerRevealChapterId: nullableString(secret.readerRevealChapterId),
    revealPlan: stringValue(secret.revealPlan),
    status,
  };
}

export function normalizeRelation(value: unknown): RelationTrack | null {
  const relation = asRecord(value);
  const a = stringValue(relation.a).trim();
  const b = stringValue(relation.b).trim();
  if (!a || !b) return null;
  return {
    id: stringValue(relation.id) || uniqueId("track"),
    a,
    b,
    social: arrayValue(relation.social).map((item) => { const point = asRecord(item); return { chapterId: nullableString(point.chapterId), status: stringValue(point.status) }; }).filter((point) => point.status).slice(0, 100),
    intimacy: arrayValue(relation.intimacy).map((item) => { const point = asRecord(item); return { chapterId: nullableString(point.chapterId), level: Math.round(clampNumber(point.level, 0, 0, 10)), event: stringValue(point.event), reason: stringValue(point.reason), origin: point.origin === "extracted" ? "extracted" as const : "user" as const }; }).slice(0, 300),
  };
}

export function normalizeVolumePlan(value: unknown): VolumePlan | null {
  const plan = asRecord(value);
  const volumeId = stringValue(plan.volumeId).trim();
  if (!volumeId) return null;
  const threshold = asRecord(plan.threshold);
  const transition = asRecord(plan.transition);
  return {
    volumeId,
    endpoint: stringValue(plan.endpoint),
    threshold: { reasons: stringArray(threshold.reasons, 20), preparation: stringValue(threshold.preparation), beyond: stringValue(threshold.beyond) },
    coreLoop: stringArray(plan.coreLoop, 20),
    transition: { carriedRelations: stringArray(transition.carriedRelations, 30), carriedPromises: stringArray(transition.carriedPromises, 30), bridgeCharacters: stringArray(transition.bridgeCharacters, 30) },
  };
}

export function normalizeThresholds(value: unknown): StoryThresholds {
  const stored = asRecord(value);
  return {
    foreshadowStaleChapters: Math.round(clampNumber(stored.foreshadowStaleChapters, DEFAULT_THRESHOLDS.foreshadowStaleChapters, 5, 1_000)),
    suppressMax: Math.round(clampNumber(stored.suppressMax, DEFAULT_THRESHOLDS.suppressMax, 1, 20)),
    payoffRepeatWindow: Math.round(clampNumber(stored.payoffRepeatWindow, DEFAULT_THRESHOLDS.payoffRepeatWindow, 2, 20)),
    expectationHandoffProgress: clampNumber(stored.expectationHandoffProgress, DEFAULT_THRESHOLDS.expectationHandoffProgress, 0.1, 1),
    maxNewCastPerChapter: Math.round(clampNumber(stored.maxNewCastPerChapter, DEFAULT_THRESHOLDS.maxNewCastPerChapter, 1, 50)),
    intimacyJumpMax: Math.round(clampNumber(stored.intimacyJumpMax, DEFAULT_THRESHOLDS.intimacyJumpMax, 1, 10)),
  };
}

export function parseStoryOperation(value: unknown): StoryOperation {
  const operation = asRecord(value);
  switch (operation.type) {
    case "setPromise": return { type: "setPromise", promise: normalizePromise(operation.promise) };
    case "upsertPower": return { type: "upsertPower", power: normalizePower(operation.power) };
    case "removePower": return { type: "removePower", id: requireId(operation.id) };
    case "upsertSecret": return { type: "upsertSecret", secret: normalizeSecret(operation.secret) };
    case "removeSecret": return { type: "removeSecret", id: requireId(operation.id) };
    case "upsertRelation": { const relation = normalizeRelation(operation.relation); if (!relation) throw new Error("关系需要两个人物。"); return { type: "upsertRelation", relation }; }
    case "removeRelation": return { type: "removeRelation", id: requireId(operation.id) };
    case "upsertVolumePlan": { const plan = normalizeVolumePlan(operation.plan); if (!plan) throw new Error("卷规划需要 volumeId。"); return { type: "upsertVolumePlan", plan }; }
    case "removeVolumePlan": return { type: "removeVolumePlan", volumeId: requireId(operation.volumeId) };
    case "setThresholds": return { type: "setThresholds", thresholds: normalizeThresholds(operation.thresholds) };
    default: throw new Error(`未知的故事规划操作：${String(operation.type)}`);
  }
}

function requireId(value: unknown): string {
  const id = stringValue(value).trim();
  if (!id) throw new Error("缺少 id。");
  return id;
}

export function storyOperationLabel(operation: StoryOperation): string {
  switch (operation.type) {
    case "setPromise": return "核心承诺";
    case "upsertPower": return `金手指：${operation.power.name}`;
    case "removePower": return "删除金手指";
    case "upsertSecret": return `暗线：${operation.secret.title}`;
    case "removeSecret": return "删除暗线";
    case "upsertRelation": return `关系：${operation.relation.a} × ${operation.relation.b}`;
    case "removeRelation": return "删除关系";
    case "upsertVolumePlan": return "卷规划";
    case "removeVolumePlan": return "删除卷规划";
    case "setThresholds": return "诊断阈值";
  }
}
