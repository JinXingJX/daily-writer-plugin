import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Brush, ChevronRight, Eye, EyeOff, Plus, Sparkles, Stamp, Trash2, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EVENT_KIND_LABELS, PLACE_KIND_LABELS, ROUTE_KIND_LABELS, TERRAIN_LABELS, type Atlas, type AtlasEvent, type AtlasMap, type AtlasMoment, type AtlasPlace, type AtlasRegion, type AtlasRoute, type AtlasTerritory, type AtlasItem, type BlockEdge, type ItemStop, type TerrainChange, type EventKind, type PlaceKind, type RouteKind, type Terrain } from "../../atlas/schema";
import { TOKEN_METHOD_LABELS, type TokenMethod } from "../../atlas/canvas";
import { TOKEN_KIND_LABELS, type TokenKind } from "../../atlas/tokens";
import { childMapOf, interiorOf, eventPosition, itemStopAt, sortedMoments, timeKey, timeLabel, type TimeAxis } from "../../atlas/timeline";
import { uniqueId } from "../../domain/ids";
import { CommitTextarea, Field, Spinner, Tabs } from "../common";
import { OwnerImages } from "../images/OwnerImages";
import type { AtlasLayers, AtlasSelection } from "./AtlasCanvas";

const splitList = (value: string) => value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean);
type Timed = { chapterId: string | null; momentId: string | null };

/** The time a stop stands for, as the two fields records carry. */
export function timeOfStop(axis: TimeAxis, index: number): Timed {
  const stop = axis.stops[index];
  if (!stop) return { chapterId: null, momentId: null };
  return stop.kind === "chapter" ? { chapterId: stop.id, momentId: null } : { chapterId: null, momentId: stop.id };
}

function timedPosition(axis: TimeAxis, record: Timed) { const key = timeKey(record); return key === null ? -1 : axis.position.get(key) ?? -1; }

