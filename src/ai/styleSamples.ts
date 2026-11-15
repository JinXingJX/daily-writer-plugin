// The work's voice, given to the model as the author's own sample chapters instead of a written style prompt:
// the model reads them and works out the voice itself.
import { listSamples, loadSample, type StyleSample } from "../storage/sampleStore";
import type { WriterProject } from "../types";

export const SAMPLES_HEADING = "【样章】";
const SAMPLES_NOTE = "作者挑的文风参考。只学叙述的声音：叙述者站在哪、离人物多近，句子和段落的长短节奏，对白怎么起怎么收，幽默或冷意从哪来。样章的内容一概不进本作：不用它的句子、桥段、笑点、人名、地名和专有名词，也不照它的描写密度写，本作写多少描写由这一章发生的事决定。称谓、器物和规则都用本作自己的。";

/** Budgets in characters: the writing agent reads more of the samples than a single prose call. */
export const AGENT_SAMPLE_BUDGET = 30_000;
export const PROSE_SAMPLE_BUDGET = 12_000;

export type LoadedSample = StyleSample & { text: string };

export async function loadStyleSamples(projectId: string): Promise<LoadedSample[]> {
  const samples = await listSamples(projectId).catch(() => []);
  const texts = await Promise.all(samples.map((sample) => loadSample(projectId, sample.id).catch(() => "")));
  return samples.map((sample, index) => ({ ...sample, text: texts[index] })).filter((sample) => sample.text.trim());
}

/**
 * The samples within `budget` characters: each gets an even share (unused share passes on to the rest) and is cut at
 * the end of a sentence, so the model reads whole passages. Empty when the work has no samples.
 */
export function samplesSection(samples: { title: string; text: string }[], budget: number): string {
  if (!samples.length) return "";
  const order = samples.map((sample, index) => ({ sample, index })).sort((left, right) => left.sample.text.length - right.sample.text.length);
  const parts: string[] = new Array(samples.length);
  let left = budget;
  order.forEach(({ sample, index }, position) => {
    const share = Math.floor(left / (order.length - position));
    const text = cutAtSentence(sample.text.trim(), share);
    parts[index] = `〔${sample.title}〕\n${text}`;
    left -= text.length;
  });
  return `${SAMPLES_HEADING}${SAMPLES_NOTE}\n\n${parts.join("\n\n")}`;
}

/** The start of `text` up to `limit` characters, ending at a sentence or line end when one is close. */
export function cutAtSentence(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const end = Math.max(...["。", "！", "？", "…", "”", "」", "\n", ".", "!", "?"].map((mark) => head.lastIndexOf(mark)));
  return end >= limit * 0.6 ? head.slice(0, end + 1).trimEnd() : head;
}

export async function styleSamplesText(project: WriterProject, budget: number): Promise<string> {
  return samplesSection(await loadStyleSamples(project.id), budget);
}
