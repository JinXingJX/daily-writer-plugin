// Exercise domain behavior independently of task submission and finalization.
vi.mock("../worker/domainTask", () => ({ domainTask: () => null }));
import { vi, beforeEach, describe, expect, it } from "vitest";
import { generateAtlasDraft } from "../ai/pipelines/atlas";
import { normalizeChapterMeta } from "../domain/normalize";
import { imageFilePath, loadImageLibrary } from "../images/store";
import type { ChapterCard } from "../memory/schema";
import type { MemoryView } from "../memory/view";
import { createProject } from "../storage/projectStore";
import { installFakeHost, type FakeHost } from "../test/fakeHost";
import type { WriterProject } from "../types";
import { neighbours, OVERVIEW_SIZE, paintCanvas, paintOrder, tileCore, tileRect, TILE_SIZE, variantContext } from "./canvas";
import { stubRaster } from "../test/raster";
import { cellsOfMap, applyAtlasOps } from "./operations";
import { ATLAS_HEIGHT, ATLAS_WIDTH, emptyAtlas, type Atlas } from "./schema";
import { loadCurrentAtlas, saveAtlas, saveAtlasDraft } from "./store";
import { BUILTIN_STYLES, createStyle, deleteStyle, findStyle, loadStyleLibrary, resetBuiltinStyle, restoreHiddenStyles, saveStyle, setDefaultStyle, stylePrompt } from "./styles";
import { buildAxis, characterSpots, itemStopAt, terrainAt, tileAssetAt } from "./timeline";

const chapter = (id: string, rank: number, volumeId: string) => normalizeChapterMeta({ id, volumeId, title: id, rank, wordCount: 100, contentHash: `h-${id}` });

function world(): Atlas {
  return applyAtlasOps(emptyAtlas(), [
    { type: "upsertRegion", region: { id: "north", name: "北境", terrain: "tundra", center: [300, 200] } },
    { type: "upsertRegion", region: { id: "forest", name: "林海", terrain: "forest", center: [700, 220] } },
    { type: "upsertRegion", region: { id: "south", name: "南海", center: [500, 520] } },
    { type: "upsertPlace", place: { id: "city", name: "雪城", region: "北境", point: [300, 200], importance: 3 } },
    { type: "upsertPlace", place: { id: "port", name: "南港", region: "南海", point: [500, 520] } },
  ]).atlas;
}

describe("scroll tiles", () => {
  it("cover the map, overlap their neighbours and paint from the centre out", () => {
    const area = Array.from({ length: 12 }, (_, index) => tileCore(4, 3, index)).reduce((sum, rect) => sum + rect.w * rect.h, 0);
    expect(area).toBeCloseTo(ATLAS_WIDTH * ATLAS_HEIGHT);
    const left = tileRect(4, 3, 5);
    const right = tileRect(4, 3, 6);
    expect(left.x + left.w).toBeGreaterThan(right.x);
    const order = paintOrder(4, 3);
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect([5, 6]).toContain(order[0]);
    expect([0, 3, 8, 11]).toContain(order[11]);
    expect(neighbours(4, 3, 0).map((item) => item.side)).toEqual(["right", "bottom"]);
    expect(neighbours(4, 3, 5).map((item) => item.index)).toEqual([4, 1, 6, 9]);
    expect(TILE_SIZE.width % 16 + TILE_SIZE.height % 16).toBe(0);
    expect(TILE_SIZE.width * TILE_SIZE.height).toBeGreaterThanOrEqual(655_360);
  });
});

describe("style library", () => {
  let projectId: string;
  beforeEach(async () => { installFakeHost(); projectId = (await createProject({ title: "风格" })).id; });

  it("ships eleven presets whose prompts describe the look without naming any title", async () => {
    expect(BUILTIN_STYLES).toHaveLength(11);
    for (const style of BUILTIN_STYLES) {
      expect(style.prompt.length).toBeGreaterThan(60);
      expect(style.prompt).not.toMatch(/影之刃|剑网|剑侠情缘|原神|艾尔登|法环|赛博朋克|2077|Elden|Genshin|Cyberpunk/i);
    }
    expect(stylePrompt(BUILTIN_STYLES[6])).toContain("不要任何文字");
    expect((await loadStyleLibrary(projectId)).styles).toHaveLength(11);
  });

  it("creates, edits, resets, hides and restores styles", async () => {
    const own = await createStyle(projectId);
    await saveStyle(projectId, { ...own, name: "我的风格", prompt: "铅笔素描" });
    let library = await loadStyleLibrary(projectId);
    expect(library.styles.at(-1)).toMatchObject({ name: "我的风格", prompt: "铅笔素描", builtin: false });

    await saveStyle(projectId, { ...BUILTIN_STYLES[0], prompt: "改过的水墨" });
    expect((await loadStyleLibrary(projectId)).styles[0].prompt).toBe("改过的水墨");
    await resetBuiltinStyle(projectId, BUILTIN_STYLES[0].id);
    expect((await loadStyleLibrary(projectId)).styles[0].prompt).toBe(BUILTIN_STYLES[0].prompt);

    await setDefaultStyle(projectId, "neon-city");
    await deleteStyle(projectId, "neon-city");
    library = await loadStyleLibrary(projectId);
    expect(library.styles.some((style) => style.id === "neon-city")).toBe(false);
    expect(library.defaultId).not.toBe("neon-city");
    await restoreHiddenStyles(projectId);
    expect((await loadStyleLibrary(projectId)).styles.some((style) => style.id === "neon-city")).toBe(true);

    await deleteStyle(projectId, own.id);
    expect((await loadStyleLibrary(projectId)).styles.some((style) => style.id === own.id)).toBe(false);
    expect(findStyle(library, "nope").id).toBe(library.defaultId);
  });
});

