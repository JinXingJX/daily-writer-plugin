import { viewIsVisible, onViewVisibilityChange, whileViewVisible } from "../view";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { dailyHost } from "../host";
import type { TaskSnapshot } from "@daily/plugin-sdk";
import { observeWriterTasks } from "./taskObserver";
import { docKey, docTitle, orderedChapters, readDoc, refreshChapterDerived, rootDocInfo, sameDoc, totalWords } from "../domain/documents";
import { uniqueId } from "../domain/ids";
import { mergeDraft } from "../domain/merge";
import { normalizeChapterMeta, normalizeVolume } from "../domain/normalize";
import { removeChapter, removeVolume } from "../domain/operations";
import { rankAfter, rankBetween, rebalanceIfNeeded } from "../domain/ranks";
import { unixTimestamp } from "../domain/util";
import { AUTO_PHASES, emptyStatus, type MemoryStatus } from "../memory/schema";
import type { PipelineCommand, RunSummary } from "../pipeline/schema";
import { listRuns, sendCommand } from "../pipeline/store";
import { startMemoryRun, startPublishRun } from "../pipeline/templates";
import type { StoryPlan } from "../story/schema";
import { loadStoryPlan, mutateStoryPlan } from "../story/store";
import { MemoryStore } from "../memory/store";
import { loadMemoryView, type MemoryView } from "../memory/view";
import { DEFAULT_PREFS, loadLastProjectId, loadPrefs, saveLastProjectId, savePrefs, type EditorPrefs } from "../storage/prefs";
import { createProject, listProjects, loadChapterText, openProject, saveDraft, type CreateProjectInput } from "../storage/projectStore";
import { createSnapshot } from "../storage/snapshots";
import { readStats, recordWordTotal, type WritingStats } from "../storage/stats";
import { loadProposals } from "../storage/proposalStore";
import type { ChapterTexts, DocRef, ProjectDraft, WriterChapterMeta, WriterProject, WriterProjectSummary, WriterProposal } from "../types";

/** Three rooms for the book (write, story, archive), the editor's office, and two full-page tasks. */
export type ViewMode = "write" | "story" | "archive" | "bureau" | "review" | "studio";
export type StoryLens = "score" | "threads" | "board" | "map" | "atlas" | "promise" | "volumes" | "secrets" | "relations" | "reader" | "notes" | "brief";
export type ArchiveLens = "people" | "bible" | "world" | "outline" | "conflicts" | "impact" | "search" | "memory";
export type SaveState = "saved" | "dirty" | "saving" | "error";
export type Notice = { id: string; tone: "info" | "success" | "error"; text: string; action?: { label: string; run: () => void } };
export type AssistTab = "notes" | "chat" | "chapter";
/** A request to show the margin on a tab; `nonce` makes repeated requests distinct. */
/** `message` prefills the composer; with `send` it is sent to the agent right away. `refineId` names a proposal the next message revises. */
export type AssistRequest = { tab: AssistTab; focus: boolean; nonce: number; message?: string; send?: boolean; refineId?: string };

const AUTOSAVE_DELAY = 1_500;
const AUTO_MEMORY_IDLE_MS = 5 * 60_000;

