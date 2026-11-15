import { gridCells } from "./boundaries";
// Edits to the map as data, shared by the generation pipeline, the assistant's tools and the editor. Records can name
// their neighbours (a region, a place, a moment) instead of knowing their ids, since models work from names.
import { arrayValue, asRecord, stringValue } from "../domain/util";
import { freeSpot, regionCells, type RegionCell } from "./geometry";
import { emptyAtlas, normalizeEvent, normalizeItem, normalizeItemStop, normalizeMap, normalizeMoment, normalizePlace, normalizeRegion, normalizeRoute, normalizeTerrainChange, normalizeTerritory, pointValue, type Atlas, type AtlasMoment, type AtlasPlace, type AtlasRegion, type Point } from "./schema";
import { sortedMoments } from "./timeline";

/** What an operation may refer to besides the atlas itself. */
export type OpsContext = {
  /** Chapter ids in reading order, so `chapter: 12` can be resolved and chapter ids checked. */
  chapterIds?: string[];
  /** The map new regions, places and routes go on when they name none. */
  defaultMapId?: string;
};

/** The operations as described to models; kept next to the code that applies them. */
export const ATLAS_OPS_GUIDE = `每项含 type 和数据；已有记录带 id 时只传要改的字段，新记录不带 id。坐标 x 0-1000、y 0-700，北在上。
- upsertMap{map:{id,title,summary,surround:sea|land,parentId,anchorRegion:所属地区名或 id,anchorPlace:内部结构所属的地点名或 id}}：不带 parentId、anchorRegion、anchorPlace 的是顶层地图；removeMap{id} 连同它的子地图一起删除。
- upsertRegion{region:{id,mapId,name,terrain:plains|forest|mountain|desert|marsh|tundra|sea|lake|volcanic|wasteland|city|other,summary,owner,center:[x,y],weight:0.5-2}}；removeRegion{id}。
- upsertPlace{place:{id,mapId,region:地区名,name,aliases[],kind:capital|city|town|village|fortress|sect|ruin|landmark|port|dungeon|camp|other,point:[x,y],summary,importance:1-3}}；removePlace{id}。
- upsertRoute{route:{id,mapId,name,kind:road|river|sea|portal|wall|front,via:[按顺序经过的地名],points:[[x,y]],summary}}；removeRoute{id}。
- upsertMoment{moment:{id,phase:past（开篇之前的前史）|future（还没写到的后续）,label:时间名,summary,after:排在哪个时间节点之后（名或 id）}}；removeMoment{id} 会连同该节点上的事件一起删除。
- upsertEvent{event:{id,title,summary,kind:battle|meeting|discovery|death|travel|politics|disaster|ritual|other,place:地名,region:地区名,chapter:章序号（从 1 开始）,moment:时间节点名或 id（和 chapter 二选一，没有会新建，配 phase）,phase,storyTime:故事内时间,characters[],factions[],importance:1-3}}；removeEvent{id}。
- upsertTerritory{territory:{id,region:地区名,chapter:章序号 或 moment,owner:新的控制者,note}}；removeTerritory{id}。
- upsertTerrainChange{change:{id,region:地区名,chapter:章序号 或 moment,terrain:新地形（同 region.terrain）,note:怎么变的，如“大火焚林”}}：从那时起这个地区的地貌变了；removeTerrainChange{id}。
- upsertItem{item:{id,name,summary,stops:[{chapter 或 moment,holder:持有人名,place:所在地名,note}]}}：物品随时间在谁手里、在哪里，stops 给全量；removeItem{id}。`;

export function findRegion(atlas: Atlas, name: unknown, mapId?: string): AtlasRegion | undefined {
  const key = stringValue(name).trim();
  if (!key) return undefined;
  const pool = mapId ? atlas.regions.filter((region) => region.mapId === mapId) : atlas.regions;
  return pool.find((region) => region.id === key || region.name === key) ?? pool.find((region) => region.name.includes(key) || key.includes(region.name));
}

export function findPlace(atlas: Atlas, name: unknown): AtlasPlace | undefined {
  const key = stringValue(name).trim();
  if (!key) return undefined;
  return atlas.places.find((place) => place.id === key || place.name === key || place.aliases.includes(key)) ?? atlas.places.find((place) => key.length >= 2 && (place.name.includes(key) || key.includes(place.name)));
}

