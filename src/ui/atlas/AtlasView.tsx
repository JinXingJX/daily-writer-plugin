import { applyBoundaryEdit, brushGrid, initialGrid } from "../../atlas/boundaries";
import { AtlasArtworkPanel } from "./AtlasArtworkPanel";
import { Brush, Check, PanelRight, Maximize2, Redo2, Compass, ImagePlus, MapPin, Milestone, Move, Palette, RefreshCw, Shapes, Sparkles, Spline, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { friendlyAiError } from "../../ai/client";
import { generateAtlasDraft, type AtlasJobInput } from "../../ai/pipelines/atlas";
import { blockRect, emptyCanvas, paintTokens, tileRect, TOKEN_METHOD_LABELS, CANVAS_COLS, CANVAS_ROWS, type TileState, type TokenMethod } from "../../atlas/canvas";
import { characterOwner, itemOwner, placeOwner, TOKEN_KIND_LABELS, tokenTargets, type TokenKind } from "../../atlas/tokens";
import { imageInRole } from "../../images/schema";
import { cellContains } from "../../atlas/geometry";
import { applyAtlasOps, cellsOfMap } from "../../atlas/operations";
import { changedRecordIds, emptyAtlas, TERRAIN_LABELS, normalizeEvent, normalizeMap, normalizeMoment, normalizePlace, normalizeRegion, normalizeRoute, removedRecordCount, type Atlas, type AtlasEvent, type AtlasMoment, type BlockEdge, type Point, type RegionGrid, type MapRect } from "../../atlas/schema";
import { adoptAtlasDraft, atlasHistoryCount, discardAtlasDraft, editCurrentAtlas, loadAtlas, loadAtlasDraft, restorePreviousAtlas, saveAtlas, subscribeAtlas } from "../../atlas/store";
import { findStyle, type StylePalette } from "../../atlas/styles";
import { buildAxis, characterSpots, characterTrail, charactersIn, childMapOf, interiorOf, eventPoint, eventsUntil, itemStopAt, mapTrail, orderedEvents, ownerAt, ownersOf, pinsOn, placePoint, placesOn, terrainChangeAt, tileAssetAt } from "../../atlas/timeline";
import { friendlyImageError } from "../../images/generate";
import { Empty, Spinner, useDialogs } from "../common";
import { useWriter } from "../useWriter";
import { Thumb, useImageStudio } from "../images/ImageStudio";
import { useAssetUrls, useImageLibrary, useImageUrl } from "../images/useImages";
import { AtlasCanvas, type AtlasLayers, type AtlasSelection, type AtlasTool, type FocusRequest, type PaintedTile } from "./AtlasCanvas";
import { AtlasSide, GenerationBar, timeOfStop } from "./AtlasSide";
import { AtlasTimeline, SPANS } from "./AtlasTimeline";
import { runAtlasJob, useAtlasJob } from "./job";
import { MapActionDialog, type MapActionRequest } from "./MapActionDialog";
import { StyleLibraryDialog, useStyleLibrary } from "./StyleLibraryDialog";

/** The style's colours drive the vector map too, so a map looks like its scroll before and while it is painted. */
function paletteVars(palette: StylePalette): React.CSSProperties {
  const mix = (a: string, share: number, b: string) => `color-mix(in srgb, ${a} ${share}%, ${b})`;
  return {
    "--atlas-paper": palette.paper, "--atlas-plain": palette.land, "--atlas-ink": palette.ink, "--atlas-coast": palette.ink, "--atlas-accent": palette.accent,
    "--atlas-sea": mix(palette.water, 30, palette.paper), "--atlas-wave": mix(palette.water, 50, palette.paper), "--atlas-border": mix(palette.ink, 45, palette.land), "--atlas-glyph": mix(palette.ink, 60, palette.land),
    "--atlas-forest": mix(palette.land, 78, "#4f7a46"), "--atlas-mountain": mix(palette.land, 80, palette.ink), "--atlas-desert": mix(palette.land, 80, "#c9a050"), "--atlas-marsh": mix(palette.land, 80, "#5f7f5f"),
    "--atlas-tundra": mix(palette.land, 80, "#ffffff"), "--atlas-volcanic": mix(palette.land, 75, "#7a3b2c"), "--atlas-waste": mix(palette.land, 85, palette.ink), "--atlas-city": mix(palette.land, 85, palette.ink),
  } as React.CSSProperties;
}

const DEFAULT_LAYERS: AtlasLayers = { painted: true, terrain: true, owners: false, routes: true, labels: true, events: true, characters: true, items: true };
const TOOLS: { value: AtlasTool; label: string; icon: typeof MapPin }[] = [{ value: "region", label: "地区", icon: Shapes }, { value: "place", label: "地点", icon: MapPin }, { value: "route", label: "路线", icon: Spline }, { value: "event", label: "事件", icon: Milestone }];
const TOOL_HINTS: Record<AtlasTool, string> = { boundary: "抓住边界拖动，可向两侧推拉；笔刷控制影响范围", brush: "选中地区后涂抹扩张", erase: "涂抹退回海域", module: "拖出需要细化的范围", markup: "在地图上圈画修改位置", region: "点一下放地区（边界可用笔刷调整）", place: "点一下放地点", route: "依次点出路线经过的位置", event: "点一下放事件（靠近地点会落在地点上）" };
const RANK_STEP = 1024;


export function AtlasView({ onOpenChapter }: { onOpenChapter: (chapterId: string) => void }) {
  const writer = useWriter();
  const dialogs = useDialogs();
  const openStudio = useImageStudio();
  const project = writer.project;
  const projectId = project?.id;
  const job = useAtlasJob(projectId);
  const [committed, setCommitted] = useState<Atlas | null>(null);
  const [draft, setDraft] = useState<Atlas | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [mapId, setMapId] = useState<string | null>(null);
  const [selection, setSelection] = useState<AtlasSelection>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [span, setSpan] = useState("all");
  const [playing, setPlaying] = useState(false);
  const [layers, setLayers] = useState<AtlasLayers>(DEFAULT_LAYERS);
  const [character, setCharacter] = useState("");
  const [editing, setEditing] = useState(false);
  const [tool, setTool] = useState<AtlasTool | null>(null);
  const [routeDraft, setRouteDraft] = useState<Point[]>([]);
  const [redrawingRoute, setRedrawingRoute] = useState<string | null>(null);
  const [focus, setFocus] = useState<FocusRequest>(null);
  const [instruction, setInstruction] = useState("");
  const [startRefs, setStartRefs] = useState<string[]>([]);
  const [actionMap, setActionMap] = useState<string | null>(null);
  const [history, setHistory] = useState(0);
  const [tileStates] = useState<Record<number, TileState>>({});
  const [styleOpen, setStyleOpen] = useState(false);
  const overviewState: TileState | null = null;
  const [sideOpen, setSideOpen] = useState(false);
  const [artOpen, setArtOpen] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [brushRadius, setBrushRadius] = useState(18);
  const [moduleRect, setModuleRect] = useState<MapRect | null>(null);
  const [markup, setMarkup] = useState<Point[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [showLegacy, setShowLegacy] = useState(false);
  const [boundaryUndo, setBoundaryUndo] = useState<{ grid: RegionGrid | null; dirty: MapRect[] }[]>([]);
  const [boundaryRedo, setBoundaryRedo] = useState<{ grid: RegionGrid | null; dirty: MapRect[] }[]>([]);
  useEffect(() => { setShowLegacy(false); setBoundaryUndo([]); setBoundaryRedo([]); setPreview(null); setModuleRect(null); setMarkup([]); setSelection(null); setTool(null); }, [projectId, mapId]);
  const focusNonce = useRef(0);

  const reload = useCallback(async () => {
    if (!projectId) return;
    const [nextCommitted, nextDraft, count] = await Promise.all([loadAtlas(projectId), loadAtlasDraft(projectId), atlasHistoryCount(projectId)]);
    setCommitted(nextCommitted);
    setDraft(nextDraft);
    setHistory(count);
    setLoaded(true);
  }, [projectId]);
  useEffect(() => { void reload().catch((error) => writer.notify("error", friendlyAiError(error))); return subscribeAtlas((changed) => { if (changed === projectId) void reload(); }); }, [projectId, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  // Generations run as background tasks in the worker view; their writes land in another frame.
  const completedTasks = writer.tasks.filter((task) => task.status === "completed").map((task) => task.id).join(",");
  useEffect(() => { if (completedTasks) void reload(); }, [completedTasks, reload]);

  const atlas = draft ?? committed;
  const library = useImageLibrary(projectId);
  const map = atlas?.maps.find((item) => item.id === mapId) ?? atlas?.maps.find((item) => item.id === atlas.rootMapId) ?? null;
  const baseAsset = map?.baseImageId ? library.assets.find((asset) => asset.id === map.baseImageId) : undefined;
  const { url: baseUrl } = useImageUrl(projectId, baseAsset);

  const axis = useMemo(() => (project && atlas ? buildAxis(project, atlas) : null), [atlas, project]);
  const position = axis ? Math.max(0, Math.min(cursor ?? Math.max(axis.chapterStart, axis.writtenThrough), axis.stops.length - 1)) : 0;
  const regions = useMemo(() => (atlas && map ? atlas.regions.filter((region) => region.mapId === map.id) : []), [atlas, map]);
  const cells = useMemo(() => (atlas && map ? cellsOfMap(atlas, map.id) : new Map()), [atlas, map]);
  const spanValue = SPANS.find((item) => item.value === span)?.span ?? null;
  const allEvents = useMemo(() => (atlas && axis ? orderedEvents(atlas, axis) : []), [atlas, axis]);
  const shownEvents = useMemo(() => (atlas && axis ? eventsUntil(atlas, axis, position, spanValue) : []), [atlas, axis, position, spanValue]);
  const pins = useMemo(() => (atlas && map ? pinsOn(atlas, cells, map.id, shownEvents) : []), [atlas, cells, map, shownEvents]);
  const places = useMemo(() => (atlas && map ? placesOn(atlas, map.id) : []), [atlas, map]);
  const owners = useMemo(() => new Map(atlas && axis ? regions.map((region) => [region.id, ownerAt(atlas, axis, region, position)] as const) : []), [atlas, axis, position, regions]);
  const ownerNames = useMemo(() => (atlas && map ? ownersOf(atlas, map.id) : []), [atlas, map]);
  const characters = useMemo(() => (atlas ? charactersIn(atlas) : []), [atlas]);
  const trail = useMemo<Point[]>(() => (atlas && axis && map && character ? characterTrail(atlas, axis, cells, map.id, character, position).map((step) => step.point) : []), [atlas, axis, cells, character, map, position]);
  const changed = useMemo(() => (draft ? changedRecordIds(committed ?? emptyAtlas(), draft) : new Set<string>()), [committed, draft]);
  const removed = useMemo(() => (draft && committed ? removedRecordCount(committed, draft) : 0), [committed, draft]);
  const styleLibrary = useStyleLibrary(projectId);
  const style = styleLibrary ? findStyle(styleLibrary, map?.canvas?.styleId) : null;
  const cols = map?.canvas?.cols ?? CANVAS_COLS;
  const rows = map?.canvas?.rows ?? CANVAS_ROWS;
  const tileAssets = useMemo(() => (atlas && axis && map?.canvas ? map.canvas.tiles.map((tile) => tileAssetAt(atlas, axis, map.id, tile, position)) : []), [atlas, axis, map, position]);
  const tileUrls = useAssetUrls(projectId, [...tileAssets.flatMap((item) => (item.assetId ? [item.assetId] : [])), ...(map?.canvas?.tiles.flatMap((tile) => (tile.assetId ? [tile.assetId] : [])) ?? [])]);
  const blocksHere = useMemo(() => (atlas && map ? atlas.blocks.filter((block) => block.mapId === map.id && !block.hidden) : []), [atlas, map]);
  const art = showLegacy ? null : map?.artwork;
  const pending = preview !== "accepted" && !preview ? art?.pending : null;
  const overviewId = preview && preview !== "accepted" ? preview : pending?.kind === "fine" ? pending.assetId : art?.assetId || map?.canvas?.overviewAssetId || null;
  const modulesHere = useMemo(() => {
    if (!art?.assetId || (preview && preview !== "accepted") || pending?.kind === "fine") return [];
    return [...art.modules, ...(pending?.module ? [pending.module] : [])].filter((m) => {
      const pos = m.chapterId ? axis?.position.get(m.chapterId) : m.momentId ? axis?.position.get(m.momentId) : null;
      return pos == null ? !m.chapterId && !m.momentId : pos <= position;
    });
  }, [art, pending, preview, axis, position]);
  const tokenOwners = useMemo(() => {
    const owners = new Map<string, string>();
    if (!atlas || !map) return owners;
    for (const place of atlas.places.filter((item) => item.mapId === map.id)) { const asset = imageInRole(library.assets, placeOwner(place.id), "icon"); if (asset) owners.set(placeOwner(place.id), asset.id); }
    for (const item of atlas.items) { const asset = imageInRole(library.assets, itemOwner(item.id), "thumb"); if (asset) owners.set(itemOwner(item.id), asset.id); }
    for (const name of charactersIn(atlas)) { const owner = characterOwner(project, name); const asset = imageInRole(library.assets, owner, "avatar"); if (asset) owners.set(owner, asset.id); }
    return owners;
  }, [atlas, library.assets, map, project]);
  const layerUrls = useAssetUrls(projectId, [...(overviewId ? [overviewId] : []), ...blocksHere.map((block) => block.assetId), ...modulesHere.map((m) => m.assetId), ...tokenOwners.values()]);
  const overviewUrl = overviewId ? layerUrls.get(overviewId) ?? null : null;
  const blocks = useMemo(() => (atlas && map ? blocksHere.flatMap((block) => {
    const cell = cells.get(block.regionId);
    const rect = blockRect(atlas, map.id, block.regionId);
    const url = layerUrls.get(block.assetId);
    return cell && rect && url ? [{ id: block.id, polygon: cell.polygon, rect, url, edge: block.edge }] : [];
  }) : []), [atlas, blocksHere, cells, layerUrls, map]);
  const tokenUrl = useCallback((owner: string) => { const id = tokenOwners.get(owner); return id ? layerUrls.get(id) : undefined; }, [layerUrls, tokenOwners]);
  const placeTokens = useMemo(() => new Map(places.flatMap(({ place }) => { const url = tokenUrl(placeOwner(place.id)); return url ? [[place.id, url] as const] : []; })), [places, tokenUrl]);
  const painted = useMemo<PaintedTile[]>(() => {
    if (!map?.canvas && !Object.keys(tileStates).length) return [];
    return Array.from({ length: cols * rows }, (_, index) => {
      const shown = tileAssets[index];
      return { index, rect: tileRect(cols, rows, index), url: shown?.assetId ? tileUrls.get(shown.assetId) ?? null : null, state: tileStates[index] ?? null, variant: Boolean(shown?.variant) };
    });
  }, [cols, map?.canvas, rows, tileAssets, tileStates, tileUrls]);
  const spots = useMemo(() => (atlas && axis && map ? characterSpots(atlas, axis, cells, map.id, position, [...new Set([...characters.slice(0, 12), ...(selection?.type === "character" ? [selection.id] : [])])]) : []), [atlas, axis, cells, characters, map, position, selection]);
  const itemsShown = useMemo(() => {
    if (!atlas || !axis || !map) return [];
    const spotOf = new Map(spots.map((spot) => [spot.name, spot.point]));
    return atlas.items.flatMap((item) => {
      const stop = itemStopAt(axis, item, position);
      if (!stop) return [];
      let point: Point | null = stop.placeId ? placePoint(atlas, cells, map.id, stop.placeId) : null;
      if (!point && stop.holder) {
        const holder = spotOf.get(stop.holder) ?? characterSpots(atlas, axis, cells, map.id, position, [stop.holder])[0]?.point;
        if (holder) point = [holder[0] + 14, holder[1] + 12];
      }
      return point ? [{ id: item.id, name: item.name, point, token: tokenUrl(itemOwner(item.id)) }] : [];
    });
  }, [atlas, axis, cells, map, position, spots, tokenUrl]);
  const spotsShown = useMemo(() => spots.map((spot) => ({ ...spot, token: tokenUrl(characterOwner(project, spot.name)) })), [project, spots, tokenUrl]);
  const terrainMarks = useMemo(() => (atlas && axis ? regions.flatMap((region) => {
    const change = terrainChangeAt(atlas, axis, region.id, position);
    if (!change) return [];
    const index = Math.min(rows - 1, Math.floor(region.center[1] / (700 / rows))) * cols + Math.min(cols - 1, Math.floor(region.center[0] / (1000 / cols)));
    // A painted variant already shows the change; the hatching is for maps still drawn as vectors.
    if (layers.painted && tileAssets[index]?.variant) return [];
    return [{ regionId: region.id, terrain: change.terrain, label: `${TERRAIN_LABELS[change.terrain]}${change.note ? ` · ${change.note.slice(0, 8)}` : ""}` }];
  }) : []), [atlas, axis, cols, layers.painted, position, regions, rows, tileAssets]);

  if (!project || !projectId) return null;

  /** Manual edits follow what is on screen (the pending draft if there is one) and apply to the stored map, not a stale copy. */
  const mutate = (change: (next: Atlas) => void) => {
    if (!atlas) return;
    const next = structuredClone(atlas);
    try { change(next); } catch (error) { writer.notify("error", friendlyAiError(error)); return; }
    const terrainEdits = next.regions.filter((region) => atlas.regions.some((previous) => previous.id === region.id && previous.terrain !== region.terrain)).map((region) => ({ mapId: region.mapId, rect: blockRect(next, region.mapId, region.id) }));
    const markTerrain = (target: Atlas) => { for (const edit of terrainEdits) { const art = target.maps.find((m) => m.id === edit.mapId)?.artwork; if (art && edit.rect) { const x = Math.max(0, edit.rect.x), y = Math.max(0, edit.rect.y); art.dirty = [...art.dirty, { x, y, w: Math.min(1000, edit.rect.x + edit.rect.w) - x, h: Math.min(700, edit.rect.y + edit.rect.h) - y }].slice(-50); } } };
    markTerrain(next);
    if (draft) setDraft(next); else setCommitted(next);
    void editCurrentAtlas(projectId, (target) => { change(target); markTerrain(target); }).catch((error) => writer.notify("error", friendlyAiError(error)));
  };
  const applyOps = (operations: unknown[]) => {
    const outcome = atlas ? applyAtlasOps(atlas, operations) : null;
    if (outcome?.skipped.length) { writer.notify("error", outcome.skipped[0]); return false; }
    mutate((next) => { Object.assign(next, applyAtlasOps(next, operations).atlas); });
    return true;
  };

  const run = async (label: string, input: Omit<AtlasJobInput, "project" | "memory" | "story" | "onProgress" | "signal">) => {
    try {
      const result = await runAtlasJob(projectId, label, (onProgress, signal) => generateAtlasDraft({ project, memory: writer.memory, story: writer.story, ...input, onProgress, signal }));
      writer.notify("success", `${result.summary}确认后点“采纳”。`);
      for (const warning of result.warnings) writer.notify("error", warning);
      if (input.mode !== "sync" && result.mapId) { setMapId(result.mapId); setSelection(null); }
    } catch (error) {
      const message = friendlyAiError(error);
      if (message !== "已取消。") writer.notify("error", message);
    }
  };

  const runAction = async (request: MapActionRequest) => {
    setActionMap(null);
    if (request.action === "base") { mutate((next) => { const target = next.maps.find((item) => item.id === request.mapId); if (target) target.baseImageId = request.referenceIds[0] ?? null; }); return; }
    if (request.action === "paint") { setMapId(request.mapId); setArtOpen(true); return; }
    const target = atlas?.maps.find((item) => item.id === request.mapId);
    const anchored = Boolean(target?.anchorRegionId);
    const inside = Boolean(target?.anchorPlaceId);
    const mode = request.action === "full" ? "layout" : request.action === "revise" ? "revise" : inside ? "interior" : anchored ? "detail" : "redraw";
    await run(request.action === "revise" ? "修改地图" : "绘制地图", { mode, mapId: request.mapId, regionId: anchored ? target?.anchorRegionId ?? undefined : undefined, placeId: target?.anchorPlaceId ?? undefined, instruction: request.instruction, referenceIds: request.referenceIds, useReferenceAsBase: request.useReferenceAsBase });
  };

  const newMap = async (parentId: string | null, anchorRegionId?: string) => {
    const anchor = anchorRegionId ? atlas?.regions.find((region) => region.id === anchorRegionId) : undefined;
    const title = await dialogs.prompt(parentId ? "新建子地图" : "新建地图", parentId ? "子地图的名字：" : "顶层地图和世界全图并列，适合另一片大陆、秘境或异界。名字：", anchor?.name ?? "");
    if (!title?.trim()) return;
    const created = normalizeMap({ title: title.trim(), parentId, anchorRegionId: anchor?.id ?? null, surround: parentId ? "land" : "sea" });
    mutate((next) => { next.maps.push(created); });
    setMapId(created.id);
    setSelection(null);
    setEditing(true);
  };

  const deleteMap = async (id: string) => {
    if (!atlas) return;
    const target = atlas.maps.find((item) => item.id === id);
    const children = atlas.maps.filter((item) => item.parentId === id).length;
    if (!(await dialogs.confirm("删除地图", `删除「${target?.title ?? ""}」${children ? `和它下面的 ${children} 张子地图` : ""}？上面的地区、地点和路线会一并删除，事件保留但不再有位置。`, { danger: true, confirmLabel: "删除" }))) return;
    if (applyOps([{ type: "removeMap", id }]) && (id === map?.id || mapTrail(atlas, map?.id ?? "").some((item) => item.id === id))) { setMapId(null); setSelection(null); }
  };

  const remove = async (type: "region" | "place" | "event" | "route" | "territory" | "moment" | "item" | "terrain" | "variant", id: string) => {
    const messages = { region: "删除这个地区？它的分块详情也会一并删除。", place: "删除这个地点？", event: "删除这个事件？", route: "删除这条路线？", territory: "删除这次势力变更？", moment: "删除这个时间节点？节点上的事件会一并删除。", item: "删除这件物品和它的全部去向？", terrain: "删除这次地形变化？", variant: "删除这块变体？那一刻起会显示原来的画面。" };
    if (!(await dialogs.confirm("删除", messages[type], { danger: true, confirmLabel: "删除" }))) return;
    if (type === "variant") { mutate((next) => { next.variants = next.variants.filter((variant) => variant.id !== id); }); return; }
    const name = { region: "removeRegion", place: "removePlace", event: "removeEvent", route: "removeRoute", territory: "removeTerritory", moment: "removeMoment", item: "removeItem", terrain: "removeTerrainChange" }[type];
    applyOps([{ type: name, id }]);
    if (selection?.id === id) setSelection(null);
  };

  const addEventAt = (point: Point | null) => {
    if (!axis || !map) return;
    const near = point ? places.filter((item) => !item.foreign).map((item) => ({ item, distance: Math.hypot(item.point[0] - point[0], item.point[1] - point[1]) })).sort((left, right) => left.distance - right.distance)[0] : undefined;
    const region = point ? regions.find((item) => { const cell = cells.get(item.id); return cell && cellContains(cell, point); }) : undefined;
    const event = normalizeEvent({ title: "新事件", point, mapId: map.id, ...timeOfStop(axis, position), placeId: near && near.distance < 30 ? near.item.place.id : null, regionId: near && near.distance < 30 ? null : region?.id ?? null, origin: "user" });
    mutate((next) => { next.events.push(event); });
    setSelection({ type: "event", id: event.id });
  };

  const addMoment = async (phase: AtlasMoment["phase"]) => {
    const label = await dialogs.prompt(phase === "past" ? "新的前史节点" : "新的后续节点", phase === "past" ? "开篇之前的哪个时候？例如：百年前·天京之变" : "还没写到的哪个阶段？例如：第三卷·北伐", "");
    if (label === null || !atlas) return;
    const ranks = atlas.moments.filter((item) => item.phase === phase).map((item) => item.rank);
    const moment = normalizeMoment({ phase, label: label.trim(), rank: ranks.length ? Math.max(...ranks) + RANK_STEP : RANK_STEP, origin: "user" });
    mutate((next) => { next.moments.push(moment); });
  };

  const handlePoint = (point: Point) => {
    if (!map || !tool) return;
    if (tool === "route") { setRouteDraft((current) => [...current, point]); return; }
    if (tool === "event") { addEventAt(point); setTool(null); return; }
    if (tool === "region") {
      const region = normalizeRegion({ mapId: map.id, name: "新地区", center: point });
      mutate((next) => { const m = next.maps.find((m) => m.id === map.id); if (m?.boundaries) { const grid = structuredClone(m.boundaries); grid.ids.push(region.id); brushGrid(grid, point, point, 60, grid.ids.length); m.boundaries = grid; if (m.artwork) m.artwork.dirty.push({ x: Math.max(0, point[0] - 60), y: Math.max(0, point[1] - 60), w: Math.min(120, 1000 - Math.max(0, point[0] - 60)), h: Math.min(120, 700 - Math.max(0, point[1] - 60)) }); } next.regions.push(region); });
      setSelection({ type: "region", id: region.id });
    } else {
      const region = regions.find((item) => { const cell = cells.get(item.id); return cell && cellContains(cell, point); });
      const place = normalizePlace({ mapId: map.id, regionId: region?.id ?? null, name: "新地点", point, importance: 2 });
      mutate((next) => { next.places.push(place); });
      setSelection({ type: "place", id: place.id });
    }
    setTool(null);
  };

  const finishRoute = () => {
    if (!map || routeDraft.length < 2) { setTool(null); setRouteDraft([]); setRedrawingRoute(null); return; }
    const points = routeDraft;
    if (redrawingRoute) mutate((next) => { const target = next.routes.find((item) => item.id === redrawingRoute); if (target) target.points = points; });
    else {
      const route = normalizeRoute({ mapId: map.id, name: "新路线", kind: "road", points });
      mutate((next) => { next.routes.push(route); });
      setSelection({ type: "route", id: route.id });
    }
    setTool(null);
    setRouteDraft([]);
    setRedrawingRoute(null);
  };

  const paintScroll = async (tiles?: number[], _variantIndex?: number) => {
    if (tiles?.length && map) { const rect = tileRect(cols, rows, tiles[0]); setModuleRect({ x: Math.max(0, rect.x), y: Math.max(0, rect.y), w: Math.min(1000, rect.x + rect.w) - Math.max(0, rect.x), h: Math.min(700, rect.y + rect.h) - Math.max(0, rect.y) }); }
    setArtOpen(true);
  };
  const paintWholeOverview = async () => { setArtOpen(true); };
  const paintRegionBlock = async (regionId: string, _edge: BlockEdge) => {
    if (!atlas || !map) return;
    setModuleRect(blockRect(atlas, map.id, regionId)); setArtOpen(true);
  };

  const paintMapTokens = async (kind: TokenKind, method: TokenMethod, owners?: string[]) => {
    if (!atlas || !map || !style) return;
    const all = tokenTargets({ atlas, project, assets: library.assets, mapId: map.id, kind, characters: spots, all: Boolean(owners), limit: owners ? 200 : 27 });
    let targets = owners ? all.filter((target) => owners.includes(target.owner)) : all;
    // A character or item picked from its detail may not be on this map at this moment; it still gets a token.
    if (owners && !targets.length) targets = owners.map((owner) => ({ owner, role: kind === "places" ? "icon" as const : kind === "characters" ? "avatar" as const : "thumb" as const, name: kind === "characters" ? owner.replace(/^character:/, "") : atlas.items.find((item) => itemOwner(item.id) === owner)?.name ?? "", description: "", point: null }));
    if (!targets.length) { writer.notify("success", `这张图上的${TOKEN_KIND_LABELS[kind]}都已经有了。`); return; }
    const requests = method === "crop" ? 0 : targets.length;
    if (!(await dialogs.confirm("生成地图组件", `${TOKEN_METHOD_LABELS[method]}：${targets.map((target) => target.name).slice(0, 12).join("、")}${targets.length > 12 ? ` 等 ${targets.length} 个` : ""}。${requests ? `共 ${requests} 次 GPT Image 请求。` : "从已画好的画卷裁切，不花额度。"}`, { confirmLabel: "开始" }))) return;
    try {
      const result = await runAtlasJob(projectId, `生成${TOKEN_KIND_LABELS[kind]}`, (onProgress, signal) => paintTokens({ projectId, atlas, mapId: map.id, style, targets, method: method === "sheet" ? "single" : method, preview: Boolean(map.artwork), moduleIds: modulesHere.map((m) => m.id), signal, onProgress }));
      if (result.failed.length) writer.notify("error", `有 ${result.failed.length} 个没做成：${friendlyImageError(new Error(result.failed[0].error))}`);
      else { writer.notify("success", `做好了 ${result.done.length} 个组件${map.artwork ? "，请在绘图面板采纳。" : "，已显示在地图上。"}`); if (map.artwork) setArtOpen(true); }
    } catch (error) { writer.notify("error", friendlyImageError(error)); }
  };

  const enterPlace = (placeId: string) => {
    if (!atlas) return;
    const interior = interiorOf(atlas, placeId);
    if (interior) { setMapId(interior.id); setSelection(null); }
  };

  const revertTile = (index: number) => mutate((next) => {
    const tile = next.maps.find((item) => item.id === map?.id)?.canvas?.tiles[index];
    if (!tile?.versions.length) return;
    tile.assetId = tile.versions[tile.versions.length - 1];
    tile.versions = tile.versions.slice(0, -1);
  });

  const applyStyle = (styleId: string) => mutate((next) => {
    const target = next.maps.find((item) => item.id === map?.id);
    if (!target) return;
    target.canvas = target.canvas ? { ...target.canvas, styleId } : emptyCanvas(styleId);
  });

  const locate = (event: AtlasEvent) => {
    if (!atlas || !map) return;
    const spot = eventPoint(atlas, cells, map.id, event);
    if (spot) { focusNonce.current += 1; setFocus({ point: spot.point, nonce: focusNonce.current }); }
  };

  const enterRegion = (regionId: string) => {
    if (!atlas) return;
    const child = childMapOf(atlas, regionId);
    if (child) { setMapId(child.id); setSelection(null); }
  };

  if (!loaded) return <div className="w-map"><p className="w-muted pad"><Spinner size={11} /> 正在读取…</p></div>;

  if (!atlas || !map || !axis) {
    return (
      <div className="w-map">
        <div className="w-atlas-empty">
          <Empty icon={<Compass size={26} />} title="还没有世界地图">
            <p>AI 会读世界观、大纲、势力设定和故事记忆，画出地区、地点和路线，把每章的事件落到地图上，再推演开篇前的历史和后面的走向。也可以给一张手绘草图或现成的地图作参考。</p>
            <textarea className="w-textarea" rows={2} value={instruction} placeholder="额外要求（可不填），例如：大陆东西狭长，北面是冰海" onChange={(event) => setInstruction(event.currentTarget.value)} />
            {startRefs.length ? <div className="w-thumb-row">{startRefs.map((id) => { const asset = library.assets.find((item) => item.id === id); return asset ? <button key={id} type="button" className="w-thumb-pick active" title="点击移除" onClick={() => setStartRefs(startRefs.filter((item) => item !== id))}><Thumb asset={asset} projectId={projectId} /></button> : null; })}</div> : null}
            {job ? <GenerationBar message={job.message} onCancel={job.cancel} /> : <div className="w-row">
              <button type="button" className="w-btn" onClick={() => openStudio({ title: "地图参考图", material: `《${project.title}》的世界地图`, pickLabel: "用作参考", onPick: (asset) => setStartRefs((current) => [...current.filter((id) => id !== asset.id), asset.id].slice(-4)) })}><ImagePlus size={13} />参考图</button>
              <button type="button" className="w-btn primary" onClick={() => void run("准备绘制地图", { mode: "layout", instruction, referenceIds: startRefs })}><Sparkles size={13} />生成地理版图</button>
              <button type="button" className="w-btn" onClick={() => { void saveAtlas(projectId, emptyAtlas("世界全图")); setEditing(true); }}>从空白开始</button>
            </div>}
            {!writer.memory || writer.memory.isEmpty ? <p className="w-muted">还没有故事记忆，事件会比较少；在“档案 · 记忆管理”建立后可以同步。</p> : null}
          </Empty>
        </div>
      </div>
    );
  }

  const trailMaps = mapTrail(atlas, map.id);
  const staleChapters = axis.chapterCount ? project.chapters.filter((chapter) => chapter.wordCount > 0 && atlas.coverage[chapter.id] === undefined).length : 0;
  const busy = Boolean(job);
  return (
    <div className={`w-map w-atlas ${immersive ? "immersive" : ""} ${sideOpen ? "side-open" : ""}`} style={style ? paletteVars(style.palette) : undefined}>
      <header className="w-atlas-head">
        <nav className="w-atlas-crumbs" aria-label="地图层级">{trailMaps.map((item, index) => <span key={item.id}>{index ? <i>›</i> : null}<button type="button" aria-current={item.id === map.id ? "page" : undefined} onClick={() => { setMapId(item.id); setSelection(null); }}>{item.title}</button></span>)}</nav>
        <span className="w-spacer" />
        <button type="button" className="w-btn small" aria-pressed={sideOpen} onClick={() => setSideOpen(!sideOpen)}><PanelRight size={12} />地图与图层</button>
        <button type="button" className="w-btn small" aria-pressed={immersive} onClick={() => setImmersive(!immersive)}><Maximize2 size={12} />{immersive ? "退出沉浸" : "沉浸"}</button>
        <button type="button" className="w-btn small" disabled={busy} onClick={() => void run("同步章节事件", { mode: "sync" })}><RefreshCw size={12} />同步到最新章节{staleChapters ? `（${staleChapters}）` : ""}</button>
        <button type="button" className="w-btn small" disabled={busy} onClick={() => setActionMap(map.id)}><Sparkles size={12} />生成/修改这张图</button>
        <button type="button" className="w-btn small" onClick={() => setStyleOpen(true)}><Palette size={12} />风格：{style?.name ?? "…"}</button>
        <button type="button" className="w-btn small primary" disabled={busy || !regions.length} title={regions.length ? "" : "先生成或摆好版图"} onClick={() => setArtOpen(!artOpen)}><Brush size={12} />分阶段绘图</button>
        <button type="button" className={`w-btn small ${editing ? "primary" : ""}`} aria-pressed={editing} disabled={busy} onClick={() => { setEditing(!editing); setTool(null); setRouteDraft([]); }}><Move size={12} />编辑布局</button>
        {history && !draft ? <button type="button" className="w-btn small ghost" onClick={() => void restorePreviousAtlas(projectId)}><Undo2 size={12} />上一版</button> : null}
      </header>
      {job ? <GenerationBar message={job.message} onCancel={job.cancel} /> : null}
      {draft ? (
        <div className="w-atlas-draft" role="status">
          <span>AI 草稿：<b>{changed.size}</b> 项新增或改动{removed ? `，${removed} 项删除` : ""}，朱色标出。</span>
          <span className="w-spacer" />
          <button type="button" className="w-btn small w-btn-zhu" onClick={() => void adoptAtlasDraft(projectId)}>采纳</button>
          <button type="button" className="w-btn small" onClick={() => void discardAtlasDraft(projectId)}>放弃</button>
        </div>
      ) : null}
      <div className="w-atlas-body">
        <div className="w-atlas-main">
          <div className="w-atlas-stage-wrap">
            <AtlasCanvas atlas={atlas} mapId={map.id} regions={regions} cells={cells} places={places} owners={owners} ownerNames={ownerNames} pins={pins} axis={axis} cursor={position} trail={trail} layers={layers} selection={selection} changed={changed} baseImage={baseUrl ? { url: baseUrl, opacity: map.baseOpacity } : null} editing={editing} focus={focus} tool={tool} routeDraft={routeDraft} onPoint={handlePoint} painted={art?.assetId || (preview && preview !== "accepted") ? [] : painted} overviewUrl={overviewUrl} blocks={art?.assetId || (preview && preview !== "accepted") ? [] : blocks} placeTokens={placeTokens} characters={spotsShown} items={itemsShown} terrainMarks={terrainMarks} onSelect={setSelection} onEnterRegion={enterRegion} onEnterPlace={enterPlace}
              rasterMap={Boolean(art?.assetId || (preview && preview !== "accepted"))} brushRadius={brushRadius} markup={markup} autoEvents={playing} modules={modulesHere.flatMap((m) => { const url = layerUrls.get(m.assetId); return url ? [{ ...m, url }] : []; })}
              onBoundary={(grid, _coastline, rect) => {
                setBoundaryUndo([...boundaryUndo, { grid: map.boundaries ?? null, dirty: art?.dirty ?? [] }].slice(-30));
                setBoundaryRedo([]);
                mutate((next) => applyBoundaryEdit(next, map.id, grid, rect));
              }}
              onModuleRect={(rect) => { setModuleRect(rect); setTool(null); setArtOpen(true); }} onMarkup={(points) => setMarkup(points)}
              onInspect={() => setSideOpen(true)} onCursor={setCursor} onOpenChapter={onOpenChapter}
              onMoveEvent={(id, point) => mutate((next) => { const e = next.events.find((e) => e.id === id); if (e) { e.point = point; e.mapId = map.id; e.placeId = null; e.regionId = [...cells].find(([, c]) => cellContains(c, point))?.[0] ?? null; e.origin = "user"; } })}
              onStampPlace={(id) => { const place = atlas.places.find((p) => p.id === id); if (!place) return; mutate((next) => { const p = next.places.find((p) => p.id === id); if (p) p.display = "marker"; }); setModuleRect({ x: Math.max(0, Math.min(880, place.point[0] - 60)), y: Math.max(0, Math.min(580, place.point[1] - 60)), w: 120, h: 120 }); setArtOpen(true); }}
              onEditEvent={(id, patch) => mutate((next) => { const e = next.events.find((e) => e.id === id); if (e) Object.assign(e, patch); })}
              onEditPlace={(id, patch) => mutate((next) => { const p = next.places.find((p) => p.id === id); if (p) Object.assign(p, patch); })}
              onContextAdd={(kind, point) => { if (kind === "event") addEventAt(point); else { const r = regions.find((r) => { const c = cells.get(r.id); return c && cellContains(c, point); }); const p = normalizePlace({ mapId: map.id, name: "新地点", point, regionId: r?.id }); mutate((next) => next.places.push(p)); setSelection({ type: "place", id: p.id }); } }}
              onMovePlace={(id, point) => mutate((next) => { const target = next.places.find((item) => item.id === id); if (target) { if (target.display === "marker" && next.maps.find((m) => m.id === map.id)?.artwork) { const art = next.maps.find((m) => m.id === map.id)!.artwork!; for (const p of [target.point, point]) art.dirty.push({ x: Math.max(0, p[0] - 45), y: Math.max(0, p[1] - 45), w: Math.min(90, 1000 - Math.max(0, p[0] - 45)), h: Math.min(90, 700 - Math.max(0, p[1] - 45)) }); } target.point = point; target.regionId = [...cells].find(([, cell]) => cellContains(cell, point))?.[0] ?? null; } })}
              onMoveRegion={(id, point) => mutate((next) => { const target = next.regions.find((item) => item.id === id); if (target) { const m = next.maps.find((m) => m.id === map.id); if (m && !m.boundaries) m.boundaries = initialGrid(next.regions.filter((r) => r.mapId === map.id), m); target.labelPoint = point; } })} />
            {artOpen ? <div className="w-atlas-art-drawer"><div className="w-row"><strong>分阶段绘图</strong><span className="w-spacer" /><button type="button" className="w-icon-btn small" aria-label="关闭绘图面板" onClick={() => setArtOpen(false)} title="关闭绘图面板"><X size={12} /></button></div>{map.artwork?.assetId && (map.canvas?.overviewAssetId || map.baseImageId) ? <button type="button" className="w-text-btn" onClick={() => { setShowLegacy(!showLegacy); setPreview(null); }}>{showLegacy ? "返回新画卷" : "查看原有地图素材"}</button> : null}<AtlasArtworkPanel projectId={projectId} atlas={atlas} map={map} style={style} busy={busy} layoutPending={!!draft} moduleIds={modulesHere.map((m) => m.id)} rect={moduleRect} markup={markup} preview={preview} onPreview={setPreview} onTool={setTool} mutate={mutate} notify={writer.notify} time={{ ...timeOfStop(axis, position), label: axis.stops[position]?.label ?? "未定" }} />{markup.length ? <button type="button" className="w-text-btn" onClick={() => setMarkup([])}>清除圈画</button> : null}</div> : null}
            {editing || tool ? (
              <div className="w-atlas-tools" role="toolbar" aria-label="添加">
                {TOOLS.map((item) => <button key={item.value} type="button" className={`w-btn small ${tool === item.value ? "active" : ""}`} aria-pressed={tool === item.value} onClick={() => { setTool(tool === item.value ? null : item.value); setRouteDraft([]); setRedrawingRoute(null); }}><item.icon size={12} />{item.label}</button>)}
                {(["boundary", "brush", "erase"] as AtlasTool[]).map((value) => <button key={value} type="button" className={`w-btn small ${tool === value ? "active" : ""}`} aria-pressed={tool === value} onClick={() => setTool(tool === value ? null : value)}>{value === "boundary" ? "推拉边界" : value === "brush" ? "涂地区" : "退海"}</button>)}
                {tool === "brush" ? <select className="w-select" aria-label="编辑边界的地区" value={selection?.type === "region" ? selection.id : ""} onChange={(e) => setSelection({ type: "region", id: e.currentTarget.value })}><option value="">点击或选择地区</option>{regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select> : null}
                {["boundary", "brush", "erase"].includes(tool ?? "") ? <label className="w-atlas-brush-size">笔刷<input type="range" aria-label="边界笔刷大小" min={4} max={80} value={brushRadius} onChange={(e) => setBrushRadius(Number(e.currentTarget.value))} /></label> : null}
                <button type="button" className="w-icon-btn small" aria-label="撤销边界编辑" disabled={!boundaryUndo.length} onClick={() => {
                  const before = boundaryUndo[boundaryUndo.length - 1]; setBoundaryRedo([...boundaryRedo, { grid: map.boundaries ?? null, dirty: art?.dirty ?? [] }]); setBoundaryUndo(boundaryUndo.slice(0, -1)); mutate((next) => { const m = next.maps.find((m) => m.id === map.id); if (m) { applyBoundaryEdit(next, map.id, before.grid ?? initialGrid(next.regions.filter((r) => r.mapId === map.id), { ...m, boundaries: null }), { x: 0, y: 0, w: 1000, h: 700 }); m.boundaries = before.grid; if (m.artwork) m.artwork.dirty = before.dirty; } });
                }} title="撤销边界编辑"><Undo2 size={12} /></button>
                <button type="button" className="w-icon-btn small" aria-label="重做边界编辑" disabled={!boundaryRedo.length} onClick={() => {
                  const after = boundaryRedo[boundaryRedo.length - 1]; setBoundaryUndo([...boundaryUndo, { grid: map.boundaries ?? null, dirty: art?.dirty ?? [] }]); setBoundaryRedo(boundaryRedo.slice(0, -1)); mutate((next) => { const m = next.maps.find((m) => m.id === map.id); if (m) { applyBoundaryEdit(next, map.id, after.grid ?? initialGrid(next.regions.filter((r) => r.mapId === map.id), { ...m, boundaries: null }), { x: 0, y: 0, w: 1000, h: 700 }); m.boundaries = after.grid; if (m.artwork) m.artwork.dirty = after.dirty; } });
                }} title="重做边界编辑"><Redo2 size={12} /></button>
                {tool ? <span className="w-muted">{redrawingRoute ? "依次点出路线的新走向" : TOOL_HINTS[tool]}</span> : <span className="w-muted">拖动地点和名称；用推拉边界或画笔修改版图</span>}
                {tool === "route" ? <><button type="button" className="w-btn small primary" disabled={routeDraft.length < 2} onClick={finishRoute}><Check size={12} />完成</button><button type="button" className="w-btn small" onClick={() => { setTool(null); setRouteDraft([]); setRedrawingRoute(null); }}><X size={12} />取消</button></> : null}
              </div>
            ) : null}
            {!regions.length && !tool && !baseUrl ? (
              <div className="w-atlas-blank">
                <strong>这张图还是空的</strong>
                <p className="w-muted">让 AI 按材料或参考图画出来，或者打开“编辑布局”自己放地区和地点。</p>
                <div className="w-row" style={{ justifyContent: "center" }}>
                  <button type="button" className="w-btn small primary" disabled={busy} onClick={() => setActionMap(map.id)}><Sparkles size={12} />生成/修改</button>
                  <button type="button" className="w-btn small" onClick={() => { setEditing(true); setTool("region"); }}><Shapes size={12} />手动添加地区</button>
                </div>
              </div>
            ) : null}
          </div>
          <AtlasTimeline project={project} axis={axis} events={allEvents} cursor={position} onCursor={setCursor} span={span} onSpan={setSpan} playing={playing} onPlaying={setPlaying} />
        </div>
        {sideOpen ? <AtlasSide atlas={atlas} map={map} axis={axis} events={shownEvents} cursor={position} selection={selection} layers={layers} characters={characters} character={character} ownerNames={ownerNames} owners={owners} busy={busy}
          onLayers={setLayers} onCharacter={setCharacter} onSelect={setSelection} onLocate={locate} onCursor={(next) => { setPlaying(false); setCursor(next); }}
          onOpenMap={(id) => { setMapId(id); setSelection(null); }} onEnterRegion={enterRegion} onDetailRegion={(regionId) => { const child = childMapOf(atlas, regionId); if (child) setActionMap(child.id); else void run("绘制分块详情", { mode: "detail", regionId }); }}
          onMapAction={setActionMap} onNewMap={(parentId, anchor) => void newMap(parentId, anchor)} onDeleteMap={(id) => void deleteMap(id)}
          onAddEvent={() => addEventAt(null)} onAddMoment={(phase) => void addMoment(phase)} onRedrawRoute={(id) => { setEditing(true); setTool("route"); setRouteDraft([]); setRedrawingRoute(id); }}
          onOpenChapter={onOpenChapter} mutate={mutate} onRemove={(type, id) => void remove(type, id)}
          scroll={map.canvas ? { styleName: style?.name ?? "", tiles: map.canvas.tiles.map((tile) => ({ index: tile.index, url: tile.assetId ? tileUrls.get(tile.assetId) ?? null : null, state: tileStates[tile.index] ?? null, versions: tile.versions.length, error: tile.error, variants: atlas.variants.filter((variant) => variant.mapId === map.id && variant.tileIndex === tile.index).map((variant) => ({ id: variant.id, label: variant.label })) })) } : null}
          onOpenStyles={() => setStyleOpen(true)} onPaintTiles={(tiles) => void paintScroll(tiles)} onPaintVariant={(index) => void paintScroll(undefined, index)} onRevertTile={revertTile}
          overview={{ url: overviewUrl, state: overviewState, versions: map.canvas?.overviewVersions.length ?? 0 }} onPaintOverview={() => void paintWholeOverview()}
          onRevertOverview={() => mutate((next) => { const canvas = next.maps.find((item) => item.id === map.id)?.canvas; if (!canvas?.overviewVersions.length) return; canvas.overviewAssetId = canvas.overviewVersions[canvas.overviewVersions.length - 1]; canvas.overviewVersions = canvas.overviewVersions.slice(0, -1); })}
          onPaintBlock={(regionId, edge) => void paintRegionBlock(regionId, edge)} onPaintTokens={(kind, method, owners) => void paintMapTokens(kind, method, owners)}
          onEnterPlace={enterPlace} onInteriorPlace={(placeId) => { const interior = interiorOf(atlas, placeId); if (interior) setActionMap(interior.id); else void run("绘制内部结构", { mode: "interior", placeId }); }}
          characterOwner={(name) => characterOwner(project, name)} /> : null}
      </div>
      {styleOpen ? <StyleLibraryDialog projectId={projectId} currentStyleId={style?.id ?? null} onUse={applyStyle} onClose={() => setStyleOpen(false)} /> : null}
      {actionMap && atlas.maps.some((item) => item.id === actionMap) ? <MapActionDialog projectId={projectId} atlas={atlas} map={atlas.maps.find((item) => item.id === actionMap) as Atlas["maps"][number]} onClose={() => setActionMap(null)} onRun={(request) => void runAction(request)} /> : null}
    </div>
  );
}
