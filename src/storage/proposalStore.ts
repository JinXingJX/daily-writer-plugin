import { docExists, docKey, docTitle, readDoc, writeDoc } from "../domain/documents";
import { contentHash } from "../domain/ids";
import { normalizeChapterMeta, normalizeProposals, PROPOSAL_LIMIT } from "../domain/normalize";
import { applyOperation, removeChapter } from "../domain/operations";
import { isChangeAccepted, selectedTextResult } from "../domain/proposals";
import { rankAfter } from "../domain/ranks";
import { unixTimestamp } from "../domain/util";
import { applyThreadOperation, inverseThreadOperation } from "../memory/operations";
import type { ThreadOperation } from "../memory/schema";
import { MemoryStore } from "../memory/store";
import { invalidateMemoryView } from "../memory/view";
import { applyStoryOperation, inverseStoryOperation } from "../story/operations";
import type { StoryOperation } from "../story/schema";
import { loadStoryPlan, saveStoryPlan, withStoryLock } from "../story/store";
import type { ChapterTexts, DocRef, ProposalSelection, ProposalUndo, WriterPatchOperation, WriterProject, WriterProposal } from "../types";
import { readJson, removeFile, writeJson, writeText } from "./io";
import { withWriterMutationLock } from "./lock";
import { chapterFile, proposalsFile } from "./paths";
import { loadChapterText, mutateProject } from "./projectStore";
import { createSnapshot, readSnapshot } from "./snapshots";

export type ApplyFailure = { changeId: string; title: string; reason: string };
export type ApplyResult = { project: WriterProject; texts: ChapterTexts; proposals: WriterProposal[]; failures: ApplyFailure[] };

export async function loadProposals(projectId: string): Promise<WriterProposal[]> {
  return normalizeProposals(await readJson(proposalsFile(projectId)).catch(() => undefined));
}

async function saveProposals(projectId: string, proposals: WriterProposal[]) {
  await writeJson(proposalsFile(projectId), { proposals: proposals.slice(-PROPOSAL_LIMIT) });
}

/** Read-modify-write of the proposal list under the writer lock. */
async function mutateProposals(projectId: string, mutate: (proposals: WriterProposal[]) => void | Promise<void>): Promise<WriterProposal[]> {
  return withWriterMutationLock(async () => {
    const proposals = await loadProposals(projectId);
    await mutate(proposals);
    await saveProposals(projectId, proposals);
    return proposals.slice(-PROPOSAL_LIMIT);
  });
}

export async function appendProposal(projectId: string, proposal: WriterProposal, supersedes?: string): Promise<WriterProposal[]> {
  return mutateProposals(projectId, (proposals) => {
    if (supersedes) {
      const previous = proposals.find((item) => item.id === supersedes);
      if (previous?.status === "pending") previous.status = "superseded";
    }
    if (!proposals.some((item) => item.id === proposal.id)) proposals.push(proposal);
  });
}

export async function setProposalStatus(projectId: string, proposalId: string, status: "rejected" | "superseded"): Promise<WriterProposal[]> {
  return mutateProposals(projectId, (proposals) => {
    const proposal = proposals.find((item) => item.id === proposalId);
    if (proposal?.status === "pending") proposal.status = status;
  });
}

/** Runs `task` with the project and the proposal list loaded, under the writer lock; both are written back. */
async function withProjectAndProposals<T>(projectId: string, task: (project: WriterProject, proposals: WriterProposal[]) => Promise<T>) {
  let proposals: WriterProposal[] = [];
  const { project, result } = await mutateProject(projectId, async (project) => {
    proposals = await loadProposals(projectId);
    const value = await task(project, proposals);
    await saveProposals(projectId, proposals);
    return value;
  });
  return { project, proposals: proposals.slice(-PROPOSAL_LIMIT), result };
}

