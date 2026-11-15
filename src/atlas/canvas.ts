// The painted scroll, in the order that keeps it one piece: first one overview of the whole map, then the base map in
// tiles that each follow their part of the overview, then optional blocks (single regions painted over the base) and
// tokens (the small pictures places, characters and items show on the map). Every step looks at what came before it.
import { dailyHost } from "../host";
import { generateImages } from "../images/generate";
import { imageInRole, type ImageAsset, type ImageLink, type ImageQuality, type ImageRole } from "../images/schema";
import { addDerivedImage, imageDataUrl, imageFilePath, imageFilesDir, loadImageLibrary } from "../images/store";
import { cellContains, layoutSvg, type RegionCell } from "./geometry";
import { cellsOfMap } from "./operations";
import { domRaster, type RasterBackend, type RasterLayer } from "./raster";
import { ATLAS_HEIGHT, ATLAS_WIDTH, normalizeBlock, normalizeVariant, PLACE_KIND_LABELS, TERRAIN_LABELS, type Atlas, type AtlasCanvas, type AtlasMap, type BlockEdge, type Point, type Terrain } from "./schema";
import { editCurrentAtlas } from "./store";
import { stylePrompt, type MapStyle } from "./styles";
import { placesOn, terrainAt, terrainChangeAt, type TimeAxis } from "./timeline";

export const CANVAS_COLS = 4;
export const CANVAS_ROWS = 3;
/** Each tile reaches this far into its neighbours, as a share of its own size, on every side. */
export const TILE_OVERLAP = 0.12;
/** Output sizes within the API's limits, close to the shapes they cover. */
export const TILE_SIZE = { width: 1040, height: 976 };
export const OVERVIEW_SIZE = { width: 2240, height: 1568 };

export type Rect = { x: number; y: number; w: number; h: number };

export function tileCore(cols: number, rows: number, index: number): Rect {
  const w = ATLAS_WIDTH / cols;
  const h = ATLAS_HEIGHT / rows;
  return { x: (index % cols) * w, y: Math.floor(index / cols) * h, w, h };
}

/** The area a tile paints, overlap included. Edge tiles reach past the map, which fades the scroll's border. */
export function tileRect(cols: number, rows: number, index: number): Rect {
  const core = tileCore(cols, rows, index);
  const dx = core.w * TILE_OVERLAP;
  const dy = core.h * TILE_OVERLAP;
  return { x: core.x - dx, y: core.y - dy, w: core.w + dx * 2, h: core.h + dy * 2 };
}

/** Centre first, then outwards, so every later tile has painted neighbours. */
export function paintOrder(cols: number, rows: number): number[] {
  const distance = (index: number) => Math.hypot((index % cols) + 0.5 - cols / 2, Math.floor(index / cols) + 0.5 - rows / 2);
  return Array.from({ length: cols * rows }, (_, index) => index).sort((left, right) => distance(left) - distance(right) || left - right);
}

export type Side = "left" | "top" | "right" | "bottom";
export const SIDE_LABELS: Record<Side, string> = { left: "左边", top: "上边", right: "右边", bottom: "下边" };
export function neighbours(cols: number, rows: number, index: number): { side: Side; index: number }[] {
  const col = index % cols;
  const row = Math.floor(index / cols);
  const list: { side: Side; index: number }[] = [];
  if (col > 0) list.push({ side: "left", index: index - 1 });
  if (row > 0) list.push({ side: "top", index: index - cols });
  if (col < cols - 1) list.push({ side: "right", index: index + 1 });
  if (row < rows - 1) list.push({ side: "bottom", index: index + cols });
  return list;
}

const POSITION_NAMES = [["西北", "北部", "东北"], ["西部", "中部", "东部"], ["西南", "南部", "东南"]];
export function tilePosition(cols: number, rows: number, index: number) {
  const col = index % cols;
  const row = Math.floor(index / cols);
  const band = (value: number, count: number) => (count === 1 ? 1 : value === 0 ? 0 : value === count - 1 ? 2 : 1);
  return `第 ${row + 1} 行第 ${col + 1} 列（${POSITION_NAMES[band(row, rows)][band(col, cols)]}）`;
}

export function emptyCanvas(styleId: string): AtlasCanvas {
  return { styleId, overviewAssetId: null, overviewVersions: [], cols: CANVAS_COLS, rows: CANVAS_ROWS, tiles: Array.from({ length: CANVAS_COLS * CANVAS_ROWS }, (_, index) => ({ index, assetId: null, versions: [], error: "" })), updatedAt: 0 };
}

const intersects = (cell: RegionCell, rect: Rect) => (cell.rings?.flat() ?? cell.polygon).some(([x, y]) => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) || cellContains(cell, [rect.x + rect.w / 2, rect.y + rect.h / 2]);

