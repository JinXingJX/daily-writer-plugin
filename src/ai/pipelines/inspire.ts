import { domainTask } from "../../worker/domainTask";
// Inspiration burst: a batch of distinct ideas for any module of the work. Each idea is thought through a different
// "lens" so the batch spreads out instead of circling the first cliché the model reaches for.
import { chapterLabel, orderedChapters } from "../../domain/documents";
import { uniqueId } from "../../domain/ids";
import { arrayValue, asRecord, previewText, stringValue } from "../../domain/util";
import type { MemoryView } from "../../memory/view";
import type { ChapterTexts, WriterProject } from "../../types";
import { invokeJson } from "../client";
import { inspireLenses, type Lens } from "../promptRegistry";
import { withGoal } from "../prompts";
import { prepareWritingContext } from "../contextPrep";

export type InspireTarget =
  | "worldview" | "background" | "outline" | "style"
  | "chapter" | "selection" | "chapterDirection" | "scene" | "chapterTitle"
  | "character" | "faction" | "storyNode" | "relation" | "thread"
  | "premise";

export type Idea = { id: string; title: string; content: string; lens: string };
export type InspireMode = "fresh" | "expand" | "blend";

type TargetInfo = { label: string; task: string; context: "writing" | "local" | "settings" | "none"; length: string };

export const INSPIRE_TARGETS: Record<InspireTarget, TargetInfo> = {
  worldview: { label: "世界观", task: "按“下层生存账本与器物—中层组织序列与利益规矩—上层历史断层与终极隐秘”三层结构，为世界观补充或改造设定：一条硬规则、一项代价/限制、一桩历史旧案、一个特殊场所或一种底层职业习俗。每条必须写清它如何传导到人物头顶并引发具体冲突。", context: "settings", length: "80-200字" },
  background: { label: "背景设定", task: "为故事开篇前的背景提出有咬合力的方案：主角带着什么切身生存困境、欠债/旧伤或信息残片入局，与哪股势力或制度规训形成天然死结。", context: "settings", length: "80-200字" },
  outline: { label: "大纲", task: "为全书或当前卷设计兼顾【核心承诺兑现、受限金手指博弈、期待接棒与不可逆换地图门槛】的走向方案：主明线与暗线如何交汇、在哪里借规则漏洞或底牌反转、高潮如何干脆爆开并留出新期待。", context: "settings", length: "100-250字" },
  style: { label: "文风", task: "按“叙事声音生长于世界质地”原则，为本作提出不同文风方案：明确视角焦距、句式长短呼吸、动词与量词质感、交互式布景取舍与去冗余对白方式；说明它为何配这个世界，并附两句示范正文。", context: "settings", length: "80-200字" },
  chapter: { label: "本章接下来", task: "推演当前这一章接下来的场次走向：视角人物带着什么具体算计切入、遭遇什么主动变招的阻碍、借哪件器物或信息差破局、让局面发生什么不可逆位移。", context: "writing", length: "60-160字" },
  selection: { label: "这段文字", task: "围绕【当前内容】给出更具画面感与张力的改写思路：换一个动态镜头切口、换一件穿过人物动作与算计的交互器物、或把直白心理/旁白改为潜台词对白与生理反应，并附一两句示范。", context: "local", length: "60-160字" },
  chapterDirection: { label: "下一章走向", task: "承接上一章结尾钩子推演下一章走向：排除第一反应俗套，说明如何推进主线或兑现期待、利用什么规则限制或信息差制造拉扯，以及章末停在什么新钩子上。", context: "writing", length: "80-150字" },
  scene: { label: "这场戏", task: "重构【当前内容】这场戏的博弈与转折：明确谁在什么倒计时/代价下挡着视角人物、对手如何变招、主角如何借规则或底牌拐弯让局势位移。content 固定写成两行：“冲突：……”换行“转折：……”。", context: "writing", length: "60-150字" },
  chapterTitle: { label: "章节标题", task: "为这一章起一个有质感、贴合核心意象或博弈切口的标题。title 写标题本身，content 用一句话说明标题取自本章哪个器物、规矩或动作瞬间。严禁四字成语堆砌，严禁剧透底牌结局。", context: "writing", length: "20-40字" },
  character: { label: "人物", task: "按“共情支点 + 极简记忆标签 + 外在面具/内在真核反差 + 独立利益时间表”设计新人物或改造已有人物：写清其身份、明面所求、隐秘软肋、与主角的账目/利益纠葛及进场后制造的麻烦。", context: "settings", length: "80-200字" },
  faction: { label: "势力", task: "设计有真实利益逻辑的势力：写清其明面教义/规矩、底层运作账本、内部派系倾轧、掌握的垄断资源/序列途径，以及它与主角和既有势力的结构性矛盾。", context: "settings", length: "80-200字" },
  storyNode: { label: "剧情节点", task: "推演【当前内容】这个剧情节点之后的连锁反应：战利品与隐患如何兑现、哪方势力会按自身时间表介入、如何引出意料之外情理之中的反转与新期待。", context: "settings", length: "60-160字" },
  relation: { label: "人物关系", task: "按“社会名分与内心亲疏双轨制”设计人物关系碰撞：欠债、把柄、师徒算计、认知错位或利益共谋，写清是谁与谁、表面什么名分、暗里各打什么算盘，以及在哪场戏里引爆。", context: "settings", length: "60-160字" },
  thread: { label: "伏笔", task: "为【当前内容】这条伏笔/期待设计“一物多用”的推进或回收方案：在哪一章、借哪件日常器物或哪个人物之手引爆、如何同时推动明暗双线，并让读者回看时恍然大悟。", context: "writing", length: "60-160字" },
  premise: { label: "作品点子", task: "提出具备现象级潜力的长篇核心卖点（对标《诡秘之主》《凡人修仙传》《没钱修什么仙？》）：写出最具反差或制度张力的世界核心设定、受限金手指与代价、主角的切身处境与欲求，以及读者会持续追更的核心爽感循环。", context: "none", length: "80-180字" },
};

