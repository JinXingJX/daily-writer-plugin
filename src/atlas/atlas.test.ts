// Exercise domain behavior independently of task submission and finalization.
vi.mock("../worker/domainTask", () => ({ domainTask: () => null }));
import { vi, beforeEach, describe, expect, it } from "vitest";
import { generateAtlasDraft } from "../ai/pipelines/atlas";
import { ATLAS_TOOLS } from "../ai/agentTools/atlas";
import type { RunState, ToolEnv } from "../ai/agentTools/state";
import { normalizeChapterMeta } from "../domain/normalize";
import { createProject } from "../storage/projectStore";
import { installFakeHost, type FakeHost } from "../test/fakeHost";
import type { WriterProject } from "../types";
import type { ChapterCard } from "../memory/schema";
import type { MemoryView } from "../memory/view";
import { layoutSvg, pointInPolygon, polygonPath, regionCells, roughen, terrainGlyphs } from "./geometry";
import { applyAtlasOps, cellsOfMap } from "./operations";
import { ATLAS_HEIGHT, ATLAS_WIDTH, changedRecordIds, emptyAtlas, normalizeAtlas, normalizeRegion, normalizePlace, normalizeEvent, normalizeMoment, normalizeTerritory, pointValue, type Atlas, type Point } from "./schema";
import { adoptAtlasDraft, discardAtlasDraft, loadAtlas, loadAtlasDraft, loadCurrentAtlas, restorePreviousAtlas, saveAtlas, updateAtlasDraft } from "./store";
import { buildAxis, characterTrail, childMapOf, eventPoint, eventPosition, eventsUntil, mapTrail, ownerAt, pinsOn, placesOn } from "./timeline";

const region = (id: string, center: Point, patch: Record<string, unknown> = {}) => normalizeRegion({ id, mapId: "root", name: id, center, ...patch });

function chapter(id: string, rank: number, volumeId: string, words = 100) { return normalizeChapterMeta({ id, volumeId, title: id, rank, wordCount: words, contentHash: `h-${id}` }); }

function card(chapterId: string, location: string, summary: string): ChapterCard {
  return { chapterId, sourceHash: `h-${chapterId}`, version: 2, summary, scenes: [{ title: "场", time: "冬", location, characters: ["林远"], summary }], characters: [], entities: [], facts: [], threads: [], hook: "", emotionBeats: [], payoffs: [], changes: [], knowledge: [], intimacy: [], newCast: [], mentions: {}, extractedAt: 0 };
}

function memoryOf(cards: ChapterCard[]) {
  return { cards: new Map(cards.map((item) => [item.chapterId, item])), entities: [], aggregates: { worldview: null, volumes: [], arcs: [], book: null }, mentionCount: () => 0, openThreads: () => [] } as unknown as MemoryView;
}

/** One map, two regions, chapters c1..c3 plus one planned event. */
function sample(project: WriterProject): { atlas: Atlas; project: WriterProject } {
  const volumeId = project.volumes[0].id;
  const withChapters = { ...project, chapters: [chapter("c1", 1024, volumeId), chapter("c2", 2048, volumeId), chapter("c3", 3072, volumeId, 0)] };
  const atlas = emptyAtlas();
  atlas.maps[0].id = "root";
  atlas.rootMapId = "root";
  atlas.regions = [region("north", [300, 300], { owner: "北国" }), region("south", [700, 400])];
  atlas.places = [normalizePlace({ id: "a", mapId: "root", regionId: "north", name: "雪城", point: [300, 300], importance: 3 }), normalizePlace({ id: "b", mapId: "root", regionId: "south", name: "南港", point: [700, 400] })];
  atlas.moments = [normalizeMoment({ id: "future-1", phase: "future", rank: 1 })];
  atlas.events = [normalizeEvent({ id: "e1", title: "出发", placeId: "a", chapterId: "c1", characters: ["林远"] }), normalizeEvent({ id: "e2", title: "到港", placeId: "b", chapterId: "c2", characters: ["林远"] }), normalizeEvent({ id: "e3", title: "决战", placeId: "a", momentId: "future-1", characters: ["林远"] }), normalizeEvent({ id: "e4", title: "没日子的事", placeId: "a" })];
  atlas.territories = [normalizeTerritory({ id: "t1", regionId: "north", chapterId: "c2", owner: "南盟", note: "" })];
  return { atlas, project: withChapters };
}