/** What lies in an area of the map, in words, for prompts. */
export function areaContents(atlas: Atlas, mapId: string, rect: Rect, terrain: Map<string, Terrain> = new Map()): string {
  const cells = cellsOfMap(atlas, mapId);
  const inside = (x: number, y: number) => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
  const regions = atlas.regions.filter((region) => region.mapId === mapId && cells.has(region.id) && intersects(cells.get(region.id) as RegionCell, rect));
  const places = placesOn(atlas, mapId).filter(({ point }) => inside(point[0], point[1]));
  const routes = atlas.routes.filter((route) => route.mapId === mapId && route.points.some(([x, y]) => inside(x, y)));
  return [
    regions.length ? `地区：${regions.map((region) => `${region.name}（${TERRAIN_LABELS[terrain.get(region.id) ?? region.terrain]}${region.summary ? `，${region.summary.slice(0, 40)}` : ""}）`).join("；")}` : "这一片主要是海。",
    places.length ? `聚落与地标：${places.map(({ place }) => `${place.name}（${PLACE_KIND_LABELS[place.kind]}）`).join("、")}` : "",
    routes.length ? `河流与道路：${routes.map((route) => route.name || route.kind).join("、")}` : "",
  ].filter(Boolean).join("\n");
}
export function tileContents(atlas: Atlas, mapId: string, index: number, cols: number, rows: number, terrain?: Map<string, Terrain>) { return areaContents(atlas, mapId, tileRect(cols, rows, index), terrain); }

/** What a tile looks like at a moment of the story: the terrain of each region then, and the changes in words. */
export function variantContext(atlas: Atlas, axis: TimeAxis, mapId: string, tileIndex: number, cursor: number): { terrain: Map<string, Terrain>; note: string; changed: boolean } {
  const map = atlas.maps.find((item) => item.id === mapId);
  const rect = tileRect(map?.canvas?.cols ?? CANVAS_COLS, map?.canvas?.rows ?? CANVAS_ROWS, tileIndex);
  const cells = cellsOfMap(atlas, mapId);
  const terrain = new Map<string, Terrain>();
  const notes: string[] = [];
  for (const region of atlas.regions.filter((item) => item.mapId === mapId)) {
    const cell = cells.get(region.id);
    if (!cell || !intersects(cell, rect)) continue;
    terrain.set(region.id, terrainAt(atlas, axis, region, cursor));
    const change = terrainChangeAt(atlas, axis, region.id, cursor);
    if (change) notes.push(`${region.name}已从${TERRAIN_LABELS[region.terrain]}变为${TERRAIN_LABELS[change.terrain]}${change.note ? `（${change.note}）` : ""}，画出这种变化后的样子，其余地方保持原样`);
  }
  return { terrain, note: notes.join("；"), changed: notes.length > 0 };
}

// ---------- shared plumbing ----------

type Painter = {
  projectId: string;
  atlas: Atlas;
  map: AtlasMap;
  style: MapStyle;
  raster: RasterBackend;
  assets: ImageAsset[];
  urls: Map<string, Promise<string>>;
  signal?: AbortSignal;
};

async function painter(projectId: string, atlas: Atlas, mapId: string, style: MapStyle, raster: RasterBackend | undefined, signal?: AbortSignal): Promise<Painter> {
  const map = atlas.maps.find((item) => item.id === mapId);
  if (!map) throw new Error("没有找到这张地图。");
  return { projectId, atlas, map, style, raster: raster ?? domRaster, assets: (await loadImageLibrary(projectId)).assets, urls: new Map(), signal };
}

const assetOf = (p: Painter, id: string | null | undefined) => (id ? p.assets.find((asset) => asset.id === id) : undefined);
async function urlOf(p: Painter, id: string | null | undefined) {
  const asset = assetOf(p, id);
  if (!asset) return null;
  let url = p.urls.get(asset.id);
  if (!url) { url = imageDataUrl(p.projectId, asset); p.urls.set(asset.id, url); url.catch(() => p.urls.delete(asset.id)); }
  return url;
}
const pathOf = (p: Painter, id: string | null | undefined) => { const asset = assetOf(p, id); return asset ? imageFilePath(p.projectId, asset) : null; };

/** Writes a reference picture made here (a sketch, a crop) where the host can read it. */
async function savedReference(p: Painter, name: string, make: () => Promise<string>): Promise<string | null> {
  try {
    const png = await make();
    const path = `${imageFilesDir(p.projectId)}/ref-${p.map.id}-${name}.png`;
    await dailyHost().files.writeBase64(path, png);
    return path;
  } catch { return null; }
}