export function cellsOfMap(atlas: Atlas, mapId: string): Map<string, RegionCell> {
  const map = atlas.maps.find((item) => item.id === mapId);
  const regions = atlas.regions.filter((region) => region.mapId === mapId);
  return map?.boundaries ? gridCells(map.boundaries, new Set(regions.map((r) => r.id))) : regionCells(regions, map?.surround ?? "sea");
}

/** A position for a place that came without coordinates, inside its region when it has one. */
export function positionFor(atlas: Atlas, mapId: string, region: AtlasRegion | undefined, seed: string): Point {
  const cells = cellsOfMap(atlas, mapId);
  const taken = atlas.places.filter((place) => place.mapId === mapId).map((place) => place.point);
  const cell = region ? cells.get(region.id) : [...cells.values()].sort((left, right) => right.area - left.area)[0];
  return cell ? freeSpot(cell, taken, seed) : [500, 350];
}

export function resolveRoutePoints(atlas: Atlas, raw: Record<string, unknown>, mapId: string): Point[] {
  const direct = arrayValue(raw.points).map(pointValue).filter((point): point is Point => Boolean(point));
  if (direct.length >= 2) return direct;
  return arrayValue(raw.via).flatMap((name) => { const place = findPlace(atlas, name); return place && place.mapId === mapId ? [place.point] : []; });
}

const RANK_STEP = 1024;
function endRank(atlas: Atlas, phase: AtlasMoment["phase"]) {
  const ranks = atlas.moments.filter((moment) => moment.phase === phase).map((moment) => moment.rank);
  return ranks.length ? Math.max(...ranks) + RANK_STEP : RANK_STEP;
}

export function findMoment(atlas: Atlas, key: unknown): AtlasMoment | undefined {
  const text = stringValue(key).trim();
  return text ? atlas.moments.find((moment) => moment.id === text) ?? atlas.moments.find((moment) => moment.label === text) : undefined;
}

/** The moment named by `key`, created at the end of its phase when there is none. */
export function ensureMoment(atlas: Atlas, key: unknown, phase: unknown): AtlasMoment {
  const existing = findMoment(atlas, key);
  if (existing) return existing;
  const side = phase === "past" ? "past" : "future";
  const moment = normalizeMoment({ phase: side, label: stringValue(key).trim(), rank: endRank(atlas, side), origin: "user" });
  atlas.moments.push(moment);
  return moment;
}

/** Where a record sits in time, from `chapter` (number), `chapterId` or `moment`; unchanged when none is given. */
function resolveTime(atlas: Atlas, input: Record<string, unknown>, context: OpsContext, existing?: { chapterId: string | null; momentId: string | null }) {
  if (input.chapter !== undefined && input.chapter !== null && input.chapter !== "") {
    const id = context.chapterIds?.[Number(input.chapter) - 1];
    if (!id) throw new Error(`没有第 ${stringValue(input.chapter) || String(input.chapter)} 章。`);
    return { chapterId: id, momentId: null };
  }
  if (typeof input.chapterId === "string" && input.chapterId) {
    if (context.chapterIds && !context.chapterIds.includes(input.chapterId)) throw new Error(`没有 id 为 ${input.chapterId} 的章节。`);
    return { chapterId: input.chapterId, momentId: null };
  }
  const key = input.moment ?? input.momentId;
  if (stringValue(key).trim()) return { chapterId: null, momentId: ensureMoment(atlas, key, input.phase).id };
  return { chapterId: existing?.chapterId ?? null, momentId: existing?.momentId ?? null };
}

function upsert<T extends { id: string }>(list: T[], item: T) {
  const index = list.findIndex((existing) => existing.id === item.id);
  if (index >= 0) list[index] = item; else list.push(item);
}

