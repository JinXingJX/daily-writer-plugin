// Story health: deterministic checks over chapter cards, threads and the story plan. They point at likely structural
// problems (an expectation gap, a stale plant, the same payoff three times) and never block anything.
import { chapterLabel } from "../domain/documents";
import { CHANGE_KIND_LABELS } from "../memory/schema";
import type { MemoryView } from "../memory/view";
import type { StoryPlan } from "./schema";
import { isOpenAt, positionedThreads } from "./selectors";

export type HealthRule =
  | "promise-missing" | "opening-elements" | "expectation-gap" | "no-successor" | "handoff-gap" | "stale-foreshadow"
  | "payoff-repeat" | "suppress-overload" | "suppress-reason" | "scene-no-change" | "cast-overload" | "intimacy-jump" | "threshold-weak" | "reveal-early";
export type HealthSeverity = "info" | "warning";
export type HealthIssue = { id: string; rule: HealthRule; severity: HealthSeverity; chapterId: string | null; message: string; refs: string[] };

export const HEALTH_RULE_LABELS: Record<HealthRule, string> = {
  "promise-missing": "核心承诺",
  "opening-elements": "开篇要素",
  "expectation-gap": "期待空档",
  "no-successor": "期待没有后继",
  "handoff-gap": "兑现后断档",
  "stale-foreshadow": "伏笔沉寂",
  "payoff-repeat": "爽点重复",
  "suppress-overload": "积压过久",
  "suppress-reason": "积压缺理由",
  "scene-no-change": "章节没有改变",
  "cast-overload": "新人物过多",
  "intimacy-jump": "关系跳变",
  "threshold-weak": "关口理由弱",
  "reveal-early": "揭示提前",
};

const WEAK_REASON = /^(好奇|闲逛|随便|顺便|路过|无聊|想看看)/;
/** Only recent chapters are checked for per-chapter rules, so a long book does not drown in old notes. */
const RECENT_WINDOW = 30;

