import { GitMerge } from "lucide-react";
import { useMemo, useState } from "react";
import { chapterLabel } from "../../domain/documents";
import { EntityRegistry } from "../../memory/ledger";
import { ENTITY_CATEGORIES, ENTITY_CATEGORY_LABELS, type EntityCategory } from "../../memory/schema";
import { MemoryStore } from "../../memory/store";
import { invalidateMemoryView } from "../../memory/view";
import { Empty, useDialogs } from "../common";
import { OwnerImages } from "../images/OwnerImages";
import { useWriter } from "../useWriter";

export function EntitiesTab({ onOpenChapter }: { onOpenChapter: (id: string, quote?: string) => void }) {
  const writer = useWriter();
  const dialogs = useDialogs();
  const { project, memory } = writer;
  const [category, setCategory] = useState<EntityCategory | "all">("character");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Which chapter the dossier is read at; null follows the end of the book.
  const [readAt, setReadAt] = useState<number | null>(null);
  const list = useMemo(() => {
    if (!memory) return [];
    return memory.entities.filter((entity) => (category === "all" || entity.category === category) && (!query || entity.name.includes(query) || entity.aliases.some((alias) => alias.includes(query)))).map((entity) => ({ entity, count: memory.mentionCount(entity.id) })).sort((left, right) => right.count - left.count).slice(0, 300);
  }, [memory, category, query]);
  if (!project || !memory) return <Empty title="还没有建立记忆" />;
  const selected = selectedId ? memory.entity(selectedId) : list[0]?.entity ?? null;
  const lastPosition = Math.max(0, memory.orderedIds.length - 1);
  const position = Math.min(readAt ?? lastPosition, lastPosition);

  const editEntities = async (mutate: (registry: EntityRegistry) => void) => {
    const store = new MemoryStore(project.id);
    await store.withLock(async () => {
      const registry = new EntityRegistry(await store.loadEntities());
      mutate(registry);
      await store.saveEntities(registry.entities);
      invalidateMemoryView(project.id);
    });
    invalidateMemoryView(project.id);
    await writer.refreshMemory(true);
  };

  const facts = selected ? memory.facts(selected.id).filter((fact) => fact.position <= position) : [];
  const state = selected ? Object.values(memory.stateAt(selected.id, position)) : [];
  const chapters = selected ? memory.chaptersOf(selected.id) : [];

  return (
    <div className="w-entities">
      <div className="w-entity-list">
        <div className="w-row small">
          <select className="w-select small" value={category} onChange={(event) => setCategory(event.currentTarget.value as EntityCategory | "all")}>
            <option value="all">全部</option>
            {ENTITY_CATEGORIES.map((item) => <option key={item} value={item}>{ENTITY_CATEGORY_LABELS[item]}</option>)}
          </select>
          <input className="w-input grow" placeholder="搜索" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </div>
        {list.map(({ entity, count }) => (
          <button key={entity.id} type="button" className={`w-entity-row ${selected?.id === entity.id ? "active" : ""}`} onClick={() => setSelectedId(entity.id)}>
            <span>{entity.name}</span>{entity.origin === "user" ? <span className="w-pill">设定库</span> : null}<span className="w-spacer" /><span className="w-muted">{count}</span>
          </button>
        ))}
      </div>
      <div className="w-entity-detail">
        {selected ? (
          <>
            <div className="w-row">
              <h3>{selected.name}</h3>
              <span className="w-pill">{ENTITY_CATEGORY_LABELS[selected.category]}</span>
              <span className="w-spacer" />
              <button type="button" className="w-btn small" onClick={async () => { const alias = await dialogs.prompt("添加别名", "别名（多个用顿号分隔）："); if (alias?.trim()) await editEntities((registry) => registry.upsert({ name: selected.name, category: selected.category, aliases: alias.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) })); }}>添加别名</button>
              <button type="button" className="w-btn small" onClick={async () => {
                const name = await dialogs.prompt("合并实体", `把哪个实体合并进「${selected.name}」？输入它的名字：`);
                const other = name ? memory.resolve(name) : null;
                if (!other || other.id === selected.id) { if (name) writer.notify("error", "没有找到这个实体。"); return; }
                await editEntities((registry) => registry.merge(selected.id, other.id));
              }}><GitMerge size={12} />合并</button>
              <select className="w-select small" value={selected.category} onChange={(event) => { const value = event.currentTarget.value as EntityCategory; void editEntities((registry) => { const entity = registry.entities.find((item) => item.id === selected.id); if (entity) entity.category = value; }); }}>
                {ENTITY_CATEGORIES.map((item) => <option key={item} value={item}>{ENTITY_CATEGORY_LABELS[item]}</option>)}
              </select>
            </div>
            {selected.aliases.length ? <p className="w-muted">别名：{selected.aliases.join("、")}</p> : null}
            <p>{selected.summary || "暂无档案。建立“世界观与人物档案”后会自动生成。"}</p>
            <OwnerImages owner={`entity:${selected.id}`} title={`${selected.name} 的配图`} material={`${ENTITY_CATEGORY_LABELS[selected.category]}「${selected.name}」：${selected.summary}`} />
            <label className="w-readat">
              <span><b>读到{chapterLabel(position)}时</b><small>拖动回看这时的状态和事实</small></span>
              <input type="range" min={0} max={lastPosition} value={position} onChange={(event) => setReadAt(Number(event.currentTarget.value))} />
            </label>
            {state.length ? <><h4>这时的状态</h4><ul className="w-fact-list">{state.map((fact) => <li key={fact.attribute}><b>{fact.attribute}</b>：{fact.value} <button type="button" className="w-link" onClick={() => onOpenChapter(fact.chapterId, fact.quote)}>{chapterLabel(fact.position)}</button></li>)}</ul></> : null}
            <h4>出场分布 · {chapters.length} 章</h4>
            <div className="w-spark">{chapters.slice(0, 400).map((id) => <span key={id} title={chapterLabel(memory.position(id))} style={{ left: `${(memory.position(id) / Math.max(1, memory.orderedIds.length - 1)) * 100}%` }} onClick={() => onOpenChapter(id)} />)}</div>
            <h4>{facts.length} 条出自正文的事实</h4>
            <ol className="w-timeline">
              {facts.slice(-200).reverse().map((fact, index) => (
                <li key={index}>
                  <button type="button" className="w-link" onClick={() => onOpenChapter(fact.chapterId, fact.quote)}>{chapterLabel(fact.position)}</button>
                  <span><b>{fact.attribute}</b>：{fact.value}</span>
                  {fact.quote ? <span className="w-muted">“{fact.quote}”</span> : null}
                </li>
              ))}
            </ol>
          </>
        ) : <Empty title="选择一个实体">查看档案、别名、最新状态、出场分布与事实时间线。</Empty>}
      </div>
    </div>
  );
}
