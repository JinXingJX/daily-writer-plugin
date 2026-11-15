// Registry of the prompts a work can override. Each work stores overrides by key; missing keys use the built-in text.
import type { QuickActionConfig, WriterProject } from "../types";
import * as D from "./promptDefaults";

export type BasePromptKey =
  | "writer.role" | "writer.goal"
  | "task.plan" | "task.scene" | "task.continue" | "task.rewrite" | "task.revise" | "task.summary" | "task.batch"
  | "agent.system"
  | "editor.system" | "task.review" | "checklist.system"
  | "architect.system" | "story.update" | "block.system"
  | "inspire.system" | "inspire.lenses"
  | "qa.system"
  | "notes.system" | "reader.system" | "reader.panel" | "reader.digest";
export type PromptKey = BasePromptKey;

export type PromptGroup = "写作" | "生成任务" | "写作助手" | "审稿" | "设定整理" | "灵感涌现" | "问答" | "作家笔记";
export type PromptDef = { key: PromptKey; group: PromptGroup; label: string; description: string; vars: string[]; defaultText: string };

const WORK_VARS = ["title", "genre", "language", "audience"];

export const PROMPT_DEFS: PromptDef[] = [
  { key: "writer.role", group: "写作", label: "执笔者身份", description: "所有写正文、改正文调用的 system prompt；后面自动拼接创作目标和作品样章。", vars: WORK_VARS, defaultText: D.WRITER_ROLE },
  { key: "writer.goal", group: "写作", label: "创作目标", description: "这本书要写成什么样：事让人想追，话让人一遍读懂；减少读者理解的费劲，不为少字而省掉主语、因果和必要的提醒。设定和样章只作参考。写正文、定章纲、审稿、整理设定、灵感、卡文诊断、作家笔记和写作助手都以它为准。", vars: WORK_VARS, defaultText: D.WRITING_GOAL },
  { key: "task.plan", group: "生成任务", label: "章节计划", description: "定章纲：这一章发生哪些事、给读者什么兑现、哪些一笔带过、章末断在哪。写作助手的 planChapter 和下一章流水线都用它。", vars: ["chapter", ...WORK_VARS], defaultText: D.TASK_PLAN },
  { key: "task.scene", group: "生成任务", label: "按计划写正文", description: "按章纲连写多场，篇幅跟着事走。{{scenes}} 为场景范围，{{position}} 为首尾衔接与断钩指令。", vars: ["scenes", "words", "position", ...WORK_VARS], defaultText: D.TASK_SCENE },
  { key: "task.continue", group: "生成任务", label: "AI 续写", description: "编辑器 ⌘J 光标处续写：接着上文的动作或话头往下写，让事情、消息或关系往前走一步。", vars: ["length", "hint", ...WORK_VARS], defaultText: D.TASK_CONTINUE },
  { key: "task.rewrite", group: "生成任务", label: "选区改写", description: "按要求改写选中的文字，保留事实、因果和人物所知，让读者一遍跟得上；多个版本要有不同写法。", vars: ["instruction", "count", ...WORK_VARS], defaultText: D.TASK_REWRITE },
  { key: "task.revise", group: "生成任务", label: "按审稿意见修订", description: "只改审稿指到的地方，保留作者原声；该删的段落整段删掉。", vars: ["problem", "suggestion", ...WORK_VARS], defaultText: D.TASK_REVISE },
  { key: "task.summary", group: "生成任务", label: "章节摘要", description: "按顺序说清谁做了什么、遇到什么、得失如何、局面怎样改变、结尾停在哪，保留关键人名和线索。", vars: ["chapterTitle", ...WORK_VARS], defaultText: D.TASK_SUMMARY },
  { key: "task.batch", group: "生成任务", label: "批量修改", description: "按同一要求检查多章，逐字引用要改的原文并给出替换文本，无关段落不改。", vars: WORK_VARS, defaultText: D.TASK_BATCH },
  { key: "agent.system", group: "写作助手", label: "写作助手", description: "右侧写作助手的身份和工具说明；回复先说结果再说理由，什么时候查章纲、审稿和方法卡由它判断。", vars: WORK_VARS, defaultText: D.AGENT_SYSTEM },
  { key: "editor.system", group: "审稿", label: "责任编辑身份", description: "责任编辑替读者检查：事够不够、逻辑通不通、能不能一遍读懂，以及照搬设定或样章、AI 套话等问题。", vars: WORK_VARS, defaultText: D.EDITOR_SYSTEM },
  { key: "task.review", group: "审稿", label: "审稿任务", description: "草稿审读清单：追读、连续性、人物知道得太多、逻辑、世界观、偏离计划、读得懂（clarity）和文风。自动检测只作提示，由编辑判断是否真有问题。", vars: WORK_VARS, defaultText: D.TASK_REVIEW },
  { key: "checklist.system", group: "审稿", label: "检查表审读", description: "对照作者选的检查项核对本章，包括读者能否一遍跟上；给出原文依据和能动手的改法。", vars: WORK_VARS, defaultText: D.CHECKLIST_SYSTEM },
  { key: "architect.system", group: "设定整理", label: "总策划身份", description: "帮作者整理卖点、世界规矩、各卷走向、人物打算和关系，用平常的话说清它们怎样影响故事。", vars: WORK_VARS, defaultText: D.ARCHITECT_SYSTEM },
  { key: "story.update", group: "设定整理", label: "发布后的设定更新", description: "章节发布后只记录新增或变化的线索、人物、关系和世界规矩，分清几章内、本卷和全书的线索。", vars: WORK_VARS, defaultText: D.STORY_UPDATE_SYSTEM },
  { key: "block.system", group: "写作助手", label: "卡文诊断", description: "先分清是没剧情、不知怎么开场、某段写不出，还是没精力，再给能直接开写的走向、开场、占位或小任务。", vars: WORK_VARS, defaultText: D.BLOCK_SYSTEM },
  { key: "inspire.system", group: "灵感涌现", label: "灵感伙伴身份", description: "从本书已有的规矩、能力代价、人物打算、生计和各人所知的差别里想新点子。", vars: WORK_VARS, defaultText: D.INSPIRE_SYSTEM },
  { key: "inspire.lenses", group: "灵感涌现", label: "视角镜头", description: "每行一个想点子的角度（“名称：说明”），例如规则漏洞、胜利的代价、旧物新用或对手主动行动。", vars: [], defaultText: D.INSPIRE_LENSES },
  { key: "qa.system", group: "问答", label: "资料管理员身份", description: "回答设定和剧情问题，先给答案再给章节依据；分清正文事实、作者计划和推测。", vars: WORK_VARS, defaultText: D.QA_SYSTEM },
  { key: "notes.system", group: "作家笔记", label: "笔记编辑身份", description: "整理写到哪里、卖点有没有跑偏、期待和伏笔有没有接上，再给下一步最该做的事。", vars: WORK_VARS, defaultText: D.NOTES_SYSTEM },
  { key: "reader.system", group: "作家笔记", label: "模拟读者身份", description: "读者小组每位成员共用的身份：只读到当前章的真实追更读者，不欠作者耐心，像段评一样说反应并用两三句复述发生了什么。不附加创作目标；模型模拟不等同真人理解测试。", vars: WORK_VARS, defaultText: D.READER_SYSTEM },
  { key: "reader.panel", group: "作家笔记", label: "读者小组", description: "每行一位读者（“名称：画像”，写口味、阅读习惯和雷点），最多 8 位。每位读者单独读一遍本章正文，行数就是每次试读的模型调用数（另加一次汇总）。", vars: WORK_VARS, defaultText: D.READER_PANEL },
  { key: "reader.digest", group: "作家笔记", label: "读者反馈汇总", description: "编辑对照本章正文、作者计划和读者复述，核对事实、动机和因果；分清有意的悬念与写不清楚，给出可执行的修改。", vars: WORK_VARS, defaultText: D.READER_DIGEST_SYSTEM },
];

