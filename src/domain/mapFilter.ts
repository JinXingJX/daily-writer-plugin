import type { StoryEdgeRelation, StoryNodeKind, WriterProject } from "../types";
import { orderedChapters } from "./documents";

/** Filters shared by the story map and the character relation graph. Empty values mean "no constraint". */
export type MapFilter = {
  volumeId: string;
  /** Inclusive chapter range, as chapter ids. */
  fromChapterId: string;
  toChapterId: string;
  characterId: string;
  /** Relation graph only: how many relation hops around `characterId` to show. */
  depth: number;
  kinds: StoryNodeKind[];
  relations: StoryEdgeRelation[];
  query: string;
  /** Dim non-matching items instead of hiding them, keeping the layout in context. */
  dim: boolean;
};

export const EMPTY_MAP_FILTER: MapFilter = { volumeId: "", fromChapterId: "", toChapterId: "", characterId: "", depth: 1, kinds: [], relations: [], query: "", dim: false };

export function isFilterActive(filter: MapFilter) {
  return Boolean(filter.volumeId || filter.fromChapterId || filter.toChapterId || filter.characterId || filter.kinds.length || filter.relations.length || filter.query.trim());
}

/** Chapter ids allowed by the volume and range filters, or `null` when neither is set. */
export function chapterScope(project: WriterProject, filter: MapFilter): Set<string> | null {
  if (!filter.volumeId && !filter.fromChapterId && !filter.toChapterId) return null;
  const chapters = orderedChapters(project);
  const from = filter.fromChapterId ? chapters.findIndex((chapter) => chapter.id === filter.fromChapterId) : 0;
  const toIndex = filter.toChapterId ? chapters.findIndex((chapter) => chapter.id === filter.toChapterId) : chapters.length - 1;
  const [start, end] = [Math.max(0, from), toIndex < 0 ? chapters.length - 1 : toIndex].sort((left, right) => left - right);
  return new Set(chapters.slice(start, end + 1).filter((chapter) => !filter.volumeId || chapter.volumeId === filter.volumeId).map((chapter) => chapter.id));
}

/** Chapters each story node belongs to: its own chapter plus chapters that link to it. */
export function nodeChapters(project: WriterProject): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>(project.storyNodes.map((node) => [node.id, new Set(node.chapterId ? [node.chapterId] : [])]));
  for (const chapter of project.chapters) for (const nodeId of chapter.storyNodeIds) result.get(nodeId)?.add(chapter.id);
  return result;
}

const intersects = (left: Set<string> | undefined, right: Set<string>) => [...(left ?? [])].some((id) => right.has(id));
const includes = (query: string, ...values: string[]) => values.some((value) => value.toLowerCase().includes(query));

export function filterStoryMap(project: WriterProject, filter: MapFilter): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const scope = chapterScope(project, filter);
  const chaptersOf = nodeChapters(project);
  const pov = new Map(project.chapters.map((chapter) => [chapter.id, chapter.povCharacterId]));
  const query = filter.query.trim().toLowerCase();
  const nodeIds = new Set(project.storyNodes.filter((node) => {
    if (filter.kinds.length && !filter.kinds.includes(node.kind)) return false;
    if (scope && !intersects(chaptersOf.get(node.id), scope)) return false;
    if (filter.characterId && !node.characterIds.includes(filter.characterId) && ![...(chaptersOf.get(node.id) ?? [])].some((id) => pov.get(id) === filter.characterId)) return false;
    if (query && !includes(query, node.title, node.summary, ...node.tags)) return false;
    return true;
  }).map((node) => node.id));
  const edgeIds = new Set(project.storyEdges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target) && (!filter.relations.length || filter.relations.includes(edge.relation))).map((edge) => edge.id));
  return { nodeIds, edgeIds };
}

/**
 * Characters and relations visible in the relation graph. `appearances` returns the chapters a character
 * appears in beyond what the project itself records (e.g. mentions from story memory).
 */
export function filterRelations(project: WriterProject, filter: MapFilter, appearances: (characterId: string) => string[] = () => []): { characterIds: Set<string>; relationIds: Set<string> } {
  const scope = chapterScope(project, filter);
  const query = filter.query.trim().toLowerCase();
  const names = new Map(project.characters.map((character) => [character.id, [character.name, ...character.aliases]]));
  let candidates = new Set(project.characters.map((character) => character.id));
  let scopedNodes: Set<string> | null = null;
  if (scope) {
    const chaptersOf = nodeChapters(project);
    scopedNodes = new Set(project.storyNodes.filter((node) => intersects(chaptersOf.get(node.id), scope)).map((node) => node.id));
    const present = new Set<string>();
    for (const chapter of project.chapters) if (scope.has(chapter.id) && chapter.povCharacterId) present.add(chapter.povCharacterId);
    for (const node of project.storyNodes) if (scopedNodes.has(node.id)) for (const id of node.characterIds) present.add(id);
    for (const id of candidates) if (appearances(id).some((chapterId) => scope.has(chapterId))) present.add(id);
    candidates = new Set([...candidates].filter((id) => present.has(id)));
  }
  let relations = project.characterRelations.filter((relation) => {
    if (!candidates.has(relation.sourceCharacterId) || !candidates.has(relation.targetCharacterId)) return false;
    // Relations tied to story nodes only hold within the chapters of those nodes.
    if (scopedNodes && relation.storyNodeIds.length && !relation.storyNodeIds.some((id) => scopedNodes?.has(id))) return false;
    return true;
  });
  const nameMatches = (id: string) => includes(query, ...(names.get(id) ?? []));
  if (query) relations = relations.filter((relation) => includes(query, relation.relation) || nameMatches(relation.sourceCharacterId) || nameMatches(relation.targetCharacterId));

  if (filter.characterId) {
    const reached = new Set(candidates.has(filter.characterId) ? [filter.characterId] : []);
    let frontier = [...reached];
    for (let hop = 0; hop < Math.max(1, filter.depth) && frontier.length; hop += 1) {
      const next: string[] = [];
      for (const relation of relations) {
        for (const [from, to] of [[relation.sourceCharacterId, relation.targetCharacterId], [relation.targetCharacterId, relation.sourceCharacterId]]) {
          if (frontier.includes(from) && !reached.has(to)) { reached.add(to); next.push(to); }
        }
      }
      frontier = next;
    }
    relations = relations.filter((relation) => reached.has(relation.sourceCharacterId) && reached.has(relation.targetCharacterId));
    return { characterIds: reached, relationIds: new Set(relations.map((relation) => relation.id)) };
  }

  const characterIds = query
    ? new Set([...candidates].filter((id) => nameMatches(id) || relations.some((relation) => relation.sourceCharacterId === id || relation.targetCharacterId === id)))
    : candidates;
  return { characterIds, relationIds: new Set(relations.map((relation) => relation.id)) };
}
