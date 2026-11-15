// How the map reads at a moment of the story. The axis runs through the chapters, then through what the outline still plans.
import { orderedChapters } from "../domain/documents";
import type { WriterProject } from "../types";
import type { RegionCell } from "./geometry";
import type { Atlas, AtlasEvent, AtlasItem, AtlasMap, AtlasMoment, AtlasPlace, AtlasRegion, CanvasTile, ItemStop, Point, Terrain, TerrainChange, TileVariant } from "./schema";

export type AxisStop = { id: string; label: string; volumeId: string | null; kind: "past" | "chapter" | "future" };
/** History before the book, then the chapters, then what is still planned. */
export type TimeAxis = {
  stops: AxisStop[];
  /** Index of the first chapter stop. */
  chapterStart: number;
  chapterCount: number;
  /** Index of the last chapter with text; `chapterStart - 1` before anything is written. */
  writtenThrough: number;
  /** Chapter id or moment id -> index. */
  position: Map<string, number>;
};

export function sortedMoments(atlas: Atlas, phase: AtlasMoment["phase"]): AtlasMoment[] {
  return atlas.moments.filter((moment) => moment.phase === phase).sort((left, right) => left.rank - right.rank);
}

export function momentLabel(moment: AtlasMoment, index: number) { return moment.label || `${moment.phase === "past" ? "前史" : "后续"} ${index + 1}`; }

export function buildAxis(project: WriterProject, atlas: Atlas): TimeAxis {
  const chapters = orderedChapters(project);
  const past = sortedMoments(atlas, "past");
  const stops: AxisStop[] = [
    ...past.map((moment, index): AxisStop => ({ id: moment.id, label: momentLabel(moment, index), volumeId: null, kind: "past" })),
    ...chapters.map((chapter, index): AxisStop => ({ id: chapter.id, label: `第 ${index + 1} 章 ${chapter.title}`, volumeId: chapter.volumeId, kind: "chapter" })),
    ...sortedMoments(atlas, "future").map((moment, index): AxisStop => ({ id: moment.id, label: momentLabel(moment, index), volumeId: null, kind: "future" })),
  ];
  const writtenThrough = chapters.reduce((last, chapter, index) => (chapter.wordCount > 0 ? past.length + index : last), past.length - 1);
  return { stops, chapterStart: past.length, chapterCount: chapters.length, writtenThrough, position: new Map(stops.map((stop, index) => [stop.id, index])) };
}

export function timeKey(record: { chapterId: string | null; momentId: string | null }) { return record.chapterId ?? record.momentId; }

export function eventPosition(axis: TimeAxis, event: AtlasEvent): number {
  const key = timeKey(event);
  return key === null ? -1 : axis.position.get(key) ?? -1;
}

/** Short label of where a record sits in time, for lists. */
export function timeLabel(axis: TimeAxis, record: { chapterId: string | null; momentId: string | null }): string {
  const key = timeKey(record);
  const index = key === null ? -1 : axis.position.get(key) ?? -1;
  if (index < 0) return "未定";
  const stop = axis.stops[index];
  return stop.kind === "chapter" ? `第 ${index - axis.chapterStart + 1} 章` : stop.label;
}

/** Events in story order; undated ones are left out. */
export function orderedEvents(atlas: Atlas, axis: TimeAxis): AtlasEvent[] {
  return atlas.events.filter((event) => eventPosition(axis, event) >= 0).sort((left, right) => eventPosition(axis, left) - eventPosition(axis, right));
}

/** `span` keeps only the last few stops; null keeps everything up to the cursor. */
export function eventsUntil(atlas: Atlas, axis: TimeAxis, cursor: number, span: number | null): AtlasEvent[] {
  const from = span === null ? 0 : cursor - span + 1;
  return orderedEvents(atlas, axis).filter((event) => { const position = eventPosition(axis, event); return position >= from && position <= cursor; });
}

/** Who holds the region at the cursor: the latest change at or before it, else its starting owner. */
export function ownerAt(atlas: Atlas, axis: TimeAxis, region: AtlasRegion, cursor: number): string {
  let owner = region.owner;
  let latest = -1;
  for (const change of atlas.territories) {
    const key = timeKey(change);
    if (change.regionId !== region.id || key === null) continue;
    const position = axis.position.get(key) ?? -1;
    if (position >= 0 && position <= cursor && position >= latest) { owner = change.owner; latest = position; }
  }
  return owner;
}

