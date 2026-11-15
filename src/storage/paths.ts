import { docKey } from "../domain/documents";
import { projectIdValue } from "../domain/ids";
import type { DocRef } from "../types";

export const PROJECTS_DIR = "projects";
export const INDEX_PATH = `${PROJECTS_DIR}/index.json`;
export const RUNS_DIR = "runs";

export function projectDir(projectId: string) { return `${PROJECTS_DIR}/${projectIdValue(projectId)}`; }
export function projectFile(projectId: string) { return `${projectDir(projectId)}/project.json`; }
export function chaptersDir(projectId: string) { return `${projectDir(projectId)}/chapters`; }
export function chapterFile(projectId: string, chapterId: string) { return `${chaptersDir(projectId)}/${chapterId}.md`; }
export function snapshotsDir(projectId: string) { return `${projectDir(projectId)}/snapshots`; }
export function snapshotFile(projectId: string, ref: DocRef) { return `${snapshotsDir(projectId)}/${docKey(ref).replace(":", "-")}.json`; }
export function statsFile(projectId: string) { return `${projectDir(projectId)}/stats.json`; }
export function exportManifestFile(projectId: string) { return `${projectDir(projectId)}/export-manifest.json`; }
export function memoryDir(projectId: string) { return `${projectDir(projectId)}/memory`; }
/** Author notebook: notes and cached AI briefings / reader snapshots. */
export function notebookFile(projectId: string) { return `${projectDir(projectId)}/notebook.json`; }
/** Story plan: promise, powers, secrets, relation tracks, volume plans, diagnostic thresholds. */
export function storyFile(projectId: string) { return `${projectDir(projectId)}/story.json`; }
/** AI proposals (pending and history), kept out of project.json so autosave does not rewrite them. */
export function proposalsFile(projectId: string) { return `${projectDir(projectId)}/proposals.json`; }
export function ideasFile(projectId: string) { return `${projectDir(projectId)}/ideas.json`; }
/** Style samples: `index.json` lists them, each text in its own file. */
export function samplesDir(projectId: string) { return `${projectDir(projectId)}/samples`; }
/** Background pipeline runs: `index.json`, one file per run and per-step artifacts. */
export function pipelineDir(projectId: string) { return `${projectDir(projectId)}/pipeline`; }