export function useWriterController() {
  const [projects, setProjects] = useState<WriterProjectSummary[]>([]);
  const [draft, setDraftState] = useState<ProjectDraft | null>(null);
  const [active, setActive] = useState<DocRef>({ kind: "outline" });
  const [view, setView] = useState<ViewMode>("write");
  const [storyLens, setStoryLens] = useState<StoryLens>("score");
  const [archiveLens, setArchiveLens] = useState<ArchiveLens>("people");
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [toneOpen, setToneOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [prefs, setPrefsState] = useState<EditorPrefs>(DEFAULT_PREFS);
  const [memory, setMemory] = useState<MemoryView | null>(null);
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatus>(emptyStatus());
  const [stats, setStats] = useState<WritingStats>({ days: {} });
  const [loading, setLoading] = useState(true);
  const [proposals, setProposals] = useState<WriterProposal[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [tasks, setTasks] = useState<TaskSnapshot[]>([]);
  const [story, setStory] = useState<StoryPlan | null>(null);
  const runsRef = useRef<RunSummary[]>([]);
  const [assistRequest, setAssistRequest] = useState<AssistRequest | null>(null);

  const baseRef = useRef<ProjectDraft | null>(null);
  const draftRef = useRef<ProjectDraft | null>(null);
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const savingRef = useRef<Promise<void> | null>(null);
  const lastEditRef = useRef<Map<string, number>>(new Map());

  const notify = useCallback((tone: Notice["tone"], text: string, action?: Notice["action"]) => {
    const notice = { id: uniqueId("notice"), tone, text, action };
    // A repeating failure (autosave retries, polling) refreshes one notice instead of stacking copies.
    setNotices((current) => [...current.filter((item) => item.text !== text).slice(-3), notice]);
    if (tone !== "error") globalThis.setTimeout(() => setNotices((current) => current.filter((item) => item.id !== notice.id)), action ? 9_000 : 4_000);
  }, []);
  const dismiss = useCallback((id: string) => setNotices((current) => current.filter((item) => item.id !== id)), []);

  const setBoth = useCallback((next: ProjectDraft) => {
    baseRef.current = next;
    draftRef.current = next;
    dirtyRef.current = false;
    setDraftState(next);
    setSaveState("saved");
  }, []);

  // ---------- saving ----------
  const runSave = useCallback(async (reason: "autosave" | "manual") => {
    const base = baseRef.current;
    const sent = draftRef.current;
    if (!base || !sent || !dirtyRef.current) return;
    dirtyRef.current = false;
    setSaveState("saving");
    try {
      const result = await saveDraft(base, sent);
      baseRef.current = result.draft;
      const working = draftRef.current;
      const next = working === sent ? result.draft : mergeDraft(sent, working as ProjectDraft, result.draft).merged;
      draftRef.current = next;
      setDraftState(next);
      if (working !== sent) dirtyRef.current = true;
      setSaveState(dirtyRef.current ? "dirty" : "saved");
      if (result.conflicts.length) notify("error", `以下内容已在其他窗口被修改，已保留较新的版本（你的版本已存入历史）：${result.conflicts.map((item) => item.label).join("、")}`);
      const project = result.draft.project;
      void recordWordTotal(project.id, totalWords(project)).then(setStats).catch(() => undefined);
      for (const id of Object.keys(sent.texts)) {
        if (sent.texts[id] !== base.texts[id]) {
          const ref: DocRef = { kind: "chapter", id };
          void createSnapshot(project.id, ref, docTitle(project, ref), result.draft.texts[id] ?? sent.texts[id], reason === "manual" ? "manual" : "autosave").catch(() => undefined);
        }
      }
      for (const doc of ["worldview", "background", "outline", "style"] as const) {
        const field = rootDocInfo(doc).field;
        if (sent.project[field] !== base.project[field]) void createSnapshot(project.id, { kind: doc }, rootDocInfo(doc).label, project[field], reason === "manual" ? "manual" : "autosave").catch(() => undefined);
      }
    } catch (error) {
      dirtyRef.current = true;
      setSaveState("error");
      notify("error", `保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [notify]);

  const flush = useCallback(async (reason: "autosave" | "manual" = "autosave") => {
    if (timerRef.current) { globalThis.clearTimeout(timerRef.current); timerRef.current = null; }
    while (savingRef.current) await savingRef.current;
    if (!dirtyRef.current) return;
    const promise = runSave(reason).finally(() => { savingRef.current = null; });
    savingRef.current = promise;
    await promise;
  }, [runSave]);

  const scheduleSave = useCallback(() => {
    if (timerRef.current) globalThis.clearTimeout(timerRef.current);
    timerRef.current = globalThis.setTimeout(() => { timerRef.current = null; void flush(); }, AUTOSAVE_DELAY) as unknown as number;
  }, [flush]);

  /** Applies a local edit to the working draft and schedules an autosave. */
  const setDraft = useCallback((update: (current: ProjectDraft) => ProjectDraft) => {
    const current = draftRef.current;
    if (!current) return;
    const next = update(current);
    if (next === current) return;
    draftRef.current = next;
    dirtyRef.current = true;
    setDraftState(next);
    setSaveState("dirty");
    scheduleSave();
  }, [scheduleSave]);

  const mutateProject = useCallback((mutate: (project: WriterProject) => void) => {
    setDraft((current) => { const project = structuredClone(current.project); mutate(project); return { project, texts: current.texts }; });
  }, [setDraft]);

  /** Replaces state with what the server returned after a server-side mutation (call `flush` first). */
  const adopt = useCallback((project: WriterProject, texts: ChapterTexts = {}) => {
    const base = baseRef.current;
    setBoth({ project, texts: { ...(base?.texts ?? {}), ...texts } });
  }, [setBoth]);

  const refreshBackgroundResults = useCallback(async () => {
    const base = baseRef.current;
    if (!base) return;
    const project = await openProject(base.project.id);
    const current = draftRef.current;
    if (!current || current.project.id !== project.id) return;
    const remote = { project, texts: base.texts };
    const merged = mergeDraft(base, current, remote).merged;
    baseRef.current = remote;
    draftRef.current = merged;
    setDraftState(merged);
  }, []);

  const refreshStory = useCallback(async () => {
    const projectId = draftRef.current?.project.id;
    if (!projectId) return;
    const plan = await loadStoryPlan(projectId).catch(() => null);
    if (draftRef.current?.project.id === projectId) setStory(plan);
  }, []);

  /** Author edits of the story plan are saved right away (they are the author's own decisions, not AI proposals). */
  const updateStory = useCallback(async (mutate: (plan: StoryPlan) => void) => {
    const projectId = draftRef.current?.project.id;
    if (!projectId) return;
    try { setStory((await mutateStoryPlan(projectId, mutate)).plan); }
    catch (error) { notify("error", `保存故事规划失败：${error instanceof Error ? error.message : String(error)}`); }
  }, [notify]);

  /** Re-reads proposals from disk (after background runs created some). */
  const reloadProposals = useCallback(async () => {
    const projectId = draftRef.current?.project.id;
    if (!projectId) return;
    const list = await loadProposals(projectId);
    if (draftRef.current?.project.id === projectId) setProposals(list);
  }, []);

  useEffect(() => { void dailyHost().host.setDirty(saveState === "dirty" || saveState === "saving" || saveState === "error").catch(() => undefined); }, [saveState]);
  useEffect(() => () => { void dailyHost().host.setDirty(false).catch(() => undefined); }, []);
  useEffect(() => {
    const onHide = () => { if (!viewIsVisible()) void flush(); };
    const off = onViewVisibilityChange(onHide);
    globalThis.addEventListener("blur", onHide);
    return () => { off(); globalThis.removeEventListener("blur", onHide); };
  }, [flush]);

  // ---------- documents ----------
  // In-flight body loads, so repeated renders asking for the same chapter share one request.
  const loadingTextRef = useRef<Map<string, Promise<void>>>(new Map());
  const ensureText = useCallback((chapterId: string): Promise<void> => {
    const current = draftRef.current;
    if (!current || current.texts[chapterId] !== undefined) return Promise.resolve();
    const inflight = loadingTextRef.current.get(chapterId);
    if (inflight) return inflight;
    const projectId = current.project.id;
    const promise = (async () => {
      const text = await loadChapterText(projectId, chapterId);
      if (draftRef.current?.project.id !== projectId) return;
      const base = baseRef.current;
      if (base && base.texts[chapterId] === undefined) baseRef.current = { project: base.project, texts: { ...base.texts, [chapterId]: text } };
      const latest = draftRef.current;
      if (latest && latest.texts[chapterId] === undefined) {
        const next = { project: latest.project, texts: { ...latest.texts, [chapterId]: text } };
        draftRef.current = next;
        setDraftState(next);
      }
    })().finally(() => loadingTextRef.current.delete(chapterId));
    loadingTextRef.current.set(chapterId, promise);
    return promise;
  }, []);

  const selectDoc = useCallback((ref: DocRef) => {
    setActive(ref);
    setView("write");
    if (ref.kind === "chapter") void ensureText(ref.id).catch(() => undefined);
    void flush();
  }, [ensureText, flush]);

  const editText = useCallback((ref: DocRef, text: string) => {
    if (ref.kind === "chapter") lastEditRef.current.set(ref.id, Date.now());
    setDraft((current) => {
      if (readDoc(current.project, current.texts, ref) === text) return current;
      if (ref.kind !== "chapter") return { project: { ...current.project, [rootDocInfo(ref.kind).field]: text }, texts: current.texts };
      const chapters = current.project.chapters.map((chapter) => {
        if (chapter.id !== ref.id) return chapter;
        const copy = { ...chapter };
        refreshChapterDerived(copy, text);
        return copy;
      });
      return { project: { ...current.project, chapters }, texts: { ...current.texts, [ref.id]: text } };
    });
  }, [setDraft]);

  const updateChapter = useCallback((chapterId: string, patch: Partial<WriterChapterMeta>) => {
    setDraft((current) => ({ project: { ...current.project, chapters: current.project.chapters.map((chapter) => (chapter.id === chapterId ? { ...chapter, ...patch, id: chapter.id } : chapter)) }, texts: current.texts }));
  }, [setDraft]);

  const addChapter = useCallback((options: { volumeId?: string; afterId?: string; title?: string; content?: string } = {}) => {
    const current = draftRef.current;
    if (!current) return null;
    const chapters = orderedChapters(current.project);
    const after = options.afterId ? chapters.find((chapter) => chapter.id === options.afterId) : undefined;
    const volumeId = after?.volumeId ?? options.volumeId ?? (chapters[chapters.length - 1]?.volumeId ?? current.project.volumes[0].id);
    const inVolume = chapters.filter((chapter) => chapter.volumeId === volumeId);
    const anchor = after ?? inVolume[inVolume.length - 1];
    const next = anchor ? inVolume[inVolume.indexOf(anchor) + 1] : undefined;
    const meta = normalizeChapterMeta({ id: uniqueId("chapter"), volumeId, title: options.title ?? `第 ${chapters.length + 1} 章`, rank: anchor ? rankBetween(anchor.rank, next?.rank) : rankAfter(undefined), status: "draft", updatedAt: unixTimestamp() });
    const content = options.content ?? "";
    refreshChapterDerived(meta, content);
    setDraft((draftValue) => ({ project: { ...draftValue.project, chapters: rebalanceIfNeeded([...draftValue.project.chapters, meta], volumeId) }, texts: { ...draftValue.texts, [meta.id]: content } }));
    setActive({ kind: "chapter", id: meta.id });
    setView("write");
    return meta.id;
  }, [setDraft]);

  const moveChapter = useCallback((chapterId: string, volumeId: string, beforeId: string | null) => {
    setDraft((current) => {
      const chapters = orderedChapters(current.project).filter((chapter) => chapter.volumeId === volumeId && chapter.id !== chapterId);
      const beforeIndex = beforeId ? chapters.findIndex((chapter) => chapter.id === beforeId) : chapters.length;
      const prev = chapters[beforeIndex - 1];
      const next = chapters[beforeIndex];
      const rank = rankBetween(prev?.rank, next?.rank);
      const list = current.project.chapters.map((chapter) => (chapter.id === chapterId ? { ...chapter, volumeId, rank } : chapter));
      return { project: { ...current.project, chapters: rebalanceIfNeeded(list, volumeId) }, texts: current.texts };
    });
  }, [setDraft]);

  const deleteChapter = useCallback(async (chapterId: string) => {
    const current = draftRef.current;
    if (!current) return;
    const ref: DocRef = { kind: "chapter", id: chapterId };
    const text = current.texts[chapterId] ?? (await loadChapterText(current.project.id, chapterId));
    if (text) await createSnapshot(current.project.id, ref, docTitle(current.project, ref), text, "before-delete", { force: true });
    if (!draftRef.current?.texts[chapterId] && baseRef.current) baseRef.current = { project: baseRef.current.project, texts: { ...baseRef.current.texts, [chapterId]: text } };
    const order = orderedChapters(current.project);
    const at = order.findIndex((chapter) => chapter.id === chapterId);
    const neighbour = order[at + 1] ?? order[at - 1];
    setDraft((draftValue) => {
      const project = structuredClone(draftValue.project);
      removeChapter(project, chapterId);
      const texts = { ...draftValue.texts };
      delete texts[chapterId];
      return { project, texts };
    });
    // Keep writing in the neighbouring chapter rather than jumping to the outline.
    const fallback: DocRef = neighbour ? { kind: "chapter", id: neighbour.id } : { kind: "outline" };
    setActive((activeRef) => (sameDoc(activeRef, ref) ? fallback : activeRef));
    if (neighbour) void ensureText(neighbour.id).catch(() => undefined);
    notify("info", "章节已删除，正文已保存在“历史版本”中。");
  }, [ensureText, notify, setDraft]);

  const addVolume = useCallback((title: string) => {
    mutateProject((project) => { project.volumes.push(normalizeVolume({ id: uniqueId("volume"), title, rank: rankAfter(Math.max(0, ...project.volumes.map((volume) => volume.rank)) || undefined) })); });
  }, [mutateProject]);

  const deleteVolume = useCallback((volumeId: string) => {
    mutateProject((project) => {
      const target = project.volumes.find((volume) => volume.id !== volumeId);
      if (target) removeVolume(project, volumeId, target.id);
    });
  }, [mutateProject]);

  // ---------- projects ----------
  const refreshMemory = useCallback(async (force = false) => {
    const project = draftRef.current?.project;
    if (!project) return;
    try {
      const next = await loadMemoryView(project, force);
      setMemory(next);
      setMemoryStatus(next.status);
    } catch { /* memory is optional */ }
  }, []);

  const openProjectById = useCallback(async (projectId: string) => {
    await flush();
    if (dirtyRef.current && draftRef.current?.project.id !== projectId) {
      // Switching now would drop the edits that just failed to save.
      notify("error", "当前作品还有未保存的修改，已取消切换。请先解决保存问题。", { label: "重试保存", run: () => void flush("manual") });
      return;
    }
    setLoading(true);
    try {
      const project = await openProject(projectId);
      const chapters = orderedChapters(project);
      const first: DocRef = chapters.length ? { kind: "chapter", id: chapters[chapters.length - 1].id } : { kind: "outline" };
      const texts: ChapterTexts = {};
      if (first.kind === "chapter") texts[first.id] = await loadChapterText(project.id, first.id);
      setBoth({ project, texts });
      setProposals(await loadProposals(project.id));
      setStory(await loadStoryPlan(project.id).catch(() => null));
      runsRef.current = [];
      setRuns(await listRuns(project.id).catch(() => []));
      setActive(first);
      setView("write");
      setMemory(null);
      void saveLastProjectId(project.id);
      void recordWordTotal(project.id, totalWords(project)).then(setStats).catch(() => void readStats(project.id).then(setStats).catch(() => undefined));
      void refreshMemory(true);
    } catch (error) {
      notify("error", `打开项目失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [flush, notify, refreshMemory, setBoth]);

  const reloadProjects = useCallback(async () => {
    const list = await listProjects();
    setProjects(list);
    return list;
  }, []);

  const createNewProject = useCallback(async (input: CreateProjectInput = {}) => {
    await flush();
    const project = await createProject(input);
    await reloadProjects();
    await openProjectById(project.id);
  }, [flush, openProjectById, reloadProjects]);

  useEffect(() => {
    void (async () => {
      setPrefsState(await loadPrefs());
      try {
        const list = await reloadProjects();
        const last = await loadLastProjectId();
        const target = list.find((item) => item.id === last && !item.outdated)?.id ?? list.find((item) => !item.outdated)?.id;
        const outdated = list.filter((item) => item.outdated).length;
        if (outdated) notify("info", `有 ${outdated} 部作品是旧版 Writer 的格式，新版不再读取。请用“导入”重新导入它们的正文。`);
        if (target) await openProjectById(target); else setLoading(false);
      } catch (error) {
        notify("error", `加载 Writer 失败：${error instanceof Error ? error.message : String(error)}`);
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setPrefs = useCallback((update: Partial<EditorPrefs>) => {
    setPrefsState((current) => { const next = { ...current, ...update }; void savePrefs(next); return next; });
  }, []);

  /** Shows the assistant (docked or as an overlay on narrow windows) on the given tab. */
  const openAssist = useCallback((tab: AssistTab = "chat", focus = false, message?: { text: string; send?: boolean; refineId?: string }) => {
    setPrefs({ showAssist: true, focusMode: false });
    // Full-page tasks have no margin; the conversation continues back at the page.
    setView((current) => (current === "review" || current === "bureau" ? "write" : current));
    setAssistRequest({ tab, focus, nonce: Date.now() + Math.random(), message: message?.text, send: message?.send, refineId: message?.refineId });
  }, [setPrefs]);

  const openStory = useCallback((lens: StoryLens = "score") => { setStoryLens(lens); setView("story"); }, []);
  const openArchive = useCallback((lens: ArchiveLens = "people") => { setArchiveLens(lens); setView("archive"); }, []);
  /** Opens a proposal on the page, change by change. */
  const openReview = useCallback((proposalId: string) => { setReviewId(proposalId); setView("review"); }, []);

  // ---------- background pipeline ----------
  // Execution is owned by the independent background runtime; this view only observes.
  const projectId = draft?.project.id;
  const viewRef = useRef<(view: ViewMode) => void>(() => undefined);
  viewRef.current = setView;
  useEffect(() => {
    if (!projectId) return;
    let stopped = false;
    let polling = false;
    let lastMemoryState = "";
    const store = new MemoryStore(projectId);
    const tick = async () => {
      if (stopped || polling || !viewIsVisible()) return;
      polling = true;
      try {
        const [status, list] = await Promise.all([store.loadStatus(), listRuns(projectId)]);
        if (stopped) return;
        setMemoryStatus(status);
        if (lastMemoryState === "running" && status.state !== "running") void refreshMemory(true);
        lastMemoryState = status.state;
        const previous = new Map(runsRef.current.map((run) => [run.id, run]));
        const changed = list.length !== runsRef.current.length || list.some((run) => previous.get(run.id)?.updatedAt !== run.updatedAt);
        if (changed) {
          for (const run of list) {
            const before = previous.get(run.id);
            if (!before || before.state === run.state) continue;
            if (run.state === "awaiting") notify("info", `${run.title}：有一步等你确认。`, { label: "去看看", run: () => viewRef.current("bureau") });
            else if (run.state === "done" && run.template === "publish") notify("success", `${run.title}：已完成，生成的建议在“朱批”里。`, { label: "查看", run: () => viewRef.current("bureau") });
            else if (run.state === "error") notify("error", `${run.title}：${run.message || "出错了"}`, { label: "查看", run: () => viewRef.current("bureau") });
          }
          if (runsRef.current.length && list.some((run) => previous.get(run.id)?.done !== run.done)) { void reloadProposals(); void refreshMemory(true); void refreshStory(); }
          runsRef.current = list;
          setRuns(list);
        }

      } catch { /* retried on the next tick */ }
      finally { polling = false; }
    };
    const interval = globalThis.setInterval(() => { void tick(); }, 3_000);
    void tick();
    const off = onViewVisibilityChange(() => { void tick(); });
    return () => { stopped = true; off(); globalThis.clearInterval(interval); };
  }, [projectId, refreshMemory, reloadProposals, refreshStory, notify]);

  /** Publishes a chapter: marks it final, saves, and starts the publish pipeline. */
  const publishChapter = useCallback(async (chapterId: string) => {
    updateChapter(chapterId, { status: "final" });
    await flush("manual");
    const project = draftRef.current?.project;
    if (!project) return null;
    const run = await startPublishRun(project, chapterId);
    setRuns(await listRuns(project.id));
    return run;
  }, [flush, updateChapter]);

  const pipelineCommand = useCallback(async (command: Omit<PipelineCommand, "id" | "at">) => {
    const id = draftRef.current?.project.id;
    if (!id) return;
    await sendCommand(id, command);
  }, []);

  // Background memory upkeep: chapters idle for a while get re-extracted, once memory exists.
  useEffect(() => {
    if (!projectId) return;
    const interval = globalThis.setInterval(() => {
      const project = draftRef.current?.project;
      if (!project?.settings.autoMemory || !memory || memory.isEmpty || memoryStatus.state === "running") return;
      const now = Date.now();
      const stale = new Set(memory.withProject(project).staleChapterIds());
      const ready = [...lastEditRef.current].filter(([id, at]) => now - at > AUTO_MEMORY_IDLE_MS && stale.has(id)).map(([id]) => id);
      if (!ready.length) return;
      for (const id of ready) lastEditRef.current.delete(id);
      void startMemoryRun(project.id, AUTO_PHASES, ready);
    }, 60_000);
    return () => globalThis.clearInterval(interval);
  }, [projectId, memory, memoryStatus.state]);

  useEffect(() => {
    if (!projectId) { setTasks([]); return; }
    return whileViewVisible(() => observeWriterTasks(projectId, setTasks, async () => {
      const results = await Promise.allSettled([reloadProposals(), refreshBackgroundResults(), refreshStory()]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    }, (error) => notify("error", `读取后台任务失败：${error instanceof Error ? error.message : String(error)}`)));
  }, [projectId, reloadProposals, refreshBackgroundResults, refreshStory, notify]);

  const closeProject = useCallback(() => {
    if (timerRef.current) globalThis.clearTimeout(timerRef.current);
    timerRef.current = null;
    baseRef.current = null;
    draftRef.current = null;
    dirtyRef.current = false;
    setDraftState(null);
    setSaveState("saved");
    setMemory(null);
    setStory(null);
    setProposals([]);
    setRuns([]);
  }, []);

  const project = draft?.project ?? null;
  const memoryView = useMemo(() => (memory && project ? memory.withProject(project) : null), [memory, project]);

  return {
    projects, project, draft, active, view, saveState, notices, prefs, memory: memoryView, memoryStatus, stats, loading, assistRequest, proposals, runs, tasks,
    publishChapter, pipelineCommand, story, refreshStory, updateStory,
    setView, storyLens, setStoryLens, archiveLens, setArchiveLens, openStory, openArchive, reviewId, openReview, toneOpen, setToneOpen, openAssist, selectDoc, editText, updateChapter, addChapter, moveChapter, deleteChapter, addVolume, deleteVolume, mutateProject, setDraft,
    flush, adopt, setProposals, reloadProposals, refreshBackgroundResults, ensureText, notify, dismiss, setPrefs, openProjectById, createNewProject, reloadProjects, refreshMemory,
    closeProject, getDraft: () => draftRef.current,
  };
}

export type WriterController = ReturnType<typeof useWriterController>;
export const WriterContext = createContext<WriterController | null>(null);
export function useWriter(): WriterController {
  const value = useContext(WriterContext);
  if (!value) throw new Error("WriterContext missing");
  return value;
}

export function activeText(controller: WriterController): string | undefined {
  return controller.draft ? readDoc(controller.draft.project, controller.draft.texts, controller.active) : undefined;
}

export { docKey };
