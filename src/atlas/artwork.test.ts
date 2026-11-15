import { beforeEach, describe, expect, it } from "vitest";
import { installFakeHost } from "../test/fakeHost";
import { stubRaster } from "../test/raster";
import { createProject } from "../storage/projectStore";
import { applyAtlasOps, cellsOfMap } from "./operations";
import { emptyAtlas, normalizeAtlas, type Atlas, type RegionGrid } from "./schema";
import { applyBoundaryEdit, brushGrid, dragGrid, gridCells, initialGrid } from "./boundaries";
import { cellContains, cellPath } from "./geometry";
import { adoptArtwork, artSource, emptyArtwork, moduleSize, paintDraft, paintFine, paintModule, restoreArtwork } from "./artwork";
import { BUILTIN_STYLES } from "./styles";
import { editCurrentAtlas, loadCurrentAtlas, saveAtlas } from "./store";
import { patchPixels } from "./raster";
import { eventPoint } from "./timeline";
import { generateAtlasDraft } from "../ai/pipelines/atlas";
import { imageInRole } from "../images/schema";
import { loadImageLibrary } from "../images/store";
import { paintTokens } from "./canvas";

const world = () => applyAtlasOps(emptyAtlas(), [
  { type: "upsertRegion", region: { id: "a", name: "西境", center: [250, 350] } },
  { type: "upsertRegion", region: { id: "b", name: "东境", center: [750, 350] } },
]).atlas;