/** Applies the selected changes of a pending proposal. Conflicting changes fail individually; the rest are applied. */
export async function applyProposal(projectId: string, proposalId: string, selection?: ProposalSelection): Promise<ApplyResult> {
  const { project, proposals, result } = await withProjectAndProposals(projectId, async (project, proposals) => {
    const proposal = proposals.find((item) => item.id === proposalId);
    if (!proposal) throw new Error("没有找到这条 AI 建议。");
    if (proposal.status !== "pending") throw new Error("只能应用待审核的建议。");
    const texts: ChapterTexts = {};
    const failures: ApplyFailure[] = [];
    const undo: ProposalUndo = { snapshots: {}, afterHashes: {}, inverseOperations: [] as WriterPatchOperation[], createdChapterIds: [], inverseStoryOperations: [], inverseThreadOperations: [] };
    const applied: string[] = [];
    const storyChanges: { id: string; title: string; operation: StoryOperation }[] = [];
    const threadChanges: { id: string; title: string; operation: ThreadOperation }[] = [];
    let skipped = 0;

    for (const change of proposal.changes) {
      if (!isChangeAccepted(change, selection)) { skipped += 1; continue; }
      if (change.kind === "story") { storyChanges.push({ id: change.id, title: change.label, operation: change.operation }); continue; }
      if (change.kind === "thread") { threadChanges.push({ id: change.id, title: change.label, operation: change.operation }); continue; }
      if (change.kind === "entity") {
        try {
          undo.inverseOperations.push(...inverseOperations(project, change.operation));
          applyOperation(project, change.operation);
          applied.push(change.id);
        } catch (error) {
          failures.push({ changeId: change.id, title: change.label, reason: error instanceof Error ? error.message : String(error) });
        }
        continue;
      }
      const nextText = selectedTextResult(change, selection);
      if (nextText === null) { skipped += 1; continue; }
      const key = docKey(change.doc);
      if (change.createChapter) {
        if (project.chapters.some((chapter) => chapter.id === change.createChapter?.id)) { failures.push({ changeId: change.id, title: change.title, reason: "同名章节已存在。" }); continue; }
        const meta = normalizeChapterMeta(change.createChapter);
        const sameVolume = project.chapters.filter((chapter) => chapter.volumeId === meta.volumeId);
        if (!project.volumes.some((volume) => volume.id === meta.volumeId)) meta.volumeId = project.volumes[0].id;
        if (sameVolume.some((chapter) => chapter.rank === meta.rank)) meta.rank = rankAfter(Math.max(...sameVolume.map((chapter) => chapter.rank)));
        project.chapters.push(meta);
        writeDoc(project, texts, change.doc, nextText);
        await writeText(chapterFile(projectId, meta.id), nextText);
        undo.createdChapterIds.push(meta.id);
        undo.afterHashes[key] = contentHash(nextText);
        applied.push(change.id);
        continue;
      }
      if (!docExists(project, change.doc)) { failures.push({ changeId: change.id, title: change.title, reason: "目标文档已被删除。" }); continue; }
      const current = await currentText(projectId, project, change.doc);
      if (current !== change.before) { failures.push({ changeId: change.id, title: change.title, reason: "生成建议后原文已被修改，请重新生成。" }); continue; }
      const snapshotId = await createSnapshot(projectId, change.doc, docTitle(project, change.doc), current, "before-ai", { force: true });
      if (snapshotId) undo.snapshots[key] = snapshotId;
      writeDoc(project, texts, change.doc, nextText);
      if (change.doc.kind === "chapter") {
        await writeText(chapterFile(projectId, change.doc.id), nextText);
        const chapter = project.chapters.find((item) => item.id === (change.doc as { id: string }).id);
        if (chapter) chapter.updatedAt = unixTimestamp();
      }
      undo.afterHashes[key] = contentHash(nextText);
      applied.push(change.id);
    }

    if (storyChanges.length) {
      await withStoryLock(projectId, async () => {
        const plan = await loadStoryPlan(projectId);
        for (const change of storyChanges) {
          try {
            undo.inverseStoryOperations.push(...inverseStoryOperation(plan, change.operation));
            applyStoryOperation(plan, change.operation);
            applied.push(change.id);
          } catch (error) { failures.push({ changeId: change.id, title: change.title, reason: error instanceof Error ? error.message : String(error) }); }
        }
        await saveStoryPlan(projectId, plan);
      });
    }
    if (threadChanges.length) {
      const store = new MemoryStore(projectId);
      await store.withLock(async () => {
        let threads = await store.loadThreads();
        for (const change of threadChanges) {
          undo.inverseThreadOperations.push(...inverseThreadOperation(threads, change.operation));
          threads = applyThreadOperation(threads, change.operation);
          applied.push(change.id);
        }
        await store.saveThreads(threads);
      });
      invalidateMemoryView(projectId);
    }

    if (!applied.length) {
      if (failures.length) throw new Error(failures.map((failure) => `${failure.title}：${failure.reason}`).join("\n"));
      throw new Error("没有选中任何修改。");
    }
    proposal.status = failures.length || skipped ? "partially_applied" : "applied";
    proposal.appliedAt = unixTimestamp();
    proposal.appliedChangeIds = applied;
    proposal.undo = undo;
    return { texts, failures };
  });
  return { project, proposals, texts: result.texts, failures: result.failures };
}

