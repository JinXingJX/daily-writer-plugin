// Exercise domain behavior independently of task submission and finalization.
vi.mock("../worker/domainTask", () => ({ domainTask: () => null }));
import { vi, beforeEach, describe, expect, it } from "vitest";
import { ATLAS_TOOLS } from "../ai/agentTools/atlas";
import type { RunState, ToolEnv } from "../ai/agentTools/state";
import { generateAtlasDraft } from "../ai/pipelines/atlas";
import { normalizeChapterMeta } from "../domain/normalize";
import { generateImages } from "../images/generate";
import { imageFilePath, loadImageLibrary } from "../images/store";
import type { ChapterCard } from "../memory/schema";
import type { MemoryView } from "../memory/view";
import { createProject } from "../storage/projectStore";
import { installFakeHost, type FakeHost } from "../test/fakeHost";
import type { WriterProject } from "../types";
import { applyAtlasOps } from "./operations";
import { emptyAtlas, normalizeAtlas, type Atlas } from "./schema";
import { editCurrentAtlas, loadAtlas, loadAtlasDraft, loadCurrentAtlas, saveAtlas, updateAtlasDraft } from "./store";
import { buildAxis, eventPosition, sortedMoments, timeLabel } from "./timeline";

const chapter = (id: string, rank: number, volumeId: string) => normalizeChapterMeta({ id, volumeId, title: id, rank, wordCount: 100, contentHash: `h-${id}` });
const card = (chapterId: string, summary: string): ChapterCard => ({ chapterId, sourceHash: `h-${chapterId}`, version: 2, summary, scenes: [{ title: "场", time: "", location: "雪城", characters: ["林远"], summary }], characters: [], entities: [], facts: [], threads: [], hook: "", emotionBeats: [], payoffs: [], changes: [], knowledge: [], intimacy: [], newCast: [], mentions: {}, extractedAt: 0 });
const memoryOf = (cards: ChapterCard[]) => ({ cards: new Map(cards.map((item) => [item.chapterId, item])), entities: [], aggregates: { worldview: null, volumes: [], arcs: [], book: null }, mentionCount: () => 0, openThreads: () => [] }) as unknown as MemoryView;

function world(): Atlas {
  return applyAtlasOps(emptyAtlas(), [
    { type: "upsertRegion", region: { id: "north", name: "北境", center: [300, 250], owner: "北国" } },
    { type: "upsertRegion", region: { id: "south", name: "南海", center: [700, 450] } },
    { type: "upsertPlace", place: { id: "city", name: "雪城", region: "北境", point: [300, 250], importance: 3 } },
  ]).atlas;
}

describe("map list operations", () => {
  it("keeps several top-level maps and sub-maps, and at least one top-level map", () => {
    const base = world();
    const { atlas, skipped } = applyAtlasOps(base, [
      { type: "upsertMap", map: { id: "abyss", title: "归墟秘境" } },
      { type: "upsertMap", map: { id: "palace", title: "天京宫城", parentId: base.rootMapId } },
      { type: "upsertMap", map: { id: "north-detail", title: "北境详图", anchorRegion: "北境" } },
      { type: "upsertMap", map: { title: "重复分块", anchorRegion: "北境" } },
    ]);
    expect(skipped).toEqual(["「北境」已经有分块详情图了。"]);
    expect(atlas.maps.find((map) => map.id === "abyss")).toMatchObject({ parentId: null, surround: "sea" });
    expect(atlas.maps.find((map) => map.id === "palace")).toMatchObject({ parentId: base.rootMapId, surround: "land" });
    expect(atlas.maps.find((map) => map.id === "north-detail")).toMatchObject({ parentId: base.rootMapId, anchorRegionId: "north" });

    const moved = applyAtlasOps(atlas, [{ type: "removeMap", id: base.rootMapId }]).atlas;
    expect(moved.rootMapId).toBe("abyss");
    expect(moved.maps.map((map) => map.id)).toEqual(["abyss"]);
    expect(moved.places).toHaveLength(0);
    expect(applyAtlasOps(moved, [{ type: "removeMap", id: "abyss" }]).skipped).toEqual(["至少要保留一张顶层地图。"]);
  });

  it("puts new records on the given default map", () => {
    const base = applyAtlasOps(world(), [{ type: "upsertMap", map: { id: "abyss", title: "归墟秘境" } }]).atlas;
    const { atlas } = applyAtlasOps(base, [{ type: "upsertRegion", region: { name: "深渊", center: [500, 350] } }], { defaultMapId: "abyss" });
    expect(atlas.regions.find((region) => region.name === "深渊")?.mapId).toBe("abyss");
  });
});

