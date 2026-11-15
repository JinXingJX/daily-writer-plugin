// Layout of a map from region centers: a weighted Voronoi diagram with hand-drawn edges. Everything is deterministic,
// so a map looks the same on every open and moving one region only reshapes its neighbours.
import { ATLAS_HEIGHT, ATLAS_WIDTH, type AtlasRegion, type Point, type Terrain } from "./schema";

export function seededRandom(seed: string) {
  let hash = 1779033703 ^ seed.length;
  for (let index = 0; index < seed.length; index += 1) { hash = Math.imul(hash ^ seed.charCodeAt(index), 3432918353); hash = (hash << 13) | (hash >>> 19); }
  let state = hash >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

type Site = { id: string | null; point: Point; power: number };

/** Keeps the part of `polygon` where normal·p <= limit. */
function clip(polygon: Point[], normal: Point, limit: number): Point[] {
  const output: Point[] = [];
  const side = (point: Point) => normal[0] * point[0] + normal[1] * point[1] - limit;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const currentSide = side(current);
    const nextSide = side(next);
    if (currentSide <= 0) output.push(current);
    if ((currentSide < 0 && nextSide > 0) || (currentSide > 0 && nextSide < 0)) {
      const t = currentSide / (currentSide - nextSide);
      output.push([current[0] + t * (next[0] - current[0]), current[1] + t * (next[1] - current[1])]);
    }
  }
  return output;
}

function oceanRing(): Site[] {
  const sites: Site[] = [];
  const add = (x: number, y: number) => sites.push({ id: null, point: [x, y], power: 0 });
  const STEP = 70;
  const INSET = 8;
  for (let x = 0; x <= ATLAS_WIDTH; x += STEP) { add(x, INSET); add(x, ATLAS_HEIGHT - INSET); }
  for (let y = STEP; y < ATLAS_HEIGHT; y += STEP) { add(INSET, y); add(ATLAS_WIDTH - INSET, y); }
  return sites;
}

/** A region's weight scales its share of the map; 1 is neutral. */
const power = (weight: number) => (weight - 1) * 25_000;

function roundKey(point: Point) { return `${point[0].toFixed(1)},${point[1].toFixed(1)}`; }

/** Bends a straight edge the same way for both cells that share it, so borders stay closed. */
function roughEdge(from: Point, to: Point, depth = 3): Point[] {
  const forward = roundKey(from) <= roundKey(to);
  const [a, b] = forward ? [from, to] : [to, from];
  const random = seededRandom(`${roundKey(a)}|${roundKey(b)}`);
  const interior = (left: Point, right: Point, level: number): Point[] => {
    const length = Math.hypot(right[0] - left[0], right[1] - left[1]);
    if (level === 0 || length < 8) return [];
    const offset = (random() - 0.5) * length * 0.32;
    const mid: Point = [(left[0] + right[0]) / 2 - ((right[1] - left[1]) / length) * offset, (left[1] + right[1]) / 2 + ((right[0] - left[0]) / length) * offset];
    return [...interior(left, mid, level - 1), mid, ...interior(mid, right, level - 1)];
  };
  const points = interior(a, b, depth);
  return forward ? points : points.reverse();
}

export function roughen(polygon: Point[]): Point[] {
  const onFrame = (point: Point) => point[0] <= 0.01 || point[1] <= 0.01 || point[0] >= ATLAS_WIDTH - 0.01 || point[1] >= ATLAS_HEIGHT - 0.01;
  const output: Point[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    output.push(current);
    // Edges along the frame stay straight, or a land map would pull away from its border.
    if (!(onFrame(current) && onFrame(next))) output.push(...roughEdge(current, next));
  }
  return output;
}

export type RegionCell = { polygon: Point[]; rings?: Point[][]; centroid: Point; area: number };

/** The shape of every region on one map. A region with an empty cell (its center coincides with another) is left out. */
export function regionCells(regions: AtlasRegion[], surround: "sea" | "land"): Map<string, RegionCell> {
  const sites: Site[] = [...regions.map((region) => ({ id: region.id, point: region.center, power: power(region.weight) })), ...(surround === "sea" ? oceanRing() : [])];
  const frame: Point[] = [[0, 0], [ATLAS_WIDTH, 0], [ATLAS_WIDTH, ATLAS_HEIGHT], [0, ATLAS_HEIGHT]];
  const cells = new Map<string, RegionCell>();
  for (const site of sites) {
    if (site.id === null) continue;
    let polygon = frame;
    for (const other of sites) {
      if (other === site) continue;
      const normal: Point = [2 * (other.point[0] - site.point[0]), 2 * (other.point[1] - site.point[1])];
      if (normal[0] === 0 && normal[1] === 0) continue;
      const limit = other.point[0] ** 2 + other.point[1] ** 2 - site.point[0] ** 2 - site.point[1] ** 2 - other.power + site.power;
      polygon = clip(polygon, normal, limit);
      if (polygon.length < 3) break;
    }
    if (polygon.length < 3) continue;
    cells.set(site.id, { polygon: roughen(polygon), ...measure(polygon) });
  }
  return cells;
}

