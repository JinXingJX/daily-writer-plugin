// Chapter planning for the publish pipeline's "next chapter plan" step and the assistant's planChapter tool: the plan
// comes from one model call against the assembled context, then goes through the plan normalizer and lint.
import { asRecord } from "../../domain/util";
import { lintPlan, type PlanWarning } from "../../story/planLint";
import { invokeJson } from "../client";
import { resolvePrompt } from "../promptRegistry";
import { withGoal } from "../prompts";
import { normalizePlan, type ChapterPlan, type GenerationSession } from "./nextChapter";

export const PLAN_SCHEMA = `{
  "title": "章节标题（贴合本章的事，不剧透结局）",
  "core": "读者读完最记得的那一下：最过瘾、最揪心或最恍然大悟的那件事",
  "reward": "本章给读者的兑现：主角得到/赢下/看穿/扳回了什么，谁看见、什么反应；有意压着不给时，写清压的是什么、哪一章给",
  "logic": "台面下推演（写给执笔者，不进正文）：排除了哪个第一反应的套路；各方此刻想要什么、知道什么、在做什么，牵动哪些规则",
  "kernel": "取材内核：从什么现实博弈、荒诞或两难里取的内核，事件怎么换成本作的；没有就留空",
  "summary": "全章梗概：按顺序说清发生了哪些事",
  "promiseAlignment": "direct|support|off",
  "promiseNote": "这一章怎样兑现或铺垫全书核心承诺",
  "threads": { "advance": ["推进的线索 id 或标题"], "plant": ["新埋的伏笔或接棒的新期待"], "payoff": ["本章兑现的线索 id 或标题"] },
  "skim": ["正文一两句带过、不展开的内容：过场、赶路、推理过程、设定解释、日常"],
  "hook": "章末断在哪：行动半途、真相揭开一半、新危机露头或抉择落子前的具体画面或台词",
  "scenes": [{
    "title": "场景名", "cause": "紧接上文的触发因",
    "goal": "视角人物本场要拿下什么（不能写成‘推进剧情/铺垫气氛’）", "stakes": "失手的代价或成功的收益", "deadline": "时间窗口及原因，没有就留空",
    "obstacles": ["会变招的阻碍"],
    "events": ["本场按顺序发生的、读者能复述的事"],
    "choice": "人物在代价和限制下的关键抉择", "turn": "意料之外、情理之中的转折", "outcome": "场末局面停在哪",
    "changes": ["info|relation|resource|risk|judgment"],
    "readerKnows": "读者知道而视角人物不知道的事", "characterUnknown": "视角人物此刻的盲区",
    "emotion": { "from": "开场情绪", "to": "收场情绪" }, "focal": "群戏或对手戏的焦点人物",
    "characters": ["出场人物"], "location": "地点", "words": 1000
  }]
}`;

export type PlanRequest = {
  session: GenerationSession;
  /** What the author (or the briefing) wants from this chapter; may be empty. */
  direction: string;
  targetWords: number;
  signal?: AbortSignal;
};

export type PlannedChapter = { plan: ChapterPlan; warnings: PlanWarning[] };

export async function planChapter({ session, direction, targetWords, signal }: PlanRequest): Promise<PlannedChapter> {
  const { project } = session;
  const plan = await invokeJson({
    task: "review",
    system: withGoal(project, "writer.role"),
    prompt: [
      session.context.text,
      direction.trim()
        ? `【这一章的方向】\n${direction.trim()}`
        : "【这一章的方向】作者没有指定。从上一章的钩子、核心承诺、本卷的门槛和读者正在等的事出发，推演出最抓人、最合逻辑的这一章。",
      `【任务】${resolvePrompt(project, "task.plan", { chapter: "下一章" })}\n全章约 ${targetWords} 字，各场 words 之和接近它。`,
      `【输出 JSON】只输出一个 JSON 对象：\n${PLAN_SCHEMA}`,
    ].join("\n\n"),
    effort: "high", temperature: 0.6,
    maxOutputTokens: 8_000,
    signal,
  }, (value) => normalizePlan(asRecord(value), targetWords));
  return { plan, warnings: lintPlan(plan, { story: session.story, memory: session.memory, position: session.position }) };
}