describe("timeline editing", () => {
  const context = { chapterIds: ["c1", "c2", "c3"] };

  it("dates events by chapter number, moment name or id, and checks chapters", () => {
    const { atlas, skipped } = applyAtlasOps(world(), [
      { type: "upsertMoment", moment: { id: "fall", phase: "past", label: "百年前·天京之变" } },
      { type: "upsertEvent", event: { id: "e1", title: "出城", place: "雪城", chapter: 2 } },
      { type: "upsertEvent", event: { id: "e2", title: "旧王陨落", place: "雪城", moment: "百年前·天京之变" } },
      { type: "upsertEvent", event: { id: "e3", title: "北伐", moment: "第三卷·北伐", phase: "future" } },
      { type: "upsertEvent", event: { title: "幻觉", chapter: 9 } },
      { type: "upsertEvent", event: { title: "幽灵章", chapterId: "nope" } },
    ], context);
    expect(skipped).toEqual(["没有第 9 章。", "没有 id 为 nope 的章节。"]);
    expect(atlas.events.find((event) => event.id === "e1")).toMatchObject({ chapterId: "c2", momentId: null, origin: "user" });
    expect(atlas.events.find((event) => event.id === "e2")).toMatchObject({ chapterId: null, momentId: "fall" });
    const future = atlas.moments.find((moment) => moment.label === "第三卷·北伐");
    expect(future).toMatchObject({ phase: "future", origin: "user" });
    expect(atlas.events.find((event) => event.id === "e3")?.momentId).toBe(future?.id);

    const moved = applyAtlasOps(atlas, [{ type: "upsertEvent", event: { id: "e1", moment: "fall" } }, { type: "upsertEvent", event: { id: "e2", chapter: 1 } }], context).atlas;
    expect(moved.events.find((event) => event.id === "e1")).toMatchObject({ chapterId: null, momentId: "fall" });
    expect(moved.events.find((event) => event.id === "e2")).toMatchObject({ chapterId: "c1", momentId: null });
    const renamed = applyAtlasOps(moved, [{ type: "upsertEvent", event: { id: "e1", title: "改名" } }], context).atlas;
    expect(renamed.events.find((event) => event.id === "e1")).toMatchObject({ title: "改名", momentId: "fall" });
  });

  it("orders moments with `after` and removes a moment with its events", () => {
    const { atlas } = applyAtlasOps(emptyAtlas(), [
      { type: "upsertMoment", moment: { id: "a", phase: "future", label: "甲" } },
      { type: "upsertMoment", moment: { id: "c", phase: "future", label: "丙" } },
      { type: "upsertMoment", moment: { id: "b", phase: "future", label: "乙", after: "甲" } },
      { type: "upsertEvent", event: { id: "e", title: "事", moment: "b" } },
    ]);
    expect(sortedMoments(atlas, "future").map((moment) => moment.id)).toEqual(["a", "b", "c"]);
    const cleared = applyAtlasOps(atlas, [{ type: "removeMoment", id: "b" }]).atlas;
    expect(cleared.moments.map((moment) => moment.id)).toEqual(["a", "c"]);
    expect(cleared.events).toHaveLength(0);
  });

  it("runs history, then chapters, then what is planned", async () => {
    installFakeHost();
    const project = await createProject({ title: "轴" });
    const volumeId = project.volumes[0].id;
    const book = { ...project, chapters: [chapter("c1", 1024, volumeId), chapter("c2", 2048, volumeId)] };
    const atlas = applyAtlasOps(world(), [
      { type: "upsertMoment", moment: { id: "p", phase: "past", label: "立国" } },
      { type: "upsertMoment", moment: { id: "f", phase: "future", label: "终局" } },
      { type: "upsertEvent", event: { id: "e", title: "决战", moment: "f" } },
      { type: "upsertTerritory", territory: { region: "北境", moment: "p", owner: "古国" } },
    ]).atlas;
    const axis = buildAxis(book, atlas);
    expect(axis.stops.map((stop) => stop.kind)).toEqual(["past", "chapter", "chapter", "future"]);
    expect(axis.chapterStart).toBe(1);
    expect(axis.writtenThrough).toBe(2);
    expect(eventPosition(axis, atlas.events[0])).toBe(3);
    expect(timeLabel(axis, { chapterId: "c2", momentId: null })).toBe("第 2 章");
    expect(timeLabel(axis, { chapterId: null, momentId: "p" })).toBe("立国");
  });

  it("reads maps saved with planned orders", () => {
    const atlas = normalizeAtlas({ maps: [{ id: "m" }], events: [{ id: "e1", title: "后来", plannedOrder: 2 }, { id: "e2", title: "更后来", plannedOrder: 5 }, { id: "e3", title: "同期", plannedOrder: 2 }] }) as Atlas;
    expect(sortedMoments(atlas, "future")).toHaveLength(2);
    expect(atlas.events[0].momentId).toBe(atlas.events[2].momentId);
    expect(atlas.events.every((event) => event.momentId)).toBe(true);
  });
});

