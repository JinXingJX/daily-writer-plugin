import { domainTask } from "../../worker/domainTask";
// Draws and maintains the world map from what the book already knows: geography from the settings (and from reference
// images the author attaches), events chapter by chapter from story memory, history and what is still to come from the
// background and outline. Every run ends in a draft for the author to adopt. Records the author or the assistant set
// by hand (`origin: "user"`) survive every pass.
import { orderedChapters } from "../../domain/documents";
import { uniqueId } from "../../domain/ids";
import { arrayValue, asRecord, mapLimit, stringValue } from "../../domain/util";
import { describeMap } from "../../atlas/describe";
import { ATLAS_HEIGHT, ATLAS_WIDTH, emptyAtlas, normalizeEvent, normalizeItem, normalizeItemStop, normalizeMap, normalizeMoment, normalizePlace, normalizeRegion, normalizeRoute, normalizeTerrainChange, normalizeTerritory, PLACE_KIND_LABELS, pointValue, type Atlas, type AtlasMap, type AtlasPlace, type AtlasRegion } from "../../atlas/schema";
import { applyAtlasOps, ATLAS_OPS_GUIDE, findPlace, findRegion, positionFor, resolveRoutePoints } from "../../atlas/operations";
import { loadCurrentAtlas, saveAtlasDraft } from "../../atlas/store";
import { imageFilePath, loadImageLibrary } from "../../images/store";
import { ENTITY_CATEGORY_LABELS, type ChapterCard } from "../../memory/schema";
import type { MemoryView } from "../../memory/view";
import type { StoryPlan } from "../../story/schema";
import type { WriterChapterMeta, WriterProject } from "../../types";
import { assertVision, invokeJson } from "../client";

/**
 * full: the world map, every event and the timeline from scratch. sync: events of new or changed chapters, and the
 * outline's future. redraw: the geography of one map. detail: a region opened into its own map. revise: targeted
 * changes to one map from an instruction or reference images.
 */
export type AtlasMode = "layout" | "full" | "sync" | "redraw" | "detail" | "revise" | "interior";
export type AtlasJobInput = {
  project: WriterProject; memory: MemoryView | null; story: StoryPlan | null; mode: AtlasMode;
  /** The map to redraw or revise; the world map when omitted. */
  mapId?: string;
  regionId?: string;
  /** interior: the place whose inside is drawn. */
  placeId?: string;
  instruction?: string;
  /** Library images the model looks at: a sketch, an existing map, a concept painting. */
  referenceIds?: string[];
  /** Also put the first reference under the map as its base image. */
  useReferenceAsBase?: boolean;
  onProgress?: (message: string) => void; signal?: AbortSignal;
};
export type AtlasJobResult = { atlas: Atlas; mapId: string; summary: string; warnings: string[] };

const SYSTEM = `你为长篇小说绘制可交互的世界地图数据。只依据给你的材料：材料写明的地名、方位、距离、归属必须照用；材料没写的可以合理补足，但不和材料冲突，也不编造重要新势力。只输出要求的 JSON，不要 Markdown 代码块。`;
const BATCH_CHARS = 24_000;
const MIN_GEOGRAPHY_SOURCE = 40;
const MAX_REFERENCES = 4;

function clipped(text: string, limit: number) { return text.length > limit ? `${text.slice(0, limit)}…` : text; }

type References = { ids: string[]; paths: string[] };

async function resolveReferences(projectId: string, ids: string[] | undefined): Promise<References> {
  if (!ids?.length) return { ids: [], paths: [] };
  const library = await loadImageLibrary(projectId);
  const assets = ids.flatMap((id) => library.assets.find((asset) => asset.id === id) ?? []).filter((asset) => ["image/png", "image/jpeg", "image/webp"].includes(asset.mime)).slice(0, MAX_REFERENCES);
  return { ids: assets.map((asset) => asset.id), paths: assets.map((asset) => imageFilePath(projectId, asset)) };
}

function referenceNote(references: References) {
  if (!references.paths.length) return "";
  return `【参考图】随这条消息附上了 ${references.paths.length} 张图，是作者给这张地图的参考（手绘草图、已有的地图或概念图）。按图上的海岸线、地区分布和相对位置来安排；图上读得出的地名照用，读不清的不要猜。坐标和第一张图对齐：x 从 0 到 ${ATLAS_WIDTH} 对应图的左边到右边，y 从 0 到 ${ATLAS_HEIGHT} 对应图的上边到下边。参考图和文字材料冲突时，版图以参考图为准，名称和归属以文字材料为准。`;
}

