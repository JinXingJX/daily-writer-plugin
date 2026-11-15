// Map tools: the assistant reads the world map, draws it, revises it from instructions or reference images, and edits
// maps, places, the timeline and events directly. All changes land in the draft the author adopts.
import { orderedChapters } from "../../domain/documents";
import { uniqueId } from "../../domain/ids";
import { arrayValue, stringValue, trimmedString } from "../../domain/util";
import { describeAtlas, describeMap } from "../../atlas/describe";
import { applyAtlasOps, cellsOfMap, findPlace, findRegion } from "../../atlas/operations";
import { CANVAS_COLS, CANVAS_ROWS, paintBlock, paintCanvas, paintOverview, paintTokens, variantContext, type TokenMethod } from "../../atlas/canvas";
import { tokenTargets, type TokenKind } from "../../atlas/tokens";
import { findStyle, loadStyleLibrary } from "../../atlas/styles";
import { buildAxis, characterSpots, charactersIn, eventPosition } from "../../atlas/timeline";
import { paintBaseMap } from "../../atlas/paint";
import { loadCurrentAtlas, updateAtlasDraft } from "../../atlas/store";
import { friendlyImageError } from "../../images/generate";
import { loadImageLibrary } from "../../images/store";
import { friendlyAiError } from "../client";
import { generateAtlasDraft, type AtlasMode } from "../pipelines/atlas";
import { storyOf, type RunState, type ToolHandler } from "./state";

const chapterIdsOf = (state: RunState) => orderedChapters(state.draft).map((chapter) => chapter.id);
const MODES = new Set(["full", "sync", "redraw", "detail", "revise", "create", "paint", "overview", "scroll", "block", "tokens", "interior", "variant"]);

/** Reference images named in the call, or the images attached to the map. */
async function referencesFor(projectId: string, input: Record<string, unknown>, mapId: string | undefined) {
  const named = arrayValue(input.referenceIds).filter((item): item is string => typeof item === "string");
  if (named.length || !mapId || input.useMapReferences === false) return named;
  return (await loadImageLibrary(projectId)).assets.filter((asset) => asset.owners.includes(`map:${mapId}`) && asset.source === "upload").map((asset) => asset.id).slice(0, 4);
}

const readAtlas: ToolHandler = async ({ state, input }) => {
  const atlas = await loadCurrentAtlas(state.projectId);
  if (!atlas) return { observation: "这本书还没有世界地图，可以用 generateAtlas（mode=full）绘制。" };
  const mapId = trimmedString(input.mapId);
  if (mapId) return { observation: describeMap(atlas, mapId, chapterIdsOf(state)) };
  const styles = await loadStyleLibrary(state.projectId);
  return { observation: `${describeAtlas(atlas, chapterIdsOf(state))}\n\n【画卷风格】${styles.styles.map((style) => `${style.name}(id=${style.id})${style.id === styles.defaultId ? "·默认" : ""}`).join("、")}\n带 mapId 读取某张图的地区、地点、路线、事件和画卷。` };
};

