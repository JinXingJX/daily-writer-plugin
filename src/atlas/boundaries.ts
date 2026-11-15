import { cellContains, regionCells, type RegionCell } from "./geometry";
import { ATLAS_HEIGHT, ATLAS_WIDTH, type AtlasMap, type AtlasRegion, type MapRect, type Point, type RegionGrid } from "./schema";

export function initialGrid(regions: AtlasRegion[], map: AtlasMap): RegionGrid {
  if (map.boundaries) return structuredClone(map.boundaries);
  const cols = 500, rows = 350;
  const shapes = regionCells(regions, map.surround);
  const ids = regions.map((r) => r.id);
  const cells = Array.from({ length: cols * rows }, (_, index) => {
    const p: Point = [(index % cols + 0.5) * ATLAS_WIDTH / cols, (Math.floor(index / cols) + 0.5) * ATLAS_HEIGHT / rows];
    return regions.findIndex((r) => { const c = shapes.get(r.id); return c && cellContains(c, p); }) + 1;
  });
  return { cols, rows, ids, cells };
}

export function ownerAtPoint(grid: RegionGrid, point: Point): number {
  if (point[0] < 0 || point[1] < 0 || point[0] >= ATLAS_WIDTH || point[1] >= ATLAS_HEIGHT) return 0;
  return grid.cells[Math.floor(point[1] * grid.rows / ATLAS_HEIGHT) * grid.cols + Math.floor(point[0] * grid.cols / ATLAS_WIDTH)] ?? 0;
}

/** Each stroke mutates only its swept disc, so unrelated borders cannot move. */
export function brushGrid(grid: RegionGrid, from: Point, to: Point, radius: number, owner: number): { changed: boolean; coastline: boolean; rect: MapRect } {
  const sx = ATLAS_WIDTH / grid.cols, sy = ATLAS_HEIGHT / grid.rows;
  const x0 = Math.max(0, Math.floor((Math.min(from[0], to[0]) - radius) / sx));
  const x1 = Math.min(grid.cols - 1, Math.ceil((Math.max(from[0], to[0]) + radius) / sx));
  const y0 = Math.max(0, Math.floor((Math.min(from[1], to[1]) - radius) / sy));
  const y1 = Math.min(grid.rows - 1, Math.ceil((Math.max(from[1], to[1]) + radius) / sy));
  const dx = to[0] - from[0], dy = to[1] - from[1], length = dx * dx + dy * dy;
  let changed = false, coastline = false;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const px = (x + 0.5) * sx, py = (y + 0.5) * sy;
    const t = length ? Math.max(0, Math.min(1, ((px - from[0]) * dx + (py - from[1]) * dy) / length)) : 0;
    if (Math.hypot(px - from[0] - t * dx, py - from[1] - t * dy) > radius) continue;
    const i = y * grid.cols + x, before = grid.cells[i];
    if (before === owner) continue;
    changed = true;
    coastline ||= !before || !owner;
    grid.cells[i] = owner;
  }
  return { changed, coastline, rect: { x: x0 * sx, y: y0 * sy, w: (x1 - x0 + 1) * sx, h: (y1 - y0 + 1) * sy } };
}

