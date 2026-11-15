import type { RasterBackend } from "../atlas/raster";

/** A raster backend for tests: every picture is the same tiny PNG, and composes are counted. */
export function stubRaster(): RasterBackend & { composed: number } {
  const raster = {
    composed: 0,
    editMask: async () => "UE5H",
    featheredPatch: async () => "UE5H",
    svgToPng: async () => "UE5H",
    compose: async () => { raster.composed += 1; return "UE5H"; },
    cropRelative: async () => "UE5H",
    slice: async (_url: string, cols: number, rows: number) => Array.from({ length: cols * rows }, () => "UE5H"),
  };
  return raster;
}
