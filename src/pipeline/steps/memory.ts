// Story memory phases as pipeline steps. Work is derived from state (stale cards, stale summaries), so a step can stop
// at any point and run again later from where it left off.
import { chapterLabel, orderedChapters } from "../../domain/documents";
import { mapLimit } from "../../domain/util";
import { buildArc, buildBook, buildProfiles, buildVolume, buildWorldview, bookInputHash, judgeMerges, planArcs, volumeInputHash, worldviewInputHash } from "../../memory/aggregate";
import { detectConflicts } from "../../memory/conflicts";
import { extractChapterCard } from "../../memory/extract";
import { applyCardEntities, applyCardThreads, EntityRegistry, mergeCandidates, retractChapterThreads, syncBibleEntities } from "../../memory/ledger";
import type { ChapterCard, MemoryPhase, MemoryStatus } from "../../memory/schema";
import { MemoryStore } from "../../memory/store";
import { invalidateMemoryView, MemoryView } from "../../memory/view";
import { loadChapterText } from "../../storage/projectStore";
import { applyCardToStory, retractChapterFromStory } from "../../story/ledger";
import { loadStoryPlan, mutateStoryPlan } from "../../story/store";
import type { WriterProject } from "../../types";
import type { StepExecutor } from "./types";

const MAX_ATTEMPTS = 3;
const FLUSH_EVERY = 6;

export type MemoryPhaseContext = {
  project: WriterProject;
  store: MemoryStore;
  status: MemoryStatus;
  /** Limits extraction to these chapters; null: every stale chapter. */
  chapterIds: string[] | null;
  signal: AbortSignal;
  publish: () => Promise<void>;
  checkStop: () => Promise<boolean>;
};

/** Wraps a memory phase as a step executor; memory status mirrors the step for the memory views. */
function memoryStep(phase: MemoryPhase, run: (context: MemoryPhaseContext) => Promise<unknown>, summary: (status: MemoryStatus, result: unknown) => string): StepExecutor {
  return async (context) => {
    const status = context.memoryStatus;
    Object.assign(status, { state: "running", phase, done: 0, total: 0, message: context.step.label });
    const publish = async () => { await context.publishMemory(); await context.report(status.done, status.total, status.message); };
    await publish();
    const result = await run({ project: context.project, store: new MemoryStore(context.project.id), status, chapterIds: context.run.trigger.chapterIds, signal: context.signal, publish, checkStop: context.checkStop });
    if (context.signal.aborted) throw new DOMException("Aborted", "AbortError");
    invalidateMemoryView(context.project.id);
    return { summary: summary(status, result) };
  };
}

export const MEMORY_STEPS = {
  "memory.extract": memoryStep("extract", runExtract, (status, result) => `抽取了 ${Number(result) || 0} 章${Object.keys(status.failures).length ? `，${Object.keys(status.failures).length} 章失败` : ""}`),
  "memory.resolve": memoryStep("resolve", runResolve, () => "实体与线索已归并"),
  "memory.arcs": memoryStep("arcs", runArcs, (status) => (status.total ? `更新了 ${status.done} 段情节弧` : "情节弧已是最新")),
  "memory.volumes": memoryStep("volumes", runVolumes, (status) => (status.total ? `更新了 ${status.done} 卷` : "分卷汇总已是最新")),
  "memory.book": memoryStep("book", runBook, (status) => (status.total ? "全书大纲已更新" : "全书大纲已是最新")),
  "memory.worldview": memoryStep("worldview", runWorldview, (status) => (status.total ? "世界观与档案已更新" : "已是最新")),
  "memory.conflicts": memoryStep("conflicts", runConflicts, () => "冲突检测完成"),
} satisfies Record<string, StepExecutor>;