export type InspireRequest = {
  project: WriterProject;
  memory: MemoryView | null;
  texts?: ChapterTexts;
  target: InspireTarget;
  /** What the author is looking at: selected text, the scene, the story node, the thread... */
  focus?: string;
  /** The author's own direction. */
  seed?: string;
  /** Titles already shown; the new batch must not repeat them. */
  avoid?: string[];
  mode?: InspireMode;
  /** Ideas to expand (one) or blend (several). */
  base?: Idea[];
  /** Reading position for chapter-level targets; defaults to the end of the book. */
  position?: number;
  count?: number;
  signal?: AbortSignal;
};

export async function inspire(request: InspireRequest): Promise<Idea[]> {
  const task = domainTask<Idea[]>("inspire", [request], request.project.id, request.signal); if (task) return task;
  const { project } = request;
  const info = INSPIRE_TARGETS[request.target];
  const count = Math.max(1, Math.min(10, request.count ?? 6));
  const lenses = pickLenses(inspireLenses(project), count);
  const context = await gatherContext(request, info);
  const mode = request.mode ?? "fresh";
  const base = request.base ?? [];
  const modeText = mode === "expand" && base[0]
    ? `沿着下面这条点子继续往深处或岔路上想，给出 ${count} 条变体，每条都要比原来更具体：\n${ideaText(base[0])}`
    : mode === "blend" && base.length > 1
      ? `把下面几条点子揉在一起，给出 ${count} 条新的点子，每条都要同时用上它们各自的长处，而不是简单拼接：\n${base.map(ideaText).join("\n")}`
      : `给出 ${count} 条点子。`;
  const prompt = [
    context,
    `【灵感对象】${info.label}`,
    request.focus?.trim() ? `【当前内容】\n${previewText(request.focus.trim(), 3_000)}` : "",
    request.seed?.trim() ? `【作者给的方向】${request.seed.trim()}` : "",
    request.avoid?.length ? `【已经出现过的点子，不要重复或换说法重复】${request.avoid.slice(-40).join("；")}` : "",
    `【镜头分配】第 i 条点子用第 i 个镜头去想：\n${lenses.map((lens, index) => `${index + 1}. ${lens.name}${lens.description ? `：${lens.description}` : ""}`).join("\n")}`,
    `【任务】${info.task}\n${modeText}每条 content ${info.length}。`,
    `输出 JSON：{"ideas":[{"lens":"所用镜头名","title":"12 字以内","content":"点子正文"}]}`,
  ].filter(Boolean).join("\n\n");
  return invokeJson({
    task: "ideas",
    system: inspireSystem(project),
    prompt,
    effort: "medium", temperature: 1,
    maxOutputTokens: Math.min(8_000, 600 + count * 500),
    signal: request.signal,
  }, (value) => {
    const ideas = arrayValue(asRecord(value).ideas).map((item, index) => {
      const record = asRecord(item);
      return { id: uniqueId("idea"), title: stringValue(record.title).trim(), content: stringValue(record.content).trim(), lens: stringValue(record.lens).trim() || lenses[index]?.name || "" };
    }).filter((idea) => idea.title || idea.content);
    if (!ideas.length) throw new Error("模型没有给出点子。");
    return ideas.slice(0, count);
  });
}

