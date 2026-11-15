import { beforeEach, describe, expect, it } from "vitest";
import { generateAtlasDraft } from "../ai/pipelines/atlas";
import { normalizeChapterMeta } from "../domain/normalize";
import { imageInRole, isImageOwner } from "../images/schema";
import { addDerivedImage, addUploadedImage, attachImage, detachImage, loadImageLibrary, setImageLink } from "../images/store";
import { createProject } from "../storage/projectStore";
import { installFakeHost, type FakeHost } from "../test/fakeHost";
import { blockRect, blockSize, paintBlock, paintCanvas, paintOverview, paintTokens, type TokenTarget } from "./canvas";
import { stubRaster } from "../test/raster";
import { applyAtlasOps, cellsOfMap } from "./operations";
import { emptyAtlas, type Atlas } from "./schema";
import { loadCurrentAtlas, saveAtlas } from "./store";
import { BUILTIN_STYLES } from "./styles";
import { buildAxis, eventPoint, interiorOf } from "./timeline";
import { characterOwner, tokenTargets } from "./tokens";

const style = BUILTIN_STYLES[0];
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

describe("image roles", () => {
  let projectId: string;
  beforeEach(async () => { installFakeHost(); projectId = (await createProject({ title: "图" })).id; });

  it("keeps one avatar per owner, with tags, a chapter and a note on the rest", async () => {
    expect(isImageOwner("character:林远")).toBe(true);
    expect(isImageOwner("item:item-1")).toBe(true);
    expect(isImageOwner("character:有 空格")).toBe(false);
    const owner = "character:林远";
    const first = await addDerivedImage(projectId, { base64: "UE5H", mime: "image/png", caption: "头像一", owner, link: { role: "avatar" } });
    const second = await addDerivedImage(projectId, { base64: "UE5H", mime: "image/png", caption: "头像二", owner, link: { role: "avatar" } });
    let library = await loadImageLibrary(projectId);
    expect(imageInRole(library.assets, owner, "avatar")?.id).toBe(second.id);
    expect(library.assets.find((asset) => asset.id === first.id)?.links[owner].role).toBe("other");

    await setImageLink(projectId, first.id, owner, { tags: ["少年时"], chapterId: "c1", note: "第一卷" });
    library = await loadImageLibrary(projectId);
    expect(library.assets.find((asset) => asset.id === first.id)?.links[owner]).toEqual({ role: "other", tags: ["少年时"], chapterId: "c1", note: "第一卷" });

    const upload = await addUploadedImage(projectId, { name: "a.png", base64: "UE5H", mime: "image/png", bytes: 3, owners: [] });
    await attachImage(projectId, upload.id, owner, { role: "base" });
    expect(imageInRole((await loadImageLibrary(projectId)).assets, owner, "base")?.id).toBe(upload.id);
    await detachImage(projectId, second.id, owner);
    library = await loadImageLibrary(projectId);
    expect(library.assets.find((asset) => asset.id === second.id)?.links[owner]).toBeUndefined();
    expect(imageInRole(library.assets, owner, "avatar")).toBeUndefined();
  });
});