const generateAtlas: ToolHandler = async ({ state, input, memory, signal }) => {
  const mode = stringValue(input.mode);
  if (!MODES.has(mode)) throw new Error("mode 只能是 full、sync、redraw、detail、revise、create、paint、overview、scroll、block、tokens、interior 或 variant。");
  let atlas = await loadCurrentAtlas(state.projectId);
  if (!atlas && mode !== "full") throw new Error("请先用 mode=full 生成世界全图。");
  let mapId = trimmedString(input.mapId);
  if (mapId && atlas && !atlas.maps.some((map) => map.id === mapId)) throw new Error(`没有 id 为 ${mapId} 的地图，先用 readAtlas 查看。`);
  let regionId: string | undefined;
  if (mode === "detail") {
    const region = atlas ? findRegion(atlas, input.region) : undefined;
    if (!region) throw new Error(`地图上没有地区「${stringValue(input.region)}」。`);
    regionId = region.id;
  }
  let placeId: string | undefined;
  if (mode === "interior") {
    const place = atlas ? findPlace(atlas, input.place) : undefined;
    if (!place) throw new Error(`地图上没有地点「${stringValue(input.place)}」。`);
    placeId = place.id;
  }
  if (mode === "overview" || mode === "block" || mode === "tokens") {
    if (!atlas) throw new Error("请先生成地图。");
    const target = mapId ?? atlas.rootMapId;
    const map = atlas.maps.find((item) => item.id === target);
    const style = findStyle(await loadStyleLibrary(state.projectId), trimmedString(input.styleId) ?? map?.canvas?.styleId);
    try {
      if (mode === "overview") {
        const asset = await paintOverview({ projectId: state.projectId, atlas, mapId: target, style, instruction: stringValue(input.instruction), signal });
        return { observation: `已用「${style.name}」画好总图（图片 ${asset.id}），显示在“故事 · 世界地图”上；之后的底图分块和块图都会照它画。`, result: { imageId: asset.id } };
      }
      if (mode === "block") {
        const region = findRegion(atlas, input.region);
        if (!region || region.mapId !== target) throw new Error(`这张图上没有地区「${stringValue(input.region)}」。`);
        const edge = input.edge === "distinct" ? "distinct" : "blend";
        const asset = await paintBlock({ projectId: state.projectId, atlas, mapId: target, regionId: region.id, style, edge, instruction: stringValue(input.instruction), signal });
        return { observation: `已画好「${region.name}」块图（${edge === "distinct" ? "泾渭分明" : "融入底图"}，图片 ${asset.id}）。`, result: { imageId: asset.id } };
      }
      const kind: TokenKind = input.kind === "characters" || input.kind === "items" ? input.kind : "places";
      const method: TokenMethod = input.method === "single" || input.method === "crop" ? input.method : "sheet";
      if (method === "crop" && kind !== "places") throw new Error("只有地点可以从画卷裁切；人物和物品用 sheet 或 single。");
      const names = arrayValue(input.names).filter((item): item is string => typeof item === "string");
      const axis = buildAxis(state.draft, atlas);
      const spots = kind === "characters" ? characterSpots(atlas, axis, cellsOfMap(atlas, target), target, Math.max(0, axis.stops.length - 1), names.length ? names : charactersIn(atlas).slice(0, 27)) : [];
      const assets = (await loadImageLibrary(state.projectId)).assets;
      let targets = tokenTargets({ atlas, project: state.draft, assets, mapId: target, kind, characters: spots, all: names.length > 0, limit: 200 });
      if (names.length) targets = targets.filter((item) => names.includes(item.name));
      if (!targets.length) return { observation: "没有需要生成的组件（都已经有了，或名字没对上；人物要在地图上出现过）。" };
      const result = await paintTokens({ projectId: state.projectId, atlas, mapId: target, style, targets: targets.slice(0, 27), method, signal });
      return { observation: `做好 ${result.done.length} 个地图组件，已设为地图上显示的图。${result.failed.length ? `\n没做成：${result.failed.map((item) => `${item.owner}（${friendlyImageError(new Error(item.error))}）`).join("；")}` : ""}`, result };
    } catch (error) { throw new Error(friendlyImageError(error)); }
  }
  if (mode === "create") {
    const title = trimmedString(input.title);
    if (!title) throw new Error("新建地图要给 title。");
    mapId = uniqueId("map");
    const created = await updateAtlasDraft(state.projectId, [{ type: "upsertMap", map: { id: mapId, title, parentId: trimmedString(input.parentMapId) ?? "" } }]);
    if (created.skipped.length) throw new Error(created.skipped[0]);
    atlas = created.atlas;
    if (input.blank === true) return { observation: `已新建空白地图「${title}」(id=${mapId})，在草稿里，作者采纳后生效。可以用 updateAtlas 往里加地区和地点。`, result: { mapId } };
  }
  const referenceIds = await referencesFor(state.projectId, input, mapId ?? (mode === "full" ? atlas?.rootMapId : undefined));
  if (mode === "scroll" || mode === "variant") {
    if (!atlas) throw new Error("请先生成地图。");
    const target = mapId ?? atlas.rootMapId;
    const map = atlas.maps.find((item) => item.id === target);
    const library = await loadStyleLibrary(state.projectId);
    const style = findStyle(library, trimmedString(input.styleId) ?? map?.canvas?.styleId);
    const tiles = arrayValue(input.tiles).map((value) => Number(value) - 1).filter((index) => Number.isInteger(index) && index >= 0 && index < CANVAS_COLS * CANVAS_ROWS);
    let variant;
    if (mode === "variant") {
      if (tiles.length !== 1) throw new Error("variant 要在 tiles 里给出一块（从 1 开始编号，按行从左到右）。");
      if (!map?.canvas?.tiles[tiles[0]]?.assetId) throw new Error("这一块还没有画，先用 mode=scroll 画出画卷。");
      const ops = applyAtlasOps(atlas, [{ type: "upsertEvent", event: { id: "__probe__", title: "probe", chapter: input.chapter, moment: input.moment, phase: input.phase } }], { chapterIds: chapterIdsOf(state) });
      if (ops.skipped.length) throw new Error(ops.skipped[0]);
      const probe = ops.atlas.events.find((event) => event.id === "__probe__");
      const axis = buildAxis(state.draft, ops.atlas);
      const cursor = probe ? eventPosition(axis, probe) : -1;
      if (cursor < 0) throw new Error("variant 要给 chapter（章序号）或 moment（时间节点）。");
      const context = variantContext(ops.atlas, axis, target, tiles[0], cursor);
      if (!context.changed && !stringValue(input.instruction).trim()) throw new Error("这一块在那个时间没有地形变化；先用 updateAtlas 记下 upsertTerrainChange，或在 instruction 里写清要画成什么样。");
      variant = { chapterId: probe?.chapterId ?? null, momentId: probe?.momentId ?? null, label: stringValue(input.label) || axis.stops[cursor].label, terrain: context.terrain, note: context.note };
    }
    try {
      const result = await paintCanvas({ projectId: state.projectId, atlas, mapId: target, style, tiles: tiles.length ? tiles : undefined, instruction: stringValue(input.instruction), variant, signal });
      const failed = result.failed.length ? `\n没画成的块：${result.failed.map((item) => `${item.index + 1}（${friendlyImageError(new Error(item.error))}）`).join("；")}` : "";
      return { observation: `已用「${style.name}」画好 ${result.done.length} 块${mode === "variant" ? "变体" : ""}，直接显示在“故事 · 世界地图”上，旧版本保留可换回。${failed}`, result };
    } catch (error) { throw new Error(friendlyImageError(error)); }
  }
  if (mode === "paint") {
    if (!atlas) throw new Error("请先生成地图。");
    const target = mapId ?? atlas.rootMapId;
    try {
      const asset = await paintBaseMap(state.projectId, atlas, target, { instruction: stringValue(input.instruction), referenceIds });
      await updateAtlasDraft(state.projectId, [{ type: "upsertMap", map: { id: target, baseImageId: asset.id } }]);
      return { observation: `已为这张图画好底图（图片 ${asset.id}），放在地图草稿里，作者采纳后生效。`, result: { imageId: asset.id } };
    } catch (error) { throw new Error(friendlyImageError(error)); }
  }
  try {
    const story = await storyOf(state);
    const pipelineMode: AtlasMode = mode === "create" ? "redraw" : mode as AtlasMode;
    const result = await generateAtlasDraft({ project: state.draft, memory, story, mode: pipelineMode, mapId, regionId, placeId, instruction: stringValue(input.instruction), referenceIds, useReferenceAsBase: input.useReferenceAsBase === true, signal });
    return { observation: `${result.summary}地图草稿(mapId=${result.mapId})已放在“故事 · 世界地图”，作者采纳后生效。${result.warnings.length ? `\n未完成：${result.warnings.join("；")}` : ""}`, result: { mapId: result.mapId } };
  } catch (error) { throw new Error(friendlyAiError(error)); }
};

const updateAtlas: ToolHandler = async ({ state, input }) => {
  const operations = arrayValue(input.operations);
  if (!operations.length) throw new Error("operations 不能为空。");
  const { applied, skipped } = await updateAtlasDraft(state.projectId, operations, { chapterIds: chapterIdsOf(state), defaultMapId: trimmedString(input.mapId) });
  return { observation: `已在地图草稿里应用 ${applied} 项修改，作者采纳后生效。${skipped.length ? `\n没有应用：${skipped.join("；")}` : ""}` };
};

export const ATLAS_TOOLS: Record<string, ToolHandler> = { "writer.readAtlas": readAtlas, "writer.generateAtlas": generateAtlas, "writer.updateAtlas": updateAtlas };