function worldSources(project: WriterProject, memory: MemoryView | null, story: StoryPlan | null): string {
  const worldSections = memory?.aggregates.worldview?.sections.map((section) => `${section.title}：${section.content}`).join("\n") ?? "";
  const locations = memory ? memory.entities.filter((entity) => entity.category === "location").map((entity) => ({ entity, count: memory.mentionCount(entity.id) })).sort((left, right) => right.count - left.count).slice(0, 120).map(({ entity, count }) => `- ${entity.name}${entity.aliases.length ? `（又名${entity.aliases.slice(0, 3).join("、")}）` : ""}｜提及 ${count} 次｜${clipped(entity.summary, 120)}`).join("\n") : "";
  const sceneLocations = new Map<string, number>();
  for (const card of memory?.cards.values() ?? []) for (const scene of card.scenes) if (scene.location.trim()) sceneLocations.set(scene.location.trim(), (sceneLocations.get(scene.location.trim()) ?? 0) + 1);
  const sceneList = [...sceneLocations].sort((left, right) => right[1] - left[1]).slice(0, 100).map(([name, count]) => `${name}×${count}`).join("、");
  const volumes = memory?.aggregates.volumes.map((volume) => `- ${project.volumes.find((item) => item.id === volume.volumeId)?.title ?? "某卷"}：${clipped(volume.mainline || volume.summary, 300)}`).join("\n") ?? "";
  return [
    project.worldview.trim() && `【世界观】\n${clipped(project.worldview, 14_000)}`,
    project.background.trim() && `【背景】\n${clipped(project.background, 4_000)}`,
    project.outline.trim() && `【大纲】\n${clipped(project.outline, 8_000)}`,
    worldSections && `【从正文归纳的世界观】\n${clipped(worldSections, 8_000)}`,
    project.factions.length ? `【势力】\n${project.factions.map((faction) => `- ${faction.name}：${clipped(faction.summary, 200)}`).join("\n")}` : "",
    locations && `【${ENTITY_CATEGORY_LABELS.location}档案】\n${locations}`,
    sceneList && `【正文场景中出现的地点及次数】\n${sceneList}`,
    volumes && `【分卷主线】\n${volumes}`,
    story?.promise.opening.where ? `【开篇地点】${story.promise.opening.where}` : "",
  ].filter(Boolean).join("\n\n");
}

const GEOGRAPHY_SHAPE = `{"title":"地图名","summary":"一两句总览","surround":"sea（四面环海）或 land（内陆，铺满画面）","regions":[{"name":"地区名","terrain":"plains|forest|mountain|desert|marsh|tundra|sea|lake|volcanic|wasteland|city|other","summary":"这里是什么样、谁在这里、为什么重要","owner":"开篇时控制这里的势力，没有留空","center":[x,y],"weight":0.6到1.6,地位越大的地区越大}],"places":[{"name":"地名","aliases":["别名"],"region":"所在地区名","kind":"capital|city|town|village|fortress|sect|ruin|landmark|port|dungeon|camp|other","point":[x,y],"summary":"一句话","importance":1到3,3只给主要舞台}],"routes":[{"name":"路线名","kind":"road|river|sea|portal|wall|front","via":["按顺序经过的地名"],"summary":"一句话"}]}`;
const COORDINATE_RULES = `坐标 x 从 ${60} 到 ${ATLAS_WIDTH - 60}，y 从 ${60} 到 ${ATLAS_HEIGHT - 60}，上北下南左西右东。材料说相邻的地区中心要靠近，说隔海、远隔的要拉开，各地区中心至少相距 110。place 的 point 要落在所属地区中心周围。`;

type Geography = { title: string; summary: string; surround: "sea" | "land"; regions: Record<string, unknown>[]; places: Record<string, unknown>[]; routes: Record<string, unknown>[] };

function parseGeography(value: unknown): Geography {
  const record = asRecord(value);
  const regions = arrayValue(record.regions).map(asRecord).filter((item) => stringValue(item.name).trim());
  if (!regions.length) throw new Error("模型没有给出地区。");
  return { title: stringValue(record.title), summary: stringValue(record.summary), surround: record.surround === "land" ? "land" : "sea", regions, places: arrayValue(record.places).map(asRecord).filter((item) => stringValue(item.name).trim()), routes: arrayValue(record.routes).map(asRecord) };
}

function isBelow(atlas: Atlas, mapId: string, ancestorId: string) {
  const seen = new Set<string>();
  let current = atlas.maps.find((map) => map.id === mapId);
  while (current?.parentId && !seen.has(current.id)) { if (current.parentId === ancestorId) return true; seen.add(current.id); current = atlas.maps.find((map) => map.id === current?.parentId); }
  return false;
}

/**
 * Replaces the geography of `map`. Records are matched by name, so events, images and detail maps stay attached to
 * what survives; places the new geography no longer names leave the map, and detail maps of vanished regions go too.
 */