export async function runExtract({ project, store, status, chapterIds, signal, publish, checkStop }: MemoryPhaseContext): Promise<number> {
  let view = await MemoryView.load(project);
  // Cards of deleted chapters are retracted first.
  const removed = [...view.cards.keys()].filter((id) => !project.chapters.some((chapter) => chapter.id === id));
  if (removed.length) {
    await store.withLock(async () => {
      await store.removeCards(removed);
      let threads = await store.loadThreads();
      for (const id of removed) threads = retractChapterThreads(threads, id);
      await store.saveThreads(threads);
    });
    await mutateStoryPlan(project.id, (plan) => { for (const id of removed) retractChapterFromStory(plan, id); });
    view = await MemoryView.load(project);
  }
  const scope = chapterIds ? new Set(chapterIds) : null;
  const targets = view.staleChapterIds().filter((id) => (!scope || scope.has(id)) && (scope || (status.failures[id]?.attempts ?? 0) < MAX_ATTEMPTS));
  status.total = targets.length;
  await publish();
  if (!targets.length) return 0;

  const secrets = (await loadStoryPlan(project.id).catch(() => null))?.secrets.map((secret) => ({ id: secret.id, title: secret.title })) ?? [];
  const registry = new EntityRegistry(await store.loadEntities());
  syncBibleEntities(registry, project);
  const cards = new Map(view.cards);
  let threads = await store.loadThreads();
  const ordered = orderedChapters(project);
  const positions = new Map(ordered.map((chapter, index) => [chapter.id, index]));
  let buffer: ChapterCard[] = [];
  const flush = async () => {
    if (!buffer.length) return;
    const batch = buffer.sort((left, right) => (positions.get(left.chapterId) ?? 0) - (positions.get(right.chapterId) ?? 0));
    buffer = [];
    await store.withLock(async () => {
      await store.putCards(batch);
      for (const card of batch) { applyCardEntities(registry, card); threads = applyCardThreads(threads, card); }
      await store.saveEntities(registry.entities);
      await store.saveThreads(threads);
    });
    if (batch.some((card) => card.knowledge.some((entry) => entry.secretId) || card.intimacy.length)) {
      const view = await MemoryView.load(project);
      await mutateStoryPlan(project.id, (plan) => { for (const card of batch) applyCardToStory(plan, card, view); });
    }
    invalidateMemoryView(project.id);
    await publish();
  };

  await mapLimit(targets, project.settings.memoryConcurrency, async (chapterId) => {
    if (signal.aborted || (await checkStop())) return;
    const position = positions.get(chapterId) ?? 0;
    const chapter = ordered[position];
    try {
      const text = await loadChapterText(project.id, chapterId);
      const previous = position > 0 ? cards.get(ordered[position - 1].id) : undefined;
      const card = await extractChapterCard({
        chapterId,
        chapterLabel: chapterLabel(position),
        title: chapter.title,
        text,
        sourceHash: chapter.contentHash,
        previousSummary: previous?.summary ?? "",
        entities: registry.entities,
        openThreads: threads.filter((thread) => thread.status === "open"),
        secrets,
        signal,
      });
      cards.set(chapterId, card);
      buffer.push(card);
      delete status.failures[chapterId];
    } catch (error) {
      if (signal.aborted) return;
      const previous = status.failures[chapterId]?.attempts ?? 0;
      status.failures[chapterId] = { attempts: previous + 1, error: error instanceof Error ? error.message.slice(0, 200) : String(error) };
    }
    status.done += 1;
    status.message = `逐章抽取 ${status.done}/${status.total}`;
    if (buffer.length >= FLUSH_EVERY) await flush();
  });
  await flush();
  return targets.length;
}

export async function runResolve({ project, store, signal, status, publish }: MemoryPhaseContext) {
  const view = await MemoryView.load(project);
  const registry = new EntityRegistry(view.entities);
  syncBibleEntities(registry, project);
  const candidates = mergeCandidates(registry.entities);
  status.total = candidates.length ? 1 : 0;
  await publish();
  if (candidates.length) {
    const merges = await judgeMerges(candidates, view, signal);
    for (const [keepId, dropId] of merges) {
      const drop = registry.entities.find((entity) => entity.id === dropId);
      const keep = registry.entities.find((entity) => entity.id === keepId);
      if (drop?.origin === "user" && keep?.origin !== "user") registry.merge(dropId, keepId);
      else registry.merge(keepId, dropId);
    }
  }
  await store.withLock(() => store.saveEntities(registry.entities));
  status.done = status.total;
}