describe("map geometry", () => {
  it("partitions a land map without gaps", () => {
    const regions = [region("a", [200, 200]), region("b", [800, 200]), region("c", [500, 600]), region("d", [500, 300])];
    const cells = regionCells(regions, "land");
    expect(cells.size).toBe(4);
    const total = [...cells.values()].reduce((sum, cell) => sum + cell.area, 0);
    expect(total).toBeCloseTo(ATLAS_WIDTH * ATLAS_HEIGHT, 0);
    for (const item of regions) expect(pointInPolygon(item.center, (cells.get(item.id) as { polygon: Point[] }).polygon)).toBe(true);
  });

  it("surrounds land with sea on a world map", () => {
    const cells = regionCells([region("a", [500, 350])], "sea");
    const cell = [...cells.values()][0];
    expect(cell.area).toBeLessThan(ATLAS_WIDTH * ATLAS_HEIGHT * 0.9);
    expect(cell.polygon.every(([x, y]) => x > 0 && y > 0 && x < ATLAS_WIDTH && y < ATLAS_HEIGHT)).toBe(true);
  });

  it("grows a region with its weight", () => {
    const even = regionCells([region("a", [300, 350]), region("b", [700, 350])], "land").get("a")?.area as number;
    const heavy = regionCells([region("a", [300, 350], { weight: 1.8 }), region("b", [700, 350])], "land").get("a")?.area as number;
    expect(heavy).toBeGreaterThan(even * 1.04);
  });

  it("bends shared borders identically for both neighbours", () => {
    const edge: Point[] = [[100, 100], [300, 180], [200, 400]];
    const reversed: Point[] = [[200, 400], [300, 180], [100, 100]];
    const forward = new Set(roughen(edge).map((point) => point.map((value) => value.toFixed(3)).join()));
    expect(roughen(reversed).every((point) => forward.has(point.map((value) => value.toFixed(3)).join()))).toBe(true);
  });

  it("is deterministic and tolerates duplicates or no regions", () => {
    const regions = [region("a", [200, 200], { terrain: "mountain" }), region("b", [800, 500], { terrain: "forest" })];
    const first = regionCells(regions, "sea");
    expect(polygonPath(first.get("a")?.polygon ?? [])).toBe(polygonPath(regionCells(regions, "sea").get("a")?.polygon ?? []));
    expect(terrainGlyphs(regions[0], first.get("a") as never)).toBe(terrainGlyphs(regions[0], regionCells(regions, "sea").get("a") as never));
    expect(terrainGlyphs(regions[0], first.get("a") as never)).not.toBe("");
    expect(regionCells([], "sea").size).toBe(0);
    expect(() => regionCells([region("a", [300, 300]), region("b", [300, 300])], "land")).not.toThrow();
  });

  it("renders a self-contained reference layout", () => {
    const regions = [region("a", [300, 300])];
    expect(layoutSvg(regions, regionCells(regions, "sea"), [{ name: "城", point: [300, 300], importance: 3 }], [])).toMatch(/^<svg xmlns=.*<circle/);
  });
});

describe("map normalization", () => {
  it("accepts both point shapes and keeps them on the map", () => {
    expect(pointValue([10, "20"])).toEqual([10, 20]);
    expect(pointValue({ x: -5, y: 9_999 })).toEqual([0, ATLAS_HEIGHT]);
    expect(pointValue("nope")).toBeNull();
  });

  it("repairs model output instead of failing on it", () => {
    const place = normalizePlace({ name: "x", kind: "spaceport", importance: 9 });
    expect(place).toMatchObject({ kind: "other", importance: 3 });
    expect(normalizeRegion({ weight: 50, terrain: "lava" })).toMatchObject({ weight: 2, terrain: "plains" });
    expect(normalizeAtlas({ maps: [] })).toBeNull();
    expect(normalizeAtlas({ maps: [{ id: "m" }], rootMapId: "gone" })?.rootMapId).toBe("m");
  });
});