export type UndoResult = { project: WriterProject; texts: ChapterTexts; proposals: WriterProposal[]; skipped: string[] };

/** Reverts an applied proposal. Documents edited after applying are left alone and reported. */
export async function undoProposal(projectId: string, proposalId: string): Promise<UndoResult> {
  const { project, proposals, result } = await withProjectAndProposals(projectId, async (project, proposals) => {
    const proposal = proposals.find((item) => item.id === proposalId);
    if (!proposal?.undo || (proposal.status !== "applied" && proposal.status !== "partially_applied")) throw new Error("这条建议无法撤销。");
    const texts: ChapterTexts = {};
    const skipped: string[] = [];
    for (const chapterId of proposal.undo.createdChapterIds) {
      const ref: DocRef = { kind: "chapter", id: chapterId };
      if (!docExists(project, ref)) continue;
      const current = await loadChapterText(projectId, chapterId);
      if (contentHash(current) !== proposal.undo.afterHashes[docKey(ref)]) { skipped.push(docTitle(project, ref)); continue; }
      await createSnapshot(projectId, ref, docTitle(project, ref), current, "before-delete", { force: true });
      removeChapter(project, chapterId);
      await removeFile(chapterFile(projectId, chapterId));
    }
    for (const [key, snapshotId] of Object.entries(proposal.undo.snapshots)) {
      const ref = refFromKey(key);
      if (!ref || !docExists(project, ref)) continue;
      const current = await currentText(projectId, project, ref);
      if (contentHash(current) !== proposal.undo.afterHashes[key]) { skipped.push(docTitle(project, ref)); continue; }
      const snapshot = await readSnapshot(projectId, ref, snapshotId);
      if (!snapshot) { skipped.push(docTitle(project, ref)); continue; }
      writeDoc(project, texts, ref, snapshot.content);
      if (ref.kind === "chapter") await writeText(chapterFile(projectId, ref.id), snapshot.content);
    }
    for (const operation of [...proposal.undo.inverseOperations].reverse()) {
      try { applyOperation(project, operation); } catch { skipped.push("结构修改"); }
    }
    const storyUndo = proposal.undo.inverseStoryOperations;
    if (storyUndo.length) {
      await withStoryLock(projectId, async () => {
        const plan = await loadStoryPlan(projectId);
        for (const operation of [...storyUndo].reverse()) applyStoryOperation(plan, operation);
        await saveStoryPlan(projectId, plan);
      });
    }
    const threadUndo = proposal.undo.inverseThreadOperations;
    if (threadUndo.length) {
      const store = new MemoryStore(projectId);
      await store.withLock(async () => {
        let threads = await store.loadThreads();
        for (const operation of [...threadUndo].reverse()) threads = applyThreadOperation(threads, operation);
        await store.saveThreads(threads);
      });
      invalidateMemoryView(projectId);
    }
    proposal.status = "reverted";
    proposal.undo = null;
    return { texts, skipped };
  });
  return { project, proposals, texts: result.texts, skipped: result.skipped };
}

