import { stripImageMarkup } from "../images/schema";
import type { WriterChapterMeta, WriterCharacter, WriterProject } from "../types";

const STATUS_LABELS: Record<string, string> = { draft: "草稿", writing: "写作中", review: "修订", final: "定稿" };
export function chapterStatusLabel(status: string) { return STATUS_LABELS[status] ?? "草稿"; }

function names(project: WriterProject) {
  const characters = new Map(project.characters.map((item) => [item.id, item.name]));
  const nodes = new Map(project.storyNodes.map((item) => [item.id, item.title]));
  return { character: (id: string | null) => (id ? characters.get(id) ?? id : ""), node: (id: string | null) => (id ? nodes.get(id) ?? id : "") };
}

export function storyMapMarkdown(project: WriterProject) {
  const name = names(project);
  const nodes = project.storyNodes.map((node) => `## ${node.title}\n\n- 类型：${node.kind}\n- 时间：${[node.startsAt, node.endsAt].filter(Boolean).join(" → ")}\n- 人物：${node.characterIds.map(name.character).join("、")}\n\n${node.summary}`).join("\n\n");
  const edges = project.storyEdges.map((edge) => `- ${name.node(edge.source)} → ${name.node(edge.target)}（${edge.relation}）${edge.label}`).join("\n");
  return `# 故事线\n\n${nodes}\n\n# 关联\n\n${edges}`;
}

export function relationsMarkdown(project: WriterProject) {
  const name = names(project);
  return `# 人物关系\n\n${project.characterRelations.map((relation) => `- ${name.character(relation.sourceCharacterId)} → ${name.character(relation.targetCharacterId)}：${relation.relation}${relation.startsAt || relation.endsAt ? `（${relation.startsAt} 至 ${relation.endsAt}）` : ""}`).join("\n")}`;
}

export function characterMarkdown(project: WriterProject, character: WriterCharacter) {
  const name = names(project);
  return `# ${character.name}\n\n- 别名：${character.aliases.join("、")}\n- 定位：${character.role}\n- 首次出场：${name.node(character.firstNodeId)}\n- 标签：${character.tags.join("、")}\n\n## 简介\n\n${character.summary}\n\n## 人物弧\n\n${character.arc}`;
}

export function chapterMarkdown(project: WriterProject, chapter: WriterChapterMeta, content: string) {
  const name = names(project);
  const meta = [`- 状态：${chapterStatusLabel(chapter.status)}`, `- 字数：${chapter.wordCount}`, chapter.povCharacterId ? `- 视角：${name.character(chapter.povCharacterId)}` : "", chapter.storyNodeIds.length ? `- 关联剧情：${chapter.storyNodeIds.map(name.node).join("、")}` : ""].filter(Boolean).join("\n");
  return `# ${chapter.title}\n\n${meta}\n\n${chapter.summary ? `> ${chapter.summary.replace(/\n/g, "\n> ")}\n\n` : ""}${content}`;
}

/** Plain manuscript text for pasting into publishing platforms. */
export function manuscriptChapterText(chapter: WriterChapterMeta, content: string) { return `${chapter.title}\n\n${stripImageMarkup(content).trim()}\n`; }
