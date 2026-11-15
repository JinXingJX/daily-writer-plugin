// Story tools: the story plan (promise, powers, secrets, relations, volume plans), thread edits, health checks. Edits to the plan and to threads become proposal changes the author reviews.
import { chapterLabel } from "../../domain/documents";
import { uniqueId } from "../../domain/ids";
import { arrayValue, previewText, stringValue, trimmedString } from "../../domain/util";
import { newThread, threadOperationLabel } from "../../memory/operations";
import { THREAD_KIND_LABELS, type StoryThread } from "../../memory/schema";
import { threadKindValue, threadTierValue } from "../../memory/store";
import { diagnoseStory, HEALTH_RULE_LABELS } from "../../story/health";
import { IMPACT_TIER_LABELS, parseStoryOperation, SECRET_STATUS_LABELS, storyOperationLabel, type StoryPlan } from "../../story/schema";
import { storyOf, type RunState, type ToolHandler } from "./state";

function planText(plan: StoryPlan, state: RunState): string {
  const chapterName = (id: string | null) => {
    const index = id ? state.draft.chapters.findIndex((chapter) => chapter.id === id) : -1;
    return index >= 0 ? `${state.draft.chapters[index].title}(id=${id})` : "未定";
  };
  const promise = plan.promise;
  return [
    `【核心承诺】${promise.oneLiner || "（未写）"}${promise.emotionalNeed ? `\n读者要的体验：${promise.emotionalNeed}` : ""}${promise.advantage ? `\n主角优势：${promise.advantage}` : ""}${promise.sceneTypes.length ? `\n兑现场景：${promise.sceneTypes.join("、")}` : ""}${promise.offPromise.length ? `\n跑偏的写法：${promise.offPromise.join("、")}` : ""}`,
    `【开篇五要素】谁：${promise.opening.who || "?"}｜在哪：${promise.opening.where || "?"}｜优势：${promise.opening.asset || "?"}｜矛盾：${promise.opening.conflict || "?"}｜第一件事：${promise.opening.firstEvent || "?"}`,
    `【金手指】\n${plan.powers.map((power) => `- ${power.name}(id=${power.id})：条件 ${power.trigger}；收获 ${power.reward}（锚：${power.rewardAnchor}）；代价 ${power.cost}；上限 ${power.cap}；解决不了 ${power.cannotSolve.join("、")}；玩法 ${power.payoffModes.join("、")}；地位阶梯 ${power.statusLadder.map((rung) => rung.level).join(" → ")}`).join("\n") || "（无）"}`,
    `【暗线】\n${plan.secrets.map((secret) => `- ${secret.title}(id=${secret.id}，${SECRET_STATUS_LABELS[secret.status]})：${previewText(secret.truth, 200)}\n  影响：${secret.impacts.map((impact) => `${IMPACT_TIER_LABELS[impact.tier]}·${impact.action}`).join("；") || "?"}\n  知情：${secret.knownBy.map((entry) => `${entry.who}@${chapterName(entry.chapterId)}`).join("、") || "无"}｜读者揭示：${chapterName(secret.readerRevealChapterId)}｜计划：${secret.revealPlan}`).join("\n") || "（无）"}`,
    `【关系双轨】\n${plan.relations.map((relation) => `- ${relation.a}×${relation.b}(id=${relation.id})：名分 ${relation.social.map((point) => point.status).join(" → ") || "?"}｜亲近 ${relation.intimacy.map((point) => point.level).join(" → ") || "?"}`).join("\n") || "（无）"}`,
    `【卷规划】\n${plan.volumes.map((volume) => `- ${state.draft.volumes.find((item) => item.id === volume.volumeId)?.title ?? volume.volumeId}(volumeId=${volume.volumeId})：终点 ${volume.endpoint}｜关口理由 ${volume.threshold.reasons.join("；")}｜核心循环 ${volume.coreLoop.join(" → ")}`).join("\n") || "（无）"}`,
  ].join("\n\n");
}