function measure(polygon: Point[]) {
  let doubled = 0;
  let x = 0;
  let y = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const [x0, y0] = polygon[index];
    const [x1, y1] = polygon[(index + 1) % polygon.length];
    const cross = x0 * y1 - x1 * y0;
    doubled += cross;
    x += (x0 + x1) * cross;
    y += (y0 + y1) * cross;
  }
  if (Math.abs(doubled) < 1e-6) return { centroid: polygon[0], area: 0 };
  const centroid: Point = [x / (3 * doubled), y / (3 * doubled)];
  return { centroid, area: Math.abs(doubled) / 2 };
}

export function pointInPolygon(point: Point, polygon: Point[]) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const [xi, yi] = polygon[index];
    const [xj, yj] = polygon[previous];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonPath(polygon: Point[]) {
  return `${polygon.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("")}Z`;
}

/** A smooth line through the points, for rivers and roads. */
export function smoothPath(points: Point[]) {
  if (points.length < 2) return "";
  let path = `M${points[0][0]} ${points[0][1]}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(0, index - 1)];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[Math.min(points.length - 1, index + 2)];
    path += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0]} ${p2[1]}`;
  }
  return path;
}

function glyph(terrain: Terrain, x: number, y: number, size: number, random: () => number): string {
  const f = (value: number) => value.toFixed(1);
  switch (terrain) {
    case "mountain": case "volcanic": return `M${f(x - size)} ${f(y + size * 0.7)}L${f(x)} ${f(y - size)}L${f(x + size)} ${f(y + size * 0.7)}M${f(x)} ${f(y - size)}L${f(x + size * 0.25)} ${f(y + size * 0.15)}`;
    case "forest": return `M${f(x - size * 0.6)} ${f(y + size * 0.5)}L${f(x)} ${f(y - size * 0.8)}L${f(x + size * 0.6)} ${f(y + size * 0.5)}ZM${f(x)} ${f(y + size * 0.5)}L${f(x)} ${f(y + size)}`;
    case "desert": return `M${f(x - size)} ${f(y)}Q${f(x)} ${f(y - size * 0.8)} ${f(x + size)} ${f(y)}`;
    case "marsh": return `M${f(x - size * 0.8)} ${f(y)}L${f(x + size * 0.8)} ${f(y)}M${f(x)} ${f(y)}L${f(x - size * 0.3)} ${f(y - size)}M${f(x)} ${f(y)}L${f(x + size * 0.3)} ${f(y - size)}`;
    case "tundra": return `M${f(x - size * 0.7)} ${f(y)}L${f(x + size * 0.7)} ${f(y)}M${f(x - size * 0.35)} ${f(y + size * 0.5)}L${f(x + size * 0.35)} ${f(y + size * 0.5)}`;
    case "wasteland": return `M${f(x - size * 0.6)} ${f(y + size * 0.4)}L${f(x - size * 0.1)} ${f(y - size * 0.3)}L${f(x + size * 0.3)} ${f(y + size * 0.2)}L${f(x + size * 0.7)} ${f(y - size * 0.4 * random())}`;
    case "city": return `M${f(x - size * 0.5)} ${f(y - size * 0.5)}h${f(size)}v${f(size)}h${f(-size)}Z`;
    case "plains": return `M${f(x - size * 0.5)} ${f(y)}q${f(size * 0.25)} ${f(-size * 0.5)} ${f(size * 0.5)} 0`;
    default: return "";
  }
}

const SPACING: Partial<Record<Terrain, number>> = { mountain: 30, volcanic: 34, forest: 24, desert: 42, marsh: 36, tundra: 40, wasteland: 44, city: 40, plains: 58 };

/** One path of terrain marks for a region; marks keep clear of the cell's border. */
export function terrainGlyphs(region: AtlasRegion, cell: RegionCell): string {
  const spacing = SPACING[region.terrain];
  if (!spacing) return "";
  const random = seededRandom(region.id);
  const xs = (cell.rings?.flat() ?? cell.polygon).map((point) => point[0]);
  const ys = (cell.rings?.flat() ?? cell.polygon).map((point) => point[1]);
  const size = region.terrain === "mountain" || region.terrain === "volcanic" ? 9 : 6;
  let path = "";
  for (let y = Math.min(...ys) + spacing / 2; y < Math.max(...ys); y += spacing) {
    for (let x = Math.min(...xs) + spacing / 2; x < Math.max(...xs); x += spacing) {
      const px = x + (random() - 0.5) * spacing * 0.7;
      const py = y + (random() - 0.5) * spacing * 0.7;
      const margin = size + 3;
      const inside = [[0, 0], [-margin, 0], [margin, 0], [0, -margin], [0, margin]].every(([dx, dy]) => cellContains(cell, [px + dx, py + dy]));
      if (inside) path += glyph(region.terrain, px, py, size, random);
    }
  }
  return path;
}