function sketchOf(p: Painter, rect: Rect, size: { width: number; height: number }, terrain?: Map<string, Terrain>) {
  const regions = p.atlas.regions.filter((region) => region.mapId === p.map.id).map((region) => ({ ...region, terrain: terrain?.get(region.id) ?? region.terrain }));
  const places = placesOn(p.atlas, p.map.id).map(({ place, point }) => ({ name: place.name, point, importance: place.importance }));
  return layoutSvg(regions, cellsOfMap(p.atlas, p.map.id), places, p.atlas.routes.filter((route) => route.mapId === p.map.id), { ...rect, ...size });
}

/** The overview cut to `rect`, as layers for a compose. */
async function overviewLayers(p: Painter, rect: Rect, out: { width: number; height: number }): Promise<RasterLayer[]> {
  const url = await urlOf(p, p.map.canvas?.overviewAssetId);
  if (!url) return [];
  const sx = out.width / rect.w;
  const sy = out.height / rect.h;
  return [{ url, sx: 0, sy: 0, sw: OVERVIEW_SIZE.width, sh: OVERVIEW_SIZE.height, dx: -rect.x * sx, dy: -rect.y * sy, dw: ATLAS_WIDTH * sx, dh: ATLAS_HEIGHT * sy }];
}

/** The painted base cut to `rect`: each tile's own part, without overlaps. */
async function baseLayers(p: Painter, rect: Rect, out: { width: number; height: number }): Promise<RasterLayer[]> {
  const canvas = p.map.canvas;
  if (!canvas) return [];
  const sx = out.width / rect.w;
  const sy = out.height / rect.h;
  const layers: RasterLayer[] = [];
  for (const tile of canvas.tiles) {
    const core = tileCore(canvas.cols, canvas.rows, tile.index);
    if (core.x > rect.x + rect.w || core.x + core.w < rect.x || core.y > rect.y + rect.h || core.y + core.h < rect.y) continue;
    const url = await urlOf(p, tile.assetId);
    if (!url) continue;
    const ext = tileRect(canvas.cols, canvas.rows, tile.index);
    layers.push({ url, sx: 0, sy: 0, sw: TILE_SIZE.width, sh: TILE_SIZE.height, dx: (ext.x - rect.x) * sx, dy: (ext.y - rect.y) * sy, dw: ext.w * sx, dh: ext.h * sy, clip: { x: (core.x - rect.x) * sx, y: (core.y - rect.y) * sy, w: core.w * sx, h: core.h * sy } });
  }
  return layers;
}

function styleReferences(p: Painter, limit: number) { return p.style.referenceIds.filter((id) => assetOf(p, id)).slice(0, limit); }

function numbered(lines: (string | null | false | undefined)[]) {
  let index = 0;
  return lines.filter((line): line is string => Boolean(line)).map((line) => (line.startsWith("@") ? `【第 ${++index} 张参考图】${line.slice(1)}` : line));
}

const stopOnBilling = (message: string) => /quota|HTTP 401|HTTP 403|not configured|额度|API Key|权限/i.test(message);

// ---------- step 1: the overview ----------

export type OverviewJob = { projectId: string; atlas: Atlas; mapId: string; style: MapStyle; quality?: ImageQuality; instruction?: string; raster?: RasterBackend; signal?: AbortSignal };

/** What a detail or interior map should look like, from its parent: the anchor region's block, else the parent overview there. */
async function parentReference(p: Painter): Promise<{ path: string; note: string } | null> {
  const parent = p.atlas.maps.find((item) => item.id === p.map.parentId);
  if (!parent) return null;
  const parentPainter = { ...p, map: parent };
  if (p.map.anchorPlaceId) {
    const owner = `place:${p.map.anchorPlaceId}`;
    const picture = imageInRole(p.assets, owner, "base") ?? imageInRole(p.assets, owner, "icon");
    const place = p.atlas.places.find((item) => item.id === p.map.anchorPlaceId);
    if (picture) return { path: imageFilePath(p.projectId, picture), note: `「${place?.name ?? ""}」从外面看的样子。内部结构图要和它的建筑形制、材质、颜色一致。` };
    return null;
  }
  const region = p.atlas.regions.find((item) => item.id === p.map.anchorRegionId);
  if (!region) return null;
  const block = p.atlas.blocks.find((item) => item.regionId === region.id);
  if (block && pathOf(p, block.assetId)) return { path: pathOf(p, block.assetId) as string, note: `上级地图里「${region.name}」这一块的样子。详情图是它的放大，地貌、色调和画风要一致。` };
  const cell = cellsOfMap(p.atlas, parent.id).get(region.id);
  if (!cell || !parent.canvas?.overviewAssetId) return null;
  const xs = (cell.rings?.flat() ?? cell.polygon).map(([x]) => x);
  const ys = (cell.rings?.flat() ?? cell.polygon).map(([, y]) => y);
  const rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  const layers = await overviewLayers(parentPainter, rect, { width: 1024, height: 1024 });
  if (!layers.length) return null;
  const path = await savedReference(p, "parent", () => p.raster.compose(1024, 1024, layers));
  return path ? { path, note: `上级地图里「${region.name}」一带的样子。详情图是它的放大，地貌、色调和画风要一致。` } : null;
}