function placeGeography(atlas: Atlas, map: AtlasMap, geography: Geography) {
  const oldRegions = new Map(atlas.regions.filter((region) => region.mapId === map.id).map((region) => [region.name, region]));
  map.title = geography.title || map.title;
  map.summary = geography.summary || map.summary;
  map.surround = geography.surround;
  atlas.regions = atlas.regions.filter((region) => region.mapId !== map.id);
  for (const item of geography.regions) atlas.regions.push(normalizeRegion({ ...item, id: oldRegions.get(stringValue(item.name).trim())?.id, mapId: map.id }));
  const kept = new Set<string>();
  const unplaced: { id: string; region: AtlasRegion | undefined }[] = [];
  for (const item of geography.places) {
    const found = findPlace(atlas, item.name);
    // The place an interior map belongs to is outside it; a room with its name is a different record.
    const existing = found && found.id !== map.anchorPlaceId ? found : undefined;
    const point = pointValue(item.point);
    // A place that already lives on a detail map below this one stays there; only its mark on this map moves.
    if (existing && existing.mapId !== map.id && isBelow(atlas, existing.mapId, map.id)) { if (point) existing.parentPoint = point; continue; }
    const region = findRegion(atlas, item.region, map.id);
    const place = normalizePlace({ ...existing, ...item, id: existing?.id, mapId: map.id, regionId: region?.id ?? null, point: point ?? (existing?.mapId === map.id ? existing.point : undefined), parentPoint: existing && existing.mapId === map.parentId ? existing.point : existing?.parentPoint });
    atlas.places = atlas.places.filter((other) => other.id !== place.id);
    atlas.places.push(place);
    kept.add(place.id);
    if (!point && existing?.mapId !== map.id) unplaced.push({ id: place.id, region });
  }
  for (const { id, region } of unplaced) {
    const place = atlas.places.find((item) => item.id === id);
    if (place) place.point = positionFor({ ...atlas, places: atlas.places.filter((item) => item.id !== id) }, map.id, region, id);
  }
  const gone = new Set(atlas.places.filter((place) => place.mapId === map.id && !kept.has(place.id)).map((place) => place.id));
  atlas.places = atlas.places.filter((place) => !gone.has(place.id));
  atlas.routes = atlas.routes.filter((route) => route.mapId !== map.id);
  for (const item of geography.routes) {
    const points = resolveRoutePoints(atlas, item, map.id);
    if (points.length >= 2) atlas.routes.push(normalizeRoute({ ...item, mapId: map.id, points }));
  }
  const regionIds = new Set(atlas.regions.map((region) => region.id));
  const placeIds = new Set(atlas.places.map((item) => item.id));
  const orphaned = atlas.maps.filter((item) => (item.anchorRegionId && !regionIds.has(item.anchorRegionId)) || (item.anchorPlaceId && !placeIds.has(item.anchorPlaceId))).map((item) => ({ type: "removeMap", id: item.id }));
  if (orphaned.length) Object.assign(atlas, applyAtlasOps(atlas, orphaned).atlas);
  for (const place of atlas.places) if (place.regionId && !regionIds.has(place.regionId)) place.regionId = null;
  for (const event of atlas.events) { if (event.placeId && gone.has(event.placeId)) event.placeId = null; if (event.regionId && !regionIds.has(event.regionId)) event.regionId = null; }
  atlas.territories = atlas.territories.filter((change) => regionIds.has(change.regionId));
  atlas.terrainChanges = atlas.terrainChanges.filter((change) => regionIds.has(change.regionId));
  for (const item of atlas.items) for (const stop of item.stops) if (stop.placeId && gone.has(stop.placeId)) stop.placeId = null;
}

function existingNote(atlas: Atlas, map: AtlasMap) {
  const regions = atlas.regions.filter((region) => region.mapId === map.id);
  if (!regions.length) return "";
  const places = atlas.places.filter((place) => place.mapId === map.id);
  return `【这张图现在的内容，没有理由就沿用原名】\n地区：${regions.map((region) => region.name).join("、")}\n地点：${places.map((place) => place.name).join("、") || "（无）"}`;
}

function detailPrompt(atlas: Atlas, region: AtlasRegion, input: AtlasJobInput, references: References) {
  const placesHere = atlas.places.filter((place) => place.regionId === region.id);
  const eventsHere = atlas.events.filter((event) => event.regionId === region.id || placesHere.some((place) => place.id === event.placeId));
  const names = [region.name, ...placesHere.map((place) => place.name)];
  const scenes: string[] = [];
  for (const card of input.memory?.cards.values() ?? []) for (const scene of card.scenes) if (names.some((name) => name.length >= 2 && `${scene.location}${scene.summary}`.includes(name)) && scenes.length < 80) scenes.push(`- ${scene.location}：${clipped(scene.summary, 140)}`);
  const entities = (input.memory?.entities ?? []).filter((entity) => entity.category === "location" && names.some((name) => name.length >= 2 && `${entity.name}${entity.summary}`.includes(name))).slice(0, 40).map((entity) => `- ${entity.name}：${clipped(entity.summary, 160)}`);
  return [
    `【要细化的地区】${region.name}（地形：${region.terrain}）\n${region.summary}${region.owner ? `\n控制者：${region.owner}` : ""}`,
    placesHere.length ? `【已有地点，必须放进这张图，名字不变】\n${placesHere.map((place) => `- ${place.name}（${place.kind}）：${place.summary}`).join("\n")}` : "",
    eventsHere.length ? `【发生在这里的事件】\n${eventsHere.slice(0, 40).map((event) => `- ${event.title}：${clipped(event.summary, 100)}`).join("\n")}` : "",
    scenes.length ? `【正文相关场景】\n${scenes.join("\n")}` : "",
    entities.length ? `【相关地点档案】\n${entities.join("\n")}` : "",
    input.project.worldview.trim() ? `【世界观摘录】\n${clipped(input.project.worldview, 4_000)}` : "",
    input.instruction?.trim() ? `【作者要求】${input.instruction.trim()}` : "",
    referenceNote(references),
    `【任务】把这个地区放大成一张详情图：4 到 14 个分区（城区、山谷、河段等）和其中的具体地点。surround 通常填 land。${COORDINATE_RULES}\n输出 JSON：${GEOGRAPHY_SHAPE}`,
  ].filter(Boolean).join("\n\n");
}

