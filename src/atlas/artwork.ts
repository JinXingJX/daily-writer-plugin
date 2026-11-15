import { dailyHost } from "../host";
import { uniqueId } from "../domain/ids";
import { generateImages } from "../images/generate";
import { addDerivedImage, imageDataUrl, imageFilesDir, loadImageLibrary } from "../images/store";
import { areaContents, blockRect } from "./canvas";
import { cellPath, layoutSvg } from "./geometry";
import { cellsOfMap } from "./operations";
import { domRaster, type RasterBackend, type RasterLayer } from "./raster";
import { ATLAS_HEIGHT, ATLAS_WIDTH, type Atlas, type AtlasMap, type MapArtwork, type MapModule, type MapRect } from "./schema";
import { editCurrentAtlas, loadCurrentAtlas } from "./store";
import { stylePrompt, type MapStyle } from "./styles";
import { placesOn } from "./timeline";

export const DRAFT_SIZE = { width: 1120, height: 784 };
export const FINE_SIZE = { width: 3440, height: 2400 };
export const emptyArtwork = (): MapArtwork => ({ assetId: "", stage: "draft", modules: [], candidates: [], pending: null, history: [], dirty: [] });
export const artSource = (map: AtlasMap) => JSON.stringify([map.artwork?.assetId, map.artwork?.modules, map.boundaries, map.artwork?.dirty, map.canvas, map.baseImageId]);
export function adoptArtwork(map: AtlasMap, assetId?: string) {
  const art = map.artwork;
  if (!art) return;
  if (assetId && !art.candidates.includes(assetId)) throw new Error("这张草图已不在候选中。");
  if (!assetId && !art.pending) return;
  if (!assetId && art.pending?.source !== artSource(map)) throw new Error("地图已改动，请放弃此预览并重新生成。");
  if (art.assetId) art.history = [...art.history, { assetId: art.assetId, stage: art.stage, modules: structuredClone(art.modules), dirty: structuredClone(art.dirty) }].slice(-20);
  if (assetId) { art.assetId = assetId; art.stage = "draft"; art.modules = []; art.pending = null; }
  else if (art.pending?.kind === "fine") { art.assetId = art.pending.assetId; art.stage = "fine"; art.modules = []; art.pending = null; art.dirty = []; }
  else if (art.pending?.module) { const m = art.pending.module; art.modules.push(m); art.pending = null; art.dirty = art.dirty.filter((r) => !(r.x >= m.rect.x && r.y >= m.rect.y && r.x + r.w <= m.rect.x + m.rect.w && r.y + r.h <= m.rect.y + m.rect.h)); }
}
export function restoreArtwork(map: AtlasMap) {
  const art = map.artwork, previous = art?.history.pop();
  if (art && previous) { Object.assign(art, previous); art.dirty = previous.dirty ?? []; art.pending = null; }
}

type ArtJob = { projectId: string; atlas: Atlas; mapId: string; style: MapStyle; instruction?: string; markup?: string; moduleIds?: string[]; signal?: AbortSignal; raster?: RasterBackend };
async function context(job: ArtJob) {
  const map = job.atlas.maps.find((m) => m.id === job.mapId);
  if (!map) throw new Error("没有找到这张地图。");
  if (!job.atlas.regions.some((r) => r.mapId === map.id)) throw new Error("请先生成或编辑版图。");
  const library = await loadImageLibrary(job.projectId);
  const asset = (id: string) => { const a = library.assets.find((a) => a.id === id); if (!a) throw new Error("参考图素材已丢失，请重新选择。"); return a; };
  const raster = job.raster ?? domRaster;
  const saveRef = async (name: string, png: string) => {
    const path = `${imageFilesDir(job.projectId)}/ref-${uniqueId(name)}.png`;
    await dailyHost().files.writeBase64(path, png);
    return path;
  };
  const layout = (size: { width: number; height: number }) => layoutSvg(job.atlas.regions.filter((r) => r.mapId === map.id), cellsOfMap(job.atlas, map.id), placesOn(job.atlas, map.id).map(({ place, point }) => ({ ...place, point })), job.atlas.routes.filter((r) => r.mapId === map.id), { x: 0, y: 0, w: 1000, h: 700, ...size });
  return { map, asset, raster, saveRef, layout };
}
const terrainPrompt = "保持地理轮廓、河流道路与地形位置一致。不要文字、边框、网格、人物或地点图标。默认聚落位置留出空间，由独立交互图标表示。";
const placeRendering = (job: ArtJob, rect: MapRect = { x: 0, y: 0, w: 1000, h: 700 }) => job.atlas.places.filter((p) => p.mapId === job.mapId && p.display === "marker" && p.point[0] >= rect.x && p.point[0] <= rect.x + rect.w && p.point[1] >= rect.y && p.point[1] <= rect.y + rect.h).map((p) => `例外：在第一张参考图从左往右 ${((p.point[0] - rect.x) / rect.w * 100).toFixed(1)}%、从上往下 ${((p.point[1] - rect.y) / rect.h * 100).toFixed(1)}% 的位置画入「${p.name}」（${p.summary}）的实际建筑，和周围环境融合，交互标记由程序叠加。`).join("\n");