export async function paintOverview(job: OverviewJob): Promise<ImageAsset> {
  const p = await painter(job.projectId, job.atlas, job.mapId, job.style, job.raster, job.signal);
  if (!p.atlas.regions.some((region) => region.mapId === p.map.id)) throw new Error("这张图还没有地区。先生成或摆好版图，再画画卷。");
  const full = { x: 0, y: 0, w: ATLAS_WIDTH, h: ATLAS_HEIGHT };
  const sketch = await savedReference(p, "overview-sketch", () => p.raster.svgToPng(sketchOf(p, full, OVERVIEW_SIZE)));
  const parent = await parentReference(p);
  const styleRefs = styleReferences(p, 2);
  const prompt = numbered([
    `画一整幅完整的地图：「${p.map.title}」。${p.map.summary} 俯视地图视角，画面铺满，四边不留白、不加边框。这是整张地图的总图，后面会按它分块画出更精细的版本，所以整体构图、色调和每个地区的样子都在这一张里定下来。`,
    stylePrompt(p.style),
    `【图上有】\n${areaContents(p.atlas, p.map.id, full)}`,
    sketch && "@布局线稿：色块是地形（蓝色是水，绿色是林，灰褐是山，黄色是荒漠），黑点是聚落，线是河流和道路。严格照它的海岸线、地形分区、河流道路走向和聚落位置来画，不要挪动、不要增减陆地。线稿只管位置，不管画风。",
    parent && `@${parent.note}`,
    ...styleRefs.map(() => "@风格参考：只学它的画法、用色和质感，不照搬内容。"),
    job.instruction?.trim() ? `【作者要求】${job.instruction.trim()}` : "",
  ]).join("\n\n");
  const [asset] = await generateImages(p.projectId, { prompt, caption: `${p.map.title} · 总图`, quality: job.quality ?? "high", size: `${OVERVIEW_SIZE.width}x${OVERVIEW_SIZE.height}`, referencePaths: [sketch, parent?.path].filter((path): path is string => Boolean(path)), referenceIds: styleRefs, owners: [`map:${p.map.id}`], ignoreStyle: true, signal: job.signal });
  await editCurrentAtlas(p.projectId, (atlas) => {
    const target = atlas.maps.find((item) => item.id === p.map.id);
    if (!target) return;
    target.canvas ??= emptyCanvas(p.style.id);
    target.canvas.styleId = p.style.id;
    if (target.canvas.overviewAssetId) target.canvas.overviewVersions = [...target.canvas.overviewVersions, target.canvas.overviewAssetId].slice(-20);
    target.canvas.overviewAssetId = asset.id;
    target.canvas.updatedAt = Date.now();
  });
  return asset;
}

// ---------- step 2: the base map in tiles ----------

export type TileState = "queued" | "drawing" | "done" | "failed";
export type PaintCanvasJob = {
  projectId: string;
  /** The map as laid out when painting starts; results are written to the stored map as they finish. */
  atlas: Atlas;
  mapId: string;
  style: MapStyle;
  /** Only these tiles; all of them by default. */
  tiles?: number[];
  quality?: ImageQuality;
  instruction?: string;
  concurrency?: number;
  /** Paint variants that take over from this time on, instead of replacing the tiles. */
  variant?: { chapterId: string | null; momentId: string | null; label: string; terrain: Map<string, Terrain>; note: string };
  /** Paints the overview first when the map has none (the default); false paints tiles from the sketch alone. */
  withOverview?: boolean;
  onOverview?: (state: TileState, detail?: string) => void;
  onTile?: (index: number, state: TileState, detail?: string) => void;
  signal?: AbortSignal;
  raster?: RasterBackend;
};
export type PaintCanvasResult = { overview: boolean; done: number[]; failed: { index: number; error: string }[] };

