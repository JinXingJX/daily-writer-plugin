import { onViewKeyDown } from "../../view";
import { AtlasRasterLayer } from "./AtlasRasterLayer";
import { brushGrid, dragGrid, initialGrid, ownerAtPoint, gridCells } from "../../atlas/boundaries";
import { Maximize, Minus, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cellPath, polygonPath, regionLabelSpot, smoothPath, terrainGlyphs, type RegionCell } from "../../atlas/geometry";
import { ATLAS_HEIGHT, ATLAS_WIDTH, type Atlas, type AtlasPlace, type AtlasRegion, type EventKind, type PlaceKind, type Point, type MapRect, type RegionGrid, type AtlasEvent } from "../../atlas/schema";
import { childMapOf, eventPosition, eventPoint, timeLabel, interiorOf, type MapPin, type TimeAxis } from "../../atlas/timeline";

export type AtlasSelection = { type: "region" | "place" | "event" | "route" | "character" | "item"; id: string } | null;
/** Click-to-add tools of the layout editor. */
export type AtlasTool = "region" | "place" | "event" | "route" | "boundary" | "brush" | "erase" | "module" | "markup";
export type AtlasLayers = { painted: boolean; terrain: boolean; owners: boolean; routes: boolean; labels: boolean; events: boolean; characters: boolean; items: boolean };
/** One tile of the painted scroll as shown: where it sits (overlap included), its picture, and its progress. */
export type PaintedTile = { index: number; rect: { x: number; y: number; w: number; h: number }; url: string | null; state: "queued" | "drawing" | "done" | "failed" | null; variant: boolean };
export type FocusRequest = { point: Point; nonce: number } | null;

type Props = {
  atlas: Atlas;
  mapId: string;
  regions: AtlasRegion[];
  cells: Map<string, RegionCell>;
  places: { place: AtlasPlace; point: Point; foreign: boolean }[];
  owners: Map<string, string>;
  ownerNames: string[];
  pins: MapPin[];
  axis: TimeAxis;
  cursor: number;
  trail: Point[];
  layers: AtlasLayers;
  selection: AtlasSelection;
  changed: Set<string>;
  baseImage: { url: string; opacity: number } | null;
  editing: boolean;
  focus: FocusRequest;
  tool: AtlasTool | null;
  /** Points of a route being drawn. */
  routeDraft: Point[];
  onPoint: (point: Point) => void;
  painted: PaintedTile[];
  /** The whole-map painting, shown under the tiles (and alone until they are painted). */
  overviewUrl: string | null;
  blocks: { id: string; polygon: Point[]; rect: { x: number; y: number; w: number; h: number }; url: string; edge: "distinct" | "blend" }[];
  /** Map tokens of places, by place id. */
  placeTokens: Map<string, string>;
  characters: { name: string; point: Point; token?: string }[];
  items: { id: string; name: string; point: Point; token?: string }[];
  terrainMarks: { regionId: string; terrain: string; label: string }[];
  onSelect: (selection: AtlasSelection) => void;
  onEnterRegion: (regionId: string) => void;
  /** Double-clicking a place with an interior map opens it. */
  onEnterPlace: (placeId: string) => void;
  onMovePlace: (placeId: string, point: Point) => void;
  onMoveEvent: (id: string, point: Point) => void;
  onStampPlace: (id: string) => void;
  onMoveRegion: (regionId: string, point: Point) => void;
  brushRadius: number;
  onBoundary: (grid: RegionGrid, coast: boolean, rect: MapRect) => void;
  onModuleRect: (rect: MapRect) => void;
  onMarkup: (points: Point[]) => void;
  markup: Point[];
  onInspect: () => void;
  onCursor: (position: number) => void;
  onOpenChapter: (id: string) => void;
  onEditEvent: (id: string, patch: Partial<AtlasEvent>) => void;
  onEditPlace: (id: string, patch: Partial<AtlasPlace>) => void;
  onContextAdd: (kind: "event" | "place", point: Point) => void;
  autoEvents: boolean;
  rasterMap?: boolean;
  modules?: { id: string; rect: MapRect; url: string }[];

};

const KIND_MARKS: Record<EventKind, string> = { battle: "战", meeting: "遇", discovery: "现", death: "亡", travel: "行", politics: "谋", disaster: "灾", ritual: "祭", other: "事" };
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 24;
const DRAG_THRESHOLD = 4;

function clampView(x: number, y: number, k: number) {
  const margin = 180;
  return { k, x: Math.min(margin, Math.max(ATLAS_WIDTH * (1 - k) - margin, x)), y: Math.min(margin, Math.max(ATLAS_HEIGHT * (1 - k) - margin, y)) };
}

