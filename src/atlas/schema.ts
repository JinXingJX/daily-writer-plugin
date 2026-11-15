// The world map of a work: nested maps of regions and places, with events that unfold along the chapter order.
import { uniqueId } from "../domain/ids";
import { arrayValue, asRecord, stringArray, stringValue } from "../domain/util";

export const ATLAS_WIDTH = 1000;
export const ATLAS_HEIGHT = 700;
export type Point = [number, number];

export type Terrain = "plains" | "forest" | "mountain" | "desert" | "marsh" | "tundra" | "sea" | "lake" | "volcanic" | "wasteland" | "city" | "other";
export const TERRAIN_LABELS: Record<Terrain, string> = { plains: "平原", forest: "森林", mountain: "山地", desert: "荒漠", marsh: "沼泽", tundra: "冻土", sea: "海域", lake: "湖泊", volcanic: "火山", wasteland: "废土", city: "城区", other: "其他" };
export type PlaceKind = "capital" | "city" | "town" | "village" | "fortress" | "sect" | "ruin" | "landmark" | "port" | "dungeon" | "camp" | "other";
export const PLACE_KIND_LABELS: Record<PlaceKind, string> = { capital: "都城", city: "城市", town: "城镇", village: "村落", fortress: "要塞", sect: "宗门", ruin: "遗迹", landmark: "地标", port: "港口", dungeon: "秘境", camp: "营地", other: "其他" };
export type RouteKind = "road" | "river" | "sea" | "portal" | "wall" | "front";
export const ROUTE_KIND_LABELS: Record<RouteKind, string> = { road: "道路", river: "河流", sea: "航线", portal: "传送", wall: "城墙/边防", front: "战线" };
export type EventKind = "battle" | "meeting" | "discovery" | "death" | "travel" | "politics" | "disaster" | "ritual" | "other";
export const EVENT_KIND_LABELS: Record<EventKind, string> = { battle: "战斗", meeting: "相遇", discovery: "发现", death: "死亡", travel: "行旅", politics: "权谋", disaster: "灾变", ritual: "仪式", other: "事件" };

export type RegionGrid = { cols: number; rows: number; ids: string[]; cells: number[] };
export type MapRect = { x: number; y: number; w: number; h: number };
export type MapModule = { id: string; assetId: string; rect: MapRect; regionId: string | null; label: string; chapterId: string | null; momentId: string | null };
export type ArtVersion = { assetId: string; stage: "draft" | "fine"; modules: MapModule[]; dirty?: MapRect[] };
export type MapArtwork = ArtVersion & {
  tokens?: { assetId: string; owner: string; role: "icon" | "avatar" | "thumb"; name: string }[];
  candidates: string[];
  pending: { assetId: string; kind: "fine" | "module"; module: MapModule | null; source: string } | null;
  history: ArtVersion[];
  dirty: MapRect[];
};

export type AtlasMap = {
  id: string;
  parentId: string | null;
  /** The parent map's region this map zooms into. */
  anchorRegionId: string | null;
  /** The parent map's place whose inside this map shows (a palace, a sect, a city). */
  anchorPlaceId: string | null;
  title: string;
  summary: string;
  /** "sea" surrounds the land with ocean; "land" fills the frame, as a district map does. */
  surround: "sea" | "land";
  baseImageId: string | null;
  baseOpacity: number;
  /** The painted scroll of this map, when one has been generated. */
  canvas: AtlasCanvas | null;
  boundaries?: RegionGrid | null;
  artwork?: MapArtwork | null;
};

/** One tile of a painted scroll. `versions` keeps earlier paintings, newest last, so a redraw can be undone. */
export type CanvasTile = { index: number; assetId: string | null; versions: string[]; error: string };
/** A map painted as one continuous picture, in `cols` × `rows` tiles that overlap and fade into each other. */
export type AtlasCanvas = {
  styleId: string;
  /** One picture of the whole map, painted first; every tile and block follows it so the scroll stays one piece. */
  overviewAssetId: string | null;
  overviewVersions: string[];
  cols: number; rows: number; tiles: CanvasTile[]; updatedAt: number;
};
/**
 * A region painted on its own over the scroll. "distinct" stands apart, cut to the region's shape with an inked border;
 * "blend" fades into the base around it.
 */