/** A batch never advances to fine painting or overwrites the accepted map. */
export async function paintDraft(job: ArtJob) {
  const p = await context(job);
  const sketch = await p.saveRef("draft-layout", await p.raster.svgToPng(p.layout(DRAFT_SIZE)));
  const existingId = p.map.artwork?.assetId || p.map.canvas?.overviewAssetId || p.map.baseImageId;
  const acceptedRef = existingId ? await p.saveRef("draft-base", await p.raster.cropRelative(await imageDataUrl(job.projectId, p.asset(existingId)), { x: 0, y: 0, w: 1, h: 1 }, DRAFT_SIZE)) : null;
  const refs = acceptedRef ? [acceptedRef, sketch] : [sketch];
  const assets = await generateImages(job.projectId, { prompt: `快速粗略构图草图：${p.map.title}。${p.map.summary}\n${stylePrompt(job.style)}\n${terrainPrompt}\n${placeRendering(job)}\n${areaContents(job.atlas, job.mapId, { x: 0, y: 0, w: 1000, h: 700 })}\n作者要求：${job.instruction ?? "探索整体构图"}`, model: "flare", quality: "low", size: "1120x784", count: 3, referencePaths: refs, referenceIds: job.style.referenceIds.slice(0, 2), markup: job.markup, caption: `${p.map.title} · 草图候选`, owners: [`map:${job.mapId}`], ignoreStyle: true, signal: job.signal });
  job.signal?.throwIfAborted();
  await editCurrentAtlas(job.projectId, (atlas) => { const map = atlas.maps.find((m) => m.id === job.mapId); if (!map) return; map.artwork ??= emptyArtwork(); map.artwork.candidates = [...map.artwork.candidates, ...assets.map((a) => a.id)].slice(-12); });
  return assets;
}

export async function paintFine(job: ArtJob) {
  const p = await context(job), art = p.map.artwork;
  if (!art?.assetId || art.stage !== "draft") throw new Error("请先采纳一张草图，再生成精图。");
  if (art.pending) throw new Error("请先处理当前预览。");
  const source = artSource(p.map);
  const draftRef = await p.saveRef("fine-base", await p.raster.cropRelative(await imageDataUrl(job.projectId, p.asset(art.assetId)), { x: 0, y: 0, w: 1, h: 1 }, DRAFT_SIZE));
  const [asset] = await generateImages(job.projectId, { prompt: `将第一张已确认草图绘制成细致完整地图：${p.map.title}。保持构图、轮廓、比例、地形位置与色调。${terrainPrompt}\n${placeRendering(job)}\n${stylePrompt(job.style)}\n${job.instruction ?? ""}`, model: "sunburst", quality: "high", size: "3440x2400", referencePaths: [draftRef], markup: job.markup, caption: `${p.map.title} · 精图预览`, owners: [`map:${job.mapId}`], ignoreStyle: true, signal: job.signal });
  job.signal?.throwIfAborted();
  await editCurrentAtlas(job.projectId, (atlas) => { const map = atlas.maps.find((m) => m.id === job.mapId); if (!map?.artwork || artSource(map) !== source) throw new Error("地图已改动，结果保存在素材库，请重新生成预览。"); map.artwork.pending = { assetId: asset.id, kind: "fine", module: null, source }; });
  return asset;
}

/** Composite the accepted base plus patches, using actual asset dimensions rather than assumed generation sizes. */
export async function artworkCrop(job: ArtJob, rect: MapRect, size: { width: number; height: number }): Promise<string> {
  const p = await context(job), art = p.map.artwork;
  const id = art?.assetId || p.map.canvas?.overviewAssetId || p.map.baseImageId;
  if (!id) throw new Error("请先生成精图。");
  const layers: RasterLayer[] = [];
  const add = async (assetId: string, r: MapRect) => {
    const url = await imageDataUrl(job.projectId, p.asset(assetId));
    const x = Math.max(rect.x, r.x), y = Math.max(rect.y, r.y), w = Math.min(rect.x + rect.w, r.x + r.w) - x, h = Math.min(rect.y + rect.h, r.y + r.h) - y;
    if (w <= 0 || h <= 0) return;
    const out = { width: Math.max(1, Math.round(w * size.width / rect.w)), height: Math.max(1, Math.round(h * size.height / rect.h)) };
    const cropped = await p.raster.cropRelative(url, { x: (x - r.x) / r.w, y: (y - r.y) / r.h, w: w / r.w, h: h / r.h }, out);
    layers.push({ url: `data:image/png;base64,${cropped}`, sx: 0, sy: 0, sw: out.width, sh: out.height, dx: (x - rect.x) * size.width / rect.w, dy: (y - rect.y) * size.height / rect.h, dw: out.width, dh: out.height });
  };
  await add(id, { x: 0, y: 0, w: ATLAS_WIDTH, h: ATLAS_HEIGHT });
  for (const m of art?.modules ?? []) if (!job.moduleIds || job.moduleIds.includes(m.id)) await add(m.assetId, m.rect);
  return p.raster.compose(size.width, size.height, layers);
}

