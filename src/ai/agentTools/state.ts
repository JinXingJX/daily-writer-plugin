// The writing agent's per-run state and the helpers tool handlers share: resolving documents, recording draft edits
// as proposal changes and creating chapters.
import { docKey, docTitle, orderedChapters, readDoc, writeDoc } from "../../domain/documents";
import { uniqueId } from "../../domain/ids";
import { normalizeChapterMeta } from "../../domain/normalize";
import { rankBetween } from "../../domain/ranks";
import { stringValue, trimmedString } from "../../domain/util";
import type { MemoryView } from "../../memory/view";
import { loadChapterText } from "../../storage/projectStore";
import type { StoryPlan } from "../../story/schema";
import { loadStoryPlan } from "../../story/store";
import type { AgentEventView, ChapterTexts, DocRef, ProposalChange, WriterComment, WriterProject } from "../../types";
import type { ChapterPlan } from "../pipelines/nextChapter";
import type { AgentDisplay } from "../sessions";

/** `consumed` once draft edits rewrote the selected text, so the tool can say why it is gone. */
export type AgentSelection = { doc: DocRef; start: number; end: number; text: string; consumed?: boolean } | null;

export type RunState = {
  projectId: string;
  sessionId: string;
  instruction: string;
  supersedes: string | null;
  draft: WriterProject;
  base: ChapterTexts;
  texts: ChapterTexts;
  changes: ProposalChange[];
  comments: WriterComment[];
  displays: AgentDisplay[];
  eventViews: AgentEventView[];
  selection: AgentSelection;
  activeDoc: DocRef;
  /** The latest chapter plan of this run (planChapter); reviewChapter checks the chapter at its position against it. */
  plan?: AgentPlan | null;
};

/** `chapterId` is the chapter being rewritten; null for a new chapter at `position`. */
export type AgentPlan = { position: number; chapterId: string | null; plan: ChapterPlan };

export type ToolOutcome = { observation: string; result?: unknown };
export type ToolEnv = { state: RunState; input: Record<string, unknown>; memory: MemoryView | null; signal?: AbortSignal };
export type ToolHandler = (env: ToolEnv) => Promise<ToolOutcome> | ToolOutcome;

export function docRef(state: RunState, input: Record<string, unknown>): DocRef {
  const kind = stringValue(input.doc) || state.activeDoc.kind;
  if (kind === "chapter") {
    const id = trimmedString(input.chapterId) ?? (state.activeDoc.kind === "chapter" ? state.activeDoc.id : undefined);
    if (!id || !state.draft.chapters.some((chapter) => chapter.id === id)) throw new Error("chapterId 无效，请先 readProjectIndex 查看章节 id。");
    return { kind: "chapter", id };
  }
  if (kind === "worldview" || kind === "background" || kind === "outline" || kind === "style") return { kind };
  throw new Error(`不支持的文档类型 ${kind}`);
}

export async function docText(state: RunState, ref: DocRef): Promise<string> {
  if (ref.kind !== "chapter") return readDoc(state.draft, state.texts, ref) ?? "";
  if (state.texts[ref.id] === undefined) {
    const text = await loadChapterText(state.projectId, ref.id);
    state.texts[ref.id] = text;
    state.base[ref.id] = text;
  }
  return state.texts[ref.id];
}

export function recordText(state: RunState, ref: DocRef, before: string, after: string, summary: string): ToolOutcome {
  writeDoc(state.draft, state.texts, ref, after);
  state.changes.push({ id: uniqueId("change"), kind: "text", doc: ref, title: docTitle(state.draft, ref), summary, before, after });
  // The selection follows the edit, so a later useSelection still finds what the author selected.
  const selection = state.selection;
  if (selection && !selection.consumed && docKey(selection.doc) === docKey(ref)) state.selection = shiftedSelection(selection, before, after);
  return { observation: `已在草稿中修改《${docTitle(state.draft, ref)}》：${before.length} → ${after.length} 字符。修改会以建议形式交给作者审核。` };
}

/** Moves the selection past an edit before it; an edit that touches the selected text uses it up. */
function shiftedSelection(selection: NonNullable<AgentSelection>, before: string, after: string): AgentSelection {
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < max - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  if (prefix >= selection.end) return selection;
  const delta = after.length - before.length;
  if (before.length - suffix <= selection.start) return { ...selection, start: selection.start + delta, end: selection.end + delta };
  return { ...selection, consumed: true };
}

export function createChapter(state: RunState, spec: { title: string; summary: string; afterChapterId: string | null }, content: string) {
  const chapters = orderedChapters(state.draft);
  const anchor = (spec.afterChapterId && chapters.find((chapter) => chapter.id === spec.afterChapterId)) || chapters[chapters.length - 1];
  const volumeId = anchor?.volumeId ?? state.draft.volumes[0].id;
  const sameVolume = chapters.filter((chapter) => chapter.volumeId === volumeId);
  const next = anchor ? sameVolume[sameVolume.indexOf(anchor) + 1] : undefined;
  const meta = normalizeChapterMeta({ id: uniqueId("chapter"), volumeId, title: spec.title, summary: spec.summary, rank: rankBetween(anchor?.rank, next?.rank), status: "draft" });
  state.draft.chapters.push(meta);
  writeDoc(state.draft, state.texts, { kind: "chapter", id: meta.id }, content);
  state.changes.push({ id: uniqueId("change"), kind: "text", doc: { kind: "chapter", id: meta.id }, title: meta.title, summary: "新建章节", before: "", after: content, createChapter: { ...meta } });
  return meta;
}

/** The story plan as the agent's pending story changes would leave it is not tracked; reads come from disk. */
export async function storyOf(state: RunState): Promise<StoryPlan | null> { return loadStoryPlan(state.projectId).catch(() => null); }