/** Removes a map together with everything on it and the maps below it. */
function removeMapDeep(atlas: Atlas, id: string) {
  for (const child of atlas.maps.filter((map) => map.parentId === id)) removeMapDeep(atlas, child.id);
  const regionIds = new Set(atlas.regions.filter((region) => region.mapId === id).map((region) => region.id));
  const placeIds = new Set(atlas.places.filter((place) => place.mapId === id).map((place) => place.id));
  atlas.maps = atlas.maps.filter((map) => map.id !== id);
  atlas.regions = atlas.regions.filter((region) => region.mapId !== id);
  atlas.places = atlas.places.filter((place) => place.mapId !== id);
  atlas.routes = atlas.routes.filter((route) => route.mapId !== id);
  atlas.territories = atlas.territories.filter((change) => !regionIds.has(change.regionId));
  atlas.terrainChanges = atlas.terrainChanges.filter((change) => !regionIds.has(change.regionId));
  atlas.variants = atlas.variants.filter((variant) => variant.mapId !== id);
  atlas.blocks = atlas.blocks.filter((block) => block.mapId !== id && !regionIds.has(block.regionId));
  for (const item of atlas.items) for (const stop of item.stops) if (stop.placeId && placeIds.has(stop.placeId)) stop.placeId = null;
  for (const event of atlas.events) { if (event.placeId && placeIds.has(event.placeId)) event.placeId = null; if (event.regionId && regionIds.has(event.regionId)) event.regionId = null; }
}

export function isTopLevel(atlas: Atlas, mapId: string) {
  const map = atlas.maps.find((item) => item.id === mapId);
  return Boolean(map) && !atlas.maps.some((item) => item.id === map?.parentId);
}

function removeMap(atlas: Atlas, id: string) {
  if (!atlas.maps.some((map) => map.id === id)) throw new Error(`没有 id 为 ${id} 的地图。`);
  if (isTopLevel(atlas, id) && atlas.maps.filter((map) => isTopLevel(atlas, map.id)).length <= 1) throw new Error("至少要保留一张顶层地图。");
  removeMapDeep(atlas, id);
  if (!atlas.maps.some((map) => map.id === atlas.rootMapId)) atlas.rootMapId = (atlas.maps.find((map) => isTopLevel(atlas, map.id)) ?? atlas.maps[0]).id;
}

function removeRegion(atlas: Atlas, id: string) {
  const child = atlas.maps.find((map) => map.anchorRegionId === id);
  if (child) removeMapDeep(atlas, child.id);
  for (const map of atlas.maps) if (map.boundaries) { const index = map.boundaries.ids.indexOf(id) + 1; if (index) map.boundaries.cells = map.boundaries.cells.map((cell) => cell === index ? 0 : cell); }
  atlas.regions = atlas.regions.filter((region) => region.id !== id);
  atlas.territories = atlas.territories.filter((change) => change.regionId !== id);
  atlas.terrainChanges = atlas.terrainChanges.filter((change) => change.regionId !== id);
  atlas.blocks = atlas.blocks.filter((block) => block.regionId !== id);
  for (const place of atlas.places) if (place.regionId === id) place.regionId = null;
  for (const event of atlas.events) if (event.regionId === id) event.regionId = null;
}

function removePlace(atlas: Atlas, id: string) {
  const interior = atlas.maps.find((map) => map.anchorPlaceId === id);
  if (interior) removeMapDeep(atlas, interior.id);
  atlas.places = atlas.places.filter((place) => place.id !== id);
  for (const event of atlas.events) if (event.placeId === id) event.placeId = null;
  for (const item of atlas.items) for (const stop of item.stops) if (stop.placeId === id) stop.placeId = null;
}

function requireMap(atlas: Atlas, value: unknown, context: OpsContext) {
  const id = stringValue(value).trim();
  if (!id) return context.defaultMapId && atlas.maps.some((map) => map.id === context.defaultMapId) ? context.defaultMapId : atlas.rootMapId;
  if (!atlas.maps.some((map) => map.id === id)) throw new Error(`没有 id 为 ${id} 的地图。`);
  return id;
}