describe("author edits", () => {
  let projectId: string;
  beforeEach(async () => { installFakeHost(); projectId = (await createProject({ title: "改" })).id; });

  it("go to the pending draft when there is one, the adopted map otherwise", async () => {
    await saveAtlas(projectId, world());
    await editCurrentAtlas(projectId, (atlas) => { atlas.regions[0].name = "北原"; });
    expect((await loadAtlas(projectId))?.regions[0].name).toBe("北原");
    await updateAtlasDraft(projectId, [{ type: "upsertRegion", region: { id: "south", name: "南洋" } }]);
    await editCurrentAtlas(projectId, (atlas) => { atlas.regions[0].name = "北荒"; });
    expect((await loadAtlas(projectId))?.regions[0].name).toBe("北原");
    expect((await loadAtlasDraft(projectId))?.regions.map((region) => region.name)).toEqual(["北荒", "南洋"]);
  });
});

describe("map generation with reference images and kept edits", () => {
  let host: FakeHost;
  let project: WriterProject;
  const GEOGRAPHY = { title: "九州", summary: "总览", surround: "sea", regions: [{ name: "北境", terrain: "tundra", center: [300, 200] }, { name: "南海", center: [650, 480] }], places: [{ name: "雪城", region: "北境", kind: "capital", point: [300, 210], importance: 3 }], routes: [] };
  beforeEach(async () => {
    host = installFakeHost();
    const created = await createProject({ title: "九州传", outline: "主角从北境南下，最终回到雪城决战。大纲足够长，可以作为材料来源。" });
    const volumeId = created.volumes[0].id;
    project = { ...created, worldview: "世界分北境与南海。".repeat(5), background: "百年前北国与南国大战。", chapters: [chapter("c1", 1024, volumeId), chapter("c2", 2048, volumeId)] };
    host.setModel((prompt) => {
      if (prompt.includes("设计「归墟秘境」")) return JSON.stringify({ ...GEOGRAPHY, title: "归墟秘境", regions: [{ name: "深渊", center: [500, 350] }], places: [] });
      if (prompt.includes("世界全图")) return JSON.stringify(GEOGRAPHY);
      if (prompt.includes("值得标在地图上的事件")) return JSON.stringify({ events: [{ chapter: 1, title: "雪夜出城", place: "雪城" }, { chapter: 2, title: "南下", region: "南海" }] });
      if (prompt.includes("正文之外的事件")) return JSON.stringify({ past: [{ order: 1, when: "百年前", title: "南北大战", place: "雪城", kind: "battle" }], future: [{ order: 1, when: "终章", title: "决战雪城", place: "雪城" }] });
      if (prompt.includes("只做作者要求的修改")) return JSON.stringify({ summary: "加了一座港口", operations: [{ type: "upsertPlace", place: { name: "南港", region: "南海", kind: "port" } }, { type: "upsertEvent", event: { title: "港口开埠", place: "南港", chapter: 2 } }, { type: "removePlace", id: "nope-but-harmless" }] });
      return "{}";
    });
  });
  const memory = () => memoryOf([card("c1", "出城"), card("c2", "南下")]);

  it("places history before the book and the outline after it", async () => {
    const { atlas } = await generateAtlasDraft({ project, memory: memory(), story: null, mode: "full" });
    const axis = buildAxis(project, atlas);
    const war = atlas.events.find((event) => event.title === "南北大战");
    const end = atlas.events.find((event) => event.title === "决战雪城");
    expect(axis.stops[eventPosition(axis, war as never)]).toMatchObject({ kind: "past", label: "百年前" });
    expect(axis.stops[eventPosition(axis, end as never)]).toMatchObject({ kind: "future", label: "终章" });
  });

  it("keeps what the author set through a sync and a full redraw", async () => {
    await generateAtlasDraft({ project, memory: memory(), story: null, mode: "full" });
    await updateAtlasDraft(project.id, [
      { type: "upsertEvent", event: { title: "我的伏笔", place: "雪城", chapter: 1 } },
      { type: "upsertMoment", moment: { phase: "future", label: "我加的节点" } },
    ], { chapterIds: ["c1", "c2"] });
    const changedCard = { ...card("c1", "改了"), sourceHash: "h-new" };
    await generateAtlasDraft({ project, memory: memoryOf([changedCard, card("c2", "南下")]), story: null, mode: "sync" });
    let atlas = await loadAtlasDraft(project.id) as Atlas;
    expect(atlas.events.filter((event) => event.title === "我的伏笔")).toHaveLength(1);
    expect(atlas.events.filter((event) => event.title === "雪夜出城")).toHaveLength(1);
    expect(atlas.moments.some((moment) => moment.label === "我加的节点")).toBe(true);
    await generateAtlasDraft({ project, memory: memory(), story: null, mode: "full" });
    atlas = await loadAtlasDraft(project.id) as Atlas;
    expect(atlas.events.find((event) => event.title === "我的伏笔")).toMatchObject({ origin: "user", chapterId: "c1" });
    expect(atlas.moments.some((moment) => moment.label === "我加的节点")).toBe(true);
    const prompts = host.modelCalls.filter((call) => call.prompt.includes("值得标在地图上的事件")).map((call) => call.prompt);
    expect(prompts.some((prompt) => prompt.includes("不要重复列出的事件：我的伏笔"))).toBe(true);
  });

  it("shows reference images to the model and can use the first as the base image", async () => {
    const [sketch] = await generateImages(project.id, { prompt: "手绘草图" });
    const { atlas } = await generateAtlasDraft({ project, memory: memory(), story: null, mode: "full", referenceIds: [sketch.id], useReferenceAsBase: true });
    const geography = host.modelCalls.find((call) => call.prompt.includes("世界全图"));
    expect(geography?.images).toEqual([imageFilePath(project.id, sketch)]);
    expect(geography?.prompt).toContain("【参考图】");
    expect(host.modelCalls.filter((call) => call.prompt.includes("值得标在地图上的事件")).every((call) => !call.images)).toBe(true);
    expect(atlas.maps[0].baseImageId).toBe(sketch.id);
  });

  it("refuses reference images when the model cannot read them", async () => {
    const [sketch] = await generateImages(project.id, { prompt: "草图" });
    host.storage.set("writer.modelRouting.v1", { memory: { authConfigId: "blind", model: "b-1" } });
    await expect(generateAtlasDraft({ project, memory: memory(), story: null, mode: "full", referenceIds: [sketch.id] })).rejects.toThrow("不能读图");
    expect(host.modelCalls).toHaveLength(0);
  });

  it("revises one map from an instruction, reporting what it could not apply", async () => {
    await generateAtlasDraft({ project, memory: memory(), story: null, mode: "full" });
    const result = await generateAtlasDraft({ project, memory: memory(), story: null, mode: "revise", instruction: "南海加一座港口" });
    expect(result.summary).toContain("加了一座港口");
    expect(result.warnings).toEqual([]);
    const port = result.atlas.places.find((place) => place.name === "南港");
    expect(port?.regionId).toBe(result.atlas.regions.find((region) => region.name === "南海")?.id);
    expect(result.atlas.events.find((event) => event.title === "港口开埠")).toMatchObject({ placeId: port?.id, chapterId: "c2", origin: "user" });
    await expect(generateAtlasDraft({ project, memory: memory(), story: null, mode: "revise" })).rejects.toThrow("要怎么改");
  });

  it("redraws a second top-level map without touching the world map", async () => {
    await generateAtlasDraft({ project, memory: memory(), story: null, mode: "full" });
    const { atlas: withAbyss } = await updateAtlasDraft(project.id, [{ type: "upsertMap", map: { id: "abyss", title: "归墟秘境" } }]);
    const worldPlaces = withAbyss.places.map((place) => place.id);
    const result = await generateAtlasDraft({ project, memory: memory(), story: null, mode: "redraw", mapId: "abyss" });
    expect(result.mapId).toBe("abyss");
    expect(result.atlas.regions.filter((region) => region.mapId === "abyss").map((region) => region.name)).toEqual(["深渊"]);
    expect(result.atlas.places.map((place) => place.id)).toEqual(worldPlaces);
  });

  it("lets the assistant create, list and fill maps", async () => {
    const state = { projectId: project.id, draft: project } as RunState;
    const env = (input: Record<string, unknown>): ToolEnv => ({ state, input, memory: memory() });
    await ATLAS_TOOLS["writer.generateAtlas"](env({ mode: "full" }));
    const created = await ATLAS_TOOLS["writer.generateAtlas"](env({ mode: "create", title: "天外天", blank: true }));
    const mapId = (created.result as { mapId: string }).mapId;
    expect((await ATLAS_TOOLS["writer.readAtlas"](env({}))).observation).toMatch(/天外天\(id=.*顶层地图/);
    const update = await ATLAS_TOOLS["writer.updateAtlas"](env({ mapId, operations: [{ type: "upsertRegion", region: { name: "云海", center: [500, 300] } }, { type: "upsertEvent", event: { title: "飞升", region: "云海", chapter: 2 } }, { type: "upsertEvent", event: { title: "不存在", chapter: 7 } }] }));
    expect(update.observation).toContain("应用 2 项");
    expect(update.observation).toContain("没有第 7 章");
    const atlas = await loadCurrentAtlas(project.id) as Atlas;
    expect(atlas.regions.find((region) => region.name === "云海")?.mapId).toBe(mapId);
    expect((await ATLAS_TOOLS["writer.readAtlas"](env({ mapId }))).observation).toContain("飞升");
    await expect(ATLAS_TOOLS["writer.generateAtlas"](env({ mode: "revise", mapId: "nope", instruction: "x" }))).rejects.toThrow("没有 id 为 nope");
    expect((await loadImageLibrary(project.id)).assets).toHaveLength(0);
  });
});