/** Trace the directed cell edges once; both sides use identical points. Collinear points are removed. */
export function gridCells(grid: RegionGrid, valid: Set<string>): Map<string, RegionCell> {
  type Edge = { a: number; b: number; dir: number };
  const edges = new Map<number, Edge[]>(), count = new Map<number, number>();
  const stride = grid.cols + 1;
  const at = (x: number, y: number) => x < 0 || y < 0 || x >= grid.cols || y >= grid.rows ? 0 : grid.cells[y * grid.cols + x];
  const add = (id: number, x: number, y: number, nx: number, ny: number, dir: number) => { const list = edges.get(id) ?? []; list.push({ a: y * stride + x, b: ny * stride + nx, dir }); edges.set(id, list); };
  for (let y = 0; y < grid.rows; y++) for (let x = 0; x < grid.cols; x++) {
    const id = at(x, y);
    if (!id || !valid.has(grid.ids[id - 1])) continue;
    count.set(id, (count.get(id) ?? 0) + 1);
    if (at(x, y - 1) !== id) add(id, x, y, x + 1, y, 0);
    if (at(x + 1, y) !== id) add(id, x + 1, y, x + 1, y + 1, 1);
    if (at(x, y + 1) !== id) add(id, x + 1, y + 1, x, y + 1, 2);
    if (at(x - 1, y) !== id) add(id, x, y + 1, x, y, 3);
  }
  const result = new Map<string, RegionCell>();
  for (const [id, list] of edges) {
    const byStart = new Map<number, Edge[]>();
    for (const edge of list) { const next = byStart.get(edge.a) ?? []; next.push(edge); byStart.set(edge.a, next); }
    const used = new Set<Edge>(), rings: Point[][] = [];
    for (const start of list) {
      if (used.has(start)) continue;
      const vertices: number[] = [];
      let edge: Edge | undefined = start;
      while (edge && !used.has(edge)) {
        used.add(edge); vertices.push(edge.a);
        if (edge.b === start.a) break;
        const direction: number = edge.dir;
        const priority = [1, 0, 3, 2];
        edge = byStart.get(edge.b)?.filter((e) => !used.has(e)).sort((a, b) => priority.indexOf((a.dir - direction + 4) % 4) - priority.indexOf((b.dir - direction + 4) % 4))[0];
      }
      const pts: Point[] = vertices.map((v) => [(v % stride) * ATLAS_WIDTH / grid.cols, Math.floor(v / stride) * ATLAS_HEIGHT / grid.rows]);
      const simple = pts.filter((p, i) => { const a = pts[(i + pts.length - 1) % pts.length], b = pts[(i + 1) % pts.length]; return (p[0] - a[0]) * (b[1] - p[1]) !== (p[1] - a[1]) * (b[0] - p[0]); });
      if (simple.length >= 3) rings.push(simple);
    }
    rings.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
    if (!rings.length) continue;
    const polygon = rings[0];
    // Pick an actual owned pixel near the bounding centre, including concave regions and archipelagos.
    const xs = polygon.map((p) => p[0]), ys = polygon.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    let centroid: Point = polygon[0], best = Infinity;
    for (let i = 0; i < grid.cells.length; i++) if (grid.cells[i] === id) {
      const p: Point = [(i % grid.cols + 0.5) * ATLAS_WIDTH / grid.cols, (Math.floor(i / grid.cols) + 0.5) * ATLAS_HEIGHT / grid.rows];
      const d = (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
      if (d < best) { best = d; centroid = p; }
    }
    result.set(grid.ids[id - 1], { polygon, rings, centroid, area: (count.get(id) ?? 0) * ATLAS_WIDTH * ATLAS_HEIGHT / grid.cols / grid.rows });
  }
  return result;
}
function signedArea(ring: Point[]) { return ring.reduce((sum, p, i) => { const q = ring[(i + 1) % ring.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0) / 2; }

/** Locally carry the boundary in either direction, sampling the old ownership field. */
export function dragGrid(grid: RegionGrid, from: Point, to: Point, radius: number) {
  const before = [...grid.cells];
  const sx = ATLAS_WIDTH / grid.cols, sy = ATLAS_HEIGHT / grid.rows;
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const reach = radius + Math.hypot(dx, dy);
  const x0 = Math.max(0, Math.floor((to[0] - reach) / sx)), x1 = Math.min(grid.cols - 1, Math.ceil((to[0] + reach) / sx));
  const y0 = Math.max(0, Math.floor((to[1] - reach) / sy)), y1 = Math.min(grid.rows - 1, Math.ceil((to[1] + reach) / sy));
  let changed = false, coastline = false;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const px = (x + 0.5) * sx, py = (y + 0.5) * sy;
    const distance = Math.hypot(px - to[0], py - to[1]);
    if (distance >= reach) continue;
    const t = Math.max(0, 1 - distance / reach);
    const weight = t * t * (3 - 2 * t);
    const sourceX = Math.floor((px - dx * weight) / sx), sourceY = Math.floor((py - dy * weight) / sy);
    const i = y * grid.cols + x;
    const owner = sourceX < 0 || sourceX >= grid.cols || sourceY < 0 || sourceY >= grid.rows ? 0 : before[sourceY * grid.cols + sourceX];
    if (owner === before[i]) continue;
    changed = true; coastline ||= !owner || !before[i]; grid.cells[i] = owner;
  }
  return { changed, coastline, rect: { x: x0 * sx, y: y0 * sy, w: (x1 - x0 + 1) * sx, h: (y1 - y0 + 1) * sy } };
}

/** Persist one edit and keep the geographic membership of pins consistent with the new ownership. */
export function applyBoundaryEdit(atlas: import("./schema").Atlas, mapId: string, grid: RegionGrid, rect: MapRect) {
  const map = atlas.maps.find((m) => m.id === mapId);
  if (!map) return;
  const regions = atlas.regions.filter((r) => r.mapId === mapId);
  const previous = initialGrid(regions, map);
  const water = new Set(regions.filter((r) => r.terrain === "sea" || r.terrain === "lake").map((r) => r.id));
  const isWater = (id: string | undefined) => !id || water.has(id);
  const coastline = grid.cells.some((owner, i) => isWater(grid.ids[owner - 1]) !== isWater(previous.ids[previous.cells[i] - 1]));
  map.boundaries = grid;
  const regionAt = (point: Point) => grid.ids[ownerAtPoint(grid, point) - 1] ?? null;
  for (const place of atlas.places) if (place.mapId === mapId) place.regionId = regionAt(place.point);
  for (const event of atlas.events) if (!event.placeId && event.mapId === mapId && event.point) event.regionId = regionAt(event.point);
  if (coastline && map.artwork) map.artwork.dirty = [...map.artwork.dirty, rect].slice(-50);
}