export async function paintModule(job: ArtJob & { regionId?: string; rect?: MapRect; chapterId?: string | null; momentId?: string | null }) {
  // Always re-read: an adjoining patch must see the last accepted result.
  const atlas = await loadCurrentAtlas(job.projectId);
  if (atlas) job = { ...job, atlas };
  const p = await context(job), art = p.map.artwork;
  if (art?.stage !== "fine" || !art.assetId) throw new Error("请先采纳精图，再细化模块。");
  if (art.pending) throw new Error("请先采纳或放弃当前预览。");
  const core = job.rect ?? (job.regionId ? blockRect(job.atlas, job.mapId, job.regionId) : null);
  if (!core) throw new Error("请选择地区或框选范围。");
  const pad = 16;
  const rect = { x: Math.max(0, core.x - pad), y: Math.max(0, core.y - pad), w: 0, h: 0 };
  rect.w = Math.min(1000, core.x + core.w + pad) - rect.x; rect.h = Math.min(700, core.y + core.h + pad) - rect.y;
  const size = moduleSize(rect);
  if (!p.raster.editMask || !p.raster.featheredPatch) throw new Error("当前绘图环境不支持局部遮罩。");
  const base = await artworkCrop(job, rect, size);
  const baseRef = await p.saveRef("module-base", base);
  const cell = job.regionId ? cellsOfMap(job.atlas, job.mapId).get(job.regionId) : null;
  const shape = cell ? `<path d="${cellPath(cell)}" fill="white" fill-rule="evenodd"/>` : `<rect x="${core.x}" y="${core.y}" width="${core.w}" height="${core.h}" fill="white"/>`;
  const coverage = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="${rect.x} ${rect.y} ${rect.w} ${rect.h}" preserveAspectRatio="none"><rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" fill="black"/>${shape}</svg>`;
  const mask = await p.raster.editMask(coverage, 24);
  const maskRef = await p.saveRef("module-mask", mask);
  const source = artSource(p.map);
  const region = job.atlas.regions.find((r) => r.id === job.regionId);
  const [asset] = await generateImages(job.projectId, { prompt: `在第一张原图中精细绘制遮罩开放的内部区域，保留外围全部内容、色调、光照与俯视角度。${terrainPrompt}\n${placeRendering(job, rect)}\n${stylePrompt(job.style)}\n${areaContents(job.atlas, job.mapId, core)}\n${job.instruction ?? "补充细节"}${job.markup ? "\n第二张图为全图圈画标注，请按对应地理位置理解作者要求，圈线不进入成图。" : ""}`, model: "sunburst", quality: "high", size: `${size.width}x${size.height}`, referencePaths: [baseRef, ...(job.markup ? [job.markup] : [])], mask: maskRef, caption: `${region?.name ?? "框选模块"} · 局部生成`, owners: [`map:${job.mapId}`], ignoreStyle: true, signal: job.signal });
  job.signal?.throwIfAborted();
  const patch = await p.raster.featheredPatch(`data:image/png;base64,${base}`, await imageDataUrl(job.projectId, asset), `data:image/png;base64,${mask}`, size.width, size.height);
  const derived = await addDerivedImage(job.projectId, { base64: patch, mime: "image/png", caption: `${region?.name ?? "框选模块"} · 融合预览`, owner: `map:${job.mapId}`, link: { role: "other" } });
  const module: MapModule = { id: uniqueId("module"), assetId: derived.id, rect, regionId: job.regionId ?? null, label: region?.name ?? "框选模块", chapterId: job.chapterId ?? null, momentId: job.momentId ?? null };
  await editCurrentAtlas(job.projectId, (atlas) => { const map = atlas.maps.find((m) => m.id === job.mapId); if (!map?.artwork || artSource(map) !== source) throw new Error("地图已改动，结果保存在素材库，请重新生成预览。"); map.artwork.pending = { assetId: derived.id, kind: "module", module, source }; });
  return derived;
}

/** Aspect and edge limits are enforced by the Rust host, including for thin selection boxes. */
export function moduleSize(rect: MapRect) {
  const ratio = Math.max(1 / 3, Math.min(3, rect.w / rect.h));
  const target = Math.max(655360, Math.min(8294400, rect.w * rect.h * 6.88 * 6.88));
  let w = Math.sqrt(target * ratio), h = Math.sqrt(target / ratio);
  const scale = Math.min(1, 3840 / w, 3840 / h); w *= scale; h *= scale;
  const size = { width: Math.max(16, Math.floor(w / 16) * 16), height: Math.max(16, Math.floor(h / 16) * 16) };
  if (size.width > size.height * 3) size.width = size.height * 3;
  if (size.height > size.width * 3) size.height = size.width * 3;
  while (size.width * size.height < 655360) { size.width += 16; size.height += 16; }
  return size;
}
