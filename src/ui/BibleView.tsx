import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { uniqueId } from "../domain/ids";
import { normalizeCharacter, normalizeCharacterRelation, normalizeFaction } from "../domain/normalize";
import { removeCharacter } from "../domain/operations";
import type { WriterProject } from "../types";
import { Empty, Field, Tabs, useDialogs } from "./common";
import { OwnerImages } from "./images/OwnerImages";
import { InspireButton } from "./inspire/InspireButton";
import { useWriter } from "./useWriter";

type Tab = "characters" | "factions" | "relations";
const splitList = (value: string) => value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean);

export function BibleView() {
  const writer = useWriter();
  const [tab, setTab] = useState<Tab>("characters");
  const { project } = writer;
  if (!project) return null;
  return (
    <div className="w-bible">
      <header className="w-memory-head">
        <Tabs size="sm" value={tab} onChange={setTab} items={[{ value: "characters", label: "人物", badge: project.characters.length }, { value: "factions", label: "势力", badge: project.factions.length }, { value: "relations", label: "人物关系", badge: project.characterRelations.length }]} />
        <span className="w-muted">剧情节点在“故事 · 结构图”里编辑。</span>
        <span className="w-muted">设定库是作者亲自维护的权威设定；AI 写作时优先遵循它，记忆中同名实体会自动关联。</span>
      </header>
      <div className="w-memory-body">
        {tab === "characters" ? <CharacterEditor project={project} /> : null}
        {tab === "factions" ? <FactionEditor project={project} /> : null}
        {tab === "relations" ? <RelationEditor project={project} /> : null}
      </div>
    </div>
  );
}

function MasterDetail<T extends { id: string }>({ items, label, selectedId, onSelect, onAdd, extra, children }: { items: T[]; label: (item: T) => string; selectedId: string | null; onSelect: (id: string) => void; onAdd: () => void; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="w-entities">
      <div className="w-entity-list">
        <div className="w-row"><button type="button" className="w-btn small" onClick={onAdd}><Plus size={12} />新建</button>{extra}</div>
        {items.map((item) => <button key={item.id} type="button" className={`w-entity-row ${selectedId === item.id ? "active" : ""}`} onClick={() => onSelect(item.id)}>{label(item) || "未命名"}</button>)}
      </div>
      <div className="w-entity-detail">{children}</div>
    </div>
  );
}