const readStoryPlan: ToolHandler = async ({ state, memory }) => {
  const plan = await storyOf(state);
  if (!plan) return { observation: "读取故事规划失败。" };
  const threads = memory?.threads.filter((thread) => thread.status === "open").slice(0, 40).map((thread) => `- ${thread.id}〔${THREAD_KIND_LABELS[thread.kind]}·进度${Math.round(thread.progress * 100)}%〕${thread.title}${thread.plan ? `｜计划：${thread.plan}` : ""}${thread.successorIds.length ? `｜接棒：${thread.successorIds.join("、")}` : ""}`) ?? [];
  return { observation: `${planText(plan, state)}\n\n【未兑现的线索】\n${threads.join("\n") || "（无）"}` };
};

const updateStoryPlan: ToolHandler = ({ state, input }) => {
  const raw = arrayValue(input.operations);
  if (!raw.length) throw new Error("operations 不能为空。");
  const operations = raw.map(parseStoryOperation);
  const summary = stringValue(input.summary);
  for (const operation of operations) state.changes.push({ id: uniqueId("change"), kind: "story", label: `${storyOperationLabel(operation)}${summary ? `：${summary}` : ""}`, operation });
  return { observation: `已把 ${operations.length} 项故事规划修改加入建议，作者审核后生效。` };
};

const diagnose: ToolHandler = async ({ state, memory }) => {
  const plan = await storyOf(state);
  if (!plan) return { observation: "读取故事规划失败。" };
  const issues = diagnoseStory(plan, memory);
  const label = (id: string | null) => { const index = id ? memory?.position(id) ?? -1 : -1; return index >= 0 ? `（${chapterLabel(index)}）` : ""; };
  return { observation: issues.length ? issues.slice(0, 40).map((issue) => `- [${issue.severity}]〔${HEALTH_RULE_LABELS[issue.rule]}〕${issue.message}${label(issue.chapterId)}`).join("\n") : "故事体检没有发现结构问题。" };
};

const updateThread: ToolHandler = ({ state, input, memory }) => {
  const threads = memory?.threads ?? [];
  const id = trimmedString(input.threadId);
  const existing = id ? threads.find((thread) => thread.id === id) : undefined;
  if (id && !existing) throw new Error(`没有 id 为 ${id} 的线索。`);
  const pending = state.changes.flatMap((change) => (change.kind === "thread" && change.operation.type === "upsertThread" && change.operation.thread.id === id ? [change.operation.thread] : []));
  const base: StoryThread = structuredClone(pending[pending.length - 1] ?? existing ?? newThread({ id: uniqueId("thread"), title: stringValue(input.title) || "新线索" }));
  if (stringValue(input.title)) base.title = stringValue(input.title);
  if (stringValue(input.description)) base.description = stringValue(input.description);
  if (input.status === "open" || input.status === "paid" || input.status === "abandoned") base.status = input.status;
  if (input.kind) base.kind = threadKindValue(input.kind);
  if (input.tier) base.tier = threadTierValue(input.tier);
  if (typeof input.plan === "string") base.plan = input.plan;
  if (typeof input.progress === "number") base.progress = Math.max(0, Math.min(1, input.progress));
  if (trimmedString(input.targetChapterId) && state.draft.chapters.some((chapter) => chapter.id === input.targetChapterId)) base.targetChapterId = input.targetChapterId as string;
  const successorOf = trimmedString(input.successorOf);
  const operation = { type: "upsertThread" as const, thread: base };
  state.changes.push({ id: uniqueId("change"), kind: "thread", label: threadOperationLabel(operation, threads), operation });
  if (successorOf) {
    const predecessor = threads.find((thread) => thread.id === successorOf);
    if (predecessor && !predecessor.successorIds.includes(base.id)) {
      const linked = { type: "upsertThread" as const, thread: { ...structuredClone(predecessor), successorIds: [...predecessor.successorIds, base.id] } };
      state.changes.push({ id: uniqueId("change"), kind: "thread", label: `「${predecessor.title}」由「${base.title}」接棒`, operation: linked });
    }
  }
  return { observation: `已把线索修改（id=${base.id}）加入建议，作者审核后生效。`, result: { threadId: base.id } };
};

export const STORY_TOOLS: Record<string, ToolHandler> = {
  "writer.readStoryPlan": readStoryPlan,
  "writer.updateStoryPlan": updateStoryPlan,
  "writer.diagnoseStory": diagnose,
  "writer.updateThread": updateThread,
};