describe("editable ownership", () => {
  it("updates place and event membership while flagging only coastline edits", () => {
    const atlas = world(), map = atlas.maps[0]; map.surround = "land"; map.artwork = emptyArtwork();
    atlas.places.push({ id: "p", mapId: map.id, regionId: "b", name: "边城", aliases: [], kind: "city", point: [530, 350], parentPoint: null, summary: "", importance: 2, firstChapterId: null });
    const grid = initialGrid(atlas.regions, map);
    brushGrid(grid, [530, 350], [530, 350], 40, 1);
    applyBoundaryEdit(atlas, map.id, grid, { x: 490, y: 310, w: 80, h: 80 });
    expect(atlas.places[0].regionId).toBe("a"); expect(map.artwork.dirty).toEqual([]);
    const erased = structuredClone(grid);
    brushGrid(erased, [530, 350], [530, 350], 20, 0);
    applyBoundaryEdit(atlas, map.id, erased, { x: 510, y: 330, w: 40, h: 40 });
    expect(atlas.places[0].regionId).toBeNull(); expect(map.artwork.dirty).toHaveLength(1);
  });
  it("drags a shared border in either direction without moving remote regions", () => {
    const grid: RegionGrid = { cols: 100, rows: 70, ids: ["a", "b"], cells: Array.from({ length: 7000 }, (_, i) => i % 100 < 50 ? 1 : 2) };
    const right = structuredClone(grid), left = structuredClone(grid);
    expect(dragGrid(right, [500, 350], [540, 350], 40).changed).toBe(true);
    expect(right.cells[35 * 100 + 52]).toBe(1);
    expect(dragGrid(left, [500, 350], [460, 350], 40).changed).toBe(true);
    expect(left.cells[35 * 100 + 48]).toBe(2);
    expect(left.cells.slice(0, 100)).toEqual(grid.cells.slice(0, 100));
    expect(right.cells.slice(-100)).toEqual(grid.cells.slice(-100));
  });
  it("keeps islands, holes and exact shared boundaries through persistence", () => {
    const grid: RegionGrid = { cols: 5, rows: 5, ids: ["a", "b"], cells: [1,1,1,2,2, 1,0,1,2,2, 1,1,1,2,2, 2,2,2,2,2, 1,2,2,2,2] };
    const cells = gridCells(grid, new Set(grid.ids)), a = cells.get("a")!, b = cells.get("b")!;
    expect(a.rings).toHaveLength(3);
    expect(cellContains(a, [300, 210])).toBe(false); // enclosed water
    expect(cellContains(a, [100, 630])).toBe(true); // island
    expect(cellContains(b, [100, 630])).toBe(false);
    expect(cellPath(a).match(/M/g)).toHaveLength(3);
    const atlas = world(); atlas.maps[0].boundaries = grid;
    const restored = normalizeAtlas(JSON.parse(JSON.stringify(atlas)))!;
    expect(cellsOfMap(restored, restored.rootMapId).get("a")).toEqual(a);
    for (let y = 70; y < 700; y += 140) for (let x = 100; x < 1000; x += 200) {
      const owners = [...cells.values()].filter((c) => cellContains(c, [x, y]));
      expect(owners.length).toBe(grid.cells[Math.floor(y / 140) * 5 + Math.floor(x / 200)] ? 1 : 0);
    }
  });
  it("alters only swept cells and does not recompute the shape when a name moves", () => {
    const atlas = world(), map = atlas.maps[0]; map.surround = "land";
    const grid = initialGrid(atlas.regions, map), before = [...grid.cells];
    const change = brushGrid(grid, [490, 350], [550, 350], 14, 1);
    expect(change).toMatchObject({ changed: true, coastline: false });
    expect(grid.cells[0]).toBe(before[0]); expect(grid.cells.at(-1)).toBe(before.at(-1));
    map.boundaries = grid;
    const shape = cellPath(cellsOfMap(atlas, map.id).get("a")!);
    atlas.regions[0].center = [900, 100]; atlas.regions[0].labelPoint = [50, 100];
    expect(cellPath(cellsOfMap(atlas, map.id).get("a")!)).toBe(shape);
    const erased = brushGrid(grid, [100, 100], [100, 100], 16, 0);
    expect(erased.coastline).toBe(true);
    const removed = applyAtlasOps(atlas, [{ type: "removeRegion", id: "a" }]).atlas;
    expect(removed.maps[0].boundaries?.cells.includes(1)).toBe(false);
  });
  it("retains diagonal islands separately and rejects invalid stored grids", () => {
    const grid = { cols: 2, rows: 2, ids: ["a"], cells: [1,0,0,1] };
    expect(gridCells(grid, new Set(["a"])).get("a")?.rings).toHaveLength(2);
    const atlas = world(); atlas.maps[0].boundaries = { ...grid, cols: 9999999 };
    expect(normalizeAtlas(atlas)?.maps[0].boundaries).toBeNull();
  });
  it("keeps a manually positioned event on the exact point instead of a region centre", () => {
    const atlas = applyAtlasOps(world(), [{ type: "upsertEvent", event: { title: "路遇", mapId: world().rootMapId, point: [120, 230] } }]).atlas;
    atlas.events[0].mapId = atlas.rootMapId;
    const restored = normalizeAtlas(atlas)!;
    expect(eventPoint(restored, cellsOfMap(restored, restored.rootMapId), restored.rootMapId, restored.events[0])?.point).toEqual([120, 230]);
  });
});