describe("map timeline", () => {
  let project: WriterProject;
  beforeEach(async () => { installFakeHost(); project = await createProject({ title: "时间" }); });

  it("runs through chapters and then the planned events", () => {
    const { atlas, project: book } = sample(project);
    const axis = buildAxis(book, atlas);
    expect(axis.stops.map((stop) => stop.kind === "future")).toEqual([false, false, false, true]);
    expect(axis.writtenThrough).toBe(1);
    expect(eventPosition(axis, atlas.events[2])).toBe(3);
    expect(eventPosition(axis, atlas.events[3])).toBe(-1);
  });

  it("reveals events and territory changes as the cursor moves", () => {
    const { atlas, project: book } = sample(project);
    const axis = buildAxis(book, atlas);
    expect(eventsUntil(atlas, axis, 0, null).map((event) => event.id)).toEqual(["e1"]);
    expect(eventsUntil(atlas, axis, 3, null).map((event) => event.id)).toEqual(["e1", "e2", "e3"]);
    expect(eventsUntil(atlas, axis, 1, 1).map((event) => event.id)).toEqual(["e2"]);
    expect(ownerAt(atlas, axis, atlas.regions[0], 0)).toBe("北国");
    expect(ownerAt(atlas, axis, atlas.regions[0], 1)).toBe("南盟");
  });

  it("traces a character and collapses repeat stays", () => {
    const { atlas, project: book } = sample(project);
    atlas.events.push(normalizeEvent({ id: "e5", title: "又在港口", placeId: "b", chapterId: "c2", characters: ["林远"] }));
    const axis = buildAxis(book, atlas);
    const trail = characterTrail(atlas, axis, cellsOfMap(atlas, "root"), "root", "林远", 1);
    expect(trail.map((step) => step.point)).toEqual([[300, 300], [700, 400]]);
    expect(characterTrail(atlas, axis, cellsOfMap(atlas, "root"), "root", "无名", 3)).toEqual([]);
  });

  it("rolls detail-map events up to the parent map", () => {
    const { atlas } = sample(project);
    atlas.maps.push({ ...atlas.maps[0], id: "child", parentId: "root", anchorRegionId: "north", title: "北地" });
    const cells = cellsOfMap(atlas, "root");
    const place = atlas.places[0];
    place.mapId = "child";
    place.parentPoint = null;
    const event = atlas.events[0];
    expect(eventPoint(atlas, cells, "root", event)).toMatchObject({ key: "north", region: { id: "north" } });
    expect(eventPoint(atlas, cellsOfMap(atlas, "child"), "child", event)).toMatchObject({ key: "a", point: place.point });
    place.parentPoint = [111, 222];
    expect(eventPoint(atlas, cells, "root", event)).toMatchObject({ point: [111, 222] });
    expect(placesOn(atlas, "root").find((item) => item.place.id === "a")).toMatchObject({ point: [111, 222], foreign: true });
    expect(mapTrail(atlas, "child").map((map) => map.id)).toEqual(["root", "child"]);
    expect(childMapOf(atlas, "north")?.id).toBe("child");
  });

  it("groups events into one pin per spot", () => {
    const { atlas } = sample(project);
    const pins = pinsOn(atlas, cellsOfMap(atlas, "root"), "root", [atlas.events[0], atlas.events[2], atlas.events[1]]);
    expect(pins.map((pin) => pin.events.length).sort()).toEqual([1, 2]);
  });
});