/** Where a region's name reads best: the first spot near the centroid that clears the places in it. */
export function regionLabelSpot(cell: RegionCell, places: Point[]): Point {
  const [x, y] = cell.centroid;
  const candidates: Point[] = [[x, y], [x, y + 36], [x, y - 36], [x - 56, y + 24], [x + 56, y + 24], [x - 56, y - 24], [x + 56, y - 24], [x, y + 64], [x, y - 64]];
  const clear = (point: Point) => cellContains(cell, point) && places.every((place) => Math.abs(place[0] - point[0]) > 62 || Math.abs(place[1] - point[1]) > 24);
  return candidates.find(clear) ?? [x, y];
}

/** A free spot in the cell for a place the model did not position, away from `taken`. */
export function freeSpot(cell: RegionCell, taken: Point[], seed: string): Point {
  const random = seededRandom(seed);
  const clear = (point: Point, gap: number) => cellContains(cell, point) && taken.every((other) => Math.hypot(other[0] - point[0], other[1] - point[1]) > gap);
  const reach = Math.sqrt(cell.area / Math.PI);
  for (const gap of [46, 30, 16]) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const angle = random() * Math.PI * 2;
      const distance = Math.sqrt(random()) * reach * 0.8;
      const point: Point = [Math.round(cell.centroid[0] + Math.cos(angle) * distance), Math.round(cell.centroid[1] + Math.sin(angle) * distance)];
      if (clear(point, gap)) return point;
    }
  }
  return cellContains(cell, cell.centroid) ? [Math.round(cell.centroid[0]), Math.round(cell.centroid[1])] : cell.polygon[0];
}

export type LayoutFrame = { x: number; y: number; w: number; h: number; width: number; height: number };
const FULL_FRAME: LayoutFrame = { x: 0, y: 0, w: ATLAS_WIDTH, h: ATLAS_HEIGHT, width: 1600, height: 1120 };

/** Layout-only rendering used as the composition reference when painting, of the whole map or one tile of it. */
export function layoutSvg(regions: AtlasRegion[], cells: Map<string, RegionCell>, places: { name: string; point: Point; importance: number }[], routes: { kind: string; points: Point[] }[], frame: LayoutFrame = FULL_FRAME): string {
  const shade: Partial<Record<Terrain, string>> = { sea: "#9db8c7", lake: "#9db8c7", mountain: "#9a9184", forest: "#8fa382", desert: "#d8c79c", marsh: "#a3aa8a", tundra: "#dfe3e0", volcanic: "#80665a", wasteland: "#b5a58c", city: "#b8b2a8" };
  const land = regions.flatMap((region) => { const cell = cells.get(region.id); return cell ? [`<path d="${cellPath(cell)}" fill-rule="evenodd" fill="${shade[region.terrain] ?? "#c7c39c"}" stroke="#6b6558" stroke-width="1"/>`] : []; }).join("");
  const lines = routes.filter((route) => route.points.length > 1).map((route) => `<path d="${smoothPath(route.points)}" fill="none" stroke="${route.kind === "river" ? "#5b86a0" : "#6b5a48"}" stroke-width="${route.kind === "river" ? 3 : 2}"/>`).join("");
  const dots = places.map((place) => `<circle cx="${place.point[0]}" cy="${place.point[1]}" r="${2 + place.importance * 2}" fill="#2b2925"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}" viewBox="${frame.x} ${frame.y} ${frame.w} ${frame.h}" preserveAspectRatio="none"><rect x="-200" y="-200" width="${ATLAS_WIDTH + 400}" height="${ATLAS_HEIGHT + 400}" fill="#9db8c7"/>${land}${lines}${dots}</svg>`;
}

/** Even-odd rings preserve islands and holes. All contours come from the same ownership grid. */
export function cellPath(cell: RegionCell): string { return (cell.rings ?? [cell.polygon]).map(polygonPath).join(""); }
export function cellContains(cell: RegionCell, point: Point): boolean {
  return (cell.rings ?? [cell.polygon]).reduce((inside, ring) => pointInPolygon(point, ring) ? !inside : inside, false);
}