describe("staged painting", () => {
  let host: ReturnType<typeof installFakeHost>, projectId: string;
  const raster = stubRaster();
  const current = async () => (await loadCurrentAtlas(projectId)) as Atlas;
  const job = async () => { const atlas = await current(); return { projectId, atlas, mapId: atlas.rootMapId, style: BUILTIN_STYLES[0], raster }; };
  beforeEach(async () => { host = installFakeHost(); projectId = (await createProject({ title: "新地图" })).id; await saveAtlas(projectId, world()); });
  const adoptDraft = async () => {
    const candidates = await paintDraft(await job());
    await editCurrentAtlas(projectId, (a) => adoptArtwork(a.maps[0], candidates[0].id));
  };
  const adoptFine = async () => { await adoptDraft(); await paintFine(await job()); await editCurrentAtlas(projectId, (a) => adoptArtwork(a.maps[0])); };
  it("makes one cheap three-candidate request, then waits for explicit adoption", async () => {
    await expect(paintFine(await job())).rejects.toThrow("先采纳");
    await paintDraft(await job());
    expect(host.imageCalls).toHaveLength(1);
    expect(host.imageCalls[0]).toMatchObject({ model: "flare", quality: "low", size: "1120x784", n: 3 });
    expect((await current()).maps[0].artwork?.assetId).toBe("");
    expect((await current()).maps[0].artwork?.candidates).toHaveLength(3);
    await expect(paintFine(await job())).rejects.toThrow("先采纳");
    const atlas = await current(), candidate = atlas.maps[0].artwork!.candidates[0];
    await editCurrentAtlas(projectId, (a) => adoptArtwork(a.maps[0], candidate));
    await paintFine(await job());
    expect(host.imageCalls).toHaveLength(2);
    expect(host.imageCalls[1]).toMatchObject({ model: "sunburst", quality: "high", size: "3440x2400" });
    expect((await current()).maps[0].artwork).toMatchObject({ assetId: candidate, stage: "draft", pending: { kind: "fine" } });
    await editCurrentAtlas(projectId, (a) => adoptArtwork(a.maps[0]));
    expect((await current()).maps[0].artwork?.stage).toBe("fine");
    await editCurrentAtlas(projectId, (a) => restoreArtwork(a.maps[0]));
    expect((await current()).maps[0].artwork).toMatchObject({ assetId: candidate, stage: "draft" });
  });
  it("uses masks and a re-read composite for module previews, never writes before adoption", async () => {
    await adoptFine();
    const atlas = await current(), original = atlas.maps[0].artwork!.assetId;
    await paintModule({ ...await job(), rect: { x: 300, y: 200, w: 150, h: 120 }, markup: "annotation.png" });
    const call = host.imageCalls.at(-1)!;
    expect(call.mask).toMatch(/module-mask/); expect(call.markup).toBeUndefined();
    expect(call.references?.[0]).toMatch(/module-base/); expect(call.references?.[1]).toBe("annotation.png");
    expect((await current()).maps[0].artwork?.modules).toHaveLength(0);
    await expect(paintModule({ ...await job(), regionId: "a" })).rejects.toThrow("先采纳或放弃");
    await editCurrentAtlas(projectId, (a) => adoptArtwork(a.maps[0]));
    expect((await current()).maps[0].artwork).toMatchObject({ assetId: original, modules: [expect.any(Object)] });
    const cropsBefore = raster.composed;
    // A stale caller snapshot must still include the newly adopted module.
    await paintModule({ projectId, atlas, mapId: atlas.rootMapId, style: BUILTIN_STYLES[0], raster, regionId: "b" });
    expect(raster.composed).toBeGreaterThan(cropsBefore);
    await editCurrentAtlas(projectId, (a) => { a.maps[0].artwork!.pending = null; a.maps[0].artwork!.dirty = [{ x: 300, y: 200, w: 50, h: 50 }]; });
    await paintModule({ ...await job(), rect: { x: 300, y: 200, w: 150, h: 120 } });
    await editCurrentAtlas(projectId, (a) => adoptArtwork(a.maps[0]));
    expect((await current()).maps[0].artwork!.dirty).toEqual([]);
    await editCurrentAtlas(projectId, (a) => restoreArtwork(a.maps[0]));
    expect((await current()).maps[0].artwork!.dirty).toHaveLength(1);
    await paintModule({ ...await job(), rect: { x: 300, y: 200, w: 150, h: 120 } });
    const edited = await current(); edited.maps[0].artwork!.dirty.push({ x: 0, y: 0, w: 10, h: 10 });
    expect(() => adoptArtwork(edited.maps[0])).toThrow("地图已改动");
  });
  it("preserves old assets and rejects a cancelled generation without adopting it", async () => {
    const atlas = await current(); atlas.maps[0].baseImageId = "old-base";
    await saveAtlas(projectId, atlas);
    const controller = new AbortController(); host.setImage(() => controller.abort());
    await expect(paintDraft({ ...await job(), signal: controller.signal })).rejects.toThrow();
    expect((await current()).maps[0].baseImageId).toBe("old-base");
    expect((await current()).maps[0].artwork).toBeNull();
  });
  it("keeps generated and cropped tokens pending and supplies the actual map as a reference", async () => {
    await adoptFine();
    const j = await job();
    const result = await paintTokens({ ...j, method: "single", preview: true, targets: [{ owner: "place:p", name: "城门", role: "icon", point: [300, 200], description: "城门" }] });
    expect(host.imageCalls.at(-1)?.references?.[0]).toMatch(/token-context/);
    expect(imageInRole((await loadImageLibrary(projectId)).assets, "place:p", "icon")).toBeUndefined();
    expect((await current()).maps[0].artwork?.tokens?.[0].assetId).toBe(result.done[0].assetId);
    const crop = await paintTokens({ ...await job(), method: "crop", preview: true, targets: [{ owner: "place:crop", name: "城门裁片", role: "icon", point: [300, 200], description: "" }] });
    expect(crop.failed).toEqual([]);
    expect(imageInRole((await loadImageLibrary(projectId)).assets, "place:crop", "icon")).toBeUndefined();
    expect((await current()).maps[0].artwork?.tokens?.[1].assetId).toBe(crop.done[0].assetId);
  });
  it("publishes a geographic layout after one model call without waiting for event extraction", async () => {
    const project = await createProject({ title: "快速版图" });
    host.setModel(() => JSON.stringify({ title: "地图", regions: [{ name: "冰原", center: [300, 200] }], places: [], routes: [] }));
    await generateAtlasDraft({ project, memory: null, story: null, mode: "layout", instruction: "绘制北方冰原与南方森林" });
    expect(host.modelCalls).toHaveLength(1);
  });
});