describe("painting a scroll", () => {
  let host: FakeHost;
  let projectId: string;
  let project: WriterProject;
  const raster = stubRaster();
  beforeEach(async () => {
    host = installFakeHost();
    const created = await createProject({ title: "画卷" });
    project = { ...created, chapters: [chapter("c1", 1024, created.volumes[0].id), chapter("c2", 2048, created.volumes[0].id)] };
    projectId = created.id;
    await saveAtlas(projectId, world());
  });

  it("paints every tile, each with its sketch and the painted tiles beside it", async () => {
    const atlas = await loadCurrentAtlas(projectId) as Atlas;
    const states: string[] = [];
    const style = BUILTIN_STYLES.find((item) => item.id === "golden-dusk") ?? BUILTIN_STYLES[0];
    const result = await paintCanvas({ projectId, atlas, mapId: atlas.rootMapId, style, raster, onTile: (index, state) => states.push(`${index}:${state}`) });
    expect(result.overview).toBe(true);
    expect(result.done).toHaveLength(12);
    expect(host.imageCalls).toHaveLength(13);
    const [overview, ...tiles] = host.imageCalls;
    expect(overview.size).toBe(`${OVERVIEW_SIZE.width}x${OVERVIEW_SIZE.height}`);
    expect(overview.references).toHaveLength(1);
    expect(overview.references?.[0]).toMatch(/overview-sketch\.png$/);
    expect(overview.prompt).toContain(style.prompt);
    expect(overview.prompt).toContain("聚落与地标：雪城");
    expect(tiles.every((call) => call.size === "1040x976")).toBe(true);
    expect(tiles.every((call) => call.references?.[0]?.match(/overview-\d+\.png$/))).toBe(true);
    expect(tiles.every((call) => call.prompt.includes("整幅总图里这一块的样子"))).toBe(true);
    expect(tiles.slice(1).some((call) => call.prompt.includes("相邻块"))).toBe(true);
    expect(states[0]).toMatch(/:drawing$/);
    const stored = await loadCurrentAtlas(projectId) as Atlas;
    const canvas = stored.maps[0].canvas;
    expect(canvas?.styleId).toBe(style.id);
    expect(canvas?.tiles.every((tile) => tile.assetId)).toBe(true);
    expect(canvas?.overviewAssetId).toEqual(expect.any(String));
    expect(atlas.maps[0].canvas).toBeNull();
    const library = await loadImageLibrary(projectId);
    expect(library.assets.filter((asset) => asset.owners.includes(`map:${stored.rootMapId}`))).toHaveLength(13);
  });

  it("keeps going past a failed tile, records the error and keeps earlier versions on a redraw", async () => {
    const atlas = await loadCurrentAtlas(projectId) as Atlas;
    let calls = 0;
    host.setImage(() => { calls += 1; if (calls === 3) throw new Error("OpenAI HTTP 500 (server_error): boom."); });
    const first = await paintCanvas({ projectId, atlas, mapId: atlas.rootMapId, style: BUILTIN_STYLES[0], raster });
    expect(first.failed).toHaveLength(1);
    expect(first.done).toHaveLength(11);
    let stored = await loadCurrentAtlas(projectId) as Atlas;
    const failedIndex = first.failed[0].index;
    expect(stored.maps[0].canvas?.tiles[failedIndex]).toMatchObject({ assetId: null, error: expect.stringContaining("boom") });

    host.setImage(() => undefined);
    const before = stored.maps[0].canvas?.tiles[5].assetId;
    await paintCanvas({ projectId, atlas: stored, mapId: stored.rootMapId, style: BUILTIN_STYLES[0], tiles: [5, failedIndex], raster });
    stored = await loadCurrentAtlas(projectId) as Atlas;
    expect(stored.maps[0].canvas?.tiles[5].versions).toEqual([before]);
    expect(stored.maps[0].canvas?.tiles[failedIndex]).toMatchObject({ error: "", assetId: expect.any(String) });
  });

  it("stops at once when the account cannot pay", async () => {
    const atlas = await loadCurrentAtlas(projectId) as Atlas;
    host.setImage(() => { throw new Error("OpenAI HTTP 429 (insufficient_quota): no credit."); });
    await expect(paintCanvas({ projectId, atlas, mapId: atlas.rootMapId, style: BUILTIN_STYLES[0], raster })).rejects.toThrow("insufficient_quota");
    expect(host.imageCalls).toHaveLength(1);
    host.imageCalls.length = 0;
    const tilesOnly = await paintCanvas({ projectId, atlas, mapId: atlas.rootMapId, style: BUILTIN_STYLES[0], raster, withOverview: false });
    expect(tilesOnly.failed).toHaveLength(1);
    expect(host.imageCalls).toHaveLength(1);
  });

  it("refuses a map without regions", async () => {
    const atlas = emptyAtlas();
    await expect(paintCanvas({ projectId, atlas, mapId: atlas.rootMapId, style: BUILTIN_STYLES[0], raster })).rejects.toThrow("还没有地区");
  });

  it("paints a variant that takes over from its moment, describing the terrain then", async () => {
    let atlas = await loadCurrentAtlas(projectId) as Atlas;
    await paintCanvas({ projectId, atlas, mapId: atlas.rootMapId, style: BUILTIN_STYLES[0], raster });
    await saveAtlas(projectId, applyAtlasOps(await loadCurrentAtlas(projectId), [{ type: "upsertTerrainChange", change: { region: "林海", chapter: 2, terrain: "wasteland", note: "大火焚林" } }], { chapterIds: ["c1", "c2"] }).atlas);
    atlas = await loadCurrentAtlas(projectId) as Atlas;
    const axis = buildAxis(project, atlas);
    const forestTile = 2;
    expect(variantContext(atlas, axis, atlas.rootMapId, forestTile, 0).changed).toBe(false);
    const context = variantContext(atlas, axis, atlas.rootMapId, forestTile, 1);
    expect(context.changed).toBe(true);
    expect(context.note).toContain("大火焚林");
    host.imageCalls.length = 0;
    await paintCanvas({ projectId, atlas, mapId: atlas.rootMapId, style: BUILTIN_STYLES[0], tiles: [forestTile], variant: { chapterId: "c2", momentId: null, label: "第 2 章", terrain: context.terrain, note: context.note }, raster });
    expect(host.imageCalls[0].prompt).toContain("【此刻的变化】");
    expect(host.imageCalls[0].prompt).toContain("废土");
    const stored = await loadCurrentAtlas(projectId) as Atlas;
    const tile = stored.maps[0].canvas?.tiles[forestTile];
    expect(stored.variants).toHaveLength(1);
    expect(tile?.versions).toEqual([]);
    expect(tileAssetAt(stored, axis, stored.rootMapId, tile as never, 0)).toMatchObject({ assetId: tile?.assetId, variant: null });
    expect(tileAssetAt(stored, axis, stored.rootMapId, tile as never, 1).assetId).toBe(stored.variants[0].assetId);
    expect(host.imageCalls[0].references).toContain(imageFilePath(projectId, (await loadImageLibrary(projectId)).assets.find((asset) => asset.id === stored.maps[0].canvas?.tiles[1].assetId) as never));
  });
});