export type BlockEdge = "distinct" | "blend";
export type AtlasBlock = { id: string; mapId: string; regionId: string; assetId: string; versions: string[]; edge: BlockEdge; hidden: boolean };
/** A repainted tile that replaces the base tile from a chapter or moment on (a forest burned, a city fallen). */
export type TileVariant = { id: string; mapId: string; tileIndex: number; assetId: string; chapterId: string | null; momentId: string | null; label: string; origin: RecordOrigin };
/** Where an item is over time: held by someone, or lying somewhere. */
export type ItemStop = { chapterId: string | null; momentId: string | null; placeId: string | null; holder: string; note: string };
export type AtlasItem = { id: string; name: string; summary: string; stops: ItemStop[]; origin: RecordOrigin };
/** From this chapter or moment on, the region's land looks different (burned, flooded, frozen, built up). */
export type TerrainChange = { id: string; regionId: string; chapterId: string | null; momentId: string | null; terrain: Terrain; note: string; origin: RecordOrigin };
export type AtlasRegion = { id: string; mapId: string; name: string; terrain: Terrain; summary: string; owner: string; center: Point; weight: number; labelPoint?: Point | null };
export type AtlasPlace = {
  id: string; mapId: string; regionId: string | null; name: string; aliases: string[]; kind: PlaceKind; point: Point;
  /** Where the place sits on the parent map once it has moved into a detail map. */
  parentPoint: Point | null;
  display?: "icon" | "marker";
  summary: string; importance: 1 | 2 | 3; firstChapterId: string | null;
};
export type AtlasRoute = { id: string; mapId: string; name: string; kind: RouteKind; points: Point[]; summary: string };
/** "extracted" records are rebuilt by AI passes over the book; "user" ones were set by the author or the assistant and are kept. */
export type RecordOrigin = "extracted" | "user";
/** A point on the timeline outside the chapters: history before the book opens, or what the outline still plans. */
export type AtlasMoment = { id: string; phase: "past" | "future"; rank: number; label: string; summary: string; origin: RecordOrigin };
/** An event sits at a chapter or at a moment; with neither it is undated and stays off the timeline. */
export type AtlasEvent = {
  id: string; title: string; summary: string; kind: EventKind; placeId: string | null; regionId: string | null;
  point?: Point | null; mapId?: string | null;
  chapterId: string | null; momentId: string | null; storyTime: string; characters: string[]; factions: string[]; importance: 1 | 2 | 3; origin: RecordOrigin;
};
/** From this chapter or moment on, `regionId` is held by `owner`. */
export type AtlasTerritory = { id: string; regionId: string; chapterId: string | null; momentId: string | null; owner: string; note: string; origin: RecordOrigin };

export type Atlas = {
  version: 1;
  rootMapId: string;
  maps: AtlasMap[];
  regions: AtlasRegion[];
  places: AtlasPlace[];
  routes: AtlasRoute[];
  events: AtlasEvent[];
  moments: AtlasMoment[];
  territories: AtlasTerritory[];
  items: AtlasItem[];
  terrainChanges: TerrainChange[];
  variants: TileVariant[];
  blocks: AtlasBlock[];
  /** chapter id -> card hash the chapter's events were read from. */
  coverage: Record<string, string>;
  updatedAt: number;
};

export function emptyAtlas(title = "世界全图"): Atlas {
  const root = normalizeMap({ title });
  return { version: 1, rootMapId: root.id, maps: [root], regions: [], places: [], routes: [], events: [], moments: [], territories: [], items: [], terrainChanges: [], variants: [], blocks: [], coverage: {}, updatedAt: 0 };
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const number = (value: unknown, fallback: number) => { const parsed = typeof value === "string" ? Number(value) : value; return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : fallback; };
const nullable = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const textOr = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value.trim() : fallback);
const oneOf = <T extends string>(labels: Record<T, string>, value: unknown, fallback: T): T => (typeof value === "string" && value in labels ? value as T : fallback);
const originValue = (value: unknown): RecordOrigin => (value === "user" ? "user" : "extracted");
const importance = (value: unknown, fallback: 1 | 2 | 3 = 2): 1 | 2 | 3 => { const level = Math.round(number(value, fallback)); return level <= 1 ? 1 : level >= 3 ? 3 : 2; };

