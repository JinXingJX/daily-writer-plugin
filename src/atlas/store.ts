// Persistence of the world map. AI work lands in a draft the author adopts or discards; earlier versions are kept for undo.
import { readJson, removeFile, writeJson } from "../storage/io";
import { withWriterMutationLock } from "../storage/lock";
import { projectDir } from "../storage/paths";
import { arrayValue, asRecord } from "../domain/util";
import { applyAtlasOps, type OpsContext } from "./operations";
import { normalizeAtlas, type Atlas } from "./schema";

const HISTORY_LIMIT = 5;
function atlasDir(projectId: string) { return `${projectDir(projectId)}/atlas`; }
const atlasFile = (projectId: string) => `${atlasDir(projectId)}/atlas.json`;
const draftFile = (projectId: string) => `${atlasDir(projectId)}/draft.json`;
const historyFile = (projectId: string) => `${atlasDir(projectId)}/history.json`;

type Listener = (projectId: string) => void;
const listeners = new Set<Listener>();
export function subscribeAtlas(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function changed(projectId: string) { for (const listener of listeners) listener(projectId); }

export async function loadAtlas(projectId: string): Promise<Atlas | null> { return normalizeAtlas(await readJson(atlasFile(projectId))); }
export async function loadAtlasDraft(projectId: string): Promise<Atlas | null> { return normalizeAtlas(await readJson(draftFile(projectId))); }
/** What the map shows right now: the pending draft when there is one. */
export async function loadCurrentAtlas(projectId: string): Promise<Atlas | null> { return (await loadAtlasDraft(projectId)) ?? loadAtlas(projectId); }

export async function saveAtlas(projectId: string, atlas: Atlas) {
  await withWriterMutationLock(() => writeJson(atlasFile(projectId), { ...atlas, updatedAt: Date.now() }));
  changed(projectId);
}

export async function saveAtlasDraft(projectId: string, atlas: Atlas) {
  await withWriterMutationLock(() => writeJson(draftFile(projectId), { ...atlas, updatedAt: Date.now() }));
  changed(projectId);
}

/** Applies operations to the draft, starting one from the adopted map when none is pending. */
export async function updateAtlasDraft(projectId: string, operations: unknown[], context: OpsContext = {}): Promise<{ atlas: Atlas; applied: number; skipped: string[] }> {
  const result = await withWriterMutationLock(async () => {
    const base = (await loadAtlasDraft(projectId)) ?? (await loadAtlas(projectId));
    const outcome = applyAtlasOps(base, operations, context);
    await writeJson(draftFile(projectId), { ...outcome.atlas, updatedAt: Date.now() });
    return outcome;
  });
  changed(projectId);
  return result;
}

/**
 * The author's own edits: they apply to what is on screen, the pending draft when there is one, and re-read the
 * stored map first so an edit never overwrites a change saved meanwhile (an AI pass, another edit).
 */
export async function editCurrentAtlas(projectId: string, change: (atlas: Atlas) => void): Promise<Atlas | null> {
  const result = await withWriterMutationLock(async () => {
    const draft = await loadAtlasDraft(projectId);
    const current = draft ?? (await loadAtlas(projectId));
    if (!current) return null;
    change(current);
    await writeJson(draft ? draftFile(projectId) : atlasFile(projectId), { ...current, updatedAt: Date.now() });
    return current;
  });
  changed(projectId);
  return result;
}

export async function discardAtlasDraft(projectId: string) {
  await withWriterMutationLock(() => removeFile(draftFile(projectId)));
  changed(projectId);
}

export async function adoptAtlasDraft(projectId: string) {
  await withWriterMutationLock(async () => {
    const draft = await loadAtlasDraft(projectId);
    if (!draft) return;
    const current = await loadAtlas(projectId);
    if (current) {
      const history = arrayValue(asRecord(await readJson(historyFile(projectId))).versions).slice(-(HISTORY_LIMIT - 1));
      await writeJson(historyFile(projectId), { versions: [...history, current] });
    }
    await writeJson(atlasFile(projectId), draft);
    await removeFile(draftFile(projectId));
  });
  changed(projectId);
}

export async function atlasHistoryCount(projectId: string) { return arrayValue(asRecord(await readJson(historyFile(projectId))).versions).length; }

/** Steps back to the previous adopted map. */
export async function restorePreviousAtlas(projectId: string): Promise<boolean> {
  const restored = await withWriterMutationLock(async () => {
    const versions = arrayValue(asRecord(await readJson(historyFile(projectId))).versions);
    const previous = versions.length ? normalizeAtlas(versions[versions.length - 1]) : null;
    if (!previous) return false;
    await writeJson(atlasFile(projectId), previous);
    await writeJson(historyFile(projectId), { versions: versions.slice(0, -1) });
    return true;
  });
  if (restored) changed(projectId);
  return restored;
}
