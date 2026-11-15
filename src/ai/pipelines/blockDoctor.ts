import { domainTask } from "../../worker/domainTask";
// Writer's block triage after the craft notes: tell "no plot" from "no way in", "can't phrase it" and "no energy",
// then answer with what fits — three real branches, an emotion plus ways in, a placeholder, or a minimal task.
import { chapterLabel } from "../../domain/documents";
import { arrayValue, asRecord, previewText, stringValue } from "../../domain/util";
import type { MemoryView } from "../../memory/view";
import { relevantThreads } from "../../story/selectors";
import type { StoryPlan } from "../../story/schema";
import type { WriterProject } from "../../types";
import { invokeJson } from "../client";
import { prepareWritingContext } from "../contextPrep";
import { withGoal } from "../prompts";

export type BlockType = "plot" | "entry" | "expression" | "energy";
export const BLOCK_TYPES: BlockType[] = ["plot", "entry", "expression", "energy"];
export const BLOCK_TYPE_LABELS: Record<BlockType, string> = { plot: "没剧情：不知道接下来发生什么", entry: "缺切口：知道大事，不知道怎么落地", expression: "写不出：某一段描写卡住", energy: "不想写：没精力" };

/** The block card: what kind of block, what is already settled, what the character wants, what this part should make the reader feel. */
export type BlockCard = { type: BlockType | null; facts: string; want: string; emotion: string; note: string };
export type BlockBranch = { title: string; cause: string; event: string; leadsTo: string };
export type BlockResult = { type: BlockType; analysis: string; branches: BlockBranch[]; emotion: string; approaches: { title: string; entry: string }[]; placeholder: string; minimalTask: string };

export function normalizeBlockCard(value: unknown): BlockCard {
  const card = asRecord(value);
  return { type: BLOCK_TYPES.includes(card.type as BlockType) ? card.type as BlockType : null, facts: stringValue(card.facts), want: stringValue(card.want), emotion: stringValue(card.emotion), note: stringValue(card.note) };
}

export function blockCardText(card: BlockCard): string {
  return [`卡点类型：${card.type ? BLOCK_TYPE_LABELS[card.type] : "不确定"}`, `已经成立的事实与承诺：${card.facts || "（未填）"}`, `人物现在最想做什么：${card.want || "（未填）"}`, `这一段想传达的情绪：${card.emotion || "（未填）"}`, card.note ? `补充：${card.note}` : ""].filter(Boolean).join("\n");
}

export type BlockRequest = { project: WriterProject; memory: MemoryView | null; story: StoryPlan | null; position: number; card: BlockCard; focus: string; signal?: AbortSignal };

/** Material the "no plot" branches can grow from: recent gains, open threads, characters who have been away. */
function branchMaterial(memory: MemoryView | null, position: number): string {
  if (!memory || memory.isEmpty) return "";
  const gains = [];
  for (let index = Math.max(0, position - 5); index < position; index += 1) {
    const card = memory.cardAt(index);
    for (const payoff of card?.payoffs ?? []) gains.push(`${chapterLabel(index)} ${payoff.type}：${payoff.description}`);
  }
  const threads = relevantThreads(memory, position, [], 8).map((thread) => `${thread.title}（${thread.plantedAt >= 0 ? chapterLabel(thread.plantedAt) : "?"}起）`);
  const dormant = memory.entities.filter((entity) => entity.category === "character").map((entity) => {
    const chapters = memory.chaptersOf(entity.id).map((id) => memory.position(id)).filter((at) => at >= 0 && at < position);
    return { entity, count: chapters.length, last: chapters.length ? Math.max(...chapters) : -1 };
  }).filter((item) => item.count >= 5 && position - item.last >= 20).sort((left, right) => right.count - left.count).slice(0, 6).map((item) => `${item.entity.name}（出场 ${item.count} 章，上次${chapterLabel(item.last)}）`);
  return [gains.length ? `最近的收获：${gains.join("；")}` : "", threads.length ? `没回收的线索：${threads.join("；")}` : "", dormant.length ? `很久没出场的人物：${dormant.join("；")}` : ""].filter(Boolean).join("\n");
}