/** The inside of a place (a palace, a sect, a walled city) as a map of its parts. */
function interiorPrompt(atlas: Atlas, place: AtlasPlace, input: AtlasJobInput, references: References) {
  const events = atlas.events.filter((event) => event.placeId === place.id).slice(0, 40);
  const scenes: string[] = [];
  for (const card of input.memory?.cards.values() ?? []) for (const scene of card.scenes) if (place.name.length >= 2 && `${scene.location}${scene.summary}`.includes(place.name) && scenes.length < 60) scenes.push(`- ${scene.location}：${clipped(scene.summary, 140)}`);
  const entity = input.memory?.entities.find((item) => item.name === place.name || item.aliases.includes(place.name));
  return [
    `【要画内部结构的地点】${place.name}（${PLACE_KIND_LABELS[place.kind]}）\n${place.summary}${entity?.summary ? `\n档案：${clipped(entity.summary, 400)}` : ""}`,
    events.length ? `【在这里发生的事】\n${events.map((event) => `- ${event.title}：${clipped(event.summary, 100)}`).join("\n")}` : "",
    scenes.length ? `【正文里的相关场景】\n${scenes.join("\n")}` : "",
    input.project.worldview.trim() ? `【世界观摘录】\n${clipped(input.project.worldview, 3_000)}` : "",
    input.instruction?.trim() ? `【作者要求】${input.instruction.trim()}` : "",
    referenceNote(references),
    `【任务】把「${place.name}」的内部画成一张平面结构图：用 regions 表示它的组成部分（殿、院、街坊、山门、广场、园林、水面、城墙内外等，3 到 14 个，terrain 用 city、plains、forest、lake、mountain 等表达地面），用 places 标出里面具体的建筑和地点（门、殿、塔、井、密室入口等），用 routes 画出主要通道、回廊和水道。正文和事件里出现过的内部地点一定要放进去；没写到的按这类地方的常理补足。surround 填 land。${COORDINATE_RULES}\n输出 JSON：${GEOGRAPHY_SHAPE}`,
  ].filter(Boolean).join("\n\n");
}

/** Draws the geography of one map: a region's detail when the map is anchored to one, a whole world or realm otherwise. */
async function drawMap(atlas: Atlas, map: AtlasMap, input: AtlasJobInput, references: References) {
  const region = map.anchorRegionId ? atlas.regions.find((item) => item.id === map.anchorRegionId) : undefined;
  const place = map.anchorPlaceId ? atlas.places.find((item) => item.id === map.anchorPlaceId) : undefined;
  let prompt: string;
  if (place) {
    input.onProgress?.(`构思「${place.name}」的内部结构`);
    prompt = interiorPrompt(atlas, place, input, references);
  } else if (region) {
    input.onProgress?.(`绘制「${region.name}」的分块详情`);
    prompt = detailPrompt(atlas, region, input, references);
  } else {
    const sources = worldSources(input.project, input.memory, input.story);
    if (sources.length < MIN_GEOGRAPHY_SOURCE && !input.instruction?.trim() && !references.paths.length) throw new Error("材料太少，画不出地图。请先写世界观或大纲、为已有章节建立故事记忆，或者给一张参考图。");
    const isWorld = map.id === atlas.rootMapId;
    input.onProgress?.(isWorld ? "构思地理格局" : `绘制「${map.title}」`);
    const task = isWorld ? "设计这本书的世界全图" : `设计「${map.title}」这张地图${map.parentId ? `（它是「${atlas.maps.find((item) => item.id === map.parentId)?.title ?? ""}」下的子地图）` : "（它和世界全图并列，是书里另一片天地）"}，只放属于这张图的地方`;
    prompt = [sources, existingNote(atlas, map), input.instruction?.trim() ? `【作者要求】${input.instruction.trim()}` : "", referenceNote(references), `【任务】${task}：6 到 24 个地区，把材料里属于它的重要地点放进去，用河流、道路等路线把舞台连起来。${COORDINATE_RULES}\n输出 JSON：${GEOGRAPHY_SHAPE}`].filter(Boolean).join("\n\n");
  }
  const geography = await invokeJson({ task: "memory", system: SYSTEM, prompt, images: references.paths, temperature: 0.4, maxOutputTokens: 12_000, effort: "medium", signal: input.signal }, parseGeography);
  placeGeography(atlas, map, geography);
  map.boundaries = null;
  if (map.artwork) { map.artwork.pending = null; map.artwork.dirty = [{ x: 0, y: 0, w: 1000, h: 700 }]; }
  if (input.useReferenceAsBase && references.ids[0]) map.baseImageId = references.ids[0];
}

function cardText(chapter: WriterChapterMeta, position: number, card: ChapterCard | undefined) {
  if (!card) return `第${position + 1}章《${chapter.title}》：${clipped(chapter.summary, 300)}`;
  const scenes = card.scenes.map((scene) => `  - ${scene.time ? `[${scene.time}]` : ""}${scene.location ? `@${scene.location} ` : ""}${scene.characters.join("、")}：${clipped(scene.summary, 160)}`).join("\n");
  return `第${position + 1}章《${chapter.title}》：${clipped(card.summary, 260)}\n${scenes}`;
}