describe("map operations", () => {
  it("resolves names and reports what it could not apply", () => {
    const base = emptyAtlas();
    const { atlas, applied, skipped } = applyAtlasOps(base, [
      { type: "upsertRegion", region: { name: "北境", center: [300, 300] } },
      { type: "upsertPlace", place: { name: "雪城", region: "北境", kind: "capital" } },
      { type: "upsertPlace", place: { name: "冰港", region: "北境", point: [350, 340] } },
      { type: "upsertRoute", route: { name: "冰道", kind: "road", via: ["雪城", "冰港"] } },
      { type: "upsertRoute", route: { name: "断路", via: ["雪城"] } },
      { type: "upsertEvent", event: { title: "围城", place: "雪城", chapterId: "c1" } },
      { type: "upsertTerritory", territory: { region: "无此地", owner: "x" } },
      { type: "nonsense" },
    ]);
    expect(applied).toBe(5);
    expect(skipped).toHaveLength(3);
    const city = atlas.places.find((place) => place.name === "雪城");
    expect(city?.regionId).toBe(atlas.regions[0].id);
    expect(atlas.events[0].placeId).toBe(city?.id);
    expect(atlas.routes[0].points).toHaveLength(2);
    expect(pointInPolygon(city?.point as Point, cellsOfMap(atlas, atlas.rootMapId).get(atlas.regions[0].id)?.polygon as Point[])).toBe(true);
    expect(base.regions).toHaveLength(0);
  });

  it("merges partial updates and cleans up removals", () => {
    const first = applyAtlasOps(emptyAtlas(), [{ type: "upsertRegion", region: { id: "r", name: "甲", center: [200, 200], owner: "王" } }, { type: "upsertPlace", place: { id: "p", name: "城", region: "r", point: [200, 200] } }, { type: "upsertEvent", event: { id: "e", title: "事", place: "城", chapterId: "c" } }]).atlas;
    const patched = applyAtlasOps(first, [{ type: "upsertRegion", region: { id: "r", summary: "新概况" } }]).atlas;
    expect(patched.regions[0]).toMatchObject({ name: "甲", owner: "王", summary: "新概况", center: [200, 200] });
    const removed = applyAtlasOps(patched, [{ type: "removePlace", id: "p" }]).atlas;
    expect(removed.events[0].placeId).toBeNull();
    const child = applyAtlasOps(patched, [{ type: "upsertMap", map: { id: "c", anchorRegionId: "r", title: "分块" } }, { type: "upsertRegion", region: { id: "inner", mapId: "c", name: "内", center: [100, 100] } }, { type: "removeRegion", id: "r" }]).atlas;
    expect(child.maps).toHaveLength(1);
    expect(child.regions).toHaveLength(0);
    expect(applyAtlasOps(patched, [{ type: "removeMap", id: patched.rootMapId }]).skipped).toHaveLength(1);
  });
});

describe("map drafts", () => {
  let projectId: string;
  beforeEach(async () => { installFakeHost(); projectId = (await createProject({ title: "稿" })).id; });

  it("leaves the adopted map alone until the draft is adopted", async () => {
    await saveAtlas(projectId, applyAtlasOps(emptyAtlas(), [{ type: "upsertRegion", region: { id: "r", name: "旧", center: [200, 200] } }]).atlas);
    await updateAtlasDraft(projectId, [{ type: "upsertRegion", region: { id: "r", name: "新" } }, { type: "upsertRegion", region: { id: "n", name: "加", center: [700, 500] } }]);
    expect((await loadAtlas(projectId))?.regions[0].name).toBe("旧");
    expect((await loadCurrentAtlas(projectId))?.regions[0].name).toBe("新");
    expect([...changedRecordIds(await loadAtlas(projectId) as Atlas, await loadAtlasDraft(projectId) as Atlas)].sort()).toEqual(["n", "r"]);
    await discardAtlasDraft(projectId);
    expect(await loadAtlasDraft(projectId)).toBeNull();
    await updateAtlasDraft(projectId, [{ type: "upsertRegion", region: { id: "r", name: "新" } }]);
    await adoptAtlasDraft(projectId);
    expect((await loadAtlas(projectId))?.regions[0].name).toBe("新");
    expect(await restorePreviousAtlas(projectId)).toBe(true);
    expect((await loadAtlas(projectId))?.regions[0].name).toBe("旧");
    expect(await restorePreviousAtlas(projectId)).toBe(false);
  });
});

