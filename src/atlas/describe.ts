// The map as text, for models: what the assistant reads and what a revision starts from.
import { previewText } from "../domain/util";
import { EVENT_KIND_LABELS, PLACE_KIND_LABELS, ROUTE_KIND_LABELS, TERRAIN_LABELS, type Atlas } from "./schema";
import { momentLabel, sortedMoments } from "./timeline";

function timeOf(atlas: Atlas, chapterIds: string[], record: { chapterId: string | null; momentId: string | null }) {
  if (record.chapterId) { const index = chapterIds.indexOf(record.chapterId); return index >= 0 ? `第${index + 1}章` : "章节已删"; }
  const moment = atlas.moments.find((item) => item.id === record.momentId);
  if (!moment) return "时间未定";
  return `${moment.phase === "past" ? "前史" : "后续"}·${momentLabel(moment, sortedMoments(atlas, moment.phase).indexOf(moment))}`;
}

export function describeAtlas(atlas: Atlas, chapterIds: string[] = []): string {
  const depth = (id: string | null): number => { const parent = atlas.maps.find((map) => map.id === id); return parent ? 1 + depth(parent.parentId) : 0; };
  const maps = atlas.maps.map((map) => `${"  ".repeat(depth(map.parentId))}- ${map.title}(id=${map.id})｜${map.parentId ? "子地图" : "顶层地图"}｜地区 ${atlas.regions.filter((region) => region.mapId === map.id).length}｜地点 ${atlas.places.filter((place) => place.mapId === map.id).length}${map.baseImageId ? "｜有底图" : ""}｜${previewText(map.summary, 60)}`).join("\n");
  const moments = (["past", "future"] as const).map((phase) => { const list = sortedMoments(atlas, phase); return `${phase === "past" ? "前史" : "后续"}：${list.map((moment, index) => `${momentLabel(moment, index)}(id=${moment.id})`).join(" → ") || "（无）"}`; }).join("\n");
  const items = atlas.items.map((item) => `- ${item.name}(id=${item.id})：${item.stops.map((stop) => `${timeOf(atlas, chapterIds, stop)}→${stop.holder || atlas.places.find((place) => place.id === stop.placeId)?.name || "?"}`).join("，")}`).join("\n");
  return `【地图列表】\n${maps}\n\n【正文之外的时间节点】\n${moments}\n\n【物品】\n${items || "（无）"}\n\n共 ${atlas.events.length} 个事件。`;
}

export function describeMap(atlas: Atlas, mapId: string, chapterIds: string[], eventLimit = 120): string {
  const map = atlas.maps.find((item) => item.id === mapId);
  if (!map) throw new Error(`没有 id 为 ${mapId} 的地图。`);
  const regions = atlas.regions.filter((region) => region.mapId === mapId);
  const places = atlas.places.filter((place) => place.mapId === mapId);
  const placeIds = new Set(places.map((place) => place.id));
  const regionIds = new Set(regions.map((region) => region.id));
  const regionName = (id: string | null) => regions.find((region) => region.id === id)?.name ?? "";
  const events = atlas.events.filter((event) => (event.placeId && placeIds.has(event.placeId)) || (event.regionId && regionIds.has(event.regionId)));
  const changes = atlas.territories.filter((change) => regionIds.has(change.regionId));
  return [
    `【${map.title}】(id=${map.id}，${map.surround === "sea" ? "四面环海" : "内陆铺满"}) ${map.summary}`,
    `【地区】\n${regions.map((region) => `- ${region.name}(id=${region.id})｜${TERRAIN_LABELS[region.terrain]}｜中心(${region.center.join(",")})｜大小 ${region.weight}｜控制者 ${region.owner || "无"}｜${previewText(region.summary, 80)}`).join("\n") || "（无）"}`,
    `【地点】\n${places.map((place) => `- ${place.name}(id=${place.id})｜${PLACE_KIND_LABELS[place.kind]}｜${regionName(place.regionId)}｜(${place.point.join(",")})｜重要度 ${place.importance}｜${previewText(place.summary, 60)}`).join("\n") || "（无）"}`,
    `【路线】\n${atlas.routes.filter((route) => route.mapId === mapId).map((route) => `- ${route.name || "无名"}(id=${route.id})｜${ROUTE_KIND_LABELS[route.kind]}｜${previewText(route.summary, 40)}`).join("\n") || "（无）"}`,
    `【事件】\n${events.slice(0, eventLimit).map((event) => `- ${event.title}(id=${event.id})｜${EVENT_KIND_LABELS[event.kind]}｜${timeOf(atlas, chapterIds, event)}｜${places.find((place) => place.id === event.placeId)?.name ?? regionName(event.regionId)}｜${event.characters.join("、")}｜${previewText(event.summary, 50)}`).join("\n") || "（无）"}${events.length > eventLimit ? `\n（另有 ${events.length - eventLimit} 个未列出）` : ""}`,
    atlas.terrainChanges.some((change) => regionIds.has(change.regionId)) ? `【地形变化】\n${atlas.terrainChanges.filter((change) => regionIds.has(change.regionId)).map((change) => `- ${regionName(change.regionId)}(id=${change.id})｜${timeOf(atlas, chapterIds, change)} 起变为 ${TERRAIN_LABELS[change.terrain]}｜${change.note}`).join("\n")}` : "",
    map.artwork?.assetId ? `【画卷】${map.artwork.stage === "fine" ? "精图" : "草图"}｜已细化 ${map.artwork.modules.length} 个模块｜${map.artwork.pending ? "有待确认预览" : "已采纳"}｜${map.boundaries ? "地区边界已手工编辑" : "自动版图"}` : map.canvas ? `【画卷】风格 ${map.canvas.styleId}｜已画 ${map.canvas.tiles.filter((tile) => tile.assetId).length}/${map.canvas.tiles.length} 块｜变体 ${atlas.variants.filter((variant) => variant.mapId === map.id).length} 个` : "【画卷】还没有画",
    changes.length ? `【势力变更】\n${changes.map((change) => `- ${regionName(change.regionId)}(id=${change.id})｜${timeOf(atlas, chapterIds, change)} 起归 ${change.owner}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}
