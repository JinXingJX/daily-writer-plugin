// Read-only tools: project index, documents, memory, manuscript search and style samples.
import { chapterLabel, docTitle, orderedChapters } from "../../domain/documents";
import { previewText, stringValue, trimmedString } from "../../domain/util";
import type { MemoryView } from "../../memory/view";
import { searchBook } from "../../storage/bookOps";
import type { WriterProject } from "../../types";
import { loadStyleSamples } from "../styleSamples";
import { docRef, docText, type ToolHandler } from "./state";

const readProjectIndex: ToolHandler = ({ state, memory }) => ({ observation: projectIndex(state.draft, memory) });

const readDocument: ToolHandler = async ({ state, input }) => {
  const ref = docRef(state, input);
  const text = await docText(state, ref);
  const offset = Math.max(0, Number(input.offset) || 0);
  const limit = Math.min(30_000, Math.max(500, Number(input.limit) || 20_000));
  const slice = text.slice(offset, offset + limit);
  return { observation: `《${docTitle(state.draft, ref)}》共 ${text.length} 字符，返回 ${offset}-${offset + slice.length}${offset + slice.length < text.length ? "（未读完，可继续用 offset 读取）" : ""}：\n${slice}` };
};

const searchMemory: ToolHandler = ({ input, memory }) => {
  if (!memory || memory.isEmpty) return { observation: "这部作品还没有建立故事记忆。可以改用 grepManuscript 搜索原文，或建议作者在“记忆”面板中建立记忆。" };
  const hits = memory.searchCards(stringValue(input.query), Math.min(20, Number(input.limit) || 10));
  return { observation: hits.map((hit) => `${chapterLabel(memory.position(hit.id))}（id=${hit.id}）：${memory.cards.get(hit.id)?.summary ?? ""}`).join("\n") || "没有相关结果。" };
};

const readChapterCard: ToolHandler = ({ input, memory }) => {
  if (!memory) return { observation: "尚未建立故事记忆。" };
  const raw = stringValue(input.chapter) || String(input.chapter ?? "");
  const chapterId = /^\d+$/.test(raw) ? memory.orderedIds[Number(raw) - 1] : raw;
  const card = chapterId ? memory.cards.get(chapterId) : null;
  if (!card) return { observation: "没有这一章的记忆卡片（可能尚未抽取）。" };
  return { observation: JSON.stringify({ chapter: chapterLabel(memory.position(card.chapterId)), ...card, mentions: undefined }, null, 1) };
};

const readEntity: ToolHandler = ({ input, memory }) => {
  if (!memory) return { observation: "尚未建立故事记忆。" };
  const entity = memory.resolve(stringValue(input.name));
  if (!entity) return { observation: `记忆中没有“${stringValue(input.name)}”。` };
  const at = Number(input.atChapter) ? Number(input.atChapter) - 1 : memory.orderedIds.length;
  const facts = memory.facts(entity.id).filter((fact) => fact.position <= at).slice(-60).map((fact) => `${chapterLabel(fact.position)}：${fact.attribute}=${fact.value}（${fact.kind}）`);
  const current = Object.values(memory.stateAt(entity.id, at)).map((fact) => `${fact.attribute}=${fact.value}`).join("；");
  const chapters = memory.chaptersOf(entity.id);
  return { observation: `${entity.name}（${entity.category}；别名：${entity.aliases.join("、") || "无"}）\n档案：${entity.summary}\n出场 ${chapters.length} 章，首次：${chapters[0] ? chapterLabel(memory.position(chapters[0])) : "未知"}\n当前状态：${current || "无记录"}\n事实时间线：\n${facts.join("\n")}` };
};

const grepManuscript: ToolHandler = async ({ state, input }) => {
  const hits = await searchBook(state.draft, stringValue(input.query), { regex: input.regex === true, limitPerChapter: 3 });
  const positions = orderedChapters(state.draft).map((chapter) => chapter.id);
  return { observation: hits.length ? `共 ${hits.length} 章命中：\n${hits.slice(0, 40).map((hit) => `${chapterLabel(positions.indexOf(hit.chapterId))}（id=${hit.chapterId}，${hit.count} 处）：${hit.snippets.map((snippet) => `…${snippet.before}【${snippet.match}】${snippet.after}…`).join(" ")}`).join("\n")}` : "原文中没有找到。" };
};

const readStyleSamples: ToolHandler = async ({ state, input }) => {
  const samples = await loadStyleSamples(state.projectId);
  if (!samples.length) return { observation: "这部作品还没有样章。写正文时跟着作者已有的章节写；需要的话可以建议作者在设置 → 样章里导入。" };
  const id = trimmedString(input.sampleId);
  if (!id) return { observation: samples.map((sample) => `- ${sample.title}（sampleId=${sample.id}，${sample.text.length} 字符）`).join("\n") };
  const sample = samples.find((item) => item.id === id);
  if (!sample) throw new Error(`没有 sampleId=${id} 的样章，先不带 sampleId 调用看列表。`);
  const offset = Math.max(0, Number(input.offset) || 0);
  const slice = sample.text.slice(offset, offset + 20_000);
  return { observation: `〔${sample.title}〕共 ${sample.text.length} 字符，返回 ${offset}-${offset + slice.length}：\n${slice}` };
};

export function projectIndex(project: WriterProject, memory: MemoryView | null) {
  const chapters = orderedChapters(project);
  const volumes = new Map(project.volumes.map((volume) => [volume.id, volume.title]));
  const list = chapters.length > 160 ? [...chapters.slice(0, 20), null, ...chapters.slice(-120)] : chapters;
  const lines = list.map((chapter) => {
    if (!chapter) return `…（中间省略 ${chapters.length - 140} 章，可用 searchMemory / readChapterCard 查询）`;
    const index = chapters.indexOf(chapter);
    const card = memory?.cards.get(chapter.id);
    return `${index + 1}. [${volumes.get(chapter.volumeId) ?? ""}] ${chapter.title}（id=${chapter.id}，${chapter.wordCount}字，${chapter.status}）${previewText(chapter.summary || card?.summary || "", 60)}`;
  });
  const coverage = memory?.coverage();
  return [
    `《${project.title}》${project.genre}｜共 ${chapters.length} 章，${chapters.reduce((total, chapter) => total + chapter.wordCount, 0)} 字`,
    `记忆：${coverage ? `${coverage.fresh}/${coverage.total} 章已建立` : "未建立"}`,
    `分卷：${project.volumes.map((volume) => `${volume.title}(id=${volume.id})`).join("、")}`,
    `根文档字数：世界观 ${project.worldview.length}，背景 ${project.background.length}，大纲 ${project.outline.length}，文风指南 ${project.styleGuide.length}`,
    `设定库人物：${project.characters.map((character) => `${character.name}(id=${character.id})`).join("、") || "无"}`,
    `势力：${project.factions.map((faction) => `${faction.name}(id=${faction.id})`).join("、") || "无"}`,
    `章节：\n${lines.join("\n")}`,
  ].join("\n");
}

export const READ_TOOLS: Record<string, ToolHandler> = {
  "writer.readProjectIndex": readProjectIndex,
  "writer.readDocument": readDocument,
  "writer.searchMemory": searchMemory,
  "writer.readChapterCard": readChapterCard,
  "writer.readEntity": readEntity,
  "writer.grepManuscript": grepManuscript,
  "writer.readStyleSamples": readStyleSamples,
};