/** Accepts `[x, y]` or `{x, y}`, and keeps the point inside the frame. */
export function pointValue(value: unknown): Point | null {
  const pair = Array.isArray(value) ? value : (() => { const record = asRecord(value); return [record.x, record.y]; })();
  const x = number(pair[0], Number.NaN);
  const y = number(pair[1], Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [Math.round(clamp(x, 0, ATLAS_WIDTH)), Math.round(clamp(y, 0, ATLAS_HEIGHT))];
}

export function normalizeMap(value: unknown): AtlasMap {
  const map = asRecord(value);
  return { id: textOr(map.id, uniqueId("map")), parentId: nullable(map.parentId), anchorRegionId: nullable(map.anchorRegionId), anchorPlaceId: nullable(map.anchorPlaceId), title: textOr(map.title, "未命名地图"), summary: stringValue(map.summary), surround: map.surround === "land" ? "land" : "sea", baseImageId: nullable(map.baseImageId), baseOpacity: clamp(number(map.baseOpacity, 0.85), 0, 1), canvas: normalizeCanvas(map.canvas), boundaries: normalizeGrid(map.boundaries), artwork: normalizeArtwork(map.artwork) };
}
export function normalizeCanvas(value: unknown): AtlasCanvas | null {
  const canvas = asRecord(value);
  if (!Array.isArray(canvas.tiles)) return null;
  const cols = clamp(Math.round(number(canvas.cols, 4)), 1, 8);
  const rows = clamp(Math.round(number(canvas.rows, 3)), 1, 8);
  const byIndex = new Map(arrayValue(canvas.tiles).map(asRecord).map((tile) => [Math.round(number(tile.index, -1)), tile]));
  const tiles = Array.from({ length: cols * rows }, (_, index): CanvasTile => {
    const tile = byIndex.get(index) ?? {};
    return { index, assetId: nullable(tile.assetId), versions: stringArray(tile.versions, 20), error: stringValue(tile.error) };
  });
  return { styleId: stringValue(canvas.styleId), overviewAssetId: nullable(canvas.overviewAssetId), overviewVersions: stringArray(canvas.overviewVersions, 20), cols, rows, tiles, updatedAt: number(canvas.updatedAt, 0) };
}
export function normalizeBlock(value: unknown): AtlasBlock | null {
  const block = asRecord(value);
  const assetId = nullable(block.assetId);
  if (!assetId) return null;
  return { id: textOr(block.id, uniqueId("block")), mapId: stringValue(block.mapId), regionId: stringValue(block.regionId), assetId, versions: stringArray(block.versions, 20), edge: block.edge === "distinct" ? "distinct" : "blend", hidden: block.hidden === true };
}
export function normalizeVariant(value: unknown): TileVariant | null {
  const variant = asRecord(value);
  const assetId = nullable(variant.assetId);
  if (!assetId) return null;
  return { id: textOr(variant.id, uniqueId("variant")), mapId: stringValue(variant.mapId), tileIndex: Math.round(number(variant.tileIndex, 0)), assetId, chapterId: nullable(variant.chapterId), momentId: nullable(variant.chapterId) ? null : nullable(variant.momentId), label: stringValue(variant.label), origin: originValue(variant.origin) };
}
export function normalizeItemStop(value: unknown): ItemStop {
  const stop = asRecord(value);
  return { chapterId: nullable(stop.chapterId), momentId: nullable(stop.chapterId) ? null : nullable(stop.momentId), placeId: nullable(stop.placeId), holder: stringValue(stop.holder).trim(), note: stringValue(stop.note) };
}
export function normalizeItem(value: unknown): AtlasItem {
  const item = asRecord(value);
  return { id: textOr(item.id, uniqueId("item")), name: textOr(item.name, "未命名物品"), summary: stringValue(item.summary), stops: arrayValue(item.stops).map(normalizeItemStop).slice(0, 200), origin: originValue(item.origin) };
}
export function normalizeTerrainChange(value: unknown): TerrainChange {
  const change = asRecord(value);
  return { id: textOr(change.id, uniqueId("terrain")), regionId: stringValue(change.regionId), chapterId: nullable(change.chapterId), momentId: nullable(change.chapterId) ? null : nullable(change.momentId), terrain: oneOf(TERRAIN_LABELS, change.terrain, "wasteland"), note: stringValue(change.note), origin: originValue(change.origin) };
}
export function normalizeRegion(value: unknown): AtlasRegion {
  const region = asRecord(value);
  return { id: textOr(region.id, uniqueId("region")), mapId: stringValue(region.mapId), name: textOr(region.name, "未命名地区"), terrain: oneOf(TERRAIN_LABELS, region.terrain, "plains"), summary: stringValue(region.summary), owner: stringValue(region.owner), center: pointValue(region.center) ?? [ATLAS_WIDTH / 2, ATLAS_HEIGHT / 2], weight: clamp(number(region.weight, 1), 0.5, 2), labelPoint: pointValue(region.labelPoint) };
}
export function normalizePlace(value: unknown): AtlasPlace {
  const place = asRecord(value);
  return { id: textOr(place.id, uniqueId("place")), mapId: stringValue(place.mapId), regionId: nullable(place.regionId), name: textOr(place.name, "未命名地点"), aliases: stringArray(place.aliases, 12), kind: oneOf(PLACE_KIND_LABELS, place.kind, "other"), point: pointValue(place.point) ?? [ATLAS_WIDTH / 2, ATLAS_HEIGHT / 2], parentPoint: pointValue(place.parentPoint), display: place.display === "marker" ? "marker" : "icon", summary: stringValue(place.summary), importance: importance(place.importance), firstChapterId: nullable(place.firstChapterId) };
}
export function normalizeRoute(value: unknown): AtlasRoute {
  const route = asRecord(value);
  return { id: textOr(route.id, uniqueId("route")), mapId: stringValue(route.mapId), name: stringValue(route.name), kind: oneOf(ROUTE_KIND_LABELS, route.kind, "road"), points: arrayValue(route.points).map(pointValue).filter((point): point is Point => Boolean(point)).slice(0, 200), summary: stringValue(route.summary) };
}
export function normalizeEvent(value: unknown): AtlasEvent {
  const event = asRecord(value);
  return { id: textOr(event.id, uniqueId("event")), title: textOr(event.title, "未命名事件"), summary: stringValue(event.summary), kind: oneOf(EVENT_KIND_LABELS, event.kind, "other"), placeId: nullable(event.placeId), regionId: nullable(event.regionId), chapterId: nullable(event.chapterId), momentId: nullable(event.chapterId) ? null : nullable(event.momentId), point: pointValue(event.point), mapId: nullable(event.mapId), storyTime: stringValue(event.storyTime), characters: stringArray(event.characters, 30), factions: stringArray(event.factions, 12), importance: importance(event.importance), origin: originValue(event.origin) };
}
export function normalizeMoment(value: unknown): AtlasMoment {
  const moment = asRecord(value);
  return { id: textOr(moment.id, uniqueId("moment")), phase: moment.phase === "past" ? "past" : "future", rank: number(moment.rank, 0), label: stringValue(moment.label).trim(), summary: stringValue(moment.summary), origin: originValue(moment.origin) };
}
export function normalizeTerritory(value: unknown): AtlasTerritory {
  const territory = asRecord(value);
  return { id: textOr(territory.id, uniqueId("territory")), regionId: stringValue(territory.regionId), chapterId: nullable(territory.chapterId), momentId: nullable(territory.chapterId) ? null : nullable(territory.momentId), owner: stringValue(territory.owner), note: stringValue(territory.note), origin: originValue(territory.origin) };
}

export function normalizeAtlas(value: unknown): Atlas | null {
  const atlas = asRecord(value);
  const maps = arrayValue(atlas.maps).map(normalizeMap);
  if (!maps.length) return null;
  const rootMapId = maps.some((map) => map.id === atlas.rootMapId) ? atlas.rootMapId as string : maps.find((map) => !map.parentId)?.id ?? maps[0].id;
  const coverage: Record<string, string> = {};
  for (const [chapterId, hash] of Object.entries(asRecord(atlas.coverage))) if (typeof hash === "string") coverage[chapterId] = hash;
  const moments = arrayValue(atlas.moments).map(normalizeMoment);
  // Maps saved before moments existed dated planned events by a bare order.
  const events = arrayValue(atlas.events).map((raw) => {
    const event = normalizeEvent(raw);
    const order = asRecord(raw).plannedOrder;
    if (event.chapterId || event.momentId || typeof order !== "number") return event;
    const id = `moment-planned-${order}`;
    if (!moments.some((moment) => moment.id === id)) moments.push(normalizeMoment({ id, phase: "future", rank: order * 1024 }));
    return { ...event, momentId: id };
  });
  return { version: 1, rootMapId, maps, regions: arrayValue(atlas.regions).map(normalizeRegion), places: arrayValue(atlas.places).map(normalizePlace), routes: arrayValue(atlas.routes).map(normalizeRoute), events, moments, territories: arrayValue(atlas.territories).map(normalizeTerritory), items: arrayValue(atlas.items).map(normalizeItem), terrainChanges: arrayValue(atlas.terrainChanges).map(normalizeTerrainChange), variants: arrayValue(atlas.variants).flatMap((item) => normalizeVariant(item) ?? []), blocks: arrayValue(atlas.blocks).flatMap((item) => normalizeBlock(item) ?? []), coverage, updatedAt: number(atlas.updatedAt, 0) };
}

/** Stable text of every record, used to show what a draft changes. */
export function atlasRecords(atlas: Atlas): Map<string, string> {
  const records = new Map<string, string>();
  for (const list of [atlas.maps, atlas.regions, atlas.places, atlas.routes, atlas.events, atlas.moments, atlas.territories, atlas.items, atlas.terrainChanges, atlas.variants, atlas.blocks]) for (const item of list) records.set(item.id, JSON.stringify(item));
  return records;
}

export function changedRecordIds(base: Atlas, draft: Atlas): Set<string> {
  const before = atlasRecords(base);
  const changed = new Set<string>();
  for (const [id, text] of atlasRecords(draft)) if (before.get(id) !== text) changed.add(id);
  return changed;
}

export function removedRecordCount(base: Atlas, draft: Atlas): number {
  const after = atlasRecords(draft);
  let removed = 0;
  for (const id of atlasRecords(base).keys()) if (!after.has(id)) removed += 1;
  return removed;
}

export function normalizeGrid(value: unknown): RegionGrid | null {
  const grid = asRecord(value);
  const cols = number(grid.cols, 0), rows = number(grid.rows, 0);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 500 || rows > 350 || !Array.isArray(grid.cells) || grid.cells.length !== cols * rows) return null;
  const ids = stringArray(grid.ids, 500);
  return { cols, rows, ids, cells: grid.cells.map((cell) => typeof cell === "number" && Number.isInteger(cell) && cell >= 0 && cell <= ids.length ? cell : 0) };
}
function normalizeRect(value: unknown): MapRect | null {
  const r = asRecord(value);
  const x = clamp(number(r.x, 0), 0, ATLAS_WIDTH), y = clamp(number(r.y, 0), 0, ATLAS_HEIGHT);
  const w = clamp(number(r.w, 0), 0, ATLAS_WIDTH - x), h = clamp(number(r.h, 0), 0, ATLAS_HEIGHT - y);
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}
export function normalizeArtwork(value: unknown): MapArtwork | null {
  const art = asRecord(value);
  if (!art.stage) return null;
  const moduleOf = (raw: unknown): MapModule[] => {
    const m = asRecord(raw), rect = normalizeRect(m.rect);
    return rect && nullable(m.assetId) ? [{ id: textOr(m.id, uniqueId("module")), assetId: stringValue(m.assetId), rect, regionId: nullable(m.regionId), label: stringValue(m.label), chapterId: nullable(m.chapterId), momentId: nullable(m.momentId) }] : [];
  };
  const version = (raw: unknown): ArtVersion => {
    const v = asRecord(raw);
    return { assetId: stringValue(v.assetId), stage: v.stage === "fine" ? "fine" : "draft", modules: arrayValue(v.modules).flatMap(moduleOf).slice(-200), dirty: arrayValue(v.dirty).flatMap((r) => normalizeRect(r) ?? []).slice(-50) };
  };
  const pending = asRecord(art.pending);
  return { ...version(art), tokens: arrayValue(art.tokens).map(asRecord).filter((t) => nullable(t.assetId) && nullable(t.owner)).map((t) => ({ assetId: stringValue(t.assetId), owner: stringValue(t.owner), name: stringValue(t.name), role: t.role === "avatar" ? "avatar" as const : t.role === "thumb" ? "thumb" as const : "icon" as const })).slice(-100), candidates: stringArray(art.candidates, 12), pending: nullable(pending.assetId) ? { assetId: stringValue(pending.assetId), kind: pending.kind === "module" ? "module" : "fine", module: moduleOf(pending.module)[0] ?? null, source: stringValue(pending.source) } : null, history: arrayValue(art.history).map(version).slice(-20), dirty: arrayValue(art.dirty).flatMap((r) => normalizeRect(r) ?? []).slice(-50) };
}
