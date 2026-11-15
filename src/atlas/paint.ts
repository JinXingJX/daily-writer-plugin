// A painted base map: GPT Image draws over the map's own layout, so the picture lines up with regions and places.
import { dailyHost } from "../host";
import { generateImages } from "../images/generate";
import type { ImageAsset } from "../images/schema";
import { imageFilesDir } from "../images/store";
import { layoutSvg } from "./geometry";
import { cellsOfMap } from "./operations";
import type { Atlas } from "./schema";
import { placesOn } from "./timeline";

/** SVG text to base64 PNG; needs a DOM (every Writer view has one). */
export async function rasterize(svg: string): Promise<string> {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext("2d")?.drawImage(image, 0, 0);
  return canvas.toDataURL("image/png").split(",")[1] ?? "";
}

export type PaintOptions = { instruction?: string; referenceIds?: string[] };

/** One paid image request. The caller decides what to do with the result (usually: make it the map's base image). */
export async function paintBaseMap(projectId: string, atlas: Atlas, mapId: string, options: PaintOptions = {}): Promise<ImageAsset> {
  const map = atlas.maps.find((item) => item.id === mapId);
  if (!map) throw new Error("没有找到这张地图。");
  const regions = atlas.regions.filter((region) => region.mapId === mapId);
  if (!regions.length) throw new Error("这张图还没有地区，先绘制版图再画底图。");
  const referencePaths: string[] = [];
  // Without a layout reference the picture can still be used, just with looser alignment.
  try {
    const places = placesOn(atlas, mapId).map(({ place, point }) => ({ name: place.name, point, importance: place.importance }));
    const layout = await rasterize(layoutSvg(regions, cellsOfMap(atlas, mapId), places, atlas.routes.filter((route) => route.mapId === mapId)));
    const path = `${imageFilesDir(projectId)}/layout-${mapId}.png`;
    await dailyHost().files.writeBase64(path, layout);
    referencePaths.push(path);
  } catch { /* fall through */ }
  const styled = Boolean(options.referenceIds?.length);
  const prompt = [
    `一张手绘的幻想世界俯视地图${styled ? "" : "，古旧纸本质感，用色克制"}。${referencePaths.length ? "严格按第一张参考图的版图绘制：陆地和海岸的轮廓、各地区的位置和地形、河流道路的走向、圆点标出的聚落位置都不要改动。" : ""}把每种地形画成细致的山脉、森林、荒漠、海浪。画面里不要出现任何文字、图例、边框、罗盘或人物。`,
    styled ? `${referencePaths.length ? "其余" : ""}参考图是作者给的参考：沿用它的画风、用色和笔触，版图以${referencePaths.length ? "第一张" : "下面的描述"}为准。` : "",
    `这个世界：${map.summary}`,
    `地区：${regions.map((region) => `${region.name}（${region.terrain}）`).join("、")}`,
    options.instruction?.trim() ? `作者要求：${options.instruction.trim()}` : "",
  ].filter(Boolean).join("\n");
  const [asset] = await generateImages(projectId, { prompt, caption: `${map.title} 底图`, quality: "medium", size: "1600x1120", referencePaths, referenceIds: options.referenceIds, owners: [`map:${mapId}`], ignoreStyle: styled });
  return asset;
}