function PlaceIcon({ kind, importance }: { kind: PlaceKind; importance: number }) {
  const size = 2.5 + importance * 1.4;
  switch (kind) {
    case "capital": return <><circle r={size + 3} className="ring" /><rect x={-size} y={-size} width={size * 2} height={size * 2} transform="rotate(45)" /></>;
    case "city": case "town": return <rect x={-size} y={-size} width={size * 2} height={size * 2} />;
    case "fortress": case "camp": return <path d={`M${-size} ${size}L0 ${-size * 1.2}L${size} ${size}Z`} />;
    case "sect": return <path d={`M${-size * 1.2} ${-size}H${size * 1.2}M${-size * 0.7} ${-size * 1.3}V${size}M${size * 0.7} ${-size * 1.3}V${size}`} className="line" />;
    case "ruin": return <rect x={-size} y={-size} width={size * 2} height={size * 2} transform="rotate(45)" className="hollow" />;
    case "dungeon": return <><circle r={size + 1} className="hollow" /><circle r={size * 0.4} /></>;
    case "port": return <path d={`M0 ${-size * 1.3}V${size}M${-size} ${size * 0.2}Q0 ${size * 1.8} ${size} ${size * 0.2}`} className="line" />;
    default: return <circle r={size} />;
  }
}

export function AtlasCanvas(props: Props) {
  const { atlas, regions, cells: storedCells, places, owners, ownerNames, pins, axis, cursor, trail, layers, selection, changed, baseImage, editing, focus, tool, routeDraft, onPoint, painted, overviewUrl, blocks, placeTokens, characters, items, terrainMarks, onSelect, onEnterRegion, onEnterPlace, onMovePlace, onMoveRegion } = props;
  const [boundaryPreview, setBoundaryPreview] = useState<RegionGrid | null>(null);
  const cells = useMemo(() => boundaryPreview ? gridCells(boundaryPreview, new Set(regions.map((r) => r.id))) : storedCells, [boundaryPreview, storedCells, regions]);
  const [box, setBox] = useState<MapRect | null>(null);
  const [ink, setInk] = useState<Point[]>([]);
  const [contextMenu, setContextMenu] = useState<Point | null>(null);
  const [hover, setHover] = useState<AtlasSelection>(null);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { onSelect(null); setContextMenu(null); setHover(null); } }; return onViewKeyDown(onKey); }, [onSelect]);
  const [fit, setFit] = useState(false);
  const [surface, setSurface] = useState({ width: 1000, height: 700 });
  const svgRef = useRef<SVGSVGElement>(null);
  const [rasterFailed, setRasterFailed] = useState(false);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [dragging, setDragging] = useState<{ type: "place" | "region" | "event"; id: string; point: Point } | null>(null);
  const gesture = useRef<{ startX: number; startY: number; viewX: number; viewY: number; moved: boolean; target: { type: "place" | "region" | "event"; id: string } | null } | null>(null);
  const suppressClick = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => { setView({ x: 0, y: 0, k: 1 }); setBoundaryPreview(null); setContextMenu(null); setHover(null); }, [props.mapId]);
  useEffect(() => { const svg = svgRef.current; if (!svg) return; const observer = new ResizeObserver(([entry]) => setSurface({ width: entry.contentRect.width, height: entry.contentRect.height })); observer.observe(svg); return () => observer.disconnect(); }, []);
  useEffect(() => { setBoundaryPreview(null); }, [storedCells]);
  const stopGesture = useRef<(() => void) | null>(null);
  useEffect(() => () => stopGesture.current?.(), []);


  const toMap = useCallback((clientX: number, clientY: number): Point => {
    const matrix = svgRef.current?.getScreenCTM();
    if (!matrix) return [0, 0];
    const { x, y, k } = viewRef.current;
    return [((clientX - matrix.e) / matrix.a - x) / k, ((clientY - matrix.f) / matrix.d - y) / k];
  }, []);

  const zoomAt = useCallback((factor: number, center?: Point) => {
    setView((current) => {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.k * factor));
      const [cx, cy] = center ?? [(ATLAS_WIDTH / 2 - current.x) / current.k, (ATLAS_HEIGHT / 2 - current.y) / current.k];
      return clampView(current.x + cx * (current.k - k), current.y + cy * (current.k - k), k);
    });
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => { event.preventDefault(); zoomAt(event.deltaY < 0 ? 1.18 : 1 / 1.18, toMap(event.clientX, event.clientY)); };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [toMap, zoomAt]);

  useEffect(() => {
    if (!focus) return;
    setView((current) => {
      const k = Math.max(current.k, 2);
      return clampView(ATLAS_WIDTH / 2 - focus.point[0] * k, ATLAS_HEIGHT / 2 - focus.point[1] * k, k);
    });
  }, [focus]);

  // The window listens during a drag, so releasing outside the map still ends it. Clicks land on their own targets.
  const onPointerDown = (event: React.PointerEvent, target: { type: "place" | "region" | "event"; id: string } | null = null) => {
    if (event.button !== 0) return;
    stopGesture.current?.();
    setContextMenu(null);
    if (["boundary", "brush", "erase", "module", "markup"].includes(tool ?? "")) {
      event.preventDefault(); event.stopPropagation();
      const start = toMap(event.clientX, event.clientY);
      const currentMap = atlas.maps.find((m) => m.id === props.mapId);
      if (!currentMap) return;
      const grid = ["boundary", "brush", "erase"].includes(tool ?? "") ? initialGrid(regions, currentMap) : null;
      const selected = selection?.type === "region" ? selection.id : null;
      let owner = 0;
      if (grid && tool === "brush") {
        const id = selected ?? grid.ids[ownerAtPoint(grid, start) - 1];
        if (!id) return;
        if (!grid.ids.includes(id)) grid.ids.push(id);
        owner = grid.ids.indexOf(id) + 1;
        onSelect({ type: "region", id });
      }
      let previous = start, touched = false, coast = false;
      let bounds: MapRect | null = null;
      const points: Point[] = [start];
      const apply = (point: Point) => {
        if (grid) {
          const result = tool === "boundary" ? dragGrid(grid, previous, point, props.brushRadius) : brushGrid(grid, previous, point, props.brushRadius, owner);
          touched ||= result.changed; coast ||= result.coastline;
          const r = result.rect;
          if (!bounds) bounds = r;
          else { const x = Math.min(bounds.x, r.x), y = Math.min(bounds.y, r.y); bounds = { x, y, w: Math.max(bounds.x + bounds.w, r.x + r.w) - x, h: Math.max(bounds.y + bounds.h, r.y + r.h) - y }; }
          setBoundaryPreview({ ...grid, cells: [...grid.cells] });
        } else if (tool === "module") setBox({ x: Math.min(start[0], point[0]), y: Math.min(start[1], point[1]), w: Math.abs(point[0] - start[0]), h: Math.abs(point[1] - start[1]) });
        else { points.push(point); setInk([...points]); }
        previous = point;
      };
      if (tool !== "boundary") apply(start);
      const move = (e: PointerEvent) => apply(toMap(e.clientX, e.clientY));
      const cleanup = () => { globalThis.removeEventListener("pointermove", move); globalThis.removeEventListener("pointerup", up); globalThis.removeEventListener("pointercancel", cancel); stopGesture.current = null; };
      const cancel = () => { cleanup(); setBoundaryPreview(null); setBox(null); setInk([]); };
      const up = (e: PointerEvent) => {
        apply(toMap(e.clientX, e.clientY)); cleanup(); suppressClick.current = true;
        if (grid && touched && bounds) props.onBoundary(grid, coast, bounds);
        else setBoundaryPreview(null);
        if (tool === "module") { const end = toMap(e.clientX, e.clientY); const x = Math.max(0, Math.min(1000, Math.min(start[0], end[0]))), y = Math.max(0, Math.min(700, Math.min(start[1], end[1]))); const w = Math.min(1000 - x, Math.abs(end[0] - start[0])), h = Math.min(700 - y, Math.abs(end[1] - start[1])); if (w >= 10 && h >= 10) props.onModuleRect({ x, y, w, h }); }
        if (tool === "markup") props.onMarkup(points);
        setBox(null); setInk([]);
      };
      stopGesture.current = cancel;
      globalThis.addEventListener("pointermove", move); globalThis.addEventListener("pointerup", up); globalThis.addEventListener("pointercancel", cancel);
      return;
    }
    if (target) event.stopPropagation();
    gesture.current = { startX: event.clientX, startY: event.clientY, viewX: viewRef.current.x, viewY: viewRef.current.y, moved: false, target };
    suppressClick.current = false;
    const onMove = (move: PointerEvent) => {
      const state = gesture.current;
      if (!state) return;
      const dx = move.clientX - state.startX;
      const dy = move.clientY - state.startY;
      if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      state.moved = true;
      if (state.target) { setDragging({ ...state.target, point: toMap(move.clientX, move.clientY) }); return; }
      const matrix = svgRef.current?.getScreenCTM();
      if (matrix) setView((current) => clampView(state.viewX + dx / matrix.a, state.viewY + dy / matrix.d, current.k));
    };
    const onUp = (up: PointerEvent) => {
      globalThis.removeEventListener("pointermove", onMove);
      globalThis.removeEventListener("pointerup", onUp);
      globalThis.removeEventListener("pointercancel", onCancel);
      stopGesture.current = null;
      const state = gesture.current;
      gesture.current = null;
      setDragging(null);
      if (!state?.moved) return;
      suppressClick.current = true;
      if (state.target) {
        const [x, y] = toMap(up.clientX, up.clientY);
        const point: Point = [Math.round(Math.max(0, Math.min(ATLAS_WIDTH, x))), Math.round(Math.max(0, Math.min(ATLAS_HEIGHT, y)))];
        if (state.target.type === "place") onMovePlace(state.target.id, point); else if (state.target.type === "event") props.onMoveEvent(state.target.id, point); else onMoveRegion(state.target.id, point);
      }
    };
    const onCancel = () => { globalThis.removeEventListener("pointermove", onMove); globalThis.removeEventListener("pointerup", onUp); globalThis.removeEventListener("pointercancel", onCancel); gesture.current = null; setDragging(null); stopGesture.current = null; };
    stopGesture.current = onCancel;
    globalThis.addEventListener("pointercancel", onCancel);
    globalThis.addEventListener("pointermove", onMove);
    globalThis.addEventListener("pointerup", onUp);
  };

  const click = (next: AtlasSelection) => (event: React.MouseEvent) => {
    event.stopPropagation();
    if (suppressClick.current) { suppressClick.current = false; return; }
    if (["boundary", "brush", "erase", "module", "markup"].includes(tool ?? "")) return;
    if (tool) {
      const [x, y] = toMap(event.clientX, event.clientY);
      onPoint([Math.round(Math.max(0, Math.min(ATLAS_WIDTH, x))), Math.round(Math.max(0, Math.min(ATLAS_HEIGHT, y)))]);
      return;
    }
    onSelect(next);
  };

  useEffect(() => setRasterFailed(false), [overviewUrl]);
  const rasterVisible = Boolean(props.rasterMap && !rasterFailed && overviewUrl);
  const land = useMemo(() => regions.filter((region) => cells.has(region.id) && region.terrain !== "sea" && region.terrain !== "lake"), [cells, regions]);
  const water = useMemo(() => regions.filter((region) => cells.has(region.id) && (region.terrain === "sea" || region.terrain === "lake")), [cells, regions]);
  const glyphs = useMemo(() => {
    const byTerrain = new Map<string, string>();
    for (const region of regions) { const cell = cells.get(region.id); if (cell) byTerrain.set(region.terrain, (byTerrain.get(region.terrain) ?? "") + terrainGlyphs(region, cell)); }
    return [...byTerrain];
  }, [cells, regions]);
  const labelSpots = useMemo(() => {
    const points = places.map((item) => item.point);
    return new Map(regions.flatMap((region) => { const cell = cells.get(region.id); return cell ? [[region.id, regionLabelSpot(cell, points)] as const] : []; }));
  }, [cells, places, regions]);
  const routes = atlas.routes.filter((route) => route.mapId === props.mapId && route.points.length >= 2);
  const viewportScale = (fit ? Math.min : Math.max)(surface.width / 1000, surface.height / 700) || 1;
  const labelScale = 1 / view.k / viewportScale;
  const showPlace = (importance: number) => importance >= 2 || (importance === 1 && view.k >= 1.25) || view.k >= 2.2;
  const selectedRegion = selection?.type === "region" ? selection.id : null;
  const showPainted = layers.painted && (Boolean(overviewUrl) || painted.some((tile) => tile.url));
  const feather = (0.12 / 1.24).toFixed(4);
  const featherEnd = (1 - 0.12 / 1.24).toFixed(4);

  const currentPin = props.autoEvents ? pins.find((p) => p.events.some((e) => eventPosition(axis, e) === cursor)) : null;
  const active = selection?.type === "event" || selection?.type === "place" ? selection : hover;
  const activeEvent = active?.type === "event" ? atlas.events.find((e) => e.id === active.id) : null;
  const activePlace = active?.type === "place" ? places.find((p) => p.place.id === active.id) : null;
  const located = activeEvent ? eventPoint(atlas, cells, props.mapId, activeEvent) : null;
  const cardPoint = contextMenu ?? activePlace?.point ?? located?.point ?? currentPin?.point;
  const cardEvents = activePlace ? atlas.events.filter((e) => e.placeId === activePlace.place.id) : activeEvent ? pins.find((p) => p.events.some((e) => e.id === activeEvent.id))?.events ?? [activeEvent] : currentPin?.events.filter((e) => eventPosition(axis, e) === cursor) ?? [];
  const selectedEvent = activeEvent ?? cardEvents[cardEvents.length - 1];
  const title = activePlace?.place.name ?? selectedEvent?.title ?? "";
  const cardWidth = Math.min(300, surface.width - 24);
  const mx = (1000 - surface.width / viewportScale) / 2, my = (700 - surface.height / viewportScale) / 2;
  const screenPoint = cardPoint ? { x: ((cardPoint[0] * view.k + view.x) - mx) * viewportScale, y: ((cardPoint[1] * view.k + view.y) - my) * viewportScale } : null;
  return (
    <div className="w-atlas-stage">
      {rasterVisible ? <AtlasRasterLayer width={surface.width} height={surface.height} view={view} fit={fit} overview={layers.painted ? overviewUrl : null} modules={layers.painted ? props.modules ?? [] : []} onError={() => setRasterFailed(true)} /> : null}
      <svg ref={svgRef} className={`w-atlas-svg ${editing ? "editing" : ""} ${tool ? "placing" : ""} ${showPainted ? "painted" : ""}`} viewBox={`0 0 ${ATLAS_WIDTH} ${ATLAS_HEIGHT}`} preserveAspectRatio={fit ? "xMidYMid meet" : "xMidYMid slice"} role="application" aria-label="世界地图" data-raster={rasterVisible} onPointerDown={(event) => onPointerDown(event)} onClick={click(null)} onContextMenu={(event) => { event.preventDefault(); setContextMenu(toMap(event.clientX, event.clientY)); }}>
        <defs>
          <linearGradient id="w-atlas-fx" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stopColor="#000" /><stop offset={feather} stopColor="#fff" /><stop offset={featherEnd} stopColor="#fff" /><stop offset="1" stopColor="#000" /></linearGradient>
          <linearGradient id="w-atlas-fy" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#000" /><stop offset={feather} stopColor="#fff" /><stop offset={featherEnd} stopColor="#fff" /><stop offset="1" stopColor="#000" /></linearGradient>
          <mask id="w-atlas-fy-mask" maskContentUnits="objectBoundingBox"><rect width="1" height="1" fill="url(#w-atlas-fy)" /></mask>
          <mask id="w-atlas-feather" maskContentUnits="objectBoundingBox"><rect width="1" height="1" fill="url(#w-atlas-fx)" mask="url(#w-atlas-fy-mask)" /></mask>
          <filter id="w-atlas-soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7" /></filter>
          <clipPath id="w-atlas-avatar"><circle r={12} /></clipPath>
          {blocks.map((block) => block.edge === "distinct"
            ? <clipPath key={block.id} id={`w-atlas-block-${block.id}`}><path d={polygonPath(block.polygon)} /></clipPath>
            : <mask key={block.id} id={`w-atlas-block-${block.id}`} maskUnits="userSpaceOnUse" x={block.rect.x - 20} y={block.rect.y - 20} width={block.rect.w + 40} height={block.rect.h + 40}><path d={polygonPath(block.polygon)} fill="#fff" filter="url(#w-atlas-soft)" /></mask>)}
          <pattern id="w-atlas-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0V8" className="w-atlas-hatch-line" /></pattern>
          <pattern id="w-atlas-waves" width="46" height="24" patternUnits="userSpaceOnUse"><path d="M2 14q5-5 10 0t10 0" className="w-atlas-wave" /><path d="M26 4q4-4 8 0t8 0" className="w-atlas-wave" /></pattern>
        </defs>
        <rect width={ATLAS_WIDTH} height={ATLAS_HEIGHT} className="w-atlas-sea" style={rasterVisible && layers.painted ? { fill: "transparent" } : undefined} />
        {!rasterVisible || !layers.painted ? <rect width={ATLAS_WIDTH} height={ATLAS_HEIGHT} fill="url(#w-atlas-waves)" /> : null}
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {(!rasterVisible || !layers.painted) && land.map((region) => <path key={`coast-${region.id}`} d={cellPath(cells.get(region.id) as RegionCell)} className="w-atlas-coast" />)}
          {(!rasterVisible || !layers.painted) && land.map((region) => <path key={region.id} d={cellPath(cells.get(region.id) as RegionCell)} className={`w-atlas-land t-${layers.terrain ? region.terrain : "plain"}`} />)}
          {(!rasterVisible || !layers.painted) && water.map((region) => <path key={region.id} d={cellPath(cells.get(region.id) as RegionCell)} className="w-atlas-inner-water" />)}
          {baseImage && !rasterVisible ? <image href={baseImage.url} width={ATLAS_WIDTH} height={ATLAS_HEIGHT} preserveAspectRatio="none" opacity={baseImage.opacity} /> : null}
          {layers.painted && overviewUrl && !rasterVisible ? <image href={overviewUrl} x={0} y={0} width={ATLAS_WIDTH} height={ATLAS_HEIGHT} preserveAspectRatio="none" /> : null}
          {showPainted ? painted.map((tile) => (tile.url ? <image key={`tile-${tile.index}`} href={tile.url} x={tile.rect.x} y={tile.rect.y} width={tile.rect.w} height={tile.rect.h} preserveAspectRatio="none" mask="url(#w-atlas-feather)" /> : null)) : null}
          {layers.painted ? blocks.map((block) => <g key={`block-${block.id}`} className={`w-atlas-block ${block.edge}`}>
            <image href={block.url} x={block.rect.x} y={block.rect.y} width={block.rect.w} height={block.rect.h} preserveAspectRatio="none" {...(block.edge === "distinct" ? { clipPath: `url(#w-atlas-block-${block.id})` } : { mask: `url(#w-atlas-block-${block.id})` })} />
            {block.edge === "distinct" ? <path d={polygonPath(block.polygon)} className="w-atlas-block-edge" /> : null}
          </g>) : null}
          {layers.painted && !rasterVisible ? props.modules?.map((m) => <image key={m.id} href={m.url} x={m.rect.x} y={m.rect.y} width={m.rect.w} height={m.rect.h} preserveAspectRatio="none" />) : null}
          {box ? <rect x={box.x} y={box.y} width={box.w} height={box.h} className="w-atlas-module-box" /> : null}
          {(ink.length ? ink : props.markup).length > 1 ? <path d={smoothPath(ink.length ? ink : props.markup)} className="w-atlas-markup" /> : null}
          {terrainMarks.map((mark) => { const cell = cells.get(mark.regionId); return cell ? <path key={`terrain-${mark.regionId}`} d={cellPath(cell)} className={`w-atlas-terrain-change t-${mark.terrain}`} /> : null; })}
          {layers.owners ? regions.map((region) => { const owner = owners.get(region.id); const cell = cells.get(region.id); return owner && cell ? <path key={`owner-${region.id}`} d={cellPath(cell)} className={`w-atlas-owner o-${ownerNames.indexOf(owner) % 8}`} /> : null; }) : null}
          {layers.terrain && !baseImage ? glyphs.map(([terrain, path]) => <path key={terrain} d={path} className={`w-atlas-glyph g-${terrain}`} />) : null}
          {painted.filter((tile) => tile.state && tile.state !== "done").map((tile) => <rect key={`state-${tile.index}`} x={tile.rect.x + tile.rect.w * 0.0968} y={tile.rect.y + tile.rect.h * 0.0968} width={tile.rect.w * 0.8064} height={tile.rect.h * 0.8064} className={`w-atlas-tile-state s-${tile.state}`} />)}
          {regions.map((region) => { const cell = cells.get(region.id); if (!cell) return null; return <path key={`hit-${region.id}`} d={cellPath(cell)} className={`w-atlas-region ${layers.owners ? "borders" : ""} ${selectedRegion === region.id ? "selected" : ""} ${changed.has(region.id) ? "changed" : ""}`} onClick={click({ type: "region", id: region.id })} onDoubleClick={(event) => { event.stopPropagation(); if (childMapOf(atlas, region.id)) onEnterRegion(region.id); }} />; })}
          {layers.routes ? routes.map((route) => <g key={route.id}>
            <path d={smoothPath(route.points)} className={`w-atlas-route r-${route.kind} ${changed.has(route.id) ? "changed" : ""} ${selection?.id === route.id ? "selected" : ""}`} />
            <path d={smoothPath(route.points)} className="w-atlas-route-hit" style={{ strokeWidth: 12 / view.k }} onClick={click({ type: "route", id: route.id })}><title>{route.name}</title></path>
          </g>) : null}
          {routeDraft.length ? <><path d={routeDraft.length > 1 ? smoothPath(routeDraft) : ""} className="w-atlas-route-draft" />{routeDraft.map((point, index) => <circle key={index} cx={point[0]} cy={point[1]} r={3.5 / view.k} className="w-atlas-route-draft-stop" />)}</> : null}
          {trail.length > 1 ? <path d={smoothPath(trail)} className="w-atlas-trail" /> : null}
          {trail.map((point, index) => <circle key={index} cx={point[0]} cy={point[1]} r={2.6 * labelScale} className="w-atlas-trail-stop" />)}
          {layers.labels ? regions.map((region) => {
            const cell = cells.get(region.id);
            if (!cell) return null;
            const point = dragging?.type === "region" && dragging.id === region.id ? dragging.point : region.labelPoint ?? (editing ? region.center : labelSpots.get(region.id)) ?? cell.centroid;
            const hasDetail = Boolean(childMapOf(atlas, region.id));
            const changedTerrain = terrainMarks.find((mark) => mark.regionId === region.id);
            return <g key={`label-${region.id}`} transform={`translate(${point[0]} ${point[1]}) scale(${labelScale})`} className={`w-atlas-region-label ${editing ? "draggable" : ""}`} onPointerDown={editing ? (event) => onPointerDown(event, { type: "region", id: region.id }) : undefined}>
              {editing ? <circle r={6} className="w-atlas-handle" /> : null}
              <text textAnchor="middle" y={editing ? -10 : 0}>{region.name}{hasDetail ? " ⌖" : ""}</text>
              {changedTerrain ? <text textAnchor="middle" y={editing ? 6 : 16} className="w-atlas-terrain-label">{changedTerrain.label}</text> : null}
            </g>;
          }) : null}
          {places.map(({ place, point, foreign }) => {
            if (!editing && !showPlace(place.importance) && selection?.id !== place.id) return null;
            const at = dragging?.type === "place" && dragging.id === place.id ? dragging.point : point;
            const canDrag = editing && !foreign;
            return <g key={place.id} transform={`translate(${at[0]} ${at[1]}) scale(${labelScale})`} role="button" tabIndex={0} aria-label={place.name} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect({ type: "place", id: place.id }); } }} onMouseEnter={() => setHover({ type: "place", id: place.id })} onMouseLeave={() => setHover(null)} className={`w-atlas-place ${selection?.id === place.id ? "selected" : ""} ${changed.has(place.id) ? "changed" : ""} ${canDrag ? "draggable" : ""}`} onClick={click({ type: "place", id: place.id })} onDoubleClick={(event) => { event.stopPropagation(); onEnterPlace(place.id); }} onPointerDown={canDrag ? (event) => onPointerDown(event, { type: "place", id: place.id }) : undefined}>
              {place.display !== "marker" && placeTokens.get(place.id) ? <>
                <rect x={-(14 + place.importance * 7)} y={-(26 + place.importance * 12)} width={28 + place.importance * 14} height={30 + place.importance * 14} className="hit" />
                <image href={placeTokens.get(place.id)} x={-(14 + place.importance * 7)} y={-(26 + place.importance * 12)} width={28 + place.importance * 14} height={28 + place.importance * 14} className="w-atlas-token" />
                {layers.labels ? <text textAnchor="middle" y={16} className="w-atlas-token-label">{place.name}</text> : null}
              </> : <>
                <circle r={18} className="hit" />
                <PlaceIcon kind={place.kind} importance={place.importance} />
                {layers.labels ? <text x={8 + place.importance * 2} y={4}>{place.name}</text> : null}
              </>}
            </g>;
          })}
          {layers.items ? items.map((item) => <g key={item.id} transform={`translate(${item.point[0]} ${item.point[1]}) scale(${labelScale})`} className={`w-atlas-item ${selection?.id === item.id ? "selected" : ""}`} onClick={click({ type: "item", id: item.id })}>
            <title>{item.name}</title>
            <circle r={12} className="hit" />
            {item.token ? <image href={item.token} x={-11} y={-11} width={22} height={22} className="w-atlas-token" /> : <rect x={-5} y={-5} width={10} height={10} transform="rotate(45)" className="gem" />}
            {layers.labels ? <text x={10} y={4}>{item.name}</text> : null}
          </g>) : null}
          {layers.characters ? characters.map((character) => <g key={character.name} transform={`translate(${character.point[0]} ${character.point[1]}) scale(${labelScale})`} className={`w-atlas-character ${selection?.type === "character" && selection.id === character.name ? "selected" : ""}`} onClick={click({ type: "character", id: character.name })}>
            <title>{character.name}</title>
            <circle r={character.token ? 13 : 11} className="face" />
            {character.token ? <image href={character.token} x={-12} y={-12} width={24} height={24} clipPath="url(#w-atlas-avatar)" preserveAspectRatio="xMidYMid slice" /> : <text textAnchor="middle" y={4} className="initial">{character.name.slice(0, 1)}</text>}
            {layers.labels ? <text x={14} y={4}>{character.name}</text> : null}
          </g>) : null}
          {layers.events ? pins.map((pin) => {
            const latest = pin.events[pin.events.length - 1];
            const position = eventPosition(axis, latest);
            const current = position === cursor;
            const selected = pin.events.some((event) => event.id === selection?.id);
            const planned = latest.chapterId === null;
            const changedPin = pin.events.some((event) => changed.has(event.id));
            return <g key={pin.key} transform={`translate(${dragging?.type === "event" && pin.events.some((e) => e.id === dragging.id) ? dragging.point[0] : pin.point[0]} ${dragging?.type === "event" && pin.events.some((e) => e.id === dragging.id) ? dragging.point[1] : pin.point[1]}) scale(${labelScale})`} role="button" tabIndex={0} aria-label={latest.title} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect({ type: "event", id: latest.id }); } }} onMouseEnter={() => setHover({ type: "event", id: latest.id })} onMouseLeave={() => setHover(null)} className={`w-atlas-pin ${current ? "current" : ""} ${selected ? "selected" : ""} ${planned ? "planned" : ""} ${changedPin ? "changed" : ""}`} onClick={click({ type: "event", id: latest.id })} onPointerDown={editing ? (event) => onPointerDown(event, { type: "event", id: latest.id }) : undefined}>
              <title>{pin.events.map((event) => event.title).join("\n")}</title>
              <g transform="translate(0 -17)">
                {current ? <circle r={15} className="pulse" /> : null}
                <circle r={10.5} className="seal" />
                <text textAnchor="middle" y={4}>{KIND_MARKS[latest.kind]}</text>
                {pin.events.length > 1 ? <g transform="translate(10 -9)"><circle r={6.5} className="count-bg" /><text textAnchor="middle" y={3} className="count">{pin.events.length}</text></g> : null}
              </g>
            </g>;
          }) : null}
        </g>
        <g transform={`translate(${ATLAS_WIDTH - 46} ${ATLAS_HEIGHT - 46})`} className="w-atlas-compass" aria-hidden="true">
          <circle r={20} /><path d="M0 -17L4 0L0 17L-4 0Z" /><path d="M-17 0L0 -3L17 0L0 3Z" className="minor" /><text textAnchor="middle" y={-23}>北</text>
        </g>
      </svg>
      {screenPoint && (contextMenu || title) ? <div className="w-atlas-map-card" role="dialog" aria-label={contextMenu ? "地图操作" : title} style={{ left: Math.max(12, Math.min(surface.width - cardWidth - 12, screenPoint.x + 18)), top: Math.max(12, Math.min(surface.height - 220, screenPoint.y - 24)), width: cardWidth }} onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" className="w-icon-btn small close" aria-label="关闭地图卡片" onClick={() => { onSelect(null); setHover(null); setContextMenu(null); }}><X size={12} /></button>
        {contextMenu ? <><strong>在这里添加</strong><button type="button" className="w-btn small" onClick={() => { props.onContextAdd("place", contextMenu); setContextMenu(null); }}>地点</button><button type="button" className="w-btn small" onClick={() => { props.onContextAdd("event", contextMenu); setContextMenu(null); }}>事件</button></> : <>
          <strong>{title}</strong>
          {selection?.type === "place" && activePlace ? <><input key={`${activePlace.place.id}-name`} className="w-input" aria-label="地点名称" defaultValue={activePlace.place.name} onBlur={(e) => { if (e.currentTarget.value.trim()) props.onEditPlace(activePlace.place.id, { name: e.currentTarget.value }); }} /><select className="w-select" aria-label="地点显示方式" value={activePlace.place.display ?? "icon"} onChange={(e) => props.onEditPlace(activePlace.place.id, { display: e.currentTarget.value as "icon" | "marker" })}><option value="icon">独立图标</option><option value="marker">通用标记（建筑在底图中）</option></select></> : null}
          {activePlace ? <p>{activePlace.place.summary || "此地点还没有描述"}</p> : null}
          {cardEvents.length > 1 ? <select className="w-select" aria-label="同位置事件" value={selectedEvent?.id} onChange={(e) => onSelect({ type: "event", id: e.currentTarget.value })}>{cardEvents.map((e) => <option key={e.id} value={e.id}>{timeLabel(axis, e)} · {e.title}</option>)}</select> : null}
          {selectedEvent ? <div className="w-atlas-card-event"><span className="w-muted">{timeLabel(axis, selectedEvent)}{selectedEvent.storyTime ? ` · ${selectedEvent.storyTime}` : ""}</span>
            <input key={`${selectedEvent.id}-title`} className="w-input" aria-label="事件标题" defaultValue={selectedEvent.title} onBlur={(e) => { if (e.currentTarget.value.trim()) props.onEditEvent(selectedEvent.id, { title: e.currentTarget.value, origin: "user" }); }} />
            <textarea key={`${selectedEvent.id}-summary`} className="w-textarea" aria-label="事件经过" rows={3} defaultValue={selectedEvent.summary} onBlur={(e) => props.onEditEvent(selectedEvent.id, { summary: e.currentTarget.value, origin: "user" })} />
            {selectedEvent.characters.length ? <span className="w-muted">{selectedEvent.characters.join("、")}</span> : null}
            <div className="w-row"><button type="button" className="w-btn small" disabled={eventPosition(axis, selectedEvent) < 0} onClick={() => props.onCursor(eventPosition(axis, selectedEvent))}>跳到这一刻</button>{selectedEvent.chapterId ? <button type="button" className="w-btn small" onClick={() => props.onOpenChapter(selectedEvent.chapterId!)}>打开章节</button> : null}</div>
          </div> : activePlace ? <span className="w-muted">还没有关联事件</span> : null}
          {activePlace ? <button type="button" className="w-btn small" onClick={() => props.onStampPlace(activePlace.place.id)}>局部绘制建筑，保留交互标记</button> : null}
          <div className="w-row">{activePlace && interiorOf(atlas, activePlace.place.id) ? <button type="button" className="w-btn small" onClick={() => onEnterPlace(activePlace.place.id)}>进入内部</button> : null}<button type="button" className="w-text-btn" onClick={props.onInspect}>完整编辑</button></div>
        </>}
      </div> : null}
      <div className="w-atlas-zoom" role="group" aria-label="缩放">
        <button type="button" aria-label="放大" onClick={() => zoomAt(1.4)}><Plus size={14} /></button>
        <button type="button" aria-label="缩小" onClick={() => zoomAt(1 / 1.4)}><Minus size={14} /></button>
        <button type="button" aria-label="显示全图" onClick={() => { setFit(true); setView({ x: 0, y: 0, k: 1 }); }}><Maximize size={13} /></button>
      </div>
    </div>
  );
}