function CommitInput({ value, onCommit, placeholder, label }: { value: string; onCommit: (value: string) => void; placeholder?: string; label?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return <input className="w-input" aria-label={label} value={text} placeholder={placeholder} onChange={(event) => setText(event.currentTarget.value)} onBlur={() => { if (text !== value) onCommit(text); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />;
}

const NEW_MOMENT = "__new_future__";
/** Picks a chapter or a moment; choosing "new" adds a moment after the last one. */
function TimeSelect({ axis, value, onChange, label = "时间" }: { axis: TimeAxis; value: Timed; onChange: (time: Timed | "new") => void; label?: string }) {
  return (
    <select className="w-select" aria-label={label} value={timeKey(value) ?? ""} onChange={(event) => {
      const next = event.currentTarget.value;
      if (next === NEW_MOMENT) onChange("new");
      else if (!next) onChange({ chapterId: null, momentId: null });
      else onChange(timeOfStop(axis, axis.position.get(next) ?? -1));
    }}>
      <option value="">未定</option>
      {axis.stops.slice(0, 4_000).map((stop) => <option key={stop.id} value={stop.id}>{stop.kind === "past" ? `前史 · ${stop.label}` : stop.kind === "future" ? `后续 · ${stop.label}` : stop.label}</option>)}
      <option value={NEW_MOMENT}>＋ 新的后续节点</option>
    </select>
  );
}

export type SideProps = {
  atlas: Atlas;
  map: AtlasMap;
  axis: TimeAxis;
  events: AtlasEvent[];
  cursor: number;
  selection: AtlasSelection;
  layers: AtlasLayers;
  characters: string[];
  character: string;
  ownerNames: string[];
  owners: Map<string, string>;
  busy: boolean;
  onLayers: (layers: AtlasLayers) => void;
  onCharacter: (name: string) => void;
  onSelect: (selection: AtlasSelection) => void;
  onLocate: (event: AtlasEvent) => void;
  onCursor: (cursor: number) => void;
  onOpenMap: (mapId: string) => void;
  onEnterRegion: (regionId: string) => void;
  onDetailRegion: (regionId: string) => void;
  onMapAction: (mapId: string) => void;
  onNewMap: (parentId: string | null, anchorRegionId?: string) => void;
  onDeleteMap: (mapId: string) => void;
  onAddEvent: () => void;
  onAddMoment: (phase: AtlasMoment["phase"]) => void;
  onRedrawRoute: (routeId: string) => void;
  onOpenChapter: (chapterId: string) => void;
  mutate: (change: (draft: Atlas) => void) => void;
  onRemove: (type: "region" | "place" | "event" | "route" | "territory" | "moment" | "item" | "terrain" | "variant", id: string) => void;
  /** The map's painted scroll, when it has one. */
  scroll: { styleName: string; tiles: { index: number; url: string | null; state: string | null; versions: number; error: string; variants: { id: string; label: string }[] }[] } | null;
  onOpenStyles: () => void;
  onPaintTiles: (tiles: number[]) => void;
  onPaintVariant: (index: number) => void;
  onRevertTile: (index: number) => void;
  /** The whole-map painting every tile and block follows. */
  overview: { url: string | null; state: string | null; versions: number };
  onPaintOverview: () => void;
  onRevertOverview: () => void;
  onPaintBlock: (regionId: string, edge: BlockEdge) => void;
  /** Paints map tokens: all of a kind still missing one, or the given owners. */
  onPaintTokens: (kind: TokenKind, method: TokenMethod, owners?: string[]) => void;
  onEnterPlace: (placeId: string) => void;
  onInteriorPlace: (placeId: string) => void;
  /** The image owner a character on the map stands for (the bible record when there is one). */
  characterOwner: (name: string) => string;
};

const BLOCK_EDGE_LABELS: Record<BlockEdge, string> = { blend: "融入底图", distinct: "泾渭分明" };

/** How a token is made, picked once per panel. */
function MethodSelect({ value, onChange }: { value: TokenMethod; onChange: (method: TokenMethod) => void }) {
  return <select className="w-select" aria-label="组件做法" value={value} onChange={(event) => onChange(event.currentTarget.value as TokenMethod)}>{(["single", "crop"] as TokenMethod[]).map((method) => <option key={method} value={method}>{TOKEN_METHOD_LABELS[method]}</option>)}</select>;
}

type Tab = "maps" | "flow" | "timeline" | "detail" | "layers";

export function AtlasSide(props: SideProps) {
  const { selection } = props;
  const [tab, setTab] = useState<Tab>("maps");
  useEffect(() => { if (selection) setTab("detail"); }, [selection]);
  return (
    <aside className="w-atlas-side">
      <Tabs size="sm" value={tab} onChange={setTab} items={[{ value: "maps", label: "地图", badge: props.atlas.maps.length }, { value: "flow", label: "事件" }, { value: "timeline", label: "时间线" }, { value: "detail", label: "详情" }, { value: "layers", label: "图层" }]} />
      <div className="w-atlas-side-body">
        {tab === "maps" ? <MapList {...props} /> : null}
        {tab === "flow" ? <EventFlow {...props} /> : null}
        {tab === "timeline" ? <TimelineEditor {...props} /> : null}
        {tab === "detail" ? <Detail {...props} /> : null}
        {tab === "layers" ? <Layers {...props} /> : null}
      </div>
    </aside>
  );
}

function MapList({ atlas, map, busy, onOpenMap, onMapAction, onNewMap, onDeleteMap }: SideProps) {
  const rows = useMemo(() => {
    const result: { item: AtlasMap; depth: number }[] = [];
    const ids = new Set(atlas.maps.map((item) => item.id));
    const visit = (parentId: string | null, depth: number) => {
      const children = atlas.maps.filter((item) => (parentId === null ? !item.parentId || !ids.has(item.parentId) : item.parentId === parentId));
      children.sort((left, right) => (left.id === atlas.rootMapId ? -1 : right.id === atlas.rootMapId ? 1 : 0));
      for (const item of children) { result.push({ item, depth }); visit(item.id, depth + 1); }
    };
    visit(null, 0);
    return result;
  }, [atlas.maps, atlas.rootMapId]);
  return (
    <div className="w-form">
      <div className="w-row">
        <button type="button" className="w-btn small" onClick={() => onNewMap(null)}><Plus size={12} />新建地图</button>
        <button type="button" className="w-btn small" onClick={() => onNewMap(map.id)}><Plus size={12} />新建子地图</button>
      </div>
      <p className="w-muted">子地图会建在当前打开的「{map.title}」下。</p>
      <ul className="w-atlas-maplist">
        {rows.map(({ item, depth }) => {
          const regions = atlas.regions.filter((region) => region.mapId === item.id).length;
          const places = atlas.places.filter((place) => place.mapId === item.id).length;
          const anchor = atlas.regions.find((region) => region.id === item.anchorRegionId);
          return (
            <li key={item.id} className={`w-atlas-maprow ${item.id === map.id ? "active" : ""}`} style={{ paddingLeft: 4 + depth * 14 }}>
              <button type="button" className="open" aria-current={item.id === map.id ? "page" : undefined} onClick={() => onOpenMap(item.id)}>
                <strong>{item.title}</strong>
                <span>{item.id === atlas.rootMapId ? "世界全图 · " : anchor ? `「${anchor.name}」分块 · ` : depth ? "子地图 · " : "顶层地图 · "}{regions} 地区 · {places} 地点{item.baseImageId ? " · 有底图" : ""}</span>
              </button>
              <button type="button" className="w-icon-btn small" aria-label={`生成或修改「${item.title}」`} title="生成/修改" disabled={busy} onClick={() => onMapAction(item.id)}><Sparkles size={13} /></button>
              <button type="button" className="w-icon-btn small" aria-label={`删除「${item.title}」`} title="删除" onClick={() => onDeleteMap(item.id)}><Trash2 size={13} /></button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function EventFlow({ atlas, axis, events, cursor, selection, onSelect, onLocate, onAddEvent }: SideProps) {
  const currentRef = useRef<HTMLButtonElement | null>(null);
  const firstCurrent = events.find((event) => eventPosition(axis, event) === cursor)?.id;
  useEffect(() => { currentRef.current?.scrollIntoView({ block: "nearest" }); }, [firstCurrent]);
  return (
    <>
      <div className="w-row"><button type="button" className="w-btn small" onClick={onAddEvent}><Plus size={12} />在此刻加事件</button></div>
      {!events.length ? <p className="w-muted">这个范围里还没有事件。</p> : (
        <ol className="w-atlas-flow">
          {events.map((event) => {
            const place = atlas.places.find((item) => item.id === event.placeId);
            const region = atlas.regions.find((item) => item.id === event.regionId);
            return (
              <li key={event.id}>
                <button type="button" ref={event.id === firstCurrent ? currentRef : undefined} className={`w-atlas-flow-item ${eventPosition(axis, event) === cursor ? "current" : ""} ${selection?.id === event.id ? "active" : ""}`} onClick={() => { onSelect({ type: "event", id: event.id }); onLocate(event); }}>
                  <span className="meta">{timeLabel(axis, event)} · {EVENT_KIND_LABELS[event.kind]}{place || region ? ` · ${place?.name ?? region?.name}` : ""}{event.origin === "user" ? " · 手动" : ""}</span>
                  <strong>{event.title}</strong>
                  <span className="body">{event.summary}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

function TimelineEditor({ atlas, axis, cursor, selection, onSelect, onCursor, mutate, onAddEvent, onAddMoment, onRemove }: SideProps) {
  const byStop = useMemo(() => {
    const groups = new Map<string, AtlasEvent[]>();
    for (const event of atlas.events) { const key = timeKey(event) ?? ""; groups.set(key, [...(groups.get(key) ?? []), event]); }
    return groups;
  }, [atlas.events]);
  const stops = axis.stops.map((stop, index) => ({ stop, index })).filter(({ stop, index }) => stop.kind !== "chapter" || byStop.has(stop.id) || index === cursor);
  const undated = byStop.get("") ?? [];
  const moveEvent = (event: AtlasEvent, index: number) => mutate((draft) => { const target = draft.events.find((item) => item.id === event.id); if (target) Object.assign(target, timeOfStop(axis, index), { origin: "user" }); });
  const swap = (moment: AtlasMoment, delta: number) => mutate((draft) => {
    const list = sortedMoments(draft, moment.phase);
    const index = list.findIndex((item) => item.id === moment.id);
    const self = list[index];
    const other = list[index + delta];
    if (!self || !other) return;
    [self.rank, other.rank] = [other.rank, self.rank];
    self.origin = "user";
  });
  const renderEvent = (event: AtlasEvent, index: number) => (
    <div key={event.id} className="w-atlas-stop-event">
      <button type="button" className="w-icon-btn small" aria-label="移到上一个时间点" disabled={index <= 0} onClick={() => moveEvent(event, index - 1)} title="移到上一个时间点"><ArrowLeft size={12} /></button>
      <button type="button" className={`title ${selection?.id === event.id ? "active" : ""}`} onClick={() => onSelect({ type: "event", id: event.id })}>{event.title}</button>
      <button type="button" className="w-icon-btn small" aria-label="移到下一个时间点" disabled={index < 0 || index >= axis.stops.length - 1} onClick={() => moveEvent(event, index + 1)} title="移到下一个时间点"><ArrowRight size={12} /></button>
    </div>
  );
  return (
    <div className="w-form">
      <div className="w-row">
        <button type="button" className="w-btn small" onClick={onAddEvent}><Plus size={12} />此刻加事件</button>
        <button type="button" className="w-btn small" onClick={() => onAddMoment("past")}><Plus size={12} />前史节点</button>
        <button type="button" className="w-btn small" onClick={() => onAddMoment("future")}><Plus size={12} />后续节点</button>
      </div>
      <p className="w-muted">正文之外的时间节点放开篇前的前史和还没写到的后续。箭头把事件挪到相邻的时间点；事件详情里可以挪到任意时间。</p>
      <ol className="w-atlas-stops">
        {stops.map(({ stop, index }) => {
          const moment = stop.kind === "chapter" ? null : atlas.moments.find((item) => item.id === stop.id) ?? null;
          const siblings = moment ? sortedMoments(atlas, moment.phase) : [];
          const order = moment ? siblings.findIndex((item) => item.id === moment.id) : -1;
          return (
            <li key={stop.id} className={`w-atlas-stop ${stop.kind} ${index === cursor ? "current" : ""}`}>
              <div className="w-atlas-stop-head">
                <button type="button" className="jump" title="跳到这一刻" onClick={() => onCursor(index)}>{stop.kind === "chapter" ? stop.label : `${stop.kind === "past" ? "前史" : "后续"} · ${stop.label}`}</button>
                {moment ? <>
                  <button type="button" className="w-icon-btn small" aria-label="提前" disabled={order <= 0} onClick={() => swap(moment, -1)} title="提前"><ArrowUp size={12} /></button>
                  <button type="button" className="w-icon-btn small" aria-label="推后" disabled={order >= siblings.length - 1} onClick={() => swap(moment, 1)} title="推后"><ArrowDown size={12} /></button>
                  <button type="button" className="w-icon-btn small" aria-label="删除时间节点" onClick={() => onRemove("moment", moment.id)} title="删除时间节点"><Trash2 size={12} /></button>
                </> : null}
              </div>
              {moment ? <CommitInput label="时间节点名" value={moment.label} placeholder="名称，例如：百年前·天京之变" onCommit={(label) => mutate((draft) => { const target = draft.moments.find((item) => item.id === moment.id); if (target) Object.assign(target, { label, origin: "user" }); })} /> : null}
              {(byStop.get(stop.id) ?? []).map((event) => renderEvent(event, index))}
            </li>
          );
        })}
        {undated.length ? <li className="w-atlas-stop"><div className="w-atlas-stop-head"><span className="w-muted">时间未定</span></div>{undated.map((event) => renderEvent(event, -1))}</li> : null}
      </ol>
    </div>
  );
}

function RegionDetail({ region, ...props }: SideProps & { region: AtlasRegion }) {
  const { atlas, mutate, busy, owners, onEnterRegion, onDetailRegion, onNewMap, onSelect, onRemove, axis, cursor } = props;
  const child = childMapOf(atlas, region.id);
  const places = atlas.places.filter((place) => place.regionId === region.id);
  const events = atlas.events.filter((event) => event.regionId === region.id || places.some((place) => place.id === event.placeId));
  const change = (patch: Partial<AtlasRegion>) => mutate((draft) => { const target = draft.regions.find((item) => item.id === region.id); if (target) Object.assign(target, patch); });
  const changes = atlas.territories.filter((item) => item.regionId === region.id).sort((left, right) => timedPosition(axis, left) - timedPosition(axis, right));
  const editTerrain = (id: string, patch: Partial<TerrainChange>) => mutate((draft) => { const target = draft.terrainChanges.find((item) => item.id === id); if (target) Object.assign(target, patch, { origin: "user" }); });
  const editChange = (id: string, patch: Partial<AtlasTerritory>) => mutate((draft) => { const target = draft.territories.find((item) => item.id === id); if (target) Object.assign(target, patch, { origin: "user" }); });
  return (
    <div className="w-form">
      <Field label="地区名"><CommitInput value={region.name} onCommit={(name) => change({ name })} /></Field>
      <div className="w-row">
        {child ? <button type="button" className="w-btn small primary" onClick={() => onEnterRegion(region.id)}>进入分块详情<ChevronRight size={12} /></button> : null}
        <button type="button" className="w-btn small" disabled={busy} onClick={() => onDetailRegion(region.id)}>{child ? "AI 重画分块" : "AI 生成分块"}</button>
        {child ? null : <button type="button" className="w-btn small" onClick={() => onNewMap(region.mapId, region.id)}>新建空白分块</button>}
      </div>
      <div className="w-inspector-grid">
        <Field label="地形"><select className="w-select" value={region.terrain} onChange={(event) => change({ terrain: event.currentTarget.value as Terrain })}>{Object.entries(TERRAIN_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        <p className="w-muted">开启“编辑布局”，使用推拉边界或涂地区直接调整范围。</p>
      </div>
      <Field label="初始控制者"><CommitInput value={region.owner} onCommit={(owner) => change({ owner })} /></Field>
      {owners.get(region.id) && owners.get(region.id) !== region.owner ? <p className="w-muted">此刻由 {owners.get(region.id)} 控制</p> : null}
      <section className="w-form">
        <div className="w-row"><span className="w-field-label">势力变更</span><span className="w-spacer" /><button type="button" className="w-btn small" onClick={() => mutate((draft) => { draft.territories.push({ id: uniqueId("territory"), regionId: region.id, ...timeOfStop(axis, cursor), owner: owners.get(region.id) || region.owner, note: "", origin: "user" }); })}><Plus size={12} />此刻易主</button></div>
        {changes.map((item) => (
          <div key={item.id} className="w-form">
            <TimeSelect axis={axis} value={item} label="易主时间" onChange={(time) => { if (time !== "new") editChange(item.id, time); }} />
            <div className="w-row"><CommitInput label="新的控制者" value={item.owner} placeholder="新的控制者" onCommit={(owner) => editChange(item.id, { owner })} /><button type="button" className="w-icon-btn small" aria-label="删除这次变更" onClick={() => onRemove("territory", item.id)} title="删除这次变更"><Trash2 size={12} /></button></div>
          </div>
        ))}
      </section>
      <section className="w-form">
        <div className="w-row"><span className="w-field-label">地形变化</span><span className="w-spacer" /><button type="button" className="w-btn small" onClick={() => mutate((draft) => { draft.terrainChanges.push({ id: uniqueId("terrain"), regionId: region.id, ...timeOfStop(axis, cursor), terrain: "wasteland", note: "", origin: "user" }); })}><Plus size={12} />此刻地貌改变</button></div>
        {atlas.terrainChanges.filter((item) => item.regionId === region.id).sort((left, right) => timedPosition(axis, left) - timedPosition(axis, right)).map((item) => (
          <div key={item.id} className="w-form">
            <TimeSelect axis={axis} value={item} label="变化时间" onChange={(time) => { if (time !== "new") editTerrain(item.id, time); }} />
            <div className="w-row">
              <select className="w-select" aria-label="变成" value={item.terrain} onChange={(event) => editTerrain(item.id, { terrain: event.currentTarget.value as Terrain })}>{Object.entries(TERRAIN_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
              <CommitInput label="怎么变的" value={item.note} placeholder="如：大火焚林" onCommit={(note) => editTerrain(item.id, { note })} />
              <button type="button" className="w-icon-btn small" aria-label="删除这次地形变化" onClick={() => onRemove("terrain", item.id)} title="删除这次地形变化"><Trash2 size={12} /></button>
            </div>
          </div>
        ))}
      </section>
      <Field label="概况"><CommitTextarea rows={4} value={region.summary} onCommit={(summary) => change({ summary })} /></Field>
      <BlockSection region={region} {...props} />
      <OwnerImages owner={`region:${region.id}`} title={`${region.name} 的配图`} material={`地貌和风土的场景图。${region.name}（${TERRAIN_LABELS[region.terrain]}）：${region.summary}`} />
      {places.length ? <section><span className="w-field-label">地点</span><div className="w-atlas-links">{places.map((place) => <button key={place.id} type="button" className="w-chip small" onClick={() => onSelect({ type: "place", id: place.id })}>{place.name}</button>)}</div></section> : null}
      {events.length ? <p className="w-muted">这里发生过 {events.length} 个事件。</p> : null}
      <button type="button" className="w-btn danger small" onClick={() => onRemove("region", region.id)}><Trash2 size={12} />删除地区</button>
    </div>
  );
}

/** The region painted on its own over the base, and how its edge meets the rest. */
function BlockSection({ region, ...props }: SideProps & { region: AtlasRegion }) {
  const { atlas, mutate, busy, onPaintBlock, overview } = props;
  const block = atlas.blocks.find((item) => item.mapId === region.mapId && item.regionId === region.id);
  const [edge, setEdge] = useState<BlockEdge>(block?.edge ?? "blend");
  const change = (patch: Partial<NonNullable<typeof block>>) => mutate((draft) => { const target = draft.blocks.find((item) => item.id === block?.id); if (target) Object.assign(target, patch); });
  return (
    <section className="w-form">
      <span className="w-field-label">块图</span>
      <div className="w-segmented" role="radiogroup" aria-label="块图边界">
        {(Object.keys(BLOCK_EDGE_LABELS) as BlockEdge[]).map((value) => <button key={value} type="button" role="radio" aria-checked={(block?.edge ?? edge) === value} className={(block?.edge ?? edge) === value ? "active" : ""} onClick={() => { setEdge(value); if (block) change({ edge: value }); }}>{BLOCK_EDGE_LABELS[value]}</button>)}
      </div>
      <p className="w-muted">{(block?.edge ?? edge) === "distinct" ? "按地区边界裁切、描边，自成一格。" : "边缘羽化，和周围的底图连成一片。"}画好后随时可以切换。</p>
      <div className="w-row">
        <button type="button" className="w-btn small" disabled={busy} title={overview.url ? "参考总图和底图" : "这张图还没有总图，会只按线稿画"} onClick={() => onPaintBlock(region.id, block?.edge ?? edge)}><Brush size={12} />{block ? "重画块图" : "画块图"}</button>
        {block ? <button type="button" className="w-btn small" onClick={() => change({ hidden: !block.hidden })}>{block.hidden ? <Eye size={12} /> : <EyeOff size={12} />}{block.hidden ? "显示" : "隐藏"}</button> : null}
        {block?.versions.length ? <button type="button" className="w-btn small" onClick={() => change({ assetId: block.versions[block.versions.length - 1], versions: block.versions.slice(0, -1) })}><Undo2 size={12} />换回上一版</button> : null}
        {block ? <button type="button" className="w-icon-btn small" aria-label="删除块图" onClick={() => mutate((draft) => { draft.blocks = draft.blocks.filter((item) => item.id !== block.id); })} title="删除块图"><Trash2 size={12} /></button> : null}
      </div>
    </section>
  );
}

/** Generates one owner's map token with the chosen method. */
function TokenAction({ kind, owner, busy, onPaintTokens }: { kind: TokenKind; owner: string; busy: boolean; onPaintTokens: SideProps["onPaintTokens"] }) {
  return <button type="button" className="w-btn small" disabled={busy} title="透明底，自动设为地图上显示的图" onClick={() => onPaintTokens(kind, "single", [owner])}><Stamp size={12} />生成{kind === "places" ? "组件" : kind === "characters" ? "头像" : "缩略图"}</button>;
}

function PlaceDetail({ place, ...props }: SideProps & { place: AtlasPlace }) {
  const { atlas, mutate, onSelect, onRemove, onOpenChapter, axis, busy, onEnterPlace, onInteriorPlace, onPaintTokens } = props;
  const interior = interiorOf(atlas, place.id);
  const change = (patch: Partial<AtlasPlace>) => mutate((draft) => { const target = draft.places.find((item) => item.id === place.id); if (target) Object.assign(target, patch); });
  const events = atlas.events.filter((event) => event.placeId === place.id).sort((left, right) => eventPosition(axis, left) - eventPosition(axis, right));
  return (
    <div className="w-form">
      <Field label="地名"><CommitInput value={place.name} onCommit={(name) => change({ name })} /></Field>
      <Field label="别名（顿号分隔）"><CommitInput value={place.aliases.join("、")} onCommit={(value) => change({ aliases: splitList(value) })} /></Field>
      <div className="w-inspector-grid">
        <Field label="类型"><select className="w-select" value={place.kind} onChange={(event) => change({ kind: event.currentTarget.value as PlaceKind })}>{Object.entries(PLACE_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        <Field label="重要度"><select className="w-select" value={place.importance} onChange={(event) => change({ importance: Number(event.currentTarget.value) as 1 | 2 | 3 })}><option value={3}>主要舞台</option><option value={2}>重要</option><option value={1}>次要</option></select></Field>
      </div>
      <Field label="显示方式"><select className="w-select" value={place.display ?? "icon"} onChange={(event) => change({ display: event.currentTarget.value as "icon" | "marker" })}><option value="icon">独立图标</option><option value="marker">通用标记（建筑在底图中）</option></select></Field>
      <Field label="所在地区"><select className="w-select" value={place.regionId ?? ""} onChange={(event) => change({ regionId: event.currentTarget.value || null })}><option value="">无</option>{atlas.regions.filter((region) => region.mapId === place.mapId).map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}</select></Field>
      <div className="w-row">
        {interior ? <button type="button" className="w-btn small primary" onClick={() => onEnterPlace(place.id)}>进入内部<ChevronRight size={12} /></button> : null}
        <button type="button" className="w-btn small" disabled={busy} onClick={() => onInteriorPlace(place.id)}><Sparkles size={12} />{interior ? "重画内部结构" : "生成内部结构"}</button>
      </div>
      <Field label="描述"><CommitTextarea rows={4} value={place.summary} onCommit={(summary) => change({ summary })} /></Field>
      <OwnerImages owner={`place:${place.id}`} roles={["base", "icon", "other"]} title={`${place.name} 的配图`} material={`${PLACE_KIND_LABELS[place.kind]}「${place.name}」的场景：${place.summary}`} actions={<TokenAction kind="places" owner={`place:${place.id}`} busy={busy} onPaintTokens={onPaintTokens} />} />
      {place.firstChapterId ? <button type="button" className="w-text-btn" onClick={() => onOpenChapter(place.firstChapterId as string)}>打开首次出现的章节</button> : null}
      {events.length ? <section><span className="w-field-label">发生的事</span><div className="w-atlas-links column">{events.map((event) => <button key={event.id} type="button" className="w-text-btn" onClick={() => onSelect({ type: "event", id: event.id })}>{timeLabel(axis, event)}：{event.title}</button>)}</div></section> : null}
      <button type="button" className="w-btn danger small" onClick={() => onRemove("place", place.id)}><Trash2 size={12} />删除地点</button>
    </div>
  );
}

function RouteDetail({ route, ...props }: SideProps & { route: AtlasRoute }) {
  const { mutate, onRemove, onRedrawRoute } = props;
  const change = (patch: Partial<AtlasRoute>) => mutate((draft) => { const target = draft.routes.find((item) => item.id === route.id); if (target) Object.assign(target, patch); });
  return (
    <div className="w-form">
      <Field label="路线名"><CommitInput value={route.name} onCommit={(name) => change({ name })} /></Field>
      <Field label="类型"><select className="w-select" value={route.kind} onChange={(event) => change({ kind: event.currentTarget.value as RouteKind })}>{Object.entries(ROUTE_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <Field label="说明"><CommitTextarea rows={3} value={route.summary} onCommit={(summary) => change({ summary })} /></Field>
      <div className="w-row">
        <button type="button" className="w-btn small" onClick={() => onRedrawRoute(route.id)}>重画走向</button>
        <button type="button" className="w-btn danger small" onClick={() => onRemove("route", route.id)}><Trash2 size={12} />删除路线</button>
      </div>
    </div>
  );
}

function EventDetail({ event, ...props }: SideProps & { event: AtlasEvent }) {
  const { mutate, onOpenChapter, onCursor, onRemove, axis, atlas, map } = props;
  const change = (patch: Partial<AtlasEvent>) => mutate((draft) => { const target = draft.events.find((item) => item.id === event.id); if (target) Object.assign(target, patch, { origin: "user" }); });
  const setTime = (time: Timed | "new") => {
    if (time !== "new") { change(time); return; }
    mutate((draft) => {
      const ranks = draft.moments.filter((moment) => moment.phase === "future").map((moment) => moment.rank);
      const moment: AtlasMoment = { id: uniqueId("moment"), phase: "future", rank: ranks.length ? Math.max(...ranks) + 1024 : 1024, label: "", summary: "", origin: "user" };
      draft.moments.push(moment);
      const target = draft.events.find((item) => item.id === event.id);
      if (target) Object.assign(target, { chapterId: null, momentId: moment.id, origin: "user" });
    });
  };
  const position = eventPosition(axis, event);
  return (
    <div className="w-form">
      <Field label="事件"><CommitInput value={event.title} onCommit={(title) => change({ title })} /></Field>
      <div className="w-row">
        {position >= 0 ? <button type="button" className="w-btn small" onClick={() => onCursor(position)}>跳到这一刻</button> : null}
        {event.chapterId ? <button type="button" className="w-btn small" onClick={() => onOpenChapter(event.chapterId as string)}>打开章节</button> : null}
        {event.origin === "user" ? <span className="w-pill">手动设定，同步时保留</span> : null}
      </div>
      <Field label="时间"><TimeSelect axis={axis} value={event} onChange={setTime} /></Field>
      <Field label="故事内时间"><CommitInput value={event.storyTime} placeholder="例如：永安三年冬" onCommit={(storyTime) => change({ storyTime })} /></Field>
      <div className="w-inspector-grid">
        <Field label="类型"><select className="w-select" value={event.kind} onChange={(item) => change({ kind: item.currentTarget.value as EventKind })}>{Object.entries(EVENT_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        <Field label="重要度"><select className="w-select" value={event.importance} onChange={(item) => change({ importance: Number(item.currentTarget.value) as 1 | 2 | 3 })}><option value={3}>关键</option><option value={2}>重要</option><option value={1}>次要</option></select></Field>
      </div>
      <Field label="地点"><select className="w-select" value={event.placeId ?? ""} onChange={(item) => change({ placeId: item.currentTarget.value || null })}><option value="">未定</option>{atlas.places.map((place) => <option key={place.id} value={place.id}>{place.name}{place.mapId !== map.id ? `（${atlas.maps.find((item) => item.id === place.mapId)?.title ?? ""}）` : ""}</option>)}</select></Field>
      {!event.placeId ? <Field label="地区"><select className="w-select" value={event.regionId ?? ""} onChange={(item) => change({ regionId: item.currentTarget.value || null })}><option value="">未定</option>{atlas.regions.map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}</select></Field> : null}
      <Field label="经过"><CommitTextarea rows={4} value={event.summary} onCommit={(summary) => change({ summary })} /></Field>
      <Field label="人物（顿号分隔）"><CommitInput value={event.characters.join("、")} onCommit={(value) => change({ characters: splitList(value) })} /></Field>
      <Field label="势力（顿号分隔）"><CommitInput value={event.factions.join("、")} onCommit={(value) => change({ factions: splitList(value) })} /></Field>
      <OwnerImages owner={`event:${event.id}`} title={`「${event.title}」配图`} material={`${event.title}：${event.summary}。在场：${event.characters.join("、")}`} />
      <button type="button" className="w-btn danger small" onClick={() => onRemove("event", event.id)}><Trash2 size={12} />删除事件</button>
    </div>
  );
}

function TokenStep({ busy, onPaintTokens }: SideProps) {
  const [method, setMethod] = useState<TokenMethod>("single");
  return (
    <li className="w-atlas-step">
      <h4>地点、人物与物品图标</h4>
      <p className="w-muted">地点显示建筑小图，人物显示头像，物品显示缩略图。已经有的会跳过；也可以在各自的详情里单独生成或指定。</p>
      <MethodSelect value={method} onChange={setMethod} />
      <div className="w-row">{(Object.keys(TOKEN_KIND_LABELS) as TokenKind[]).map((kind) => <button key={kind} type="button" className="w-btn small" disabled={busy || (kind !== "places" && method === "crop")} onClick={() => onPaintTokens(kind, method)}><Stamp size={12} />{TOKEN_KIND_LABELS[kind]}</button>)}</div>
    </li>
  );
}

function ScrollPanel(props: SideProps) {
  return <section className="w-form"><span className="w-field-label">草图 → 精图 → 模块</span><p className="w-muted">在地图上方打开“分阶段绘图”。每一步先预览并采纳，再继续；原有分块素材保留在素材库。</p><button type="button" className="w-btn small" onClick={props.onPaintOverview}>打开绘图流程</button><ol className="w-atlas-steps"><TokenStep {...props} /></ol></section>;
}

function MapDetail(props: SideProps) {
  const { atlas, map, mutate, onMapAction, onDeleteMap, busy } = props;
  const change = (patch: Partial<AtlasMap>) => mutate((draft) => { const target = draft.maps.find((item) => item.id === map.id); if (target) Object.assign(target, patch); });
  const parent = atlas.maps.find((item) => item.id === map.parentId);
  return (
    <div className="w-form">
      <p className="w-muted">点地图上的地区、地点、人物、物品、路线或事件查看详情。</p>
      <ScrollPanel {...props} />
      <Field label="这张图"><CommitInput value={map.title} onCommit={(title) => change({ title })} /></Field>
      {parent ? <p className="w-muted">属于「{parent.title}」</p> : null}
      <Field label="概述"><CommitTextarea rows={4} value={map.summary} onCommit={(summary) => change({ summary })} /></Field>
      <Field label="四周"><select className="w-select" value={map.surround} onChange={(event) => change({ surround: event.currentTarget.value === "land" ? "land" : "sea" })}><option value="sea">四面环海</option><option value="land">铺满画面（内陆、城区）</option></select></Field>
      {map.baseImageId ? <Field label="底图不透明度"><input type="range" min={0.2} max={1} step={0.05} value={map.baseOpacity} onChange={(input) => change({ baseOpacity: Number(input.currentTarget.value) })} /></Field> : null}
      <div className="w-row">
        <button type="button" className="w-btn small" disabled={busy} onClick={() => onMapAction(map.id)}><Sparkles size={12} />生成/修改…</button>
        {map.baseImageId ? <button type="button" className="w-btn small" onClick={() => change({ baseImageId: null })}>不用底图</button> : null}
        <button type="button" className="w-btn danger small" onClick={() => onDeleteMap(map.id)}><Trash2 size={12} />删除这张图</button>
      </div>
    </div>
  );
}

function CharacterDetail({ name, ...props }: SideProps & { name: string }) {
  const { atlas, axis, cursor, onSelect, onCharacter, character } = props;
  const events = atlas.events.filter((event) => event.characters.includes(name)).sort((left, right) => eventPosition(axis, left) - eventPosition(axis, right));
  const past = events.filter((event) => { const position = eventPosition(axis, event); return position >= 0 && position <= cursor; });
  const last = past[past.length - 1];
  const where = last ? atlas.places.find((place) => place.id === last.placeId)?.name ?? atlas.regions.find((region) => region.id === last.regionId)?.name : null;
  const holding = atlas.items.filter((item) => itemStopAt(axis, item, cursor)?.holder === name);
  const owner = props.characterOwner(name);
  return (
    <div className="w-form">
      <span className="w-pill">人物</span>
      <h3 style={{ margin: 0 }}>{name}</h3>
      <p>{last ? `此刻最后出现在${where ?? "某处"}（${last.title}）。` : "此刻还没有在地图上出现。"}{holding.length ? `随身带着${holding.map((item) => item.name).join("、")}。` : ""}</p>
      <button type="button" className="w-btn small" onClick={() => onCharacter(character === name ? "" : name)}>{character === name ? "隐藏足迹" : "显示足迹"}</button>
      <section><span className="w-field-label">经历</span><div className="w-atlas-links column">{events.map((event) => <button key={event.id} type="button" className="w-text-btn" onClick={() => onSelect({ type: "event", id: event.id })}>{timeLabel(axis, event)}：{event.title}</button>)}</div></section>
      <OwnerImages owner={owner} roles={["base", "avatar", "other"]} label="人物图" title={`${name} 的人物图`} material={`人物「${name}」。`} actions={<TokenAction kind="characters" owner={owner} busy={props.busy} onPaintTokens={props.onPaintTokens} />} />
      <p className="w-muted">人物的位置来自事件：给事件加上人物和地点，足迹就会跟着变。地图上显示头像，没有头像时显示名字的首字。</p>
    </div>
  );
}

function ItemDetail({ item, ...props }: SideProps & { item: AtlasItem }) {
  const { atlas, axis, cursor, mutate, onRemove, characters } = props;
  const change = (patch: Partial<AtlasItem>) => mutate((draft) => { const target = draft.items.find((entry) => entry.id === item.id); if (target) Object.assign(target, patch, { origin: "user" }); });
  const editStop = (index: number, patch: Partial<ItemStop>) => change({ stops: item.stops.map((stop, position) => (position === index ? { ...stop, ...patch } : stop)) });
  const now = itemStopAt(axis, item, cursor);
  const placeName = (id: string | null) => atlas.places.find((place) => place.id === id)?.name;
  return (
    <div className="w-form">
      <span className="w-pill">物品</span>
      <Field label="名称"><CommitInput value={item.name} onCommit={(name) => change({ name })} /></Field>
      <p>{now ? `此刻${now.holder ? `在${now.holder}手里` : ""}${now.placeId ? `${now.holder ? "，" : ""}在${placeName(now.placeId) ?? "某处"}` : ""}。` : "此刻还没出现。"}</p>
      <Field label="说明"><CommitTextarea rows={3} value={item.summary} onCommit={(summary) => change({ summary })} /></Field>
      <section className="w-form">
        <div className="w-row"><span className="w-field-label">去向</span><span className="w-spacer" /><button type="button" className="w-btn small" onClick={() => change({ stops: [...item.stops, { ...timeOfStop(axis, cursor), placeId: null, holder: now?.holder ?? "", note: "" }] })}><Plus size={12} />此刻易手</button></div>
        {item.stops.map((stop, index) => (
          <div key={index} className="w-form">
            <TimeSelect axis={axis} value={stop} label="时间" onChange={(time) => { if (time !== "new") editStop(index, time); }} />
            <div className="w-row">
              <CommitInput label="持有人" value={stop.holder} placeholder="持有人（可空）" onCommit={(holder) => editStop(index, { holder })} />
              <select className="w-select" aria-label="所在地点" value={stop.placeId ?? ""} onChange={(event) => editStop(index, { placeId: event.currentTarget.value || null })}><option value="">随持有人</option>{atlas.places.map((place) => <option key={place.id} value={place.id}>{place.name}</option>)}</select>
              <button type="button" className="w-icon-btn small" aria-label="删除这次去向" onClick={() => change({ stops: item.stops.filter((_, position) => position !== index) })} title="删除这次去向"><Trash2 size={12} /></button>
            </div>
          </div>
        ))}
      </section>
      {characters.length ? <p className="w-muted">持有人填人物名（如 {characters.slice(0, 3).join("、")}），物品会跟着他在地图上移动。</p> : null}
      <OwnerImages owner={`item:${item.id}`} roles={["base", "thumb", "other"]} label="物品图" title={`${item.name} 的配图`} material={`物品「${item.name}」：${item.summary}`} actions={<TokenAction kind="items" owner={`item:${item.id}`} busy={props.busy} onPaintTokens={props.onPaintTokens} />} />
      <button type="button" className="w-btn danger small" onClick={() => onRemove("item", item.id)}><Trash2 size={12} />删除物品</button>
    </div>
  );
}

function Detail(props: SideProps) {
  const { atlas, selection } = props;
  if (selection?.type === "character") return <CharacterDetail key={selection.id} {...props} name={selection.id} />;
  const item = selection?.type === "item" ? atlas.items.find((entry) => entry.id === selection.id) : undefined;
  if (item) return <ItemDetail key={item.id} {...props} item={item} />;
  const region = selection?.type === "region" ? atlas.regions.find((item) => item.id === selection.id) : undefined;
  const place = selection?.type === "place" ? atlas.places.find((item) => item.id === selection.id) : undefined;
  const route = selection?.type === "route" ? atlas.routes.find((item) => item.id === selection.id) : undefined;
  const event = selection?.type === "event" ? atlas.events.find((item) => item.id === selection.id) : undefined;
  if (region) return <RegionDetail key={region.id} {...props} region={region} />;
  if (place) return <PlaceDetail key={place.id} {...props} place={place} />;
  if (route) return <RouteDetail key={route.id} {...props} route={route} />;
  if (event) return <EventDetail key={event.id} {...props} event={event} />;
  return <MapDetail {...props} />;
}

function Layers({ layers, onLayers, characters, character, onCharacter, ownerNames, atlas, mutate, onSelect }: SideProps) {
  const items = useMemo<{ key: keyof AtlasLayers; label: string }[]>(() => [{ key: "painted", label: "画卷" }, { key: "terrain", label: "地形" }, { key: "characters", label: "人物" }, { key: "items", label: "物品" }, { key: "events", label: "事件" }, { key: "routes", label: "路线" }, { key: "labels", label: "地名" }, { key: "owners", label: "势力范围" }], []);
  return (
    <div className="w-form">
      <div className="w-atlas-layers">{items.map((item) => <label key={item.key} className="w-check"><input type="checkbox" checked={layers[item.key]} onChange={(event) => onLayers({ ...layers, [item.key]: event.currentTarget.checked })} />{item.label}</label>)}</div>
      <Field label="人物足迹" hint="沿时间轴画出这个人走过的地方。"><select className="w-select" value={character} onChange={(event) => onCharacter(event.currentTarget.value)}><option value="">不显示</option>{characters.slice(0, 200).map((name) => <option key={name} value={name}>{name}</option>)}</select></Field>
      <section className="w-form">
        <div className="w-row"><span className="w-field-label">物品</span><span className="w-spacer" /><button type="button" className="w-btn small" onClick={() => { const id = uniqueId("item"); mutate((draft) => { draft.items.push({ id, name: "新物品", summary: "", stops: [], origin: "user" }); }); onSelect({ type: "item", id }); }}><Plus size={12} />新建</button></div>
        {atlas.items.length ? <div className="w-atlas-links">{atlas.items.map((item) => <button key={item.id} type="button" className="w-chip small" onClick={() => onSelect({ type: "item", id: item.id })}>{item.name}</button>)}</div> : <p className="w-muted">还没有物品。同步章节时会读出重要物品的去向，也可以手动添加。</p>}
      </section>
      {layers.owners && ownerNames.length ? <section><span className="w-field-label">势力</span><ul className="w-atlas-legend">{ownerNames.map((name, index) => <li key={name}><i className={`o-${index % 8}`} />{name}</li>)}</ul></section> : null}
      <section><span className="w-field-label">路线</span><ul className="w-atlas-legend routes">{Object.entries(ROUTE_KIND_LABELS).map(([kind, label]) => <li key={kind}><svg width="30" height="8" aria-hidden="true"><path d="M1 4H29" className={`w-atlas-route r-${kind}`} /></svg>{label}</li>)}</ul></section>
    </div>
  );
}

export function GenerationBar({ message, onCancel }: { message: string; onCancel: () => void }) {
  return <div className="w-atlas-progress" role="status"><Spinner size={12} /><span>{message}</span><button type="button" className="w-text-btn" onClick={onCancel}>取消</button></div>;
}