function batches(items: { position: number; text: string }[]) {
  const result: { position: number; text: string }[][] = [];
  let current: { position: number; text: string }[] = [];
  let size = 0;
  for (const item of items) {
    if (current.length && size + item.text.length > BATCH_CHARS) { result.push(current); current = []; size = 0; }
    current.push(item);
    size += item.text.length;
  }
  if (current.length) result.push(current);
  return result;
}

const EVENT_FIELDS = `"title":"六到十二字的事件名","summary":"一两句：谁做了什么、结果如何","kind":"battle|meeting|discovery|death|travel|politics|disaster|ritual|other","place":"发生地，用地图上的地名","region":"不确定具体地点时填地区名","characters":["主要人物"],"factions":["相关势力"],"importance":1到3`;
const EVENT_SHAPE = `{"events":[{"chapter":章序号,${EVENT_FIELDS},"time":"故事内时间，没有留空"}],"newPlaces":[{"name":"地图上还没有的地名","region":"地区名","kind":"city等","summary":"一句话","importance":1到3}],"territory":[{"region":"地区名","chapter":章序号,"owner":"新的控制者","note":"怎么变的"}],"terrain":[{"region":"地区名","chapter":章序号,"terrain":"plains|forest|mountain|desert|marsh|tundra|sea|lake|volcanic|wasteland|city|other","note":"地貌怎么变的，如大火焚林、洪水淹城"}],"items":[{"name":"物品名","chapter":章序号,"holder":"此时在谁手里，没有留空","place":"或者落在哪个地名","note":"怎么转手或移动的"}]}`;

function geographyIndex(atlas: Atlas) {
  return `【地图上的地区】${atlas.regions.map((region) => region.name).join("、") || "（无）"}\n【地图上的地点】${atlas.places.map((place) => place.name).join("、") || "（无）"}`;
}

function locate(atlas: Atlas, raw: Record<string, unknown>) {
  const place = findPlace(atlas, raw.place);
  const region = place ? undefined : findRegion(atlas, raw.region ?? raw.place);
  return { place, placeId: place?.id ?? null, regionId: region?.id ?? null };
}