describe("overview, blocks and tokens", () => {
  let host: FakeHost;
  let projectId: string;
  const raster = stubRaster();
  beforeEach(async () => {
    host = installFakeHost();
    projectId = (await createProject({ title: "层" })).id;
    await saveAtlas(projectId, world());
  });

  it("paints a child map's overview from its region in the parent", async () => {
    const parent = await loadCurrentAtlas(projectId) as Atlas;
    await paintOverview({ projectId, atlas: parent, mapId: parent.rootMapId, style, raster });
    const withChild = applyAtlasOps(await loadCurrentAtlas(projectId), [
      { type: "upsertMap", map: { id: "north-map", title: "北境详图", anchorRegion: "北境" } },
      { type: "upsertRegion", region: { name: "冰原", mapId: "north-map", center: [500, 350] } },
    ]).atlas;
    await saveAtlas(projectId, withChild);
    host.imageCalls.length = 0;
    await paintOverview({ projectId, atlas: withChild, mapId: "north-map", style, raster });
    expect(host.imageCalls[0].references).toHaveLength(2);
    expect(host.imageCalls[0].references?.[1]).toMatch(/ref-north-map-parent\.png$/);
    expect(host.imageCalls[0].prompt).toContain("上级地图里「北境」一带");
    const stored = await loadCurrentAtlas(projectId) as Atlas;
    expect(stored.maps.find((map) => map.id === "north-map")?.canvas?.overviewAssetId).toEqual(expect.any(String));
  });

  it("paints a block from the overview and the base, keeps versions, and drops it with its region", async () => {
    const atlas = await loadCurrentAtlas(projectId) as Atlas;
    await paintCanvas({ projectId, atlas, mapId: atlas.rootMapId, style, raster });
    const painted = await loadCurrentAtlas(projectId) as Atlas;
    const rect = blockRect(painted, painted.rootMapId, "forest");
    expect(rect).not.toBeNull();
    const size = blockSize(rect as NonNullable<typeof rect>);
    expect((size.width * size.height) % 256).toBe(0);
    host.imageCalls.length = 0;
    await paintBlock({ projectId, atlas: painted, mapId: painted.rootMapId, regionId: "forest", style, edge: "distinct", raster });
    const call = host.imageCalls[0];
    expect(call.size).toBe(`${size.width}x${size.height}`);
    expect(call.references?.map((path) => path.split("/").pop())).toEqual([`ref-${painted.rootMapId}-block-overview-forest.png`, `ref-${painted.rootMapId}-block-base-forest.png`, `ref-${painted.rootMapId}-block-sketch-forest.png`]);
    expect(call.prompt).toContain("按地区边界裁切");
    let stored = await loadCurrentAtlas(projectId) as Atlas;
    expect(stored.blocks).toEqual([expect.objectContaining({ regionId: "forest", edge: "distinct", versions: [] })]);
    const first = stored.blocks[0].assetId;
    await paintBlock({ projectId, atlas: stored, mapId: stored.rootMapId, regionId: "forest", style, edge: "blend", raster });
    expect(host.imageCalls[1].prompt).toContain("融为一体");
    stored = await loadCurrentAtlas(projectId) as Atlas;
    expect(stored.blocks).toHaveLength(1);
    expect(stored.blocks[0]).toMatchObject({ edge: "blend", versions: [first] });
    expect(applyAtlasOps(stored, [{ type: "removeRegion", id: "forest" }]).atlas.blocks).toHaveLength(0);
  });

  it("makes tokens from sheets, one by one or by cropping, and links them to their owners", async () => {
    const atlas = await loadCurrentAtlas(projectId) as Atlas;
    const places = tokenTargets({ atlas, project: null, assets: [], mapId: atlas.rootMapId, kind: "places" });
    expect(places.map((target) => target.name)).toEqual(["雪城", "南港"]);
    const many: TokenTarget[] = Array.from({ length: 10 }, (_, index) => ({ owner: `place:p${index}`, role: "icon", name: `地${index}`, description: "", point: [100, 100] }));
    const sheet = await paintTokens({ projectId, atlas, mapId: atlas.rootMapId, style, targets: many, method: "sheet", raster });
    expect(sheet.done).toHaveLength(10);
    expect(host.imageCalls).toHaveLength(2);
    expect(host.imageCalls.every((call) => call.size === "1536x1536" && call.background === "transparent")).toBe(true);
    let library = await loadImageLibrary(projectId);
    expect(imageInRole(library.assets, "place:p9", "icon")).toBeDefined();

    host.imageCalls.length = 0;
    const owner = characterOwner(null, "林远");
    await addDerivedImage(projectId, { base64: "UE5H", mime: "image/png", caption: "立绘", owner, link: { role: "base" } });
    const single = await paintTokens({ projectId, atlas, mapId: atlas.rootMapId, style, targets: [{ owner, role: "avatar", name: "林远", description: "少年剑客", point: null }], method: "single", raster });
    expect(single.done).toHaveLength(1);
    expect(host.imageCalls[0]).toMatchObject({ size: "1024x1024", background: "transparent" });
    expect(host.imageCalls[0].references).toHaveLength(1);
    expect(host.imageCalls[0].prompt).toContain("它的基础图");
    library = await loadImageLibrary(projectId);
    expect(imageInRole(library.assets, owner, "avatar")?.id).toBe(single.done[0].assetId);
    expect(tokenTargets({ atlas, project: null, assets: library.assets, mapId: atlas.rootMapId, kind: "characters", characters: [{ name: "林远", point: [1, 1] }] })).toEqual([]);

    host.imageCalls.length = 0;
    const noCanvas = await paintTokens({ projectId, atlas, mapId: atlas.rootMapId, style, targets: places, method: "crop", raster });
    expect(noCanvas.failed).toHaveLength(2);
    await paintOverview({ projectId, atlas, mapId: atlas.rootMapId, style, raster });
    host.imageCalls.length = 0;
    const cropped = await paintTokens({ projectId, atlas: await loadCurrentAtlas(projectId) as Atlas, mapId: atlas.rootMapId, style, targets: places, method: "crop", raster });
    expect(cropped.done).toHaveLength(2);
    expect(host.imageCalls).toHaveLength(0);
  });
});