describe("pixel constraints", () => {
  it("keeps dense module output inside all Rust image limits", () => {
    for (const rect of [{ x: 0, y: 0, w: 1000, h: 700 }, { x: 0, y: 0, w: 1000, h: 10 }, { x: 0, y: 0, w: 10, h: 700 }, { x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 300, h: 200 }]) {
      const { width, height } = moduleSize(rect);
      expect(width % 16 + height % 16).toBe(0);
      expect(Math.max(width, height)).toBeLessThanOrEqual(3840);
      expect(Math.max(width, height) / Math.min(width, height)).toBeLessThanOrEqual(3);
      expect(width * height).toBeGreaterThanOrEqual(655360);
      expect(width * height).toBeLessThanOrEqual(8294400);
    }
  });
  it("makes the locked collar fully transparent and feathers only editable pixels", () => {
    const base = new Uint8ClampedArray([100,110,120,255, 100,110,120,255, 100,110,120,255]);
    const generated = new Uint8ClampedArray([200,200,200,255, 200,200,200,255, 200,200,200,255]);
    const mask = new Uint8ClampedArray([255,255,255,255, 255,255,255,128, 255,255,255,0]);
    const patch = patchPixels(base, generated, mask);
    expect(patch[3]).toBe(0); expect(patch[7]).toBe(127); expect(patch[11]).toBe(255);
    // Outside the mask, compositing the patch gives exactly the original colour.
    expect(base[0] * (1 - patch[3] / 255) + patch[0] * patch[3] / 255).toBe(base[0]);
  });
  it("round-trips all stage state without losing legacy maps", () => {
    const atlas = world(), map = atlas.maps[0]; map.artwork = emptyArtwork(); map.artwork.assetId = "draft";
    map.artwork.pending = { assetId: "fine", kind: "fine", module: null, source: artSource(map) };
    expect(normalizeAtlas(atlas)?.maps[0].artwork).toMatchObject({ assetId: "draft", pending: { assetId: "fine" } });
  });
});