function CharacterEditor({ project }: { project: WriterProject }) {
  const writer = useWriter();
  const dialogs = useDialogs();
  const [selectedId, setSelectedId] = useState<string | null>(project.characters[0]?.id ?? null);
  const character = project.characters.find((item) => item.id === selectedId);
  const update = (patch: Partial<typeof character>) => writer.mutateProject((draft) => { const target = draft.characters.find((item) => item.id === selectedId); if (target) Object.assign(target, patch); });
  const memoryEntity = character ? writer.memory?.entities.find((entity) => entity.bibleId === character.id) : undefined;
  return (
    <MasterDetail items={project.characters} label={(item) => item.name} selectedId={selectedId} onSelect={setSelectedId} extra={<InspireButton className="w-btn small" options={() => ({ target: "character", focus: character ? `${character.name}（${character.role}）：${character.summary}` : "", adoptLabel: "新建为人物", onAdopt: (idea) => { const id = uniqueId("character"); writer.mutateProject((draft) => { draft.characters.push(normalizeCharacter({ id, name: idea.title, summary: idea.content })); }); setSelectedId(id); } })} />} onAdd={() => { const id = uniqueId("character"); writer.mutateProject((draft) => { draft.characters.push(normalizeCharacter({ id, name: "新人物" })); }); setSelectedId(id); }}>
      {character ? (
        <div className="w-form">
          <div className="w-inspector-grid">
            <Field label="姓名"><input className="w-input" value={character.name} onChange={(event) => update({ name: event.currentTarget.value })} /></Field>
            <Field label="别名（顿号分隔）"><input className="w-input" value={character.aliases.join("、")} onChange={(event) => update({ aliases: splitList(event.currentTarget.value) })} /></Field>
            <Field label="定位"><input className="w-input" value={character.role} placeholder="主角 / 反派 / 导师…" onChange={(event) => update({ role: event.currentTarget.value })} /></Field>
            <Field label="标签"><input className="w-input" value={character.tags.join("、")} onChange={(event) => update({ tags: splitList(event.currentTarget.value) })} /></Field>
          </div>
          <OwnerImages owner={`character:${character.id}`} roles={["base", "avatar", "other"]} label="人物图" title={`${character.name} 的人物图`} material={`人物立绘。${character.name}（${character.role}）：${character.minimalTag} ${character.summary}`} />
          <Field label="人物小传"><textarea className="w-textarea" rows={5} value={character.summary} onChange={(event) => update({ summary: event.currentTarget.value })} placeholder="身份、外貌、性格、能力、动机、秘密…" /></Field>
          <Field label="人物弧光"><textarea className="w-textarea" rows={3} value={character.arc} onChange={(event) => update({ arc: event.currentTarget.value })} placeholder="从哪里出发，经历什么，变成什么样" /></Field>
          <Field label="识别标签" hint="读者靠哪一个特征认出他（老酒鬼、话痨、左手刀）"><input className="w-input" value={character.minimalTag} onChange={(event) => update({ minimalTag: event.currentTarget.value })} /></Field>
          <Field label="想要什么"><input className="w-input" value={character.desire} onChange={(event) => update({ desire: event.currentTarget.value })} /></Field>
          <Field label="不愿承认的内心" hint="言行和内心的落差就是潜台词"><input className="w-input" value={character.hiddenInner} onChange={(event) => update({ hiddenInner: event.currentTarget.value })} /></Field>
          <Field label="独立目标" hint="反派和长线配角：不围绕主角，他自己在追求什么"><input className="w-input" value={character.independentGoal} onChange={(event) => update({ independentGoal: event.currentTarget.value })} /></Field>
          <Field label="此刻在做什么" hint="发布章节后，流水线会建议更新"><input className="w-input" value={character.currentAction} onChange={(event) => update({ currentAction: event.currentTarget.value })} /></Field>
          {memoryEntity && writer.memory ? (
            <section className="w-memory-card">
              <div className="w-memory-card-head"><strong>记忆中的 {memoryEntity.name}</strong><span className="w-muted">出现 {writer.memory.mentionCount(memoryEntity.id)} 次</span></div>
              <div className="w-memory-card-body">
                {Object.values(writer.memory.stateAt(memoryEntity.id, writer.memory.orderedIds.length)).slice(0, 12).map((fact) => <p key={fact.attribute}><b>{fact.attribute}</b>：{fact.value}</p>)}
              </div>
            </section>
          ) : null}
          <button type="button" className="w-btn danger small" onClick={async () => { if (await dialogs.confirm("删除人物", `删除「${character.name}」？相关的人物关系和视角设置也会一并清除。`, { danger: true })) { writer.mutateProject((draft) => removeCharacter(draft, character.id)); setSelectedId(null); } }}><Trash2 size={12} />删除人物</button>
        </div>
      ) : <Empty title="选择或新建一个人物" />}
    </MasterDetail>
  );
}