async function currentText(projectId: string, project: WriterProject, ref: DocRef): Promise<string> {
  if (ref.kind === "chapter") return loadChapterText(projectId, ref.id);
  return readDoc(project, {}, ref) ?? "";
}

function refFromKey(key: string): DocRef | null {
  if (key.startsWith("chapter:")) return { kind: "chapter", id: key.slice(8) };
  return key === "worldview" || key === "background" || key === "outline" || key === "style" ? { kind: key } : null;
}

function inverseOperations(project: WriterProject, operation: WriterPatchOperation): WriterPatchOperation[] {
  const find = <T extends { id: string }>(items: T[], id: string) => items.find((item) => item.id === id);
  switch (operation.type) {
    case "setProjectField": return [{ type: "setProjectField", field: operation.field, value: project[operation.field] }];
    case "upsertVolume": { const previous = find(project.volumes, operation.volume.id); return previous ? [{ type: "upsertVolume", volume: structuredClone(previous) }] : []; }
    case "upsertChapterMeta": { const previous = find(project.chapters, operation.chapter.id); return previous ? [{ type: "upsertChapterMeta", chapter: structuredClone(previous) }] : []; }
    case "upsertCharacter": { const previous = find(project.characters, operation.character.id); return [previous ? { type: "upsertCharacter", character: structuredClone(previous) } : { type: "removeCharacter", id: operation.character.id }]; }
    case "upsertFaction": { const previous = find(project.factions, operation.faction.id); return [previous ? { type: "upsertFaction", faction: structuredClone(previous) } : { type: "removeFaction", id: operation.faction.id }]; }
    case "upsertStoryNode": { const previous = find(project.storyNodes, operation.node.id); return [previous ? { type: "upsertStoryNode", node: structuredClone(previous) } : { type: "removeStoryNode", id: operation.node.id }]; }
    case "upsertStoryEdge": { const previous = find(project.storyEdges, operation.edge.id); return [previous ? { type: "upsertStoryEdge", edge: structuredClone(previous) } : { type: "removeStoryEdge", id: operation.edge.id }]; }
    case "upsertCharacterRelation": { const previous = find(project.characterRelations, operation.relation.id); return [previous ? { type: "upsertCharacterRelation", relation: structuredClone(previous) } : { type: "removeCharacterRelation", id: operation.relation.id }]; }
    case "removeCharacter": { const previous = find(project.characters, operation.id); return previous ? [{ type: "upsertCharacter", character: structuredClone(previous) }] : []; }
    case "removeFaction": { const previous = find(project.factions, operation.id); return previous ? [{ type: "upsertFaction", faction: structuredClone(previous) }] : []; }
    case "removeStoryNode": { const previous = find(project.storyNodes, operation.id); return previous ? [{ type: "upsertStoryNode", node: structuredClone(previous) }] : []; }
    case "removeStoryEdge": { const previous = find(project.storyEdges, operation.id); return previous ? [{ type: "upsertStoryEdge", edge: structuredClone(previous) }] : []; }
    case "removeCharacterRelation": { const previous = find(project.characterRelations, operation.id); return previous ? [{ type: "upsertCharacterRelation", relation: structuredClone(previous) }] : []; }
    case "setPromptConfig": return [{ type: "setPromptConfig", patch: Object.fromEntries(Object.keys(operation.patch).map((key) => [key, structuredClone(project.prompts[key as keyof typeof project.prompts])])) }];
  }
}
