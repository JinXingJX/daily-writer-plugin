import { Background, Controls, MiniMap, ReactFlow, type Connection, type Edge, type Node, type NodeChange, applyNodeChanges } from "@xyflow/react";
import { Filter, Plus, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { orderedChapters } from "../domain/documents";
import { uniqueId } from "../domain/ids";
import { EMPTY_MAP_FILTER, filterRelations, filterStoryMap, isFilterActive, type MapFilter } from "../domain/mapFilter";
import { normalizeStoryEdge, normalizeStoryNode } from "../domain/normalize";
import { removeStoryNode } from "../domain/operations";
import type { StoryEdgeRelation, StoryNodeKind } from "../types";
import { Field, Tabs } from "./common";
import { OwnerImages } from "./images/OwnerImages";
import { InspireButton } from "./inspire/InspireButton";
import { useWriter } from "./useWriter";

const RELATION_LABELS: Record<StoryEdgeRelation, string> = { causal: "因果", timeline: "时间", branch: "分支", foreshadow: "伏笔", character: "人物" };
const KIND_LABELS: Record<StoryNodeKind, string> = { plot_key: "关键情节", volume: "卷", chapter: "章节", scene: "场景", character_key: "人物节点" };
const RELATION_COLORS: Record<StoryEdgeRelation, string> = { causal: "#4a4740", timeline: "#8c8c94", branch: "#2e7cf6", foreshadow: "#d9822b", character: "#1e7b4f" };

export function MapView() {
  const [tab, setTab] = useState<"story" | "relations">("story");
  // Shared by both tabs so a volume or character focus survives switching between them.
  const [filter, setFilter] = useState<MapFilter>(EMPTY_MAP_FILTER);
  return (
    <div className="w-map">
      <header className="w-memory-head">
        <Tabs size="sm" value={tab} onChange={setTab} items={[{ value: "story", label: "剧情结构" }, { value: "relations", label: "人物关系网" }]} />
        <span className="w-muted">{tab === "story" ? "拖动节点布局，从节点边缘拖线建立因果/伏笔关联，点击节点编辑。" : "拖线建立人物关系，点击人物聚焦其关系。"}</span>
      </header>
      <FilterBar tab={tab} filter={filter} onChange={setFilter} />
      {tab === "story" ? <StoryMap filter={filter} /> : <RelationGraph filter={filter} onFocus={(characterId) => setFilter((current) => ({ ...current, characterId: current.characterId === characterId ? "" : characterId }))} />}
    </div>
  );
}

function StoryMap({ filter }: { filter: MapFilter }) {
  const writer = useWriter();
  const { project } = writer;
  const [selected, setSelected] = useState<{ type: "node" | "edge"; id: string } | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const active = isFilterActive(filter);
  const visible = useMemo(() => (project && active ? filterStoryMap(project, filter) : null), [active, filter, project]);
  useEffect(() => {
    if (!project) return;
    const shown = visible && !filter.dim ? project.storyNodes.filter((node) => visible.nodeIds.has(node.id)) : project.storyNodes;
    setNodes(shown.map((node) => ({ id: node.id, position: node.position, data: { label: node.title }, className: `w-flow-node k-${node.kind}${visible && !visible.nodeIds.has(node.id) ? " dim" : ""}`, selected: selected?.id === node.id })));
  }, [filter.dim, project, selected?.id, visible]);
  const edges = useMemo<Edge[]>(() => (project?.storyEdges ?? []).filter((edge) => !visible || filter.dim || visible.edgeIds.has(edge.id)).map((edge) => {
    const dimmed = Boolean(visible && !visible.edgeIds.has(edge.id));
    return { id: edge.id, source: edge.source, target: edge.target, label: edge.label || RELATION_LABELS[edge.relation], className: dimmed ? "dim" : undefined, style: { stroke: RELATION_COLORS[edge.relation], strokeDasharray: edge.relation === "foreshadow" ? "5 4" : undefined }, animated: edge.relation === "foreshadow" && !dimmed };
  }), [filter.dim, project?.storyEdges, visible]);
  if (!project) return null;

  const onNodesChange = (changes: NodeChange[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
    const done = changes.filter((change) => change.type === "position" && change.dragging === false && change.position);
    if (done.length) writer.mutateProject((draft) => { for (const change of done) { if (change.type !== "position" || !change.position) continue; const node = draft.storyNodes.find((item) => item.id === change.id); if (node) node.position = { x: Math.round(change.position.x), y: Math.round(change.position.y) }; } });
  };
  const onConnect = (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    writer.mutateProject((draft) => { draft.storyEdges.push(normalizeStoryEdge({ id: uniqueId("edge"), source: connection.source, target: connection.target, relation: "causal" })); });
  };
  const node = selected?.type === "node" ? project.storyNodes.find((item) => item.id === selected.id) : undefined;
  const edge = selected?.type === "edge" ? project.storyEdges.find((item) => item.id === selected.id) : undefined;

  return (
    <div className="w-map-body">
      <div className="w-flow">
        <ReactFlow key={visible && !filter.dim ? `${visible.nodeIds.size}|${visible.edgeIds.size}` : "all"} nodes={nodes} edges={edges} onNodesChange={onNodesChange} onConnect={onConnect} onNodeClick={(_, item) => setSelected({ type: "node", id: item.id })} onEdgeClick={(_, item) => setSelected({ type: "edge", id: item.id })} onPaneClick={() => setSelected(null)} fitView proOptions={{ hideAttribution: true }}>
          <Background gap={20} />
          <MiniMap pannable zoomable />
          <Controls showInteractive={false} />
        </ReactFlow>
        {visible && project.storyNodes.length ? <div className="w-flow-count">显示 {visible.nodeIds.size}/{project.storyNodes.length} 个节点</div> : null}
        {!project.storyNodes.length ? (
          <div className="w-flow-empty">
            <strong>还没有剧情节点</strong>
            <p>用节点和连线梳理主线、支线、因果与伏笔。{writer.memory?.aggregates.arcs.length ? "也可以根据故事记忆中的情节弧一键生成骨架。" : ""}</p>
            {writer.memory?.aggregates.arcs.length ? <button type="button" className="w-btn primary small" onClick={() => {
              const memory = writer.memory;
              if (!memory) return;
              const arcs = [...memory.aggregates.arcs].sort((left, right) => memory.position(left.chapterIds[0] ?? "") - memory.position(right.chapterIds[0] ?? ""));
              writer.mutateProject((draft) => {
                const ids = arcs.map(() => uniqueId("node"));
                arcs.forEach((arc, index) => draft.storyNodes.push(normalizeStoryNode({ id: ids[index], kind: "plot_key", title: arc.title, summary: arc.summary, chapterId: arc.chapterIds[0] ?? null, position: { x: 80 + (index % 5) * 240, y: 80 + Math.floor(index / 5) * 160 } })));
                for (let index = 1; index < ids.length; index += 1) draft.storyEdges.push(normalizeStoryEdge({ id: uniqueId("edge"), source: ids[index - 1], target: ids[index], relation: "causal" }));
              });
            }}>从情节弧生成</button> : null}
          </div>
        ) : null}
        <button type="button" className="w-btn small w-flow-add" onClick={() => { const id = uniqueId("node"); writer.mutateProject((draft) => { draft.storyNodes.push(normalizeStoryNode({ id, title: "新剧情节点", position: { x: 100 + (draft.storyNodes.length % 6) * 200, y: 100 + Math.floor(draft.storyNodes.length / 6) * 140 } })); }); setSelected({ type: "node", id }); }}><Plus size={12} />剧情节点</button>
        <InspireButton className="w-btn small w-flow-add" title={node ? `「${node.title}」之后可以发生什么` : "剧情节点灵感"} options={() => ({ target: "storyNode", focus: node ? `${node.title}：${node.summary}` : "", adoptLabel: node ? "接在这个节点之后" : "新建节点", onAdopt: (idea) => {
          const id = uniqueId("node");
          const anchor = node;
          writer.mutateProject((draft) => {
            const position = anchor ? { x: anchor.position.x + 240, y: anchor.position.y + (draft.storyEdges.filter((item) => item.source === anchor.id).length * 120) } : { x: 100 + (draft.storyNodes.length % 6) * 200, y: 100 + Math.floor(draft.storyNodes.length / 6) * 140 };
            draft.storyNodes.push(normalizeStoryNode({ id, kind: "plot_key", title: idea.title, summary: idea.content, position }));
            if (anchor) draft.storyEdges.push(normalizeStoryEdge({ id: uniqueId("edge"), source: anchor.id, target: id, relation: "causal" }));
          });
          setSelected({ type: "node", id });
        } })} />
      </div>
      {node ? (
        <aside className="w-map-side">
          <Field label="标题"><input className="w-input" value={node.title} onChange={(event) => { const value = event.currentTarget.value; writer.mutateProject((draft) => { const target = draft.storyNodes.find((item) => item.id === node.id); if (target) target.title = value; }); }} /></Field>
          <Field label="内容"><textarea className="w-textarea" rows={6} value={node.summary} onChange={(event) => { const value = event.currentTarget.value; writer.mutateProject((draft) => { const target = draft.storyNodes.find((item) => item.id === node.id); if (target) target.summary = value; }); }} /></Field>
          <OwnerImages owner={`node:${node.id}`} title={`「${node.title}」配图`} material={`${node.title}：${node.summary}`} />
          {node.chapterId ? <button type="button" className="w-btn small" onClick={() => writer.selectDoc({ kind: "chapter", id: node.chapterId as string })}>打开对应章节</button> : null}
          <button type="button" className="w-btn danger small" onClick={() => { writer.mutateProject((draft) => removeStoryNode(draft, node.id)); setSelected(null); }}><Trash2 size={12} />删除节点</button>
        </aside>
      ) : null}
      {edge ? (
        <aside className="w-map-side">
          <Field label="关联类型"><select className="w-select" value={edge.relation} onChange={(event) => { const value = event.currentTarget.value as StoryEdgeRelation; writer.mutateProject((draft) => { const target = draft.storyEdges.find((item) => item.id === edge.id); if (target) target.relation = value; }); }}>{Object.entries(RELATION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
          <Field label="说明"><input className="w-input" value={edge.label} onChange={(event) => { const value = event.currentTarget.value; writer.mutateProject((draft) => { const target = draft.storyEdges.find((item) => item.id === edge.id); if (target) target.label = value; }); }} /></Field>
          <button type="button" className="w-btn danger small" onClick={() => { writer.mutateProject((draft) => { draft.storyEdges = draft.storyEdges.filter((item) => item.id !== edge.id); }); setSelected(null); }}><Trash2 size={12} />删除关联</button>
        </aside>
      ) : null}
    </div>
  );
}

function RelationGraph({ filter, onFocus }: { filter: MapFilter; onFocus: (characterId: string) => void }) {
  const writer = useWriter();
  const { project, memory } = writer;
  const active = isFilterActive(filter);
  const visible = useMemo(() => {
    if (!project || !active) return null;
    // Story memory knows which chapters mention a character even when the bible does not record it.
    const entityOf = new Map((memory?.entities ?? []).flatMap((entity) => (entity.bibleId ? [[entity.bibleId, entity.id] as const] : [])));
    return filterRelations(project, filter, (characterId) => { const entityId = entityOf.get(characterId); return entityId && memory ? memory.chaptersOf(entityId) : []; });
  }, [active, filter, memory, project]);
  const initial = useMemo<Node[]>(() => {
    const all = project?.characters ?? [];
    // Hidden characters are dropped and the remaining ones re-laid out; a focused character sits in the middle.
    const characters = visible && !filter.dim ? all.filter((character) => visible.characterIds.has(character.id)) : all;
    const ring = characters.filter((character) => !visible || filter.dim || character.id !== filter.characterId);
    const radius = Math.max(180, ring.length * 28);
    return characters.map((character) => {
      const index = ring.indexOf(character);
      const angle = (index / Math.max(1, ring.length)) * Math.PI * 2;
      const position = index < 0 ? { x: radius, y: radius } : { x: Math.cos(angle) * radius + radius, y: Math.sin(angle) * radius + radius };
      const dimmed = Boolean(visible && !visible.characterIds.has(character.id));
      return { id: character.id, position, data: { label: character.name }, className: `w-flow-node k-character_key${dimmed ? " dim" : ""}${character.id === filter.characterId ? " focus" : ""}` };
    });
  }, [filter.characterId, filter.dim, project?.characters, visible]);
  const [nodes, setNodes] = useState<Node[]>(initial);
  useEffect(() => setNodes(initial), [initial]);
  const edges = useMemo<Edge[]>(() => (project?.characterRelations ?? []).filter((relation) => !visible || filter.dim || visible.relationIds.has(relation.id)).map((relation) => ({ id: relation.id, source: relation.sourceCharacterId, target: relation.targetCharacterId, label: relation.relation, className: visible && !visible.relationIds.has(relation.id) ? "dim" : undefined })), [filter.dim, project?.characterRelations, visible]);
  if (!project) return null;
  return (
    <div className="w-map-body">
      <div className="w-flow">
        {visible && project.characters.length ? <div className="w-flow-count">显示 {visible.characterIds.size}/{project.characters.length} 位人物 · {visible.relationIds.size} 条关系</div> : null}
        <ReactFlow key={visible && !filter.dim ? `${filter.characterId}|${visible.characterIds.size}` : "all"} nodes={nodes} edges={edges} onNodeClick={(_, item) => onFocus(item.id)} onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current))} onConnect={(connection) => { if (connection.source && connection.target) writer.mutateProject((draft) => { draft.characterRelations.push({ id: uniqueId("relation"), sourceCharacterId: connection.source, targetCharacterId: connection.target, relation: "关系", startsAt: "", endsAt: "", storyNodeIds: [] }); }); }} fitView proOptions={{ hideAttribution: true }}>
          <Background gap={20} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}

function FilterBar({ tab, filter, onChange }: { tab: "story" | "relations"; filter: MapFilter; onChange: (filter: MapFilter) => void }) {
  const { project } = useWriter();
  const chapters = useMemo(() => (project ? orderedChapters(project) : []), [project]);
  if (!project) return null;
  const set = (patch: Partial<MapFilter>) => onChange({ ...filter, ...patch });
  const indexed = chapters.map((chapter, index) => ({ chapter, index }));
  const inVolume = indexed.filter(({ chapter }) => !filter.volumeId || chapter.volumeId === filter.volumeId);
  const toggle = <T extends string>(list: T[], value: T) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  const chapterOptions = inVolume.slice(0, 2000).map(({ chapter, index }) => <option key={chapter.id} value={chapter.id}>{index + 1}. {chapter.title}</option>);
  return (
    <div className="w-map-filters" role="search" aria-label="筛选">
      <Filter size={13} className="w-muted" />
      <select className="w-select small" aria-label="卷" value={filter.volumeId} onChange={(event) => set({ volumeId: event.currentTarget.value, fromChapterId: "", toChapterId: "" })}>
        <option value="">全部卷</option>
        {project.volumes.map((volume) => <option key={volume.id} value={volume.id}>{volume.title || "未命名卷"}</option>)}
      </select>
      <select className="w-select small" aria-label="起始章节" value={filter.fromChapterId} onChange={(event) => set({ fromChapterId: event.currentTarget.value })}>
        <option value="">起始章节</option>{chapterOptions}
      </select>
      <span className="w-muted">至</span>
      <select className="w-select small" aria-label="结束章节" value={filter.toChapterId} onChange={(event) => set({ toChapterId: event.currentTarget.value })}>
        <option value="">结束章节</option>{chapterOptions}
      </select>
      <select className="w-select small" aria-label="人物" value={filter.characterId} onChange={(event) => set({ characterId: event.currentTarget.value })}>
        <option value="">全部人物</option>
        {project.characters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}
      </select>
      {tab === "relations" && filter.characterId ? (
        <select className="w-select small" aria-label="关系层级" value={filter.depth} onChange={(event) => set({ depth: Number(event.currentTarget.value) })}>
          <option value={1}>直接关系</option><option value={2}>两层关系</option><option value={3}>三层关系</option>
        </select>
      ) : null}
      <label className="w-map-search"><Search size={12} /><input value={filter.query} placeholder={tab === "story" ? "搜索节点" : "搜索人物或关系"} onChange={(event) => set({ query: event.currentTarget.value })} /></label>
      {tab === "story" ? (
        <>
          <span className="w-map-sep" />
          {(Object.keys(KIND_LABELS) as StoryNodeKind[]).map((kind) => <button key={kind} type="button" className={`w-chip small ${filter.kinds.includes(kind) ? "active" : ""}`} aria-pressed={filter.kinds.includes(kind)} onClick={() => set({ kinds: toggle(filter.kinds, kind) })}>{KIND_LABELS[kind]}</button>)}
          <span className="w-map-sep" />
          {(Object.keys(RELATION_LABELS) as StoryEdgeRelation[]).map((relation) => <button key={relation} type="button" className={`w-chip small ${filter.relations.includes(relation) ? "active" : ""}`} aria-pressed={filter.relations.includes(relation)} onClick={() => set({ relations: toggle(filter.relations, relation) })}><span className="w-map-swatch" style={{ background: RELATION_COLORS[relation] }} />{RELATION_LABELS[relation]}</button>)}
        </>
      ) : null}
      <span className="w-spacer" />
      <label className="w-check"><input type="checkbox" checked={filter.dim} onChange={(event) => set({ dim: event.currentTarget.checked })} />淡化而非隐藏</label>
      {isFilterActive(filter) ? <button type="button" className="w-btn small ghost" onClick={() => onChange({ ...EMPTY_MAP_FILTER, dim: filter.dim })}><X size={12} />清除筛选</button> : null}
    </div>
  );
}