function FactionEditor({ project }: { project: WriterProject }) {
  const writer = useWriter();
  const dialogs = useDialogs();
  const [selectedId, setSelectedId] = useState<string | null>(project.factions[0]?.id ?? null);
  const faction = project.factions.find((item) => item.id === selectedId);
  const update = (patch: Partial<typeof faction>) => writer.mutateProject((draft) => { const target = draft.factions.find((item) => item.id === selectedId); if (target) Object.assign(target, patch); });
  return (
    <MasterDetail items={project.factions} label={(item) => item.name} selectedId={selectedId} onSelect={setSelectedId} extra={<InspireButton className="w-btn small" options={() => ({ target: "faction", focus: faction ? `${faction.name}：${faction.summary}` : "", adoptLabel: "新建为势力", onAdopt: (idea) => { const id = uniqueId("faction"); writer.mutateProject((draft) => { draft.factions.push(normalizeFaction({ id, name: idea.title, summary: idea.content })); }); setSelectedId(id); } })} />} onAdd={() => { const id = uniqueId("faction"); writer.mutateProject((draft) => { draft.factions.push(normalizeFaction({ id, name: "新势力" })); }); setSelectedId(id); }}>
      {faction ? (
        <div className="w-form">
          <div className="w-inspector-grid">
            <Field label="名称"><input className="w-input" value={faction.name} onChange={(event) => update({ name: event.currentTarget.value })} /></Field>
            <Field label="别名"><input className="w-input" value={faction.aliases.join("、")} onChange={(event) => update({ aliases: splitList(event.currentTarget.value) })} /></Field>
          </div>
          <OwnerImages owner={`faction:${faction.id}`} label="势力图" title={`${faction.name} 的势力图`} material={`势力的徽记或代表性场景。${faction.name}：${faction.summary}`} />
          <Field label="简介"><textarea className="w-textarea" rows={4} value={faction.summary} onChange={(event) => update({ summary: event.currentTarget.value })} /></Field>
          <Field label="目标与动机"><textarea className="w-textarea" rows={3} value={faction.motivation} onChange={(event) => update({ motivation: event.currentTarget.value })} /></Field>
          <button type="button" className="w-btn danger small" onClick={async () => { if (await dialogs.confirm("删除势力", `删除「${faction.name || "未命名"}」？`, { danger: true, confirmLabel: "删除" })) { writer.mutateProject((draft) => { draft.factions = draft.factions.filter((item) => item.id !== faction.id); }); setSelectedId(null); } }}><Trash2 size={12} />删除势力</button>
        </div>
      ) : <Empty title="选择或新建一个势力" />}
    </MasterDetail>
  );
}

function RelationEditor({ project }: { project: WriterProject }) {
  const writer = useWriter();
  const names = new Map(project.characters.map((character) => [character.id, character.name]));
  if (project.characters.length < 2) return <Empty title="至少需要两个人物">先在“人物”中添加人物，再建立关系。</Empty>;
  const update = (id: string, patch: Record<string, unknown>) => writer.mutateProject((draft) => { const target = draft.characterRelations.find((item) => item.id === id); if (target) Object.assign(target, patch); });
  return (
    <div className="w-outline">
      <button type="button" className="w-btn small" onClick={() => writer.mutateProject((draft) => { draft.characterRelations.push(normalizeCharacterRelation({ id: uniqueId("relation"), sourceCharacterId: project.characters[0].id, targetCharacterId: project.characters[1].id, relation: "" })); })}><Plus size={12} />新建关系</button>
      <InspireButton className="w-btn small" label="关系灵感" options={() => ({ target: "relation" })} />
      <table className="w-table">
        <thead><tr><th>人物</th><th>关系</th><th>人物</th><th>时间范围</th><th /></tr></thead>
        <tbody>
          {project.characterRelations.map((relation) => (
            <tr key={relation.id}>
              <td><select className="w-select small" value={relation.sourceCharacterId} onChange={(event) => update(relation.id, { sourceCharacterId: event.currentTarget.value })}>{[...names].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></td>
              <td><input className="w-input" value={relation.relation} placeholder="师徒 / 宿敌 / 暗恋…" onChange={(event) => update(relation.id, { relation: event.currentTarget.value })} /></td>
              <td><select className="w-select small" value={relation.targetCharacterId} onChange={(event) => update(relation.id, { targetCharacterId: event.currentTarget.value })}>{[...names].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></td>
              <td><input className="w-input" value={relation.startsAt} placeholder="从" onChange={(event) => update(relation.id, { startsAt: event.currentTarget.value })} /><input className="w-input" value={relation.endsAt} placeholder="到" onChange={(event) => update(relation.id, { endsAt: event.currentTarget.value })} /></td>
              <td><button type="button" className="w-icon-btn small" aria-label="删除关系" onClick={() => writer.mutateProject((draft) => { draft.characterRelations = draft.characterRelations.filter((item) => item.id !== relation.id); })}><Trash2 size={13} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
