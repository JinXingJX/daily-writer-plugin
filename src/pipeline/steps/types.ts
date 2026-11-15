import type { MemoryStatus } from "../../memory/schema";
import type { WriterProject } from "../../types";
import type { PipelineRun, PipelineStep, StepKind } from "../schema";

export type StepContext = {
  /** The project as of the start of the step. */
  project: WriterProject;
  run: PipelineRun;
  step: PipelineStep;
  signal: AbortSignal;
  /** Updates the step's progress (saved, throttled). */
  report: (done: number, total: number, message?: string) => Promise<void>;
  /** Picks up pause/cancel commands (throttled unless `force`); true once the step should stop. */
  checkStop: (force?: boolean) => Promise<boolean>;
  /** Artifact written by another step of this run (by kind). */
  artifactOf: <T>(kind: StepKind) => Promise<T | null>;
  /** This step's own artifact from an earlier, interrupted attempt. */
  ownArtifact: <T>() => Promise<T | null>;
  writeArtifact: (value: unknown) => Promise<void>;
  /** Story memory run status (failures, usage); memory steps update it and the engine saves it. */
  memoryStatus: MemoryStatus;
  publishMemory: () => Promise<void>;
};

/** `awaiting`: the step stops here until the author approves (its artifact holds what to review). */
export type StepOutcome = { summary: string; proposalId?: string | null; awaiting?: boolean };
export type StepExecutor = (context: StepContext) => Promise<StepOutcome>;