function applyOne(atlas: Atlas, raw: unknown, context: OpsContext) {
  const operation = asRecord(raw);
  const type = stringValue(operation.type);
  const id = stringValue(operation.id).trim();
  switch (type) {
    case "upsertMap": {
      const input = asRecord(operation.map);
      const existing = atlas.maps.find((map) => map.id === input.id);
      const anchor = input.anchorRegion !== undefined || input.anchorRegionId !== undefined ? findRegion(atlas, input.anchorRegion ?? input.anchorRegionId) : undefined;
      if ((input.anchorRegion ?? input.anchorRegionId) && !anchor) throw new Error(`没有地区「${stringValue(input.anchorRegion ?? input.anchorRegionId)}」。`);
      if (anchor && atlas.maps.some((map) => map.anchorRegionId === anchor.id && map.id !== input.id)) throw new Error(`「${anchor.name}」已经有分块详情图了。`);
      const parentId = anchor ? anchor.mapId : input.parentId !== undefined ? (stringValue(input.parentId).trim() ? requireMap(atlas, input.parentId, {}) : null) : existing?.parentId ?? null;
      if (existing && parentId === existing.id) throw new Error("地图不能放在自己下面。");
      const anchorPlace = input.anchorPlace !== undefined || input.anchorPlaceId !== undefined ? findPlace(atlas, input.anchorPlace ?? input.anchorPlaceId) : undefined;
      if ((input.anchorPlace ?? input.anchorPlaceId) && !anchorPlace) throw new Error(`没有地点「${stringValue(input.anchorPlace ?? input.anchorPlaceId)}」。`);
      if (anchorPlace && atlas.maps.some((map) => map.anchorPlaceId === anchorPlace.id && map.id !== input.id)) throw new Error(`「${anchorPlace.name}」已经有内部结构图了。`);
      const parent = anchorPlace ? anchorPlace.mapId : parentId;
      upsert(atlas.maps, normalizeMap({ surround: parent ? "land" : "sea", ...existing, ...input, parentId: parent, anchorRegionId: anchor?.id ?? existing?.anchorRegionId ?? null, anchorPlaceId: anchorPlace?.id ?? existing?.anchorPlaceId ?? null }));
      return;
    }
    case "upsertRegion": {
      const input = asRecord(operation.region);
      const existing = atlas.regions.find((region) => region.id === input.id);
      upsert(atlas.regions, normalizeRegion({ ...existing, ...input, mapId: requireMap(atlas, input.mapId ?? existing?.mapId, context) }));
      return;
    }
    case "upsertPlace": {
      const input = asRecord(operation.place);
      const existing = atlas.places.find((place) => place.id === input.id);
      const mapId = requireMap(atlas, input.mapId ?? existing?.mapId, context);
      const region = input.region !== undefined || input.regionId !== undefined ? findRegion(atlas, input.region ?? input.regionId, mapId) : undefined;
      const place = normalizePlace({ ...existing, ...input, mapId, regionId: region?.id ?? existing?.regionId ?? null });
      if (!pointValue(input.point) && !existing) place.point = positionFor(atlas, mapId, region, place.id);
      upsert(atlas.places, place);
      return;
    }
    case "upsertRoute": {
      const input = asRecord(operation.route);
      const existing = atlas.routes.find((route) => route.id === input.id);
      const mapId = requireMap(atlas, input.mapId ?? existing?.mapId, context);
      const points = resolveRoutePoints(atlas, input, mapId);
      const route = normalizeRoute({ ...existing, ...input, mapId, points: points.length >= 2 ? points : existing?.points ?? [] });
      if (route.points.length < 2) throw new Error(`路线「${route.name}」至少要有两个已知地点或坐标。`);
      upsert(atlas.routes, route);
      return;
    }
    case "upsertMoment": {
      const input = asRecord(operation.moment);
      const existing = atlas.moments.find((moment) => moment.id === input.id);
      const phase = input.phase === "past" || input.phase === "future" ? input.phase : existing?.phase ?? "future";
      let rank = typeof input.rank === "number" ? input.rank : existing && existing.phase === phase ? existing.rank : endRank(atlas, phase);
      const after = findMoment(atlas, input.after);
      if (after && after.phase === phase) {
        const next = sortedMoments(atlas, phase).find((moment) => moment.rank > after.rank && moment.id !== existing?.id);
        rank = next ? (after.rank + next.rank) / 2 : after.rank + RANK_STEP;
      }
      upsert(atlas.moments, normalizeMoment({ ...existing, ...input, phase, rank, origin: "user" }));
      return;
    }
    case "upsertEvent": {
      const input = asRecord(operation.event);
      const existing = atlas.events.find((event) => event.id === input.id);
      const place = input.place !== undefined ? findPlace(atlas, input.place) : undefined;
      const region = input.region !== undefined ? findRegion(atlas, input.region) : undefined;
      const time = resolveTime(atlas, input, context, existing);
      upsert(atlas.events, normalizeEvent({ ...existing, ...input, placeId: place?.id ?? input.placeId ?? existing?.placeId ?? null, regionId: region?.id ?? input.regionId ?? existing?.regionId ?? null, ...time, origin: "user" }));
      return;
    }
    case "upsertTerritory": {
      const input = asRecord(operation.territory);
      const existing = atlas.territories.find((change) => change.id === input.id);
      const region = findRegion(atlas, input.region ?? input.regionId ?? existing?.regionId);
      if (!region) throw new Error("势力变更要指明已知的地区。");
      upsert(atlas.territories, normalizeTerritory({ ...existing, ...input, regionId: region.id, ...resolveTime(atlas, input, context, existing), origin: "user" }));
      return;
    }
    case "upsertTerrainChange": {
      const input = asRecord(operation.change);
      const existing = atlas.terrainChanges.find((change) => change.id === input.id);
      const region = findRegion(atlas, input.region ?? input.regionId ?? existing?.regionId);
      if (!region) throw new Error("地形变化要指明已知的地区。");
      upsert(atlas.terrainChanges, normalizeTerrainChange({ ...existing, ...input, regionId: region.id, ...resolveTime(atlas, input, context, existing), origin: "user" }));
      return;
    }
    case "upsertItem": {
      const input = asRecord(operation.item);
      const existing = atlas.items.find((item) => item.id === input.id) ?? atlas.items.find((item) => !input.id && item.name === stringValue(input.name).trim());
      const stops = input.stops === undefined ? existing?.stops ?? [] : arrayValue(input.stops).map((raw) => {
        const stop = asRecord(raw);
        const place = stop.place !== undefined ? findPlace(atlas, stop.place) : undefined;
        if (stringValue(stop.place).trim() && !place) throw new Error(`地图上没有「${stringValue(stop.place)}」。`);
        return normalizeItemStop({ ...stop, ...resolveTime(atlas, stop, context), placeId: place?.id ?? stop.placeId ?? null });
      });
      upsert(atlas.items, normalizeItem({ ...existing, ...input, id: existing?.id ?? input.id, stops, origin: "user" }));
      return;
    }
    case "removeTerrainChange": atlas.terrainChanges = atlas.terrainChanges.filter((change) => change.id !== id); return;
    case "removeItem": atlas.items = atlas.items.filter((item) => item.id !== id); return;
    case "removeMap": removeMap(atlas, id); return;
    case "removeRegion": removeRegion(atlas, id); return;
    case "removePlace": removePlace(atlas, id); return;
    case "removeRoute": atlas.routes = atlas.routes.filter((route) => route.id !== id); return;
    case "removeEvent": atlas.events = atlas.events.filter((event) => event.id !== id); return;
    case "removeMoment":
      atlas.moments = atlas.moments.filter((moment) => moment.id !== id);
      atlas.events = atlas.events.filter((event) => event.momentId !== id);
      atlas.territories = atlas.territories.filter((change) => change.momentId !== id);
      atlas.terrainChanges = atlas.terrainChanges.filter((change) => change.momentId !== id);
      atlas.variants = atlas.variants.filter((variant) => variant.momentId !== id);
      for (const item of atlas.items) item.stops = item.stops.filter((stop) => stop.momentId !== id);
      return;
    case "removeTerritory": atlas.territories = atlas.territories.filter((change) => change.id !== id); return;
    default: throw new Error(`未知操作 ${type}。`);
  }
}

/** Applies what it can; an operation that fails is reported and does not stop the rest. */
export function applyAtlasOps(base: Atlas | null, operations: unknown[], context: OpsContext = {}): { atlas: Atlas; applied: number; skipped: string[] } {
  const atlas: Atlas = base ? structuredClone(base) : emptyAtlas();
  const skipped: string[] = [];
  let applied = 0;
  for (const operation of operations) {
    try { applyOne(atlas, operation, context); applied += 1; }
    catch (error) { skipped.push(error instanceof Error ? error.message : String(error)); }
  }
  return { atlas, applied, skipped };
}
