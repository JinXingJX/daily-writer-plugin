import { dailyHost } from "../host";
import { asRecord, clampNumber } from "../domain/util";

export type EditorPrefs = { fontSize: number; lineHeight: number; pageWidth: number; typewriter: boolean; focusMode: boolean; showAssist: boolean; highlightEntities: boolean; markdownPreview: boolean; showRail: boolean };
export const DEFAULT_PREFS: EditorPrefs = { fontSize: 18, lineHeight: 2, pageWidth: 720, typewriter: false, focusMode: false, showAssist: true, highlightEntities: true, markdownPreview: false, showRail: true };
const PREFS_KEY = "writer.prefs.v1";

export async function loadPrefs(): Promise<EditorPrefs> {
  try {
    const stored = asRecord(await dailyHost().storage.get(PREFS_KEY));
    return {
      fontSize: clampNumber(stored.fontSize, DEFAULT_PREFS.fontSize, 13, 26),
      lineHeight: clampNumber(stored.lineHeight, DEFAULT_PREFS.lineHeight, 1.4, 2.6),
      pageWidth: clampNumber(stored.pageWidth, DEFAULT_PREFS.pageWidth, 520, 1200),
      typewriter: typeof stored.typewriter === "boolean" ? stored.typewriter : DEFAULT_PREFS.typewriter,
      focusMode: typeof stored.focusMode === "boolean" ? stored.focusMode : DEFAULT_PREFS.focusMode,
      showAssist: typeof stored.showAssist === "boolean" ? stored.showAssist : DEFAULT_PREFS.showAssist,
      highlightEntities: typeof stored.highlightEntities === "boolean" ? stored.highlightEntities : DEFAULT_PREFS.highlightEntities,
      markdownPreview: typeof stored.markdownPreview === "boolean" ? stored.markdownPreview : DEFAULT_PREFS.markdownPreview,
      showRail: typeof stored.showRail === "boolean" ? stored.showRail : DEFAULT_PREFS.showRail,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export async function savePrefs(prefs: EditorPrefs) { await dailyHost().storage.set(PREFS_KEY, prefs).catch(() => undefined); }

const LAST_PROJECT_KEY = "writer.lastProject.v1";
export async function loadLastProjectId(): Promise<string | null> {
  try { const value = await dailyHost().storage.get(LAST_PROJECT_KEY); return typeof value === "string" ? value : null; } catch { return null; }
}
export async function saveLastProjectId(projectId: string) { await dailyHost().storage.set(LAST_PROJECT_KEY, projectId).catch(() => undefined); }