export async function runArcs({ project, store, status, signal, publish, checkStop }: MemoryPhaseContext) {
  const view = await MemoryView.load(project);
  const plans = planArcs(project, view.cards);
  const aggregates = await store.loadAggregates();
  const existing = new Map(aggregates.arcs.map((arc) => [arc.id, arc]));
  const stale = plans.filter((plan) => existing.get(plan.id)?.inputHash !== plan.inputHash);
  status.total = stale.length;
  await publish();
  const built = new Map(existing);
  await mapLimit(stale, project.settings.memoryConcurrency, async (plan) => {
    if (signal.aborted || (await checkStop())) return;
    built.set(plan.id, await buildArc(view, plan, signal));
    status.done += 1;
    status.message = `情节弧 ${status.done}/${status.total}`;
    if (status.done % 5 === 0) {
      await store.withLock(async () => { const latest = await store.loadAggregates(); await store.saveAggregates({ ...latest, arcs: plans.flatMap((item) => built.get(item.id) ?? []) }); });
      await publish();
    }
  });
  await store.withLock(async () => { const latest = await store.loadAggregates(); await store.saveAggregates({ ...latest, arcs: plans.flatMap((item) => built.get(item.id) ?? []) }); });
}

export async function runVolumes({ project, store, status, signal, publish }: MemoryPhaseContext) {
  const view = await MemoryView.load(project);
  const aggregates = view.aggregates;
  const targets = project.volumes.filter((volume) => {
    const arcs = aggregates.arcs.filter((arc) => arc.volumeId === volume.id);
    return arcs.length && aggregates.volumes.find((item) => item.volumeId === volume.id)?.inputHash !== volumeInputHash(arcs);
  });
  status.total = targets.length;
  await publish();
  const volumes = new Map(aggregates.volumes.filter((item) => project.volumes.some((volume) => volume.id === item.volumeId)).map((item) => [item.volumeId, item]));
  for (const volume of targets) {
    if (signal.aborted) return;
    volumes.set(volume.id, await buildVolume(view, volume.id, aggregates.arcs.filter((arc) => arc.volumeId === volume.id), signal));
    status.done += 1;
    await store.withLock(async () => { const latest = await store.loadAggregates(); await store.saveAggregates({ ...latest, volumes: [...volumes.values()] }); });
    await publish();
  }
}

export async function runBook({ project, store, status, signal, publish }: MemoryPhaseContext) {
  const view = await MemoryView.load(project);
  const volumes = view.aggregates.volumes;
  if (!volumes.length || view.aggregates.book?.inputHash === bookInputHash(volumes)) return;
  status.total = 1;
  await publish();
  const book = await buildBook(view, volumes, signal);
  await store.withLock(async () => { const latest = await store.loadAggregates(); await store.saveAggregates({ ...latest, book }); });
  status.done = 1;
}

export async function runWorldview({ project, store, status, signal, publish }: MemoryPhaseContext) {
  let view = await MemoryView.load(project);
  if (!view.cards.size || view.aggregates.worldview?.inputHash === worldviewInputHash(view)) return;
  status.total = 2;
  status.message = "生成人物与实体档案";
  await publish();
  const profiles = await buildProfiles(view, 40, signal);
  await store.withLock(async () => {
    const entities = await store.loadEntities();
    for (const entity of entities) { const summary = profiles.get(entity.id); if (summary && entity.origin === "extracted") { entity.summary = summary; entity.updatedAt = Date.now(); } }
    await store.saveEntities(entities);
  });
  status.done = 1;
  status.message = "汇总世界观";
  await publish();
  view = await MemoryView.load(project);
  const worldview = await buildWorldview(view, signal);
  await store.withLock(async () => { const latest = await store.loadAggregates(); await store.saveAggregates({ ...latest, worldview }); });
  status.done = 2;
}

export async function runConflicts({ project, store, status }: MemoryPhaseContext) {
  const view = await MemoryView.load(project);
  await store.withLock(async () => store.saveConflicts(detectConflicts(view, await store.loadConflicts())));
  status.done = status.total = 1;
}
