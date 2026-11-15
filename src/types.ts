import type { AgentEventView, AgentToolDefinition } from "@daily/plugin-sdk";
import type { StoryOperation } from "./story/schema";
import type { ThreadOperation } from "./memory/schema";
// Core Writer data model (storage schema v3).
// Chapter bodies are stored outside project.json (`chapters/<id>.md`) and loaded on demand.

export const PROJECT_SCHEMA_VERSION = 3;

export type RootDocKind = "worldview" | "background" | "outline" | "style";
export type DocRef = { kind: RootDocKind } | { kind: "chapter"; id: string };
export type ChapterStatus = "draft" | "writing" | "review" | "final";

export type WriterVolume = { id: string; title: string; rank: number; summary: string };

export type WriterChapterMeta = {
  id: string;
  volumeId: string;
  title: string;
  summary: string;
  status: ChapterStatus;
  rank: number;
  povCharacterId: string | null;
  storyNodeIds: string[];
  /** Derived from the chapter body; refreshed whenever the body is saved. */
  wordCount: number;
  /** Derived from the chapter body; used by the memory engine to detect stale chapter cards. */
  contentHash: string;
  targetWords: number;
  notes: string;
  updatedAt: number;
};

/**
 * `minimalTag` is the one trait readers recognise the character by; `desire` what they want; `hiddenInner` what they
 * will not admit. Antagonists and long-running side characters carry their own `independentGoal` and `currentAction`
 * so they keep acting when the protagonist is elsewhere.
 */
export type WriterCharacter = {
  id: string; name: string; aliases: string[]; role: string; summary: string; arc: string; tags: string[];
  minimalTag: string; desire: string; hiddenInner: string; independentGoal: string; currentAction: string;
  firstNodeId: string | null; lastNodeId: string | null;
};
export type WriterFaction = { id: string; name: string; aliases: string[]; summary: string; motivation: string; tags: string[] };
export type FlowPosition = { x: number; y: number };
export type StoryNodeKind = "volume" | "chapter" | "scene" | "plot_key" | "character_key";
export type WriterStoryNode = { id: string; kind: StoryNodeKind; title: string; summary: string; characterIds: string[]; startsAt: string; endsAt: string; chapterId: string | null; sceneId: string | null; position: FlowPosition; tags: string[] };
export type StoryEdgeRelation = "causal" | "timeline" | "branch" | "foreshadow" | "character";
export type WriterStoryEdge = { id: string; source: string; target: string; relation: StoryEdgeRelation; label: string };
export type WriterCharacterRelation = { id: string; sourceCharacterId: string; targetCharacterId: string; relation: string; startsAt: string; endsAt: string; storyNodeIds: string[] };

export type CommentSeverity = "info" | "warning" | "error";
export type WriterComment = {
  id: string;
  doc: DocRef;
  quote: string;
  /** Hint offset; the quote is re-resolved against the current text when displayed. */
  start: number;
  comment: string;
  severity: CommentSeverity;
  author: "ai" | "user";
  resolved: boolean;
  createdAt: number;
};

export type WriterSettings = {
  /** Daily word goal; 0 disables the goal. */
  dailyGoal: number;
  /** Character budget for assembled AI context packs (must stay well below the host 256KB prompt cap). */
  contextBudgetChars: number;
  /** Number of recent chapter cards included in generation context. */
  recentCardCount: number;
  /** Re-extract stale chapter memory in the background. */
  autoMemory: boolean;
  /** Parallel model calls used by the memory worker. */
  memoryConcurrency: number;
  /** What happens in the background after a chapter is published. */
  pipeline: PipelineSettings;
};

/** Steps of the publish pipeline the author can switch off; memory steps always run. */
export type PublishStepToggle = "story" | "reader" | "briefing" | "notes" | "next";
export type PipelineSettings = {
  /** Optional publish steps that run (memory upkeep always does). */
  steps: PublishStepToggle[];
  /** "review": story/setting updates wait as a proposal. "auto-safe": additive story/memory updates apply at once (still undoable); bible and text edits stay proposals. */
  storyGate: "review" | "auto-safe";
  /** "approve": the next-chapter plan waits for the author. "auto": drafting starts right away. */
  planGate: "approve" | "auto";
  /** Target length of the drafted next chapter. */
  nextWords: number;
};

/** `ask` is a question shown before running; the answer fills `{{answer}}` in the instruction. */
export type QuickActionConfig = { id: string; label: string; instruction: string; candidates: number; ask?: string };

/**
 * Per-work prompt configuration: `overrides` replace built-in prompts by key. The work's voice comes from its
 * style samples (storage/sampleStore.ts), not from a prompt.
 */
export type WriterPromptConfig = {
  overrides: Record<string, string>;
  /** null uses the built-in quick actions. */
  quickActions: QuickActionConfig[] | null;
  updatedAt: number;
};

