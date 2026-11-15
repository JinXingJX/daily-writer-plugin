import { domainTask } from "../worker/domainTask";
// Writes an image prompt from the story material, so the author starts from something concrete.
import { invokeText } from "../ai/client";
import type { MemoryView } from "../memory/view";
import type { WriterProject } from "../types";

const SYSTEM = `你给长篇小说写图片生成提示词。读材料，想清楚这一幅要画什么，写成一段可以直接交给图像模型的中文描述。
- 写画面本身：主体是谁、在做什么、神态姿势、衣着器物、场景、光线、镜头远近和构图。
- 材料里写明的外貌、服饰、地理和时代细节照写，材料没写的按作品世界补足，不要和材料冲突。
- 不写抽象评价（比如“史诗感”“震撼”），换成看得见的东西。
- 画面里不要出现文字、水印、边框和分镜。
- 只输出这段描述，不要标题、列表或解释，300 字以内。`;

function castNotes(project: WriterProject, memory: MemoryView | null, text: string) {
  const lines: string[] = [];
  for (const character of project.characters) {
    if (![character.name, ...character.aliases].some((name) => name.length >= 2 && text.includes(name))) continue;
    lines.push(`- ${character.name}${character.role ? `（${character.role}）` : ""}：${character.minimalTag ? `${character.minimalTag}。` : ""}${character.summary.slice(0, 300)}`);
  }
  for (const entity of memory?.entitiesIn(text, 12) ?? []) {
    if (entity.bibleId || !entity.summary) continue;
    lines.push(`- ${entity.name}：${entity.summary.slice(0, 200)}`);
  }
  return lines.slice(0, 20).join("\n");
}

export async function draftImagePrompt(project: WriterProject, memory: MemoryView | null, material: string, instruction = "", signal?: AbortSignal): Promise<string> {
  const task = domainTask<string>("draftImagePrompt", [project, memory, material, instruction], project.id, signal); if (task) return task;
  const notes = castNotes(project, memory, material);
  const prompt = [
    `【作品】《${project.title}》${project.genre ? `，${project.genre}` : ""}`,
    project.worldview.trim() ? `【世界观摘录】\n${project.worldview.slice(0, 2_000)}` : "",
    notes ? `【相关设定】\n${notes}` : "",
    `【要画的内容】\n${material.slice(0, 6_000)}`,
    instruction.trim() ? `【作者要求】${instruction.trim()}` : "",
  ].filter(Boolean).join("\n\n");
  const text = await invokeText({ task: "ideas", system: SYSTEM, prompt, temperature: 0.6, maxOutputTokens: 1_000, signal });
  return text.trim();
}