export async function paintCanvas(job: PaintCanvasJob): Promise<PaintCanvasResult> {
  // A private copy: the overview painted first is recorded on it, and the caller's map stays as it was.
  const atlas = structuredClone(job.atlas);
  const map = atlas.maps.find((item) => item.id === job.mapId);
  if (!map) throw new Error("没有找到这张地图。");
  if (!atlas.regions.some((region) => region.mapId === job.mapId)) throw new Error("这张图还没有地区。先生成或摆好版图，再画画卷。");
  const result: PaintCanvasResult = { overview: false, done: [], failed: [] };
  if (!job.variant && job.withOverview !== false && !map.canvas?.overviewAssetId) {
    job.onOverview?.("drawing");
    try {
      const overview = await paintOverview({ ...job, atlas });
      map.canvas = { ...(map.canvas ?? emptyCanvas(job.style.id)), overviewAssetId: overview.id };
      result.overview = true;
      job.onOverview?.("done");
    } catch (error) {
      job.onOverview?.("failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  const p = await painter(job.projectId, atlas, job.mapId, job.style, job.raster, job.signal);
  const canvas = map.canvas && map.canvas.cols * map.canvas.rows === map.canvas.tiles.length ? map.canvas : emptyCanvas(job.style.id);
  const { cols, rows } = canvas;
  const order = paintOrder(cols, rows).filter((index) => !job.tiles || job.tiles.includes(index));
  const painted = new Map(canvas.tiles.flatMap((tile) => (tile.assetId ? [[tile.index, tile.assetId] as const] : [])));
  const styleRefs = styleReferences(p, 1);


  await editCurrentAtlas(job.projectId, (stored) => { const target = stored.maps.find((item) => item.id === job.mapId); if (target && !target.canvas) target.canvas = { ...canvas, styleId: job.style.id }; });

  const runOne = async (index: number) => {
    job.onTile?.(index, "drawing");
    try {
      const rect = tileRect(cols, rows, index);
      const overview = !job.variant ? await overviewLayers(p, rect, TILE_SIZE) : [];
      const overviewRef = overview.length ? await savedReference(p, `overview-${index}`, () => p.raster.compose(TILE_SIZE.width, TILE_SIZE.height, overview)) : null;
      const currentRef = job.variant ? pathOf(p, painted.get(index)) : null;
      const sketch = await savedReference(p, `sketch-${index}`, () => p.raster.svgToPng(sketchOf(p, rect, TILE_SIZE, job.variant?.terrain)));
      const sides = neighbours(cols, rows, index).flatMap((item) => { const path = pathOf(p, painted.get(item.index)); return path ? [{ ...item, path }] : []; }).slice(0, 2);
      const prompt = numbered([
        `你在画一整幅地图长卷中的一块。整卷分成 ${rows} 行 ${cols} 列，这是${tilePosition(cols, rows, index)}。俯视地图视角，画面铺满，四边不留白、不加边框，要能和相邻的块无缝拼接。`,
        stylePrompt(job.style),
        `【这一块里有】\n${tileContents(atlas, job.mapId, index, cols, rows, job.variant?.terrain)}`,
        overviewRef && "@整幅总图里这一块的样子（分辨率较低）。照它的构图、色调、光线和每样东西的模样，画出更精细、更清晰的版本，不要改变内容和配色。",
        currentRef && "@这一块现在的样子。只改下面说的变化，其余部分、色调和笔触保持原样。",
        sketch && "@这一块的布局线稿：色块是地形，黑点是聚落，线是河流和道路。海岸线、地形分区、河流道路和聚落位置要和它一致。",
        ...sides.map((item) => `@已经画好的${SIDE_LABELS[item.side]}相邻块。它靠近这一块的那条边和这一块的${SIDE_LABELS[item.side]}缘是同一片地方：衔接处的海岸线、山势、颜色、笔触和光线必须连续。`),
        ...styleRefs.map(() => "@风格参考：只学画法、用色和质感，不照搬内容。"),
        job.variant ? `【此刻的变化】${job.variant.note}` : "",
        job.instruction?.trim() ? `【作者要求】${job.instruction.trim()}` : "",
      ]).join("\n\n");
      const references = [overviewRef, currentRef, sketch, ...sides.map((item) => item.path)].filter((path): path is string => Boolean(path));
      const [asset] = await generateImages(job.projectId, { prompt, caption: `${map.title} · ${tilePosition(cols, rows, index)}${job.variant ? ` · ${job.variant.label}` : ""}`, quality: job.quality ?? "medium", size: `${TILE_SIZE.width}x${TILE_SIZE.height}`, referencePaths: references, referenceIds: styleRefs, owners: [`map:${job.mapId}`], ignoreStyle: true, signal: job.signal });
      if (!job.variant) painted.set(index, asset.id);
      p.assets.push(asset);
      await editCurrentAtlas(job.projectId, (stored) => {
        const target = stored.maps.find((item) => item.id === job.mapId);
        if (!target) return;
        if (job.variant) {
          const variant = normalizeVariant({ mapId: job.mapId, tileIndex: index, assetId: asset.id, chapterId: job.variant.chapterId, momentId: job.variant.momentId, label: job.variant.label, origin: "user" });
          if (variant) stored.variants.push(variant);
          return;
        }
        target.canvas ??= { ...canvas, styleId: job.style.id };
        target.canvas.styleId = job.style.id;
        const tile = target.canvas.tiles[index];
        if (tile.assetId) tile.versions = [...tile.versions, tile.assetId].slice(-20);
        tile.assetId = asset.id;
        tile.error = "";
        target.canvas.updatedAt = Date.now();
      });
      result.done.push(index);
      job.onTile?.(index, "done");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failed.push({ index, error: message });
      job.onTile?.(index, "failed", message);
      if (!job.variant) await editCurrentAtlas(job.projectId, (stored) => { const tile = stored.maps.find((item) => item.id === job.mapId)?.canvas?.tiles[index]; if (tile) tile.error = message; }).catch(() => undefined);
      if (stopOnBilling(message)) queue.length = 0;
    }
  };
  const queue = [...order];
  const worker = async () => { while (queue.length && !job.signal?.aborted) await runOne(queue.shift() as number); };
  // Without an overview the first tile sets the look, so it paints alone; the rest go a few at a time.
  if (!painted.size && !p.map.canvas?.overviewAssetId && queue.length && !job.signal?.aborted) await runOne(queue.shift() as number);
  await Promise.all(Array.from({ length: Math.max(1, Math.min(job.concurrency ?? 2, queue.length)) }, worker));
  return result;
}

// ---------- step 3: blocks ----------

/** The area a block covers: its region's bounds with a margin, kept on the map. */
export function blockRect(atlas: Atlas, mapId: string, regionId: string): Rect | null {
  const cell = cellsOfMap(atlas, mapId).get(regionId);
  if (!cell) return null;
  const xs = (cell.rings?.flat() ?? cell.polygon).map(([x]) => x);
  const ys = (cell.rings?.flat() ?? cell.polygon).map(([, y]) => y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0;
  const h = Math.max(...ys) - y0;
  const margin = Math.max(w, h) * 0.08;
  return { x: x0 - margin, y: y0 - margin, w: w + margin * 2, h: h + margin * 2 };
}

export function blockSize(rect: Rect) {
  const ratio = rect.w / rect.h;
  return ratio > 1.25 ? { width: 1536, height: 1024 } : ratio < 0.8 ? { width: 1024, height: 1536 } : { width: 1024, height: 1024 };
}

export type BlockJob = { projectId: string; atlas: Atlas; mapId: string; regionId: string; style: MapStyle; edge: BlockEdge; quality?: ImageQuality; instruction?: string; raster?: RasterBackend; signal?: AbortSignal };

export async function paintBlock(job: BlockJob): Promise<ImageAsset> {
  const p = await painter(job.projectId, job.atlas, job.mapId, job.style, job.raster, job.signal);
  const region = p.atlas.regions.find((item) => item.id === job.regionId);
  const rect = blockRect(p.atlas, job.mapId, job.regionId);
  if (!region || !rect) throw new Error("没有找到这个地区。");
  const size = blockSize(rect);
  const overview = await overviewLayers(p, rect, size);
  const base = await baseLayers(p, rect, size);
  const overviewRef = overview.length ? await savedReference(p, `block-overview-${region.id}`, () => p.raster.compose(size.width, size.height, overview)) : null;
  const baseRef = base.length ? await savedReference(p, `block-base-${region.id}`, () => p.raster.compose(size.width, size.height, base)) : null;
  const sketch = await savedReference(p, `block-sketch-${region.id}`, () => p.raster.svgToPng(sketchOf(p, rect, size)));
  const edgeNote = job.edge === "distinct"
    ? "这块地区自成一格：可以用和周边不同的质感、细节密度和色调，把它画成一幅独立的小图；地区以外的部分简单交代即可，最后会按地区边界裁切，边界处线条清楚、不要渐变。"
    : "这块地区要和周围的底图融为一体：边缘附近的地形、颜色、光线和笔触要和参考图里地区外的部分完全衔接，越靠近边缘越要和底图一致，中间可以画得更精细。";
  const prompt = numbered([
    `画地图「${p.map.title}」中「${region.name}」这一块地区的精细图。俯视地图视角，画面铺满，不加边框。${region.summary}`,
    stylePrompt(job.style),
    `【这一片里有】\n${areaContents(p.atlas, job.mapId, rect)}`,
    `【边界】${edgeNote}`,
    overviewRef && "@总图里这一块的样子。整体构图、色调和画风以它为准。",
    baseRef && "@底图里这一块已经画好的样子。比它画得更精细，但不能和它矛盾。",
    sketch && "@这一片的布局线稿。地区边界、河流道路和聚落位置要和它一致。",
    job.instruction?.trim() ? `【作者要求】${job.instruction.trim()}` : "",
  ]).join("\n\n");
  const [asset] = await generateImages(p.projectId, { prompt, caption: `${p.map.title} · ${region.name} 块图`, quality: job.quality ?? "high", size: `${size.width}x${size.height}`, referencePaths: [overviewRef, baseRef, sketch].filter((path): path is string => Boolean(path)), owners: [`map:${job.mapId}`, `region:${region.id}`], ignoreStyle: true, signal: job.signal });
  await editCurrentAtlas(p.projectId, (stored) => {
    const existing = stored.blocks.find((item) => item.mapId === job.mapId && item.regionId === region.id);
    if (existing) { existing.versions = [...existing.versions, existing.assetId].slice(-20); existing.assetId = asset.id; existing.edge = job.edge; existing.hidden = false; return; }
    const block = normalizeBlock({ mapId: job.mapId, regionId: region.id, assetId: asset.id, edge: job.edge });
    if (block) stored.blocks.push(block);
  });
  return asset;
}

// ---------- step 4: tokens ----------

/** Something on the map that shows as a small picture: a place's building, a character's avatar, an item's thumbnail. */
export type TokenTarget = { owner: string; role: ImageRole; name: string; description: string; point: Point | null };
export type TokenMethod = "sheet" | "single" | "crop";
export const TOKEN_METHOD_LABELS: Record<TokenMethod, string> = { sheet: "拼图生成后裁切", single: "逐个生成透明底", crop: "从画卷裁切" };
const TOKEN_ROLE_PROMPTS: Partial<Record<ImageRole, string>> = {
  icon: "一个地点的小图标：从斜上方俯视的这座建筑或地标，完整的单个主体",
  avatar: "一个人物的头像：胸像，正面或四分之三侧面，表情和气质符合人物",
  thumb: "一件物品的小图：完整的单个物品，略带俯视角",
};
const SHEET = { cols: 3, rows: 3, size: 1536 };

export type TokenJob = { projectId: string; atlas: Atlas; mapId: string; style: MapStyle; targets: TokenTarget[]; method: TokenMethod; quality?: ImageQuality; raster?: RasterBackend; signal?: AbortSignal; onProgress?: (message: string) => void; preview?: boolean; moduleIds?: string[] };
export type TokenResult = { done: { owner: string; assetId: string }[]; failed: { owner: string; error: string }[] };

function tokenLink(target: TokenTarget): Partial<ImageLink> { return { role: target.role, note: "地图组件" }; }

export async function paintTokens(job: TokenJob): Promise<TokenResult> {
  const p = await painter(job.projectId, job.atlas, job.mapId, job.style, job.raster, job.signal);
  const result: TokenResult = { done: [], failed: [] };
  const styleRefs = styleReferences(p, 1);
  const link = (target: TokenTarget): Partial<ImageLink> => job.preview ? { role: "other", note: "待采纳的地图组件" } : tokenLink(target);
  const queueToken = async (target: TokenTarget, assetId: string) => {
    if (!job.preview) return;
    await editCurrentAtlas(p.projectId, (atlas) => {
      const map = atlas.maps.find((m) => m.id === p.map.id);
      const role = target.role === "avatar" ? "avatar" as const : target.role === "thumb" ? "thumb" as const : "icon" as const;
      if (map?.artwork) map.artwork.tokens = [...(map.artwork.tokens ?? []), { assetId, owner: target.owner, role, name: target.name }].slice(-100);
    });
  };
  const subjectRefs = (target: TokenTarget) => {
    const base = imageInRole(p.assets, target.owner, "base");
    return base ? [base.id] : [];
  };
  const look = `透明背景，主体居中，四周留出空白，不要地面、阴影以外的背景，不要文字。画风与整幅地图一致：${p.style.prompt.slice(0, 220)}`;

  if (job.method === "crop") {
    for (const [index, target] of job.targets.entries()) {
      if (job.signal?.aborted) break;
      job.onProgress?.(`裁切组件 ${index + 1}/${job.targets.length}`);
      try {
        if (!target.point) throw new Error("它不在这张图上。");
        const span = 70;
        const rect = { x: target.point[0] - span / 2, y: target.point[1] - span / 2, w: span, h: span };
        const out = { width: 256, height: 256 };
        const layers = [...await overviewLayers(p, rect, out), ...await baseLayers(p, rect, out)];
        if (!layers.length && !p.map.artwork?.assetId) throw new Error("这张图还没有画卷，没有可裁切的画面。");
        const png = p.map.artwork?.assetId
          ? await (await import("./artwork")).artworkCrop({ projectId: p.projectId, atlas: p.atlas, mapId: p.map.id, style: p.style, raster: p.raster, moduleIds: job.moduleIds }, rect, out)
          : await p.raster.compose(out.width, out.height, layers, { circle: true });
        const asset = await addDerivedImage(p.projectId, { base64: png, mime: "image/png", caption: `${target.name} · 地图组件`, owner: target.owner, link: link(target) });
        await queueToken(target, asset.id);
        result.done.push({ owner: target.owner, assetId: asset.id });
      } catch (error) { result.failed.push({ owner: target.owner, error: error instanceof Error ? error.message : String(error) }); }
    }
    return result;
  }

  if (job.method === "single") {
    for (const [index, target] of job.targets.entries()) {
      if (job.signal?.aborted) break;
      job.onProgress?.(`生成组件 ${index + 1}/${job.targets.length}：${target.name}`);
      const references = subjectRefs(target);
      let mapRef: string | null = null;
      if (p.map.artwork?.assetId || p.map.canvas?.overviewAssetId) {
        mapRef = await savedReference(p, `token-context-${index}`, async () => {
          if (p.map.artwork?.assetId) {
            const { artworkCrop } = await import("./artwork");
            const x = target.point ? Math.max(0, Math.min(840, target.point[0] - 80)) : 0;
            const y = target.point ? Math.max(0, Math.min(540, target.point[1] - 80)) : 0;
            return artworkCrop({ projectId: p.projectId, atlas: p.atlas, mapId: p.map.id, style: p.style, raster: p.raster, moduleIds: job.moduleIds }, { x, y, w: target.point ? 160 : 1000, h: target.point ? 160 : 700 }, { width: 1024, height: 1024 });
          }
          const rect = target.point ? { x: Math.max(0, target.point[0] - 80), y: Math.max(0, target.point[1] - 80), w: 160, h: 160 } : { x: 0, y: 0, w: 1000, h: 700 };
          return p.raster.compose(1024, 1024, [...await overviewLayers(p, rect, { width: 1024, height: 1024 }), ...await baseLayers(p, rect, { width: 1024, height: 1024 })]);
        });
      }
      try {
        const prompt = numbered([
          `${TOKEN_ROLE_PROMPTS[target.role] ?? "一个小图标"}：「${target.name}」。${target.description}`,
          look,
          mapRef && "@当前地图裁片：统一俯视角度、线条粗细、光照、材质和用色，只生成独立主体。",
          ...references.map(() => "@它的基础图：外形、服饰、配色和细节都照它来，只是画成小图。"),
          ...styleRefs.map(() => "@风格参考：只学画法和用色。"),
        ]).join("\n\n");
        const [asset] = await generateImages(p.projectId, { prompt, caption: `${target.name} · ${target.role === "avatar" ? "头像" : target.role === "thumb" ? "缩略图" : "地图组件"}`, quality: job.quality ?? "medium", size: "1024x1024", background: "transparent", referencePaths: mapRef ? [mapRef] : [], referenceIds: [...references, ...styleRefs], owners: [target.owner], link: link(target), ignoreStyle: true, signal: job.signal });
        await queueToken(target, asset.id);
        result.done.push({ owner: target.owner, assetId: asset.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.failed.push({ owner: target.owner, error: message });
        if (stopOnBilling(message)) break;
      }
    }
    return result;
  }

  // A sheet of up to nine tokens per request, sliced apart and trimmed afterwards: cheaper, and the tokens match.
  const perSheet = SHEET.cols * SHEET.rows;
  for (let start = 0; start < job.targets.length; start += perSheet) {
    if (job.signal?.aborted) break;
    const group = job.targets.slice(start, start + perSheet);
    job.onProgress?.(`生成组件拼图 ${start / perSheet + 1}/${Math.ceil(job.targets.length / perSheet)}`);
    try {
      const cells = group.map((target, index) => `第 ${Math.floor(index / SHEET.cols) + 1} 行第 ${(index % SHEET.cols) + 1} 格：${TOKEN_ROLE_PROMPTS[target.role] ?? "小图标"}——「${target.name}」。${target.description.slice(0, 80)}`);
      const prompt = [
        `一张 ${SHEET.rows} 行 ${SHEET.cols} 列的图标拼图，透明背景，每格一个独立的小图，彼此不接触、不重叠，每个主体都在自己格子的正中间，四周留出至少格宽五分之一的空白。没有格线、没有文字、没有编号。`,
        look,
        cells.join("\n"),
        group.length < perSheet ? `其余 ${perSheet - group.length} 格留空。` : "",
      ].filter(Boolean).join("\n\n");
      const [sheet] = await generateImages(p.projectId, { prompt, caption: `${p.map.title} · 组件拼图`, quality: job.quality ?? "medium", size: `${SHEET.size}x${SHEET.size}`, background: "transparent", referenceIds: styleRefs, owners: [`map:${job.mapId}`], ignoreStyle: true, signal: job.signal });
      const url = await imageDataUrl(p.projectId, sheet);
      const pieces = await p.raster.slice(url, SHEET.cols, SHEET.rows);
      for (const [index, target] of group.entries()) {
        const asset = await addDerivedImage(p.projectId, { base64: pieces[index], mime: "image/png", caption: `${target.name} · 地图组件`, prompt: sheet.prompt, owner: target.owner, link: tokenLink(target) });
        result.done.push({ owner: target.owner, assetId: asset.id });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const target of group) result.failed.push({ owner: target.owner, error: message });
      if (stopOnBilling(message)) break;
    }
  }
  return result;
}
