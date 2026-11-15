import { readJson, writeJson } from "../storage/io";
import { withWriterMutationLock } from "../storage/lock";
import { notebookFile } from "../storage/paths";
import { MAX_READER_SNAPSHOTS, normalizeNotebook, type Notebook } from "./schema";

export async function loadNotebook(projectId: string): Promise<Notebook> {
  return normalizeNotebook(await readJson(notebookFile(projectId)).catch(() => undefined));
}

/** Read-modify-write under a per-project lock so edits from other windows are not lost. Returns the saved notebook. */
export async function updateNotebook(projectId: string, mutate: (notebook: Notebook) => void): Promise<Notebook> {
  return withWriterMutationLock(async () => {
    const notebook = await loadNotebook(projectId);
    mutate(notebook);
    const readers = Object.values(notebook.readers).sort((left, right) => right.generatedAt - left.generatedAt).slice(0, MAX_READER_SNAPSHOTS);
    notebook.readers = Object.fromEntries(readers.map((snapshot) => [snapshot.chapterId, snapshot]));
    for (const [chapterId, notes] of Object.entries(notebook.marginNotes)) if (!notes.length) delete notebook.marginNotes[chapterId];
    await writeJson(notebookFile(projectId), notebook);
    return notebook;
  }, `writer.notebook.lock.${projectId}`);
}
