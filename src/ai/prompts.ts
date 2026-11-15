// Composes system prompts: a role, then the writing goal; calls that write prose also get the work's style samples.
import type { WriterProject } from "../types";
import { resolvePrompt, type PromptKey } from "./promptRegistry";
import { PROSE_SAMPLE_BUDGET, styleSamplesText } from "./styleSamples";

export const GOAL_HEADING = "【创作目标】";

/** System prompt for every call that writes or rewrites prose. */
export async function writerSystem(project: WriterProject, budget = PROSE_SAMPLE_BUDGET): Promise<string> {
  return [withGoal(project, "writer.role"), await styleSamplesText(project, budget)].filter(Boolean).join("\n\n");
}

/** What the book aims at: a best-selling long web serial, and what that takes. */
export function writingGoal(project: WriterProject) { return resolvePrompt(project, "writer.goal"); }

/** A role prompt followed by the writing goal, for calls that write, plan or judge the story. */
export function withGoal(project: WriterProject, key: PromptKey) { return `${resolvePrompt(project, key)}\n\n${GOAL_HEADING}\n${writingGoal(project)}`; }

export function editorSystem(project: WriterProject) { return withGoal(project, "editor.system"); }

export function agentSystem(project: WriterProject) { return resolvePrompt(project, "agent.system"); }