export type WriterProject = {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  id: string;
  title: string;
  slug: string;
  genre: string;
  audience: string;
  targetLength: string;
  language: string;
  worldview: string;
  background: string;
  outline: string;
  styleGuide: string;
  volumes: WriterVolume[];
  chapters: WriterChapterMeta[];
  characters: WriterCharacter[];
  factions: WriterFaction[];
  storyNodes: WriterStoryNode[];
  storyEdges: WriterStoryEdge[];
  characterRelations: WriterCharacterRelation[];
  comments: WriterComment[];
  settings: WriterSettings;
  prompts: WriterPromptConfig;
  createdAt: number;
  updatedAt: number;
};

/** `outdated` marks works saved by an older Writer that can no longer be opened. */
export type WriterProjectSummary = { id: string; title: string; genre: string; updatedAt: number; chapterCount: number; wordCount: number; outdated?: boolean };

/** Chapter bodies keyed by chapter id. Only loaded chapters are present. */
export type ChapterTexts = Record<string, string>;
export type ProjectDraft = { project: WriterProject; texts: ChapterTexts };

export type WriterProjectField = "title" | "genre" | "audience" | "targetLength" | "language" | "worldview" | "background" | "outline" | "styleGuide";
export type WriterPatchOperation =
  | { type: "setProjectField"; field: WriterProjectField; value: string }
  | { type: "upsertVolume"; volume: WriterVolume }
  | { type: "upsertChapterMeta"; chapter: Partial<WriterChapterMeta> & { id: string } }
  | { type: "upsertCharacter"; character: WriterCharacter }
  | { type: "upsertFaction"; faction: WriterFaction }
  | { type: "upsertStoryNode"; node: WriterStoryNode }
  | { type: "upsertStoryEdge"; edge: WriterStoryEdge }
  | { type: "upsertCharacterRelation"; relation: WriterCharacterRelation }
  | { type: "removeCharacter"; id: string }
  | { type: "removeFaction"; id: string }
  | { type: "removeStoryNode"; id: string }
  | { type: "removeStoryEdge"; id: string }
  | { type: "removeCharacterRelation"; id: string }
  | { type: "setPromptConfig"; patch: Partial<WriterPromptConfig> };

export type ProposalTextChange = {
  id: string;
  kind: "text";
  doc: DocRef;
  title: string;
  summary: string;
  before: string;
  after: string;
  /** Present when the change creates a brand new chapter. */
  createChapter?: WriterChapterMeta;
};
export type ProposalEntityChange = { id: string; kind: "entity"; label: string; operation: WriterPatchOperation };
/** A change to the story plan (`story.json`). */
export type ProposalStoryChange = { id: string; kind: "story"; label: string; operation: StoryOperation };
/** A change to story memory threads (foreshadowing, expectations, mysteries). */
export type ProposalThreadChange = { id: string; kind: "thread"; label: string; operation: ThreadOperation };
export type ProposalChange = ProposalTextChange | ProposalEntityChange | ProposalStoryChange | ProposalThreadChange;
export type ProposalStatus = "pending" | "applied" | "partially_applied" | "rejected" | "superseded" | "reverted";

export type ProposalUndo = {
  /** Snapshot ids keyed by document key, captured right before the proposal was applied. */
  snapshots: Record<string, string>;
  /** Content hash of each document right after applying; undo only restores documents that are untouched since. */
  afterHashes: Record<string, string>;
  /** Operations that revert applied entity changes (previous entity values or removals of created ones). */
  inverseOperations: WriterPatchOperation[];
  /** Chapters created by the proposal; undo removes them when they are untouched since. */
  createdChapterIds: string[];
  inverseStoryOperations: StoryOperation[];
  inverseThreadOperations: ThreadOperation[];
};

/** Where a proposal came from, when not the assistant chat. */
export type ProposalSource = { kind: "pipeline"; runId: string; stepId: string } | null;

export type WriterProposal = {
  id: string;
  title: string;
  instruction: string;
  summary: string;
  previewMarkdown: string;
  risks: string[];
  changes: ProposalChange[];
  status: ProposalStatus;
  createdAt: number;
  appliedAt: number | null;
  appliedChangeIds: string[];
  undo: ProposalUndo | null;
  conversationId: string | null;
  source: ProposalSource;
};

/** Per change selection when applying a proposal. Missing entries mean "accept everything". */
export type ProposalSelection = Record<string, { accepted: boolean; hunks?: number[] }>;

export type SnapshotReason = "autosave" | "manual" | "before-ai" | "before-replace" | "before-delete" | "before-restore" | "import";
export type WriterSnapshot = { id: string; docKey: string; title: string; content: string; wordCount: number; reason: SnapshotReason; createdAt: number };
export type WriterSnapshotSummary = Omit<WriterSnapshot, "content">;

export type WriterExportResult = { path: string; files: string[] };

// ---- Agent bridge types (owned by the host SDK) ----
export type { AgentEventView, AgentSession, AgentSessionEntry, AgentSessionRun, AgentSessionSummary, AgentSessionToolCall, AgentTaskResponse } from "@daily/plugin-sdk";
export type AgentEventViewKind = AgentEventView["kind"];
export type AgentEventViewStatus = AgentEventView["status"];
export type DynamicAgentToolDefinition = AgentToolDefinition;
