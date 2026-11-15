import { useCallback, useMemo } from "react";
import { docKey, readDoc } from "../../domain/documents";
import { chapterHealth, diagnoseStory } from "../../story/health";
import { useNotebook } from "../story/useNotebook";
import { useWriter } from "../useWriter";
import { buildMarginNotes, type MarginNote } from "./notes";

/** The margin of the open document, shared by the page (underlines) and the margin (notes). */
export function useMarginNotes() {
  const writer = useWriter();
  const { project, draft, active, memory, story } = writer;
  const { notebook, update } = useNotebook();
  const text = project && draft ? readDoc(project, draft.texts, active) : undefined;
  const key = docKey(active);
  const chapterId = active.kind === "chapter" ? active.id : null;
  // `memory` is rewrapped on every keystroke; the checks only depend on what memory holds.
  const memoryStamp = memory?.status.updatedAt;
  const health = useMemo(() => (story && memory ? diagnoseStory(story, memory) : []), [story, memoryStamp]); // eslint-disable-line react-hooks/exhaustive-deps

  const notes = useMemo<MarginNote[]>(() => {
    if (!project || text === undefined) return [];
    return buildMarginNotes({
      text, docKey: key, chapterId,
      comments: project.comments.filter((comment) => docKey(comment.doc) === key),
      publishNotes: chapterId ? notebook.marginNotes[chapterId] ?? [] : [],
      conflicts: memory?.conflicts ?? [],
      health: chapterId ? chapterHealth(health, chapterId) : [],
      positionOf: (id) => memory?.position(id) ?? 0,
    });
  }, [chapterId, health, key, memory, notebook.marginNotes, project, text]);

  const resolve = useCallback((note: MarginNote) => {
    if (note.source === "comment") writer.mutateProject((next) => { const comment = next.comments.find((item) => item.id === note.sourceId); if (comment) comment.resolved = true; });
    else if (note.source === "publish" && chapterId) void update((next) => { next.marginNotes[chapterId] = (next.marginNotes[chapterId] ?? []).filter((item) => item.id !== note.sourceId); });
  }, [chapterId, update, writer]);

  return { notes, resolve, health };
}

export type MarginNotesApi = ReturnType<typeof useMarginNotes>;
