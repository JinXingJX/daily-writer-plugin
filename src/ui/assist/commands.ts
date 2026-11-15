import { NEXT_CHAPTER_INSTRUCTION } from "../../ai/promptDefaults";
import type { Mode } from "./Composer";

export type AssistCommand = { label: string; hint: string; instruction: string; mode?: Mode; needsChapter?: boolean };

/** `/` commands. They prepare the composer; the author sends the instruction after editing it. */
export const ASSIST_COMMANDS: AssistCommand[] = [
  { label: "写下一章", hint: "商量写法、定计划、逐场写", instruction: NEXT_CHAPTER_INSTRUCTION, needsChapter: true },
  { label: "审读本章", hint: "用批注标出问题，不动正文", instruction: "以责任编辑的身份审读当前章节：找出逻辑漏洞、与前文或设定矛盾、节奏拖沓、人物动机不足之处，用批注标出，不要直接改正文。最后总结 3 条最重要的修改建议。", needsChapter: true },
  { label: "故事体检", hint: "挑三个最要紧的结构问题", instruction: "用 diagnoseStory 给这部作品做一次故事体检，再结合 readStoryPlan 和最近几章，挑出最要紧的三个结构问题（期待空档、没人接棒的期待、沉寂的伏笔、重复的爽点、积压太久的情绪……），每个给出具体到人物和章节的补法。需要改故事规划或线索的，用 updateStoryPlan / updateThread 提议。" },
  { label: "卡文了", hint: "先问清卡在哪", instruction: "我卡文了。先看看前文，问清我卡在哪，再给我能马上动手的办法。" },
  { label: "聊聊写法", hint: "接下来最值得下功夫的地方", instruction: "结合这部作品已经写出来的内容和故事规划，和我聊聊接下来最值得下功夫的一两个地方，说具体到人物和章节，给几种做法让我选。" },
  { label: "问全书", hint: "答案带章节出处", instruction: "", mode: "qa" },
  { label: "整理设定稿", hint: "把长文拆进设定库", instruction: "", mode: "organize" },
  { label: "梳理故事规划", hint: "核心承诺、暗线、卷终点", instruction: "根据已有的大纲、设定和已写章节，帮我梳理这部作品的故事规划：一句话核心承诺和开篇五要素、金手指的规则与限制、主要暗线的真相和知情范围、当前卷的终点与主角跨过去的理由。先 readStoryPlan 看现状，缺的部分用 updateStoryPlan 提议，拿不准的地方用 askUser 问我。" },
  { label: "检查设定一致性", hint: "对照记忆标出矛盾", instruction: "对照故事记忆（人物状态、事实、伏笔）检查当前章节是否与前文矛盾，用批注标出问题并说明依据章节。", needsChapter: true },
  { label: "提取新设定", hint: "新人物、新势力进设定库", instruction: "从当前章节中找出新出现的重要人物、势力，补充到设定库（applyPatchOperations），已有的只补充新信息。", needsChapter: true },
  { label: "未回收的线索", hint: "按紧迫程度排序", instruction: "列出目前所有尚未兑现的伏笔、期待与悬念，按紧迫程度排序，给出在接下来几章兑现的建议；快兑现的期待要说清由谁接棒。建议的计划用 updateThread 提议。" },
];

/** A couple of starting points for an empty conversation; the rest live behind `/`. */
export function starterCommands(inChapter: boolean): AssistCommand[] {
  const labels = inChapter ? ["写下一章", "审读本章", "聊聊写法"] : ["聊聊写法", "故事体检", "未回收的线索"];
  return labels.flatMap((label) => ASSIST_COMMANDS.find((command) => command.label === label) ?? []);
}
