// Per-work idea inbox: ideas the author saved from inspiration bursts. Kept out of project.json so it never
// takes part in draft merging.
import type { Idea, InspireTarget } from "../ai/pipelines/inspire";
import { arrayValue, asRecord, finiteNumber, stringValue, unixTimestamp } from "../domain/util";
import { readJson, writeJson } from "./io";
import { ideasFile } from "./paths";

export type SavedIdea = Idea & { target: InspireTarget; savedAt: number };
const LIMIT = 500;


export async function loadIdeas(projectId: string): Promise<SavedIdea[]> {
  const raw = await readJson(ideasFile(projectId)).catch(() => undefined);
  return arrayValue(asRecord(raw).ideas).flatMap((item) => {
    const record = asRecord(item);
    const id = stringValue(record.id);
    if (!id) return [];
    return [{ id, title: stringValue(record.title), content: stringValue(record.content), lens: stringValue(record.lens), target: stringValue(record.target) as InspireTarget, savedAt: finiteNumber(record.savedAt, 0) }];
  });
}

export async function saveIdea(projectId: string, idea: Idea, target: InspireTarget): Promise<SavedIdea[]> {
  const ideas = (await loadIdeas(projectId)).filter((item) => item.id !== idea.id);
  const next = [{ ...idea, target, savedAt: unixTimestamp() }, ...ideas].slice(0, LIMIT);
  await writeJson(ideasFile(projectId), { version: 1, ideas: next });
  return next;
}

export async function removeIdea(projectId: string, ideaId: string): Promise<SavedIdea[]> {
  const next = (await loadIdeas(projectId)).filter((item) => item.id !== ideaId);
  await writeJson(ideasFile(projectId), { version: 1, ideas: next });
  return next;
}
