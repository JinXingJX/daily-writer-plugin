import { cancelWriterTask } from "../../worker/taskClient";
import { useCallback, useMemo, useRef, useState } from "react";
import { friendlyAiError } from "../../ai/client";
import { rewriteSelection } from "../../ai/quick";
import { relocateSelection } from "../../domain/anchors";
import { orderedChapters, readDoc } from "../../domain/documents";
import type { QuickActionConfig } from "../../types";
import { useDialogs } from "../common";
import type { EditorApi, EditorSelection } from "../editor/ManuscriptEditor";
import type { InlineSuggestion } from "../editor/extensions";
import { useWriter } from "../useWriter";

/** Rewrites the selection through the fast channel. Candidates show on the page; the panel only chooses between them. */
export function useSelectionAi(editorRef: React.RefObject<EditorApi | null>, selection: EditorSelection) {
  const writer = useWriter();
  const dialogs = useDialogs();
  const [busy, setBusy] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<InlineSuggestion | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { project, draft, active, memory } = writer;
  const text = draft && project ? readDoc(project, draft.texts, active) : undefined;
  const position = useMemo(() => {
    if (!project) return 0;
    const chapters = orderedChapters(project);
    return active.kind === "chapter" ? Math.max(0, chapters.findIndex((chapter) => chapter.id === active.id)) : chapters.length;
  }, [active, project]);

  const runRewrite = useCallback(async (label: string, instruction: string, candidates: number) => {
    if (!project || !draft || text === undefined || !selection.text.trim()) return;
    await writer.flush();
    const controller = new AbortController();
    abortRef.current = controller;
    // A line or triple-click selection carries its line breaks; rewriting must not swallow them.
    const original = selection.text.trim();
    const from = selection.from + (selection.text.length - selection.text.trimStart().length);
    const range = { from, to: from + original.length };
    setBusy(label);
    try {
      const results = await rewriteSelection({ project, memory, texts: draft.texts, position, docText: text, start: range.from, end: range.to, instruction, candidates, signal: controller.signal });
      if (controller.signal.aborted) return;
      // The author may have kept typing while the model worked: only show the suggestion over the same text.
      const view = editorRef.current?.view();
      const target = view ? relocateSelection(view.state.doc.toString(), range, original) : null;
      if (!target) { writer.notify("info", `选中的文字已被修改，已放弃这次${label}结果。`); return; }
      editorRef.current?.showSuggestion({ from: target.from, to: target.to, candidates: results, index: 0, label });
      editorRef.current?.focus();
    } catch (error) {
      if (!controller.signal.aborted) writer.notify("error", friendlyAiError(error));
    } finally {
      setBusy(null);
    }
  }, [draft, editorRef, memory, position, project, selection, text, writer]);

  /** Quick actions that ask a question first (e.g. the target effect) fill the answer into `{{answer}}`. */
  const runQuickAction = useCallback(async (action: QuickActionConfig) => {
    if (action.id === "deai") { writer.setToneOpen(true); return; }
    if (!action.ask) { await runRewrite(action.label, action.instruction, action.candidates); return; }
    const answer = await dialogs.prompt(action.label, action.ask);
    if (!answer?.trim()) return;
    await runRewrite(action.label, action.instruction.replace(/\{\{\s*answer\s*\}\}/g, answer.trim()), action.candidates);
  }, [dialogs, runRewrite, writer]);

  const cancel = useCallback(() => { cancelWriterTask(abortRef.current?.signal); abortRef.current?.abort(); setBusy(null); }, []);
  const accept = useCallback(() => editorRef.current?.acceptSuggestion(), [editorRef]);
  const discard = useCallback(() => { editorRef.current?.showSuggestion(null); editorRef.current?.focus(); }, [editorRef]);
  const pick = useCallback((index: number) => editorRef.current?.patchSuggestion({ index }), [editorRef]);
  const toggleCompare = useCallback(() => editorRef.current?.patchSuggestion({ compare: !suggestion?.compare }), [editorRef, suggestion?.compare]);
  const next = useCallback(() => { if (suggestion) pick((suggestion.index + 1) % suggestion.candidates.length); }, [pick, suggestion]);

  return { busy, suggestion, setSuggestion, position, runRewrite, runQuickAction, cancel, accept, discard, pick, next, toggleCompare };
}

export type SelectionAi = ReturnType<typeof useSelectionAi>;