/** Runs every rule. `upTo` limits the check to chapters before that reading position (default: the whole book). */
export function diagnoseStory(plan: StoryPlan, memory: MemoryView | null, upTo?: number): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const push = (rule: HealthRule, severity: HealthSeverity, message: string, chapterId: string | null = null, refs: string[] = []) => {
    issues.push({ id: `${rule}:${chapterId ?? ""}:${refs.join(",")}:${issues.length}`, rule, severity, chapterId, message, refs });
  };
  const t = plan.thresholds;
  if (!plan.promise.oneLiner.trim()) push("promise-missing", "info", "还没有写下这本书的一句话卖点：读者点开它，最想反复得到什么体验。");
  const opening = plan.promise.opening;
  const missing = (["who", "where", "asset", "conflict", "firstEvent"] as const).filter((key) => !opening[key].trim());
  const OPENING_LABELS = { who: "主角是谁", where: "在哪", asset: "有什么优势", conflict: "面临什么矛盾", firstEvent: "要做的第一件事" };
  if (missing.length && missing.length < 5) push("opening-elements", "info", `开篇五要素还缺：${missing.map((key) => OPENING_LABELS[key]).join("、")}。前三章最好都交代到。`);

  for (const volume of plan.volumes) {
    const reasons = volume.threshold.reasons.filter((reason) => reason.trim());
    if (volume.endpoint.trim() && (!reasons.length || reasons.every((reason) => WEAK_REASON.test(reason.trim())))) {
      push("threshold-weak", "warning", "这一卷的终点已定，但主角跨进下一阶段的理由还空着或只是好奇。补上非去不可的得失（危机、收获、承诺）。", null, [volume.volumeId]);
    }
  }
  for (const relation of plan.relations) {
    for (let index = 1; index < relation.intimacy.length; index += 1) {
      const previous = relation.intimacy[index - 1];
      const point = relation.intimacy[index];
      if (Math.abs(point.level - previous.level) > t.intimacyJumpMax) push("intimacy-jump", "warning", `${relation.a}与${relation.b}的亲近程度从 ${previous.level} 跳到 ${point.level}（${point.event || "未记事件"}）。关系最好由一串小事件累积，而不是一次猛跳。`, point.chapterId, [relation.id]);
      else if (!point.reason.trim() && !point.event.trim()) push("intimacy-jump", "info", `${relation.a}与${relation.b}的一次关系变化没有记下事件和理由。`, point.chapterId, [relation.id]);
    }
  }
  if (!memory || memory.isEmpty) return issues;

  const total = upTo ?? memory.orderedIds.length;
  const idAt = (position: number) => memory.orderedIds[position] ?? null;
  const threads = positionedThreads(memory);
  const readerFacing = threads.filter((thread) => thread.kind !== "foreshadow");

  // Expectation gaps: stretches where no reader-facing thread is open (after the opening chapters).
  if (readerFacing.length) {
    let gapStart = -1;
    const flush = (end: number) => {
      if (gapStart < 0) return;
      push("expectation-gap", "warning", `${chapterLabel(gapStart)}${end - 1 > gapStart ? `到${chapterLabel(end - 1)}` : ""}没有任何正在等兑现的期待或悬念。读者会在这里失去往下读的理由。`, idAt(gapStart));
      gapStart = -1;
    };
    for (let position = 3; position < total; position += 1) {
      if (!memory.cardAt(position)) { flush(position); continue; }
      const open = readerFacing.some((thread) => isOpenAt(thread, position + 1));
      if (!open && gapStart < 0) gapStart = position;
      if (open) flush(position);
    }
    flush(total);
  }

  for (const thread of readerFacing) {
    if (thread.status !== "open" || thread.plantedAt >= total) continue;
    if (thread.progress >= t.expectationHandoffProgress && !thread.successorIds.length) {
      push("no-successor", "warning", `「${thread.title}」已推进过半，还没有安排接棒的下一个期待。在它兑现之前，下一个值得关心的问题要先出现。`, idAt(thread.lastAt), [thread.id]);
    }
  }
  for (const thread of readerFacing) {
    if (thread.paidAt === null || thread.paidAt >= total) continue;
    const paidAt = thread.paidAt;
    const successor = thread.successorIds.length || threads.some((other) => other.id !== thread.id && other.kind !== "foreshadow" && other.plantedAt >= paidAt - 3 && other.plantedAt <= paidAt + 1);
    if (!successor) push("handoff-gap", "warning", `「${thread.title}」在${chapterLabel(paidAt)}兑现，前后几章没有引入新的期待，剧情可能在这里断档。`, idAt(paidAt), [thread.id]);
  }
  for (const thread of threads) {
    if (thread.kind !== "foreshadow" || !isOpenAt(thread, total) || thread.lastAt < 0) continue;
    const silent = total - 1 - thread.lastAt;
    if (silent >= t.foreshadowStaleChapters) push("stale-foreshadow", "info", `伏笔「${thread.title}」已经 ${silent} 章没有任何回响。中途碰一下让读者记起，或者让它自然失效。`, idAt(thread.lastAt), [thread.id]);
  }

  // Payoff repetition and suppression across chapters.
  let run: { type: string; start: number; length: number } | null = null;
  let suppressed = 0;
  let suppressStart = -1;
  for (let position = 0; position < total; position += 1) {
    const card = memory.cardAt(position);
    if (!card) continue;
    const types = new Set(card.payoffs.map((payoff) => payoff.type));
    if (run && types.has(run.type)) run.length += 1;
    else {
      if (run && run.length >= t.payoffRepeatWindow) push("payoff-repeat", "warning", `${chapterLabel(run.start)}起连续 ${run.length} 章都是「${run.type}」式的兑现。换一种（智取、守护、认可、揭穿、反转），或在中间插一段压抑。`, idAt(run.start));
      const first = card.payoffs[0]?.type;
      run = first ? { type: first, start: position, length: 1 } : null;
    }
    for (const beat of card.emotionBeats) {
      if (beat.type === "release") { suppressed = 0; suppressStart = -1; continue; }
      if (beat.type !== "suppress") continue;
      if (!beat.reason.trim() && position >= total - RECENT_WINDOW) push("suppress-reason", "info", `${chapterLabel(position)}有一次情绪积压没有说清理由。延迟爆发要有符合人物目标和处境的理由，否则读者会觉得在拖。`, card.chapterId);
      if (suppressed === 0) suppressStart = position;
      suppressed += 1;
      if (suppressed === t.suppressMax + 1) push("suppress-overload", "warning", `从${chapterLabel(suppressStart)}起情绪已经被压了 ${suppressed} 次还没有释放。蓄势太久会变成拖延，最强的一段之后应该兑现。`, card.chapterId);
    }
  }
  if (run && run.length >= t.payoffRepeatWindow) push("payoff-repeat", "warning", `${chapterLabel(run.start)}起连续 ${run.length} 章都是「${run.type}」式的兑现。`, idAt(run.start));

  for (let position = Math.max(0, total - RECENT_WINDOW); position < total; position += 1) {
    const card = memory.cardAt(position);
    if (!card) continue;
    if (card.version >= 2 && !card.changes.length) push("scene-no-change", "info", `${chapterLabel(position)}结束时，局面在${Object.values(CHANGE_KIND_LABELS).join("、")}上都没有变化。`, card.chapterId);
    if (card.newCast.length > t.maxNewCastPerChapter) push("cast-overload", "info", `${chapterLabel(position)}一次登场了 ${card.newCast.length} 个新人物（${card.newCast.slice(0, 6).join("、")}…）。读者记不住，先立住一两个。`, card.chapterId);
    for (const shift of card.intimacy) {
      if (Math.abs(shift.delta) > t.intimacyJumpMax) push("intimacy-jump", "warning", `${chapterLabel(position)}${shift.a}与${shift.b}的关系一下变化了 ${shift.delta}（${shift.event}）。`, card.chapterId);
    }
  }

  for (const secret of plan.secrets) {
    if (!secret.readerRevealChapterId) continue;
    const reveal = memory.position(secret.readerRevealChapterId);
    if (reveal < 0) continue;
    const early = secret.knownBy.filter((entry) => entry.chapterId && memory.position(entry.chapterId) >= 0 && memory.position(entry.chapterId) < reveal);
    const first = early.sort((left, right) => memory.position(left.chapterId as string) - memory.position(right.chapterId as string))[0];
    if (first?.chapterId) push("reveal-early", "info", `暗线「${secret.title}」计划在${chapterLabel(reveal)}揭示，但${first.who}在${chapterLabel(memory.position(first.chapterId))}已经知道了。确认这是有意的，并且读者此时还不该知道。`, first.chapterId, [secret.id]);
  }
  return issues;
}

/** Issues that concern one chapter. */
export function chapterHealth(issues: HealthIssue[], chapterId: string) { return issues.filter((issue) => issue.chapterId === chapterId); }