describe("items and terrain over time", () => {
  let project: WriterProject;
  beforeEach(async () => {
    installFakeHost();
    const created = await createProject({ title: "物" });
    const volumeId = created.volumes[0].id;
    project = { ...created, chapters: ["c1", "c2", "c3"].map((id, index) => chapter(id, (index + 1) * 1024, volumeId)) };
  });

  it("follow their stops and changes along the axis", () => {
    const context = { chapterIds: ["c1", "c2", "c3"] };
    const { atlas, skipped } = applyAtlasOps(world(), [
      { type: "upsertEvent", event: { title: "出城", place: "雪城", chapter: 1, characters: ["林远"] } },
      { type: "upsertEvent", event: { title: "到港", place: "南港", chapter: 3, characters: ["林远"] } },
      { type: "upsertItem", item: { name: "玄冰剑", stops: [{ chapter: 1, holder: "林远" }, { chapter: 2, place: "南港" }] } },
      { type: "upsertItem", item: { name: "幻影", stops: [{ chapter: 1, place: "无此地" }] } },
      { type: "upsertTerrainChange", change: { region: "林海", chapter: 2, terrain: "wasteland", note: "焚林" } },
    ], context);
    expect(skipped).toEqual(["地图上没有「无此地」。"]);
    const axis = buildAxis(project, atlas);
    const sword = atlas.items[0];
    expect(itemStopAt(axis, sword, 0)).toMatchObject({ holder: "林远", placeId: null });
    expect(itemStopAt(axis, sword, 2)).toMatchObject({ placeId: "port" });
    const forest = atlas.regions.find((region) => region.id === "forest") as Atlas["regions"][number];
    expect(terrainAt(atlas, axis, forest, 0)).toBe("forest");
    expect(terrainAt(atlas, axis, forest, 1)).toBe("wasteland");
    const cells = cellsOfMap(atlas, atlas.rootMapId);
    expect(characterSpots(atlas, axis, cells, atlas.rootMapId, 0, ["林远"])[0].point).toEqual([300, 200]);
    expect(characterSpots(atlas, axis, cells, atlas.rootMapId, 2, ["林远"])[0].point).toEqual([500, 520]);
    const cleaned = applyAtlasOps(atlas, [{ type: "removePlace", id: "port" }, { type: "removeRegion", id: "forest" }]).atlas;
    expect(cleaned.items[0].stops[1].placeId).toBeNull();
    expect(cleaned.terrainChanges).toHaveLength(0);
  });

  it("are read from chapters, and the author's survive a re-read", async () => {
    const host = installFakeHost();
    const created = await createProject({ title: "读", outline: "主角从北境南下。大纲足够长，可以作为材料来源之一。" });
    const volumeId = created.volumes[0].id;
    const book = { ...created, worldview: "北境与南海。".repeat(8), chapters: [chapter("c1", 1024, volumeId), chapter("c2", 2048, volumeId)] };
    host.setModel((prompt) => {
      if (prompt.includes("世界全图")) return JSON.stringify({ title: "图", summary: "", surround: "sea", regions: [{ name: "北境", center: [300, 200] }, { name: "林海", terrain: "forest", center: [700, 220] }], places: [{ name: "雪城", region: "北境", point: [300, 200] }], routes: [] });
      if (prompt.includes("值得标在地图上的事件")) return JSON.stringify({ events: [], items: [{ name: "玄冰剑", chapter: 1, holder: "林远" }, { name: "玄冰剑", chapter: 2, place: "雪城" }], terrain: [{ region: "林海", chapter: 2, terrain: "wasteland", note: "大火" }, { region: "林海", chapter: 9, terrain: "lake" }] });
      return "{}";
    });
    const card = (id: string): ChapterCard => ({ chapterId: id, sourceHash: `h-${id}`, version: 2, summary: "s", scenes: [], characters: [], entities: [], facts: [], threads: [], hook: "", emotionBeats: [], payoffs: [], changes: [], knowledge: [], intimacy: [], newCast: [], mentions: {}, extractedAt: 0 });
    const memory = { cards: new Map([["c1", card("c1")], ["c2", card("c2")]]), entities: [], aggregates: { worldview: null, volumes: [], arcs: [], book: null }, mentionCount: () => 0, openThreads: () => [] } as unknown as MemoryView;
    const { atlas, warnings } = await generateAtlasDraft({ project: book, memory, story: null, mode: "full" });
    expect(warnings).toEqual([]);
    expect(atlas.items).toHaveLength(1);
    expect(atlas.items[0].stops.map((stop) => [stop.chapterId, stop.holder || stop.placeId])).toEqual([["c1", "林远"], ["c2", atlas.places[0].id]]);
    expect(atlas.terrainChanges).toHaveLength(1);
    expect(atlas.terrainChanges[0]).toMatchObject({ chapterId: "c2", terrain: "wasteland", origin: "extracted" });
    const edited = applyAtlasOps(atlas, [{ type: "upsertTerrainChange", change: { region: "林海", chapter: 1, terrain: "marsh", note: "我改的" } }], { chapterIds: ["c1", "c2"] }).atlas;
    await saveAtlasDraft(book.id, edited);
    const again = await generateAtlasDraft({ project: book, memory, story: null, mode: "full" });
    expect(again.atlas.terrainChanges.filter((change) => change.origin === "user")).toHaveLength(1);
    expect(again.atlas.terrainChanges.filter((change) => change.origin === "extracted")).toHaveLength(1);
    expect(again.atlas.items[0].stops).toHaveLength(2);
  });
});