export async function diagnoseBlock({ project, memory, story, position, card, focus, signal }: BlockRequest): Promise<BlockResult> {
  const task = domainTask<BlockResult>("diagnoseBlock", [{ project, memory, story, position, card, focus }], project.id, signal); if (task) return task;
  const context = await prepareWritingContext({ project, memory, position, focus, scope: "chapter", budget: Math.min(30_000, project.settings.contextBudgetChars), story });
  const material = branchMaterial(memory, position);
  return invokeJson({
    task: "review",
    system: withGoal(project, "block.system"),
    prompt: [
      context.text,
      material ? `【可以用来长出新剧情的素材】\n${material}` : "",
      `【卡文卡】\n${blockCardText(card)}`,
      focus.trim() ? `【卡住的地方】\n${previewText(focus, 3_000)}` : "",
      `【任务】先判断作者卡在哪一类；作者已选的类型明显不符时，先说明理由再改判。analysis 用一两句先说卡在哪、为什么。只填写这一类用得上的字段，其余字符串填空、数组填 []：
- plot（没剧情）：从前面的收获和后患、能力的代价、没兑现的期待、旧人和对手的打算里，给出 3 条不同走向（branches）。每条说清谁因为什么做了什么、读者拿到什么、以后要付什么代价，不用最顺手的套路。
- entry（缺切口）：先说这一段想让读者感到什么（emotion），再给 3 个可以直接开写的开场（approaches），例如一笔付不起的账、配角反常的动作、人物试探对方的一句话。
- expression（写不出）：给出“【待补：……】”（placeholder），写清这里要发生什么、局面怎么变、读者该感到什么；analysis 再给一句能接在占位后面的正文，让作者先往下写。
- energy（没心力）：挑出当前剧情里作者最想写的一小段，给一个 10 分钟内能写完、约 150 字的小任务（minimalTask）。
用平常的话说，保留前文事实和人物此刻知道的事，作者看完就能动笔。
输出 JSON：{"type":"plot|entry|expression|energy","analysis":"卡在哪、为什么（一两句）","branches":[{"title":"","cause":"什么前情引出了这件事","event":"谁做了什么、事情怎样转折","leadsTo":"读者接下来盼什么、人物要付什么代价"}],"emotion":"想让读者感到什么","approaches":[{"title":"开场办法","entry":"从哪个动作、东西或对话开始写"}],"placeholder":"【待补：这里要发生的事、转折和结果】","minimalTask":"十分钟内能写完的约 150 字小任务"}`,
    ].filter(Boolean).join("\n\n"),
    effort: "medium", temperature: 0.8,
    maxOutputTokens: 4_000,
    signal,
  }, (value) => {
    const record = asRecord(value);
    const type = BLOCK_TYPES.includes(record.type as BlockType) ? record.type as BlockType : card.type ?? "plot";
    return {
      type,
      analysis: stringValue(record.analysis),
      branches: arrayValue(record.branches).map((item) => { const branch = asRecord(item); return { title: stringValue(branch.title), cause: stringValue(branch.cause), event: stringValue(branch.event), leadsTo: stringValue(branch.leadsTo) }; }).filter((branch) => branch.title || branch.event).slice(0, 5),
      emotion: stringValue(record.emotion),
      approaches: arrayValue(record.approaches).map((item) => { const approach = asRecord(item); return { title: stringValue(approach.title), entry: stringValue(approach.entry) }; }).filter((approach) => approach.title).slice(0, 5),
      placeholder: stringValue(record.placeholder),
      minimalTask: stringValue(record.minimalTask),
    };
  });
}

/** Placeholders left while drafting; they must be filled before export. */
export const PLACEHOLDER_PATTERN = /【待补[:：][^】]*】/g;
export function placeholderText(intent: string) { return `【待补：${intent.trim() || "这里要写的内容"}】`; }