describe("map generation", () => {
  let host: FakeHost;
  let project: WriterProject;
  const GEOGRAPHY = { title: "九州", summary: "总览", surround: "sea", regions: [{ name: "北境", terrain: "tundra", center: [300, 200], owner: "北国", summary: "雪" }, { name: "南海", terrain: "plains", center: [650, 480], summary: "暖" }], places: [{ name: "雪城", region: "北境", kind: "capital", point: [300, 210], importance: 3 }, { name: "南港", region: "南海", kind: "port", importance: 2 }], routes: [{ name: "官道", kind: "road", via: ["雪城", "南港"] }] };
  const replies = (prompt: string, events: unknown) => {
    if (prompt.includes("设计这本书的世界全图")) return JSON.stringify(GEOGRAPHY);
    if (prompt.includes("分块") || prompt.includes("放大成一张详情图")) return JSON.stringify({ title: "北境详图", summary: "细", surround: "land", regions: [{ name: "内城", terrain: "city", center: [400, 300] }, { name: "外郭", terrain: "plains", center: [700, 400] }], places: [{ name: "雪城", region: "内城", kind: "capital", point: [420, 320], importance: 3 }, { name: "钟楼", region: "内城", kind: "landmark", point: [380, 280] }], routes: [] });
    if (prompt.includes("值得标在地图上的事件")) return JSON.stringify(events);
    if (prompt.includes("还没写到")) return JSON.stringify({ future: [{ order: 1, title: "决战雪城", place: "雪城", kind: "battle", characters: ["林远"] }] });
    return "{}";
  };
  beforeEach(async () => {
    host = installFakeHost();
    const created = await createProject({ title: "九州传", outline: "主角从北境南下，最终回到雪城决战。这段大纲足够长，能作为生成地图的材料来源之一。" });
    const volumeId = created.volumes[0].id;
    project = { ...created, worldview: "世界分北境与南海。".repeat(5), chapters: [chapter("c1", 1024, volumeId), chapter("c2", 2048, volumeId)] };
    host.setModel((prompt) => replies(prompt, { events: [{ chapter: 1, title: "雪夜出城", place: "雪城", kind: "travel", characters: ["林远"], summary: "他走了", time: "初冬" }, { chapter: 2, title: "新港风波", place: "新港", kind: "politics", characters: ["林远"] }, { chapter: 99, title: "幻觉章节", place: "雪城" }], newPlaces: [{ name: "新港", region: "南海", kind: "port" }], territory: [{ region: "北境", chapter: 2, owner: "南盟", note: "易主" }] }));
  });
  const memory = () => memoryOf([card("c1", "雪城", "出城"), card("c2", "新港", "风波")]);

  it("draws geography, events and what is still planned into a draft", async () => {
    const result = await generateAtlasDraft({ project, memory: memory(), story: null, mode: "full" });
    expect(await loadAtlas(project.id)).toBeNull();
    const atlas = await loadAtlasDraft(project.id) as Atlas;
    expect(atlas.maps[0].title).toBe("九州");
    expect(atlas.regions.map((region) => region.name)).toEqual(["北境", "南海"]);
    expect(atlas.routes).toHaveLength(1);
    expect(atlas.places.map((place) => place.name).sort()).toEqual(["南港", "新港", "雪城"].sort());
    const cells = cellsOfMap(atlas, atlas.rootMapId);
    const port = atlas.places.find((place) => place.name === "南港");
    expect(pointInPolygon(port?.point as Point, cells.get(port?.regionId as string)?.polygon as Point[])).toBe(true);
    expect(atlas.events.find((event) => event.title === "雪夜出城")).toMatchObject({ chapterId: "c1", storyTime: "初冬", kind: "travel" });
    expect(atlas.events.find((event) => event.title === "新港风波")?.placeId).toBe(atlas.places.find((place) => place.name === "新港")?.id);
    expect(atlas.events.some((event) => event.title === "幻觉章节")).toBe(false);
    expect(atlas.events.find((event) => event.title === "决战雪城")).toMatchObject({ chapterId: null, momentId: expect.any(String) });
    expect(atlas.territories[0]).toMatchObject({ owner: "南盟", chapterId: "c2" });
    expect(atlas.coverage).toEqual({ c1: "h-c1", c2: "h-c2" });
    expect(result.warnings).toEqual([]);
  });

  it("refuses to invent a world from nothing", async () => {
    await expect(generateAtlasDraft({ project: { ...project, worldview: "", outline: "", background: "" }, memory: null, story: null, mode: "full" })).rejects.toThrow("材料太少");
    expect(host.modelCalls).toHaveLength(0);
  });

  it("reports chapters it could not read and keeps the rest", async () => {
    host.setModel((prompt) => { if (prompt.includes("值得标在地图上的事件")) throw new Error("boom"); return replies(prompt, {}); });
    const result = await generateAtlasDraft({ project, memory: memory(), story: null, mode: "full" });
    expect(result.warnings[0]).toContain("没有读出来");
    expect(result.atlas.regions).toHaveLength(2);
  });

  it("sync reads only chapters that are new or changed", async () => {
    await generateAtlasDraft({ project, memory: memory(), story: null, mode: "full" });
    host.modelCalls.length = 0;
    await generateAtlasDraft({ project, memory: memory(), story: null, mode: "sync" });
    expect(host.modelCalls.filter((call) => call.prompt.includes("值得标在地图上的事件"))).toHaveLength(0);
    const changed = { ...card("c2", "雪城", "改了"), sourceHash: "h-new" };
    await generateAtlasDraft({ project, memory: memoryOf([card("c1", "雪城", "出城"), changed]), story: null, mode: "sync" });
    const reads = host.modelCalls.filter((call) => call.prompt.includes("值得标在地图上的事件"));
    expect(reads).toHaveLength(1);
    expect(reads[0].prompt).toContain("第2章");
    expect(reads[0].prompt).not.toContain("第1章");
    const atlas = await loadAtlasDraft(project.id) as Atlas;
    expect(atlas.events.filter((event) => event.chapterId === "c1")).toHaveLength(1);
    expect(atlas.events.filter((event) => event.title === "决战雪城")).toHaveLength(1);
    expect(atlas.coverage.c2).toBe("h-new");
  });

  it("detail moves named places into the child map and remembers where they were", async () => {
    const full = await generateAtlasDraft({ project, memory: memory(), story: null, mode: "full" });
    const north = full.atlas.regions.find((region) => region.name === "北境");
    const city = full.atlas.places.find((place) => place.name === "雪城");
    const result = await generateAtlasDraft({ project, memory: memory(), story: null, mode: "detail", regionId: north?.id });
    const child = result.atlas.maps.find((map) => map.anchorRegionId === north?.id);
    expect(child).toMatchObject({ parentId: result.atlas.rootMapId, title: "北境详图", surround: "land" });
    const moved = result.atlas.places.find((place) => place.id === city?.id);
    expect(moved).toMatchObject({ mapId: child?.id, point: [420, 320], parentPoint: city?.point });
    const event = result.atlas.events.find((item) => item.title === "雪夜出城");
    expect(event?.placeId).toBe(city?.id);
    expect(placesOn(result.atlas, result.atlas.rootMapId).some((item) => item.place.id === city?.id)).toBe(true);
  });

  it("is available to the assistant", async () => {
    const state = { projectId: project.id, draft: project } as RunState;
    const env = (input: Record<string, unknown>): ToolEnv => ({ state, input, memory: memory() });
    expect((await ATLAS_TOOLS["writer.readAtlas"](env({}))).observation).toContain("还没有世界地图");
    expect((await ATLAS_TOOLS["writer.generateAtlas"](env({ mode: "full" }))).observation).toContain("草稿");
    const atlas = await loadCurrentAtlas(project.id) as Atlas;
    expect((await ATLAS_TOOLS["writer.readAtlas"](env({ mapId: atlas.rootMapId }))).observation).toContain("雪城");
    expect((await ATLAS_TOOLS["writer.updateAtlas"](env({ operations: [{ type: "upsertPlace", place: { name: "鹿鸣驿", region: "南海", kind: "town" } }] }))).observation).toContain("1 项");
    expect((await loadCurrentAtlas(project.id))?.places.some((place) => place.name === "鹿鸣驿")).toBe(true);
    await expect(ATLAS_TOOLS["writer.generateAtlas"](env({ mode: "detail", region: "无此地" }))).rejects.toThrow("没有地区");
  });
});