function inspireSystem(project: WriterProject) {
  return `${withGoal(project, "inspire.system")}\n\n只输出要求的 JSON。`;
}

/** A random rotation of the lens list, so consecutive batches lean on different lenses. */
export function pickLenses(lenses: Lens[], count: number, random = Math.random): Lens[] {
  const offset = Math.floor(random() * lenses.length);
  return Array.from({ length: count }, (_, index) => lenses[(offset + index) % lenses.length]);
}

function ideaText(idea: Idea) { return `- ${idea.title}：${idea.content}`; }

async function gatherContext(request: InspireRequest, info: TargetInfo): Promise<string> {
  const { project } = request;
  const header = `【作品】《${project.title}》｜类型：${project.genre}｜读者：${project.audience}`;
  if (info.context === "none") return header;
  if (info.context === "settings") return `${header}\n\n${settingsContext(project)}`;
  const position = request.position ?? orderedChapters(project).length;
  const context = await prepareWritingContext({ project, memory: request.memory, position, focus: `${request.seed ?? ""}\n${request.focus ?? ""}`, texts: request.texts, scope: info.context === "local" ? "local" : "chapter", budget: Math.min(24_000, project.settings.contextBudgetChars) });
  return `${context.text}\n\n【位置】${chapterLabel(position)}`;
}

export function settingsContext(project: WriterProject) {
  const block = (title: string, text: string, limit: number) => (text.trim() ? `【${title}】\n${previewText(text.trim(), limit)}` : "");
  return [
    block("大纲", project.outline, 5_000),
    block("世界观", project.worldview, 5_000),
    block("背景", project.background, 2_500),
    block("文风指南", project.styleGuide, 1_500),
    project.characters.length ? `【人物】\n${project.characters.slice(0, 60).map((character) => `- ${character.name}${character.role ? `（${character.role}）` : ""}：${previewText(character.summary, 80)}`).join("\n")}` : "",
    project.factions.length ? `【势力】\n${project.factions.slice(0, 30).map((faction) => `- ${faction.name}：${previewText(faction.summary, 80)}`).join("\n")}` : "",
    project.storyNodes.length ? `【剧情节点】${project.storyNodes.slice(0, 80).map((node) => node.title).join("、")}` : "",
  ].filter(Boolean).join("\n\n") || "（作品还没有设定，可以大胆提出）";
}
