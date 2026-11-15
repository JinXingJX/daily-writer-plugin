// Loads what the context builder needs from disk (previous chapter, style samples, notebook, story plan).
import { orderedChapters } from "../domain/documents";
import type { MemoryView } from "../memory/view";
import { loadNotebook } from "../notes/store";
import { loadChapterText } from "../storage/projectStore";
import type { StoryPlan } from "../story/schema";
import { loadStoryPlan } from "../story/store";
import type { ChapterTexts, WriterProject } from "../types";
import { buildWritingContext, pickStyleSamples, type AssembledContext } from "./context";

export type PrepareContextInput = {
  project: WriterProject;
  memory: MemoryView | null;
  position: number;
  focus: string;
  texts?: ChapterTexts;
  entityNames?: string[];
  scope?: "local" | "chapter";
  budget?: number;
  /** Pass a loaded story plan to skip reading it again. */
  story?: StoryPlan | null;
};

/** Loads what the context builder needs from disk (previous chapter, style samples) and assembles the pack. */
export async function prepareWritingContext(input: PrepareContextInput): Promise<AssembledContext> {
  const chapters = orderedChapters(input.project);
  const text = async (chapterId: string) => input.texts?.[chapterId] ?? (await loadChapterText(input.project.id, chapterId));
  const previous = input.position > 0 ? chapters[input.position - 1] : undefined;
  const previousChapterText = previous ? await text(previous.id) : undefined;
  const sampleSources = chapters.slice(0, input.position).filter((chapter) => chapter.wordCount > 1_500).slice(-3, -1);
  const styleSamples = input.scope === "local" ? [] : pickStyleSamples(await Promise.all(sampleSources.map((chapter) => text(chapter.id))));
  // The notebook and story plan are optional context; a missing or unreadable file must not block writing.
  const [notebook, story] = await Promise.all([loadNotebook(input.project.id).catch(() => null), input.story !== undefined ? Promise.resolve(input.story) : loadStoryPlan(input.project.id).catch(() => null)]);
  return buildWritingContext({ ...input, previousChapterText, previousChapterTitle: previous?.title, styleSamples, notebook, story });
}