describe("place interiors", () => {
  it("hang under their place, roll events up to it and go with it", () => {
    const { atlas, skipped } = applyAtlasOps(world(), [
      { type: "upsertMap", map: { id: "palace", title: "雪城·内部", anchorPlace: "雪城" } },
      { type: "upsertPlace", place: { id: "hall", name: "正殿", mapId: "palace", point: [500, 300] } },
      { type: "upsertEvent", event: { title: "殿上对峙", place: "正殿" } },
    ]);
    expect(skipped).toEqual([]);
    const palace = atlas.maps.find((map) => map.id === "palace");
    expect(palace).toMatchObject({ parentId: atlas.rootMapId, anchorPlaceId: "city", surround: "land" });
    expect(interiorOf(atlas, "city")?.id).toBe("palace");
    expect(applyAtlasOps(atlas, [{ type: "upsertMap", map: { title: "又一个", anchorPlace: "雪城" } }]).skipped[0]).toContain("已经有内部结构图");
    const spot = eventPoint(atlas, cellsOfMap(atlas, atlas.rootMapId), atlas.rootMapId, atlas.events[0]);
    expect(spot).toMatchObject({ key: "city", point: [300, 200] });
    const removed = applyAtlasOps(atlas, [{ type: "removePlace", id: "city" }]).atlas;
    expect(removed.maps.some((map) => map.id === "palace")).toBe(false);
    expect(removed.places.some((place) => place.id === "hall")).toBe(false);
  });

  it("are drawn from what the book says happens inside", async () => {
    const host = installFakeHost();
    const created = await createProject({ title: "殿", outline: "主角在雪城宫中查案。大纲足够长，可以作为材料来源之一。" });
    const book = { ...created, worldview: "雪城是北境王都。".repeat(8), chapters: [chapter("c1", 1024, created.volumes[0].id)] };
    await saveAtlas(book.id, applyAtlasOps(world(), [{ type: "upsertEvent", event: { title: "夜探冰牢", place: "雪城", chapter: 1 } }], { chapterIds: ["c1"] }).atlas);
    host.setModel((prompt) => {
      if (prompt.includes("内部画成一张平面结构图")) return JSON.stringify({ title: "雪城·内部", summary: "王宫", surround: "land", regions: [{ name: "外城", terrain: "city", center: [300, 400] }, { name: "王宫", terrain: "city", center: [700, 300] }], places: [{ name: "冰牢", region: "王宫", point: [720, 340] }, { name: "雪城", region: "外城", point: [300, 420] }], routes: [] });
      return "{}";
    });
    const result = await generateAtlasDraft({ project: book, memory: null, story: null, mode: "interior", placeId: "city" });
    expect(host.modelCalls.some((call) => JSON.stringify(call).includes("夜探冰牢"))).toBe(true);
    const interior = interiorOf(result.atlas, "city");
    expect(interior).not.toBeNull();
    expect(result.mapId).toBe(interior?.id);
    const inside = result.atlas.places.filter((place) => place.mapId === interior?.id);
    expect(inside.map((place) => place.name).sort()).toEqual(["冰牢", "雪城"]);
    // The room named like the city is a new record; the city itself stays on the world map.
    expect(result.atlas.places.find((place) => place.id === "city")?.mapId).toBe(result.atlas.rootMapId);
    expect(buildAxis(book, result.atlas).chapterCount).toBe(1);
  });
});