export function ownersOf(atlas: Atlas, mapId: string): string[] {
  const regionIds = new Set(atlas.regions.filter((region) => region.mapId === mapId).map((region) => region.id));
  return [...new Set([...atlas.regions.filter((region) => regionIds.has(region.id)).map((region) => region.owner), ...atlas.territories.filter((change) => regionIds.has(change.regionId)).map((change) => change.owner)].filter(Boolean))];
}

export function childMapOf(atlas: Atlas, regionId: string): AtlasMap | null {
  return atlas.maps.find((map) => map.anchorRegionId === regionId) ?? null;
}

/** The map showing a place's inside, if one has been made. */
export function interiorOf(atlas: Atlas, placeId: string): AtlasMap | null {
  return atlas.maps.find((map) => map.anchorPlaceId === placeId) ?? null;
}

/** The chain of maps from the world map down to `mapId`. */
export function mapTrail(atlas: Atlas, mapId: string): AtlasMap[] {
  const trail: AtlasMap[] = [];
  const seen = new Set<string>();
  let current = atlas.maps.find((map) => map.id === mapId);
  while (current && !seen.has(current.id)) { seen.add(current.id); trail.unshift(current); current = atlas.maps.find((map) => map.id === current?.parentId); }
  return trail;
}

function descendantsOf(atlas: Atlas, mapId: string): Set<string> {
  const found = new Set<string>();
  const visit = (id: string) => { for (const map of atlas.maps) if (map.parentId === id && !found.has(map.id)) { found.add(map.id); visit(map.id); } };
  visit(mapId);
  return found;
}

/** The ancestor of `mapId` that is a direct child of `parentId`. */
function childOnTheWay(atlas: Atlas, mapId: string, parentId: string): AtlasMap | null {
  const trail = mapTrail(atlas, mapId);
  const index = trail.findIndex((map) => map.id === parentId);
  return index >= 0 ? trail[index + 1] ?? null : null;
}

export type MapPin = { key: string; point: Point; place: AtlasPlace | null; region: AtlasRegion | null; events: AtlasEvent[] };

/** Where an event appears on a map; events inside a detail map show at its region on the parent map. */
export function eventPoint(atlas: Atlas, cells: Map<string, RegionCell>, mapId: string, event: AtlasEvent): { key: string; point: Point; place: AtlasPlace | null; region: AtlasRegion | null } | null {
  if (event.point && event.mapId === mapId && !event.placeId) return { key: `event:${event.id}`, point: event.point, place: null, region: atlas.regions.find((r) => r.id === event.regionId) ?? null };
  const place = event.placeId ? atlas.places.find((item) => item.id === event.placeId) ?? null : null;
  if (place?.mapId === mapId) return { key: place.id, point: place.point, place, region: null };
  if (place && descendantsOf(atlas, mapId).has(place.mapId)) {
    const child = childOnTheWay(atlas, place.mapId, mapId);
    if (place.parentPoint && child?.id === place.mapId) return { key: place.id, point: place.parentPoint, place, region: null };
    const anchorPlace = atlas.places.find((item) => item.id === child?.anchorPlaceId && item.mapId === mapId);
    if (anchorPlace) return { key: anchorPlace.id, point: anchorPlace.point, place: anchorPlace, region: null };
    const region = atlas.regions.find((item) => item.id === child?.anchorRegionId);
    const cell = region ? cells.get(region.id) : undefined;
    if (region && cell) return { key: region.id, point: cell.centroid, place: null, region };
  }
  const region = event.regionId ? atlas.regions.find((item) => item.id === event.regionId) : undefined;
  if (region?.mapId === mapId) { const cell = cells.get(region.id); if (cell) return { key: region.id, point: cell.centroid, place: null, region }; }
  return null;
}

/** Events grouped by the spot they mark on this map. */
export function pinsOn(atlas: Atlas, cells: Map<string, RegionCell>, mapId: string, events: AtlasEvent[]): MapPin[] {
  const pins = new Map<string, MapPin>();
  for (const event of events) {
    const located = eventPoint(atlas, cells, mapId, event);
    if (!located) continue;
    const pin = pins.get(located.key) ?? { ...located, events: [] };
    pin.events.push(event);
    pins.set(located.key, pin);
  }
  return [...pins.values()];
}

