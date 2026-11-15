import { ATLAS_TOOLS } from "./atlas";
import { CRAFT_TOOLS } from "./craft";
import { IMAGE_TOOLS } from "./image";
import { READ_TOOLS } from "./read";
import type { ToolHandler } from "./state";
import { STORY_TOOLS } from "./story";
import { WRITE_TOOLS } from "./write";

export const TOOL_HANDLERS: Record<string, ToolHandler> = { ...READ_TOOLS, ...WRITE_TOOLS, ...STORY_TOOLS, ...CRAFT_TOOLS, ...IMAGE_TOOLS, ...ATLAS_TOOLS };
/** Read tools: a repeated call with the same arguments is answered without running it again. */
export const READ_TOOL_IDS = new Set([...Object.keys(READ_TOOLS), "writer.readStoryPlan", "writer.diagnoseStory", "writer.readCraft", "writer.planChapter", "writer.reviewChapter", "writer.listImages", "writer.readAtlas"]);
export type { AgentSelection, RunState, ToolOutcome } from "./state";