const DEFS = new Map(PROMPT_DEFS.map((def) => [def.key, def]));

export function isPromptKey(key: string): key is PromptKey { return DEFS.has(key as PromptKey); }

export function promptDef(key: PromptKey): PromptDef {
  const def = DEFS.get(key);
  if (!def) throw new Error(`Unknown prompt ${key}`);
  return def;
}

export function isCustomized(project: WriterProject, key: PromptKey) { return Boolean(project.prompts.overrides[key]?.trim()); }

/** Replaces {{name}} placeholders; unknown placeholders are left as is so authors can see them. */
export function renderVars(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export function workVars(project: WriterProject): Record<string, string> {
  return { title: project.title, genre: project.genre, language: project.language || "中文", audience: project.audience };
}

/** The work's override, or the built-in text, with placeholders filled. */
export function resolvePrompt(project: WriterProject, key: PromptKey, vars: Record<string, string | number> = {}): string {
  const text = project.prompts.overrides[key]?.trim() ? project.prompts.overrides[key] : promptDef(key).defaultText;
  return renderVars(text, { ...workVars(project), ...vars }).trim();
}

export function quickActionsFor(project: WriterProject): QuickActionConfig[] {
  return project.prompts.quickActions?.length ? project.prompts.quickActions : D.DEFAULT_QUICK_ACTIONS;
}

export type Lens = { name: string; description: string };

/** One "名称：说明" entry per non-empty line. */
function namedLines(text: string): Lens[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name, ...rest] = line.split(/[:：]/);
    return { name: name.trim(), description: rest.join("：").trim() };
  });
}

export function inspireLenses(project: WriterProject): Lens[] {
  const lenses = namedLines(resolvePrompt(project, "inspire.lenses"));
  return lenses.length ? lenses : [{ name: "自由发挥", description: "" }];
}

export const MAX_READERS = 8;

/** The simulated readers who try each chapter; each one is a model call of its own. */
export function readerPanel(project: WriterProject): Lens[] {
  const readers = namedLines(resolvePrompt(project, "reader.panel")).filter((reader) => reader.name).slice(0, MAX_READERS);
  return readers.length ? readers : [{ name: "读者", description: "普通的追更读者" }];
}