/** Places drawn on a map: its own, plus the major places of its detail maps at their parent-map position. */
export function placesOn(atlas: Atlas, mapId: string): { place: AtlasPlace; point: Point; foreign: boolean }[] {
  const shown = atlas.places.filter((place) => place.mapId === mapId).map((place) => ({ place, point: place.point, foreign: false }));
  const children = new Set(atlas.maps.filter((map) => map.parentId === mapId).map((map) => map.id));
  for (const place of atlas.places) if (children.has(place.mapId) && place.parentPoint && place.importance === 3) shown.push({ place, point: place.parentPoint, foreign: true });
  return shown;
}

/** Where a character has been up to the cursor, on this map; repeat stays at one spot collapse. */
export function characterTrail(atlas: Atlas, axis: TimeAxis, cells: Map<string, RegionCell>, mapId: string, character: string, cursor: number): { point: Point; event: AtlasEvent }[] {
  const trail: { point: Point; event: AtlasEvent; key: string }[] = [];
  for (const event of eventsUntil(atlas, axis, cursor, null)) {
    if (!event.characters.includes(character)) continue;
    const located = eventPoint(atlas, cells, mapId, event);
    if (!located) continue;
    const last = trail[trail.length - 1];
    if (last?.key === located.key) { last.event = event; continue; }
    trail.push({ point: located.point, event, key: located.key });
  }
  return trail.map(({ point, event }) => ({ point, event }));
}

/** The latest record at or before the cursor among those dated on the axis. */
function latestAt<T extends { chapterId: string | null; momentId: string | null }>(axis: TimeAxis, records: T[], cursor: number): T | null {
  let found: T | null = null;
  let best = -1;
  for (const record of records) {
    const key = timeKey(record);
    const position = key === null ? -1 : axis.position.get(key) ?? -1;
    if (position >= 0 && position <= cursor && position >= best) { found = record; best = position; }
  }
  return found;
}

/** What the region's land looks like at the cursor. */
export function terrainAt(atlas: Atlas, axis: TimeAxis, region: AtlasRegion, cursor: number): Terrain {
  return latestAt(axis, atlas.terrainChanges.filter((change) => change.regionId === region.id), cursor)?.terrain ?? region.terrain;
}

/** The terrain change in force at the cursor, if any. */
export function terrainChangeAt(atlas: Atlas, axis: TimeAxis, regionId: string, cursor: number): TerrainChange | null {
  return latestAt(axis, atlas.terrainChanges.filter((change) => change.regionId === regionId), cursor);
}

/** The picture a tile shows at the cursor: its latest variant in force, else the base painting. */
export function tileAssetAt(atlas: Atlas, axis: TimeAxis, mapId: string, tile: CanvasTile, cursor: number): { assetId: string | null; variant: TileVariant | null } {
  const variant = latestAt(axis, atlas.variants.filter((item) => item.mapId === mapId && item.tileIndex === tile.index), cursor);
  return variant ? { assetId: variant.assetId, variant } : { assetId: tile.assetId, variant: null };
}

/** Where an item is at the cursor: with its holder, or at a place. */
export function itemStopAt(axis: TimeAxis, item: AtlasItem, cursor: number): ItemStop | null {
  return latestAt(axis, item.stops, cursor);
}

export type CharacterSpot = { name: string; point: Point; event: AtlasEvent };
/** Where each character was last seen at or before the cursor, on this map. */
export function characterSpots(atlas: Atlas, axis: TimeAxis, cells: Map<string, RegionCell>, mapId: string, cursor: number, names: string[]): CharacterSpot[] {
  const spots: CharacterSpot[] = [];
  const events = eventsUntil(atlas, axis, cursor, null);
  for (const name of names) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event.characters.includes(name)) continue;
      const located = eventPoint(atlas, cells, mapId, event);
      if (located) spots.push({ name, point: located.point, event });
      break;
    }
  }
  return spots;
}

/** Point of a place on this map (its own position, or its mark on a parent map). */
export function placePoint(atlas: Atlas, cells: Map<string, RegionCell>, mapId: string, placeId: string): Point | null {
  return eventPoint(atlas, cells, mapId, { placeId, regionId: null } as AtlasEvent)?.point ?? null;
}

export function charactersIn(atlas: Atlas): string[] {
  const counts = new Map<string, number>();
  for (const event of atlas.events) for (const name of event.characters) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].sort((left, right) => right[1] - left[1]).map(([name]) => name);
}
