// Style samples of a work: passages by the author (or an author they want to sound like) that every prose call reads
// to find the voice. `samples/index.json` lists them; each text lives in `samples/<id>.txt`.
import { uniqueId } from "../domain/ids";
import { arrayValue, asRecord, finiteNumber, stringValue, unixTimestamp } from "../domain/util";
import { readJson, readTextOr, removeFile, writeJson, writeText } from "./io";
import { samplesDir } from "./paths";

export type StyleSample = { id: string; title: string; chars: number; addedAt: number };

/** One sample's text is capped; longer imports keep their beginning. */
export const MAX_SAMPLE_CHARS = 60_000;
export const MAX_SAMPLES = 20;

const indexPath = (projectId: string) => `${samplesDir(projectId)}/index.json`;
const textPath = (projectId: string, sampleId: string) => `${samplesDir(projectId)}/${sampleId.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`;

export async function listSamples(projectId: string): Promise<StyleSample[]> {
  const index = asRecord(await readJson(indexPath(projectId)).catch(() => undefined));
  return arrayValue(index.samples).flatMap((value) => {
    const sample = asRecord(value);
    const id = stringValue(sample.id);
    return id ? [{ id, title: stringValue(sample.title) || "样章", chars: finiteNumber(sample.chars, 0), addedAt: finiteNumber(sample.addedAt, 0) }] : [];
  });
}

export async function loadSample(projectId: string, sampleId: string): Promise<string> {
  return readTextOr(textPath(projectId, sampleId), "");
}

export async function addSample(projectId: string, title: string, text: string): Promise<StyleSample> {
  const samples = await listSamples(projectId);
  if (samples.length >= MAX_SAMPLES) throw new Error(`一部作品最多 ${MAX_SAMPLES} 篇样章。`);
  const body = text.replace(/\r\n?/g, "\n").trim().slice(0, MAX_SAMPLE_CHARS);
  if (!body) throw new Error("样章是空的。");
  const sample: StyleSample = { id: uniqueId("sample"), title: title.trim() || `样章 ${samples.length + 1}`, chars: body.length, addedAt: unixTimestamp() };
  await writeText(textPath(projectId, sample.id), body);
  await writeJson(indexPath(projectId), { samples: [...samples, sample] });
  return sample;
}

/** Copies built-in samples into the work; the copies can then be removed like any other sample. */
export async function addPresetSamples(projectId: string, presets: { title: string; text: string }[]): Promise<StyleSample[]> {
  const added: StyleSample[] = [];
  for (const preset of presets) added.push(await addSample(projectId, preset.title, preset.text));
  return added;
}

export async function removeSample(projectId: string, sampleId: string) {
  const samples = await listSamples(projectId);
  await writeJson(indexPath(projectId), { samples: samples.filter((sample) => sample.id !== sampleId) });
  await removeFile(textPath(projectId, sampleId));
}
