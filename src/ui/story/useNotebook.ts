import { useCallback, useEffect, useState } from "react";
import { emptyNotebook, type Notebook } from "../../notes/schema";
import { loadNotebook, updateNotebook } from "../../notes/store";
import { useWriter } from "../useWriter";

export type OpenChapter = (chapterId: string, quote?: string) => void;
export type NotebookApi = { notebook: Notebook; loaded: boolean; update: (mutate: (draft: Notebook) => void) => Promise<void> };

/** The work's notebook (notes, briefing, reader snapshots), loaded once per view and saved under its lock. */
export function useNotebook(): NotebookApi {
  const writer = useWriter();
  const projectId = writer.project?.id;
  const [notebook, setNotebook] = useState<Notebook>(emptyNotebook());
  const [loaded, setLoaded] = useState(false);
  const notify = writer.notify;
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoaded(false);
    void loadNotebook(projectId).then((value) => { if (!cancelled) { setNotebook(value); setLoaded(true); } }).catch((error) => notify("error", `读取作家笔记失败：${error instanceof Error ? error.message : String(error)}`));
    return () => { cancelled = true; };
  }, [projectId, notify, writer.runs]);
  const update = useCallback(async (mutate: (draft: Notebook) => void) => {
    if (!projectId) return;
    try { setNotebook(await updateNotebook(projectId, mutate)); }
    catch (error) { notify("error", `保存作家笔记失败：${error instanceof Error ? error.message : String(error)}`); }
  }, [projectId, notify]);
  return { notebook, loaded, update };
}