async function readEvents(atlas: Atlas, chapters: WriterChapterMeta[], input: AtlasJobInput, warnings: string[]) {
  const ordered = orderedChapters(input.project);
  const positions = new Map(ordered.map((chapter, index) => [chapter.id, index]));
  const mine = (chapterId: string) => atlas.events.filter((event) => event.chapterId === chapterId && event.origin === "user");
  const items = chapters.map((chapter) => {
    const position = positions.get(chapter.id) as number;
    const kept = mine(chapter.id);
    return { position, text: `${cardText(chapter, position, input.memory?.cards.get(chapter.id))}${kept.length ? `\n  （这一章已记下、不要重复列出的事件：${kept.map((event) => event.title).join("、")}）` : ""}` };
  });
  const groups = batches(items);
  let done = 0;
  input.onProgress?.(`读取章节事件 0/${groups.length}`);
  const index = geographyIndex(atlas);
  const results = await mapLimit(groups, 3, async (group) => {
    try {
      const value = await invokeJson({ task: "memory", system: SYSTEM, prompt: `${index}\n\n【章节】\n${group.map((item) => item.text).join("\n")}\n\n【任务】列出这些章节里值得标在地图上的事件：战斗、相遇、发现、死亡、远行、权力变动、灾变、仪式。每章最多 3 件，日常过场不要；每件都要落到地点，用地图上已有的地名，确实没有的放进 newPlaces。地区易主写进 territory；地貌被改变（焚毁、淹没、冰封、筑城、开山）写进 terrain；神兵、信物、秘宝这类重要物品的出现、易手或移动写进 items。输出 JSON：${EVENT_SHAPE}`, temperature: 0.2, maxOutputTokens: 8_000, signal: input.signal }, asRecord);
      return { value, chapters: new Set(group.map((item) => item.position + 1)) };
    } catch (error) {
      if (input.signal?.aborted) throw error;
      warnings.push(`第 ${group[0].position + 1}–${group[group.length - 1].position + 1} 章的事件没有读出来：${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      done += 1;
      input.onProgress?.(`读取章节事件 ${done}/${groups.length}`);
    }
  });
  for (const result of results) {
    if (!result) continue;
    for (const raw of arrayValue(result.value.newPlaces).map(asRecord)) {
      if (!stringValue(raw.name).trim() || findPlace(atlas, raw.name)) continue;
      const region = findRegion(atlas, raw.region);
      const mapId = region?.mapId ?? atlas.rootMapId;
      const place = normalizePlace({ ...raw, mapId, regionId: region?.id ?? null });
      place.point = positionFor(atlas, mapId, region, place.id);
      atlas.places.push(place);
    }
  }
  for (const result of results) {
    if (!result) continue;
    // A model can answer about chapters outside its batch; those belong to another batch or do not exist.
    const inBatch = (value: unknown) => (result.chapters.has(Number(value)) ? ordered[Number(value) - 1] : undefined);
    for (const raw of arrayValue(result.value.events).map(asRecord)) {
      const chapter = inBatch(raw.chapter);
      const title = stringValue(raw.title).trim();
      if (!chapter || !title || mine(chapter.id).some((event) => event.title === title)) continue;
      const { place, placeId, regionId } = locate(atlas, raw);
      if (place && !place.firstChapterId) place.firstChapterId = chapter.id;
      atlas.events.push(normalizeEvent({ ...raw, id: uniqueId("event"), placeId, regionId, chapterId: chapter.id, momentId: null, storyTime: raw.time, origin: "extracted" }));
    }
    for (const raw of arrayValue(result.value.territory).map(asRecord)) {
      const chapter = inBatch(raw.chapter);
      const region = findRegion(atlas, raw.region);
      if (chapter && region && stringValue(raw.owner).trim()) atlas.territories.push(normalizeTerritory({ regionId: region.id, chapterId: chapter.id, owner: raw.owner, note: raw.note, origin: "extracted" }));
    }
    for (const raw of arrayValue(result.value.terrain).map(asRecord)) {
      const chapter = inBatch(raw.chapter);
      const region = findRegion(atlas, raw.region);
      if (chapter && region) atlas.terrainChanges.push(normalizeTerrainChange({ regionId: region.id, chapterId: chapter.id, terrain: raw.terrain, note: raw.note, origin: "extracted" }));
    }
    for (const raw of arrayValue(result.value.items).map(asRecord)) {
      const chapter = inBatch(raw.chapter);
      const name = stringValue(raw.name).trim();
      if (!chapter || !name) continue;
      let item = atlas.items.find((entry) => entry.name === name);
      if (!item) { item = normalizeItem({ name, summary: raw.note, origin: "extracted" }); atlas.items.push(item); }
      if (item.origin === "user") continue;
      const place = stringValue(raw.place).trim() ? findPlace(atlas, raw.place) : undefined;
      item.stops.push(normalizeItemStop({ chapterId: chapter.id, placeId: place?.id ?? null, holder: raw.holder, note: raw.note }));
    }
  }
}

/** Removes what earlier passes read from these chapters (or from all, with `null`); the author's records stay. */
function dropExtracted(atlas: Atlas, chapterIds: Set<string> | null) {
  const hit = (chapterId: string | null) => chapterIds === null || (chapterId !== null && chapterIds.has(chapterId));
  atlas.terrainChanges = atlas.terrainChanges.filter((change) => change.origin === "user" || !hit(change.chapterId));
  for (const item of atlas.items) if (item.origin === "extracted") item.stops = item.stops.filter((stop) => !hit(stop.chapterId));
  atlas.items = atlas.items.filter((item) => item.origin === "user" || item.stops.length);
}

/** Drops what an earlier pass derived for `phase`; moments the author made or put events on stay. */
function clearDerived(atlas: Atlas, phase: "past" | "future") {
  const phaseIds = new Set(atlas.moments.filter((moment) => moment.phase === phase).map((moment) => moment.id));
  atlas.events = atlas.events.filter((event) => !(event.origin === "extracted" && event.momentId && phaseIds.has(event.momentId)));
  atlas.territories = atlas.territories.filter((change) => !(change.origin === "extracted" && change.momentId && phaseIds.has(change.momentId)));
  const used = new Set([...atlas.events, ...atlas.territories].flatMap((record) => record.momentId ?? []));
  atlas.moments = atlas.moments.filter((moment) => moment.phase !== phase || moment.origin === "user" || used.has(moment.id));
}

/** History before the book opens (`past`) and what the outline still plans, placed on moments outside the chapters. */
async function planBeyond(atlas: Atlas, input: AtlasJobInput, warnings: string[], withPast: boolean) {
  const { project, memory, story } = input;
  const volumes = (story?.volumes ?? []).map((plan) => `- ${project.volumes.find((item) => item.id === plan.volumeId)?.title ?? "某卷"}：终点 ${plan.endpoint}｜核心循环 ${plan.coreLoop.join(" → ")}`).join("\n");
  const threads = memory?.openThreads().slice(0, 30).map((thread) => `- ${thread.title}${thread.plan ? `：${thread.plan}` : ""}`).join("\n") ?? "";
  const future = [project.outline.trim() && `【大纲】\n${clipped(project.outline, 12_000)}`, volumes && `【卷规划】\n${volumes}`, threads && `【未兑现的线索】\n${threads}`].filter(Boolean).join("\n\n");
  const secrets = (story?.secrets ?? []).map((secret) => `- ${secret.title}：${clipped(secret.truth, 200)}`).join("\n");
  const past = withPast ? [project.background.trim() && `【背景】\n${clipped(project.background, 6_000)}`, project.worldview.trim() && `【世界观】\n${clipped(project.worldview, 8_000)}`, secrets && `【暗线真相】\n${secrets}`].filter(Boolean).join("\n\n") : "";
  if (future) clearDerived(atlas, "future");
  if (past) clearDerived(atlas, "past");
  if (!future && !past) return;
  input.onProgress?.(past ? "推演前史与后续走向" : "推演后续走向");
  const recent = atlas.events.filter((event) => event.chapterId).slice(-12).map((event) => `- ${event.title}：${clipped(event.summary, 80)}`).join("\n");
  const kept = atlas.events.filter((event) => event.momentId).map((event) => event.title);
  const item = `{"order":从1开始的先后序号,"when":"故事内时间或阶段名，如“百年前”“第二卷末”，没有留空",${EVENT_FIELDS}}`;
  const tasks = [
    past ? `past：背景和世界观里写到的、故事开始前发生并且能落到地图上的大事（立国、战争、灾变、迁徙、封印……），按先后，最多 10 件。` : "",
    future ? `future：按大纲和卷规划，还没写到、地图上会发生的关键事件，按先后，最多 16 件。` : "",
  ].filter(Boolean).join("\n");
  try {
    const value = await invokeJson({ task: "memory", system: SYSTEM, prompt: `${geographyIndex(atlas)}\n\n${[past, future].filter(Boolean).join("\n\n")}\n\n${recent ? `【最近已发生】\n${recent}\n\n` : ""}${kept.length ? `【已记下、不要重复的事件】${kept.join("、")}\n\n` : ""}【任务】列出正文之外的事件，没有依据的不要编。\n${tasks}\n输出 JSON：{${past ? `"past":[${item}],` : ""}"future":[${future ? item : ""}]}`, temperature: 0.3, maxOutputTokens: 6_000, signal: input.signal }, asRecord);
    for (const phase of ["past", "future"] as const) {
      const moments = new Map<number, string>();
      for (const raw of arrayValue(value[phase]).map(asRecord)) {
        const title = stringValue(raw.title).trim();
        if (!title || kept.includes(title)) continue;
        const order = Number(raw.order) || moments.size + 1;
        let momentId = moments.get(order);
        if (!momentId) {
          const moment = normalizeMoment({ phase, rank: order * 1024, label: stringValue(raw.when), origin: "extracted" });
          atlas.moments.push(moment);
          moments.set(order, momentId = moment.id);
        }
        const { placeId, regionId } = locate(atlas, raw);
        atlas.events.push(normalizeEvent({ ...raw, id: uniqueId("event"), placeId, regionId, chapterId: null, momentId, storyTime: raw.when, origin: "extracted" }));
      }
    }
  } catch (error) {
    if (input.signal?.aborted) throw error;
    warnings.push(`${past ? "前史和后续" : "后续"}事件没有推演出来：${error instanceof Error ? error.message : String(error)}`);
  }
}

function eventableChapters(project: WriterProject, memory: MemoryView | null) {
  return orderedChapters(project).filter((chapter) => chapter.wordCount > 0 && (memory?.cards.has(chapter.id) || chapter.summary.trim()));
}

const sourceHash = (chapter: WriterChapterMeta, memory: MemoryView | null) => memory?.cards.get(chapter.id)?.sourceHash ?? chapter.contentHash;

/** Brings chapter events up to date: chapters that are gone lose theirs, new or changed chapters are read again. */
async function syncEvents(atlas: Atlas, input: AtlasJobInput, warnings: string[], withPast: boolean): Promise<number> {
  const { project, memory } = input;
  const known = new Set(project.chapters.map((chapter) => chapter.id));
  atlas.events = atlas.events.filter((event) => !event.chapterId || known.has(event.chapterId));
  atlas.territories = atlas.territories.filter((change) => !change.chapterId || known.has(change.chapterId));
  atlas.terrainChanges = atlas.terrainChanges.filter((change) => !change.chapterId || known.has(change.chapterId));
  for (const item of atlas.items) item.stops = item.stops.filter((stop) => !stop.chapterId || known.has(stop.chapterId));
  const stale = eventableChapters(project, memory).filter((chapter) => atlas.coverage[chapter.id] !== sourceHash(chapter, memory));
  if (stale.length) {
    const ids = new Set(stale.map((chapter) => chapter.id));
    atlas.events = atlas.events.filter((event) => event.origin === "user" || !event.chapterId || !ids.has(event.chapterId));
    atlas.territories = atlas.territories.filter((change) => change.origin === "user" || !change.chapterId || !ids.has(change.chapterId));
    dropExtracted(atlas, ids);
    await readEvents(atlas, stale, input, warnings);
    for (const chapter of stale) atlas.coverage[chapter.id] = sourceHash(chapter, memory);
  }
  await planBeyond(atlas, input, warnings, withPast);
  return stale.length;
}

async function revise(atlas: Atlas, map: AtlasMap, input: AtlasJobInput, references: References, warnings: string[]): Promise<{ atlas: Atlas; summary: string }> {
  if (!input.instruction?.trim() && !references.paths.length) throw new Error("请写下要怎么改，或者给一张参考图。");
  input.onProgress?.(`修改「${map.title}」`);
  const chapterIds = orderedChapters(input.project).map((chapter) => chapter.id);
  const prompt = [
    `【这张地图现在的样子】\n${describeMap(atlas, map.id, chapterIds, 60)}`,
    input.project.worldview.trim() ? `【世界观摘录】\n${clipped(input.project.worldview, 4_000)}` : "",
    input.instruction?.trim() ? `【作者要求】${input.instruction.trim()}` : "【作者要求】让这张图和参考图一致。",
    referenceNote(references),
    `【任务】只做作者要求的修改，其余保持原样；改已有记录时带上它的 id。用下面的操作表达修改：\n${ATLAS_OPS_GUIDE}\n输出 JSON：{"summary":"一两句说明改了什么","operations":[{"type":"…",…}]}`,
  ].filter(Boolean).join("\n\n");
  const value = await invokeJson({ task: "memory", system: SYSTEM, prompt, images: references.paths, temperature: 0.3, maxOutputTokens: 10_000, effort: "medium", signal: input.signal }, asRecord);
  const operations = arrayValue(value.operations);
  if (!operations.length) throw new Error("模型认为不需要修改。可以把要求写得更具体一些。");
  const result = applyAtlasOps(atlas, operations, { chapterIds, defaultMapId: map.id });
  if (result.skipped.length) warnings.push(`有 ${result.skipped.length} 项修改没能应用：${result.skipped.slice(0, 5).join("；")}`);
  if (!result.applied) throw new Error(`修改没能应用：${result.skipped[0] ?? "未知原因"}`);
  const target = result.atlas.maps.find((item) => item.id === map.id);
  if (target && input.useReferenceAsBase && references.ids[0]) target.baseImageId = references.ids[0];
  return { atlas: result.atlas, summary: `${stringValue(value.summary).trim() || `对「${map.title}」做了 ${result.applied} 项修改`}。` };
}

/** Runs one generation and saves the outcome as the pending draft. */
export async function generateAtlasDraft(input: AtlasJobInput): Promise<AtlasJobResult> {
  const task = domainTask<AtlasJobResult>("generateAtlasDraft", [input], input.project.id, input.signal); if (task) return task;
  const base = await loadCurrentAtlas(input.project.id);
  const references = await resolveReferences(input.project.id, input.referenceIds);
  if (references.paths.length) await assertVision("memory");
  const warnings: string[] = [];
  const mode: AtlasMode = base ? input.mode : input.mode === "redraw" ? "full" : input.mode;
  if (!base && mode !== "full" && mode !== "layout") throw new Error("请先生成世界全图。");
  let atlas: Atlas = base ? structuredClone(base) : emptyAtlas(input.project.title);
  const target = () => { const map = atlas.maps.find((item) => item.id === (input.mapId ?? atlas.rootMapId)); if (!map) throw new Error("没有找到这张地图。"); return map; };
  let mapId = atlas.rootMapId;
  let summary: string;
  if (mode === "layout") {
    const map = target(); mapId = map.id;
    await drawMap(atlas, map, input, references);
    summary = "地理版图已生成，采纳后可生成草图；章节事件可单独同步。";
  } else if (mode === "full") {
    const root = atlas.maps.find((item) => item.id === atlas.rootMapId) as AtlasMap;
    await drawMap(atlas, root, input, references);
    atlas.events = atlas.events.filter((event) => event.origin === "user");
    atlas.territories = atlas.territories.filter((change) => change.origin === "user");
    dropExtracted(atlas, null);
    atlas.coverage = {};
    await syncEvents(atlas, input, warnings, true);
    summary = `绘制了 ${atlas.regions.filter((region) => region.mapId === root.id).length} 个地区、${atlas.places.length} 个地点、${atlas.events.length} 个事件。`;
  } else if (mode === "sync") {
    const read = await syncEvents(atlas, input, warnings, false);
    summary = read ? `读入了 ${read} 章的新事件，现在共 ${atlas.events.length} 个事件。` : "地图已经跟上最新章节，刷新了后续事件。";
  } else if (mode === "redraw") {
    const map = target();
    mapId = map.id;
    await drawMap(atlas, map, input, references);
    summary = `重绘了「${map.title}」：${atlas.regions.filter((region) => region.mapId === map.id).length} 个地区、${atlas.places.filter((place) => place.mapId === map.id).length} 个地点。`;
  } else if (mode === "interior") {
    const place = atlas.places.find((item) => item.id === input.placeId) ?? findPlace(atlas, input.placeId);
    if (!place) throw new Error("没有找到这个地点。");
    let map = atlas.maps.find((item) => item.anchorPlaceId === place.id);
    if (!map) { map = normalizeMap({ parentId: place.mapId, anchorPlaceId: place.id, title: `${place.name}·内部`, surround: "land" }); atlas.maps.push(map); }
    mapId = map.id;
    await drawMap(atlas, map, input, references);
    summary = `画出了「${place.name}」的内部结构：${atlas.regions.filter((region) => region.mapId === map?.id).length} 个部分、${atlas.places.filter((item) => item.mapId === map?.id).length} 个地点。`;
  } else if (mode === "detail") {
    const region = atlas.regions.find((item) => item.id === input.regionId) ?? findRegion(atlas, input.regionId);
    if (!region) throw new Error("没有找到要细化的地区。");
    let map = atlas.maps.find((item) => item.anchorRegionId === region.id);
    if (!map) { map = normalizeMap({ parentId: region.mapId, anchorRegionId: region.id, title: region.name, surround: "land" }); atlas.maps.push(map); }
    mapId = map.id;
    await drawMap(atlas, map, input, references);
    summary = `生成了「${map.title}」的分块详情。`;
  } else {
    const map = target();
    mapId = map.id;
    const result = await revise(atlas, map, input, references, warnings);
    atlas = result.atlas;
    summary = result.summary;
  }
  await saveAtlasDraft(input.project.id, atlas);
  return { atlas, mapId, summary, warnings };
}
