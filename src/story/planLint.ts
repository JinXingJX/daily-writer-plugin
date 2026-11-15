// Deterministic checks of a chapter plan before the author sees it, kept to what a long serial cannot do without: every
// scene wants something and ends changed, enough happens for the length, readers get something or know what is held
// back, the chapter hands readers a hook, expectations hand off, payoffs vary, suppressed emotion gets released and new
// faces arrive a few at a time.
// Stakes, deadlines and obstacles are the plan's to use when they help.
import type { ChapterPlan } from "../ai/pipelines/nextChapter";
import type { MemoryView } from "../memory/view";
import type { StoryPlan } from "./schema";
import { activeExpectations, lastSeenBefore, pendingSuppression, recentPayoffTypes, sceneCast } from "./selectors";

export type PlanWarning = { sceneIndex: number | null; message: string };

const PAYOFF_WORDS = /打脸|智取|守护|认可|揭穿|收获|反转|突破|报仇|翻盘/g;
/** Words per retellable event below which a chapter tends to fill up with description and transitions. */
const WORDS_PER_EVENT = 1_000;
/** New faces in one scene from which readers lose track of who is who. */
const NEW_FACES_PER_SCENE = 3;

export function lintPlan(plan: ChapterPlan, options: { story?: StoryPlan | null; memory?: MemoryView | null; position?: number } = {}): PlanWarning[] {
  const warnings: PlanWarning[] = [];
  plan.scenes.forEach((scene, index) => {
    const at = (message: string) => warnings.push({ sceneIndex: index, message: `场景${index + 1}「${scene.title}」${message}` });
    if (!scene.goal.trim()) at("没有写视角人物想要什么。");
    if (!scene.changes.length && !scene.outcome.trim()) at("结束时局面没有改变（信息、关系、资源、风险、判断都没动）。");
  });
  const words = plan.scenes.reduce((total, scene) => total + scene.words, 0);
  const events = plan.scenes.reduce((total, scene) => total + scene.events.length, 0);
  if (events < Math.floor(words / WORDS_PER_EVENT)) warnings.push({ sceneIndex: null, message: `全章约 ${words} 字，列出的事${events ? `只有 ${events} 件` : "一件也没有"}，篇幅容易被描写和过场填满。加事，或者缩短篇幅。` });
  if (!plan.reward.trim()) warnings.push({ sceneIndex: null, message: "没写读者这一章拿到什么。有意压着就写清压的是什么、哪一章给。" });
  if (plan.promiseAlignment === "off") warnings.push({ sceneIndex: null, message: `这一章与核心承诺无关${plan.promiseNote ? `（${plan.promiseNote}）` : ""}。确认它在为承诺铺垫，或者缩短。` });
  if (!plan.hook.trim()) warnings.push({ sceneIndex: null, message: "没有章末钩子：下一个值得关心的问题是什么？" });

  const { story, memory, position } = options;
  if (memory && !memory.isEmpty && position !== undefined) {
    const handoff = story?.thresholds.expectationHandoffProgress ?? 0.5;
    const mentioned = [...plan.threads.advance, ...plan.threads.payoff].join("｜");
    for (const thread of activeExpectations(memory, position)) {
      const paying = mentioned.includes(thread.id) || mentioned.includes(thread.title);
      if (paying && thread.progress >= handoff && !thread.successorIds.length && !plan.threads.plant.length) {
        warnings.push({ sceneIndex: null, message: `要推进或兑现「${thread.title}」，但还没有接棒的新期待。在它兑现前把下一个问题抛出来。` });
      }
    }
    const window = story?.thresholds.payoffRepeatWindow ?? 3;
    const recent = recentPayoffTypes(memory, position, window - 1);
    const planned = new Set((planToCraft(plan).match(PAYOFF_WORDS) ?? []));
    for (const type of planned) {
      if (recent.length >= window - 1 && recent.every((item) => item.types.includes(type))) warnings.push({ sceneIndex: null, message: `最近几章都是「${type}」式的兑现，这一章又安排了一次。换一种兑现方式，或插一段压抑。` });
    }
    const suppressed = pendingSuppression(memory, position).length;
    const max = story?.thresholds.suppressMax ?? 3;
    if (suppressed >= max && !planToCraft(plan).match(/爆发|兑现|释放|翻盘|出手|揭穿/)) warnings.push({ sceneIndex: null, message: `情绪已经连续压了 ${suppressed} 次，这一章该让它兑现了。` });
    warnings.push(...newFaceWarnings(plan, memory, position, story?.thresholds.maxNewCastPerChapter ?? 5));
  }
  return warnings;
}

/** Readers meet new people one or two at a time; a crowd of strangers at once is a list of names they cannot hold. */
function newFaceWarnings(plan: ChapterPlan, memory: MemoryView, position: number, max: number): PlanWarning[] {
  const warnings: PlanWarning[] = [];
  const met = new Set<string>();
  plan.scenes.forEach((scene, index) => {
    const fresh: string[] = [];
    for (const raw of sceneCast(scene, memory)) {
      const name = raw.trim();
      if (!name) continue;
      const entity = memory.resolve(name);
      const key = entity?.id ?? name;
      if (met.has(key) || lastSeenBefore(memory, name, position) >= 0) continue;
      met.add(key);
      fresh.push(entity?.name ?? name);
    }
    if (fresh.length >= NEW_FACES_PER_SCENE) warnings.push({ sceneIndex: index, message: `场景${index + 1}「${scene.title}」一下子来了 ${fresh.length} 个新面孔（${fresh.join("、")}），读者记不住。先立住一两个，其余往后放。` });
  });
  if (met.size > max) warnings.push({ sceneIndex: null, message: `这一章有 ${met.size} 个新面孔，超过每章 ${max} 人的提醒线。读者可能记不住，先立住一两个，其余往后放。` });
  return warnings;
}

function planToCraft(plan: ChapterPlan) {
  return [plan.core, plan.reward, plan.summary, ...plan.scenes.flatMap((scene) => [scene.turn, scene.outcome, ...scene.events])].join("\n");
}
