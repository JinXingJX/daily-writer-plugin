/** Independent engineering adaptation of Lieflat's v2 method; not its detector or a provenance classifier. */
export const TONE_SOURCE = "https://github.com/larashero3-dotcom/lieflat-less-ai-tone";
export const TONE_VERSION = 1;
export type Grade = "A" | "B" | "C" | "F";
export const RULES = {
  reversal: { title: "预设误解再翻案", grade: "B", labels: ["虚设对立", "真实辨析", "无法判断"], positive: ["虚设对立"], criterion: "仅当反面是作者虚设的误解才算命中；事实对比、反驳已出现的观点和人物对白保留。", evidence: "原研究两轮同向；固定词形仅供候选筛选。" },
  opener: { title: "宣告式起手", grade: "A", labels: ["空提示", "承担信息", "无法判断"], positive: ["空提示"], criterion: "说白了、说穿了、先说结论仅在删除不损失信息且不是人物口吻时命中。", evidence: "原研究的局部句式信号；不能当作禁用词。" },
  enumeration: { title: "句内密集罗列", grade: "B", labels: ["机械罗列", "必要列举", "无法判断"], positive: ["机械罗列"], criterion: "至少三个顿号是粗筛；有区分意义的事实列举保留，不得删掉其中的事实。", evidence: "原研究保留的候选类型；顿号次数本身不证明问题。" },
  fingerprint: { title: "标点指纹", grade: "F", labels: ["可安全替换", "有具体作用", "无法判断"], positive: ["可安全替换"], criterion: "破折号或分号仅在可无损替换时建议；中断、插话、并列层次及作者惯用标点保留并解释作用。", evidence: "模型间差异较大；不推断来源，不追求密度归零。" },
  rename: { title: "同义重命名", grade: "B", labels: ["0组", "1组", "2组", "3组及以上", "无法判断"], positive: ["2组", "3组及以上"], criterion: "同一对象换实义名称的连接次数；代词、省略、不同实体不算。风格参考有意的称谓变化保留。", evidence: "原研究的语义判据；单一判读模型，稳健性较弱。" },
  transition: { title: "段间衔接", grade: "C", labels: ["明确承接", "关系不成立", "有关但突兀", "主题跳转", "无法判断"], positive: ["关系不成立"], criterion: "独立判断前段末句和后段首句的关系。连续承接只报告，不为制造跳跃而改结构。", evidence: "统计最长连续承接接口数；不能把自然衔接当作错误。" },
  colon: { title: "冒号用途", grade: "B", labels: ["引语", "版式", "定义解释", "列举提示", "结论提示", "其他", "无法判断"], positive: ["结论提示"], criterion: "按引语、版式、定义解释、列举提示、结论提示、其他的顺序分类；只有宣告独立结论再展开的结论提示可建议改。", evidence: "原研究仅结论提示类同向；冒号总量不是有效判断。" },
  triplet: { title: "连续三句同构", grade: "F", labels: ["高度同构", "部分同构", "仅词语重复", "仅语义并列", "无同构", "无法判断"], positive: ["高度同构"], criterion: "连续三句主谓宾与补充成分位置几乎逐项对应才算高度同构；普通排比和文学节奏保留。", evidence: "原研究狭义同构有区分；这里穷举三句组交模型复核，口径不等同原脚本。" },
} as const;
export type RuleId = keyof typeof RULES;
export const PROTECTION = "只处理确认的问题。事实、人物、数字、日期、因果、否定和可能性强度保持。标题、段落、列表、表格、代码、引文和对白不改；未命中文字逐字保留。序数词小标题、这意味着、列表引导、概括替代不作为问题。比喻、暗喻、拟人贴切度交作者判断，默认保留。不为长短句参差、标点密度或所谓 AI 率而改稿。作者的文风指南和样章优先。";
