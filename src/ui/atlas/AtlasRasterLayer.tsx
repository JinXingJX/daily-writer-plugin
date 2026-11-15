import { useEffect, useRef } from "react";
import type { MapRect } from "../../atlas/schema";

const cache = new Map<string, Promise<HTMLImageElement>>();
function load(url: string) {
  let promise = cache.get(url);
  if (!promise) { const image = new Image(); image.src = url; promise = image.decode().then(() => image); cache.set(url, promise); promise.catch(() => cache.delete(url)); if (cache.size > 40) cache.delete(cache.keys().next().value!); }
  return promise;
}
/** Bitmap pixels stay on a canvas; SVG only handles labels, editable outlines and hit targets. */
export function AtlasRasterLayer({ width, height, view, fit, overview, modules, onError }: { width: number; height: number; view: { x: number; y: number; k: number }; fit: boolean; overview: string | null; modules: { id: string; rect: MapRect; url: string }[]; onError: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let alive = true;
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(width * dpr)), pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
    const layers = [...(overview ? [{ url: overview, rect: { x: 0, y: 0, w: 1000, h: 700 } }] : []), ...modules];
    void Promise.all(layers.map(async (layer) => ({ ...layer, image: await load(layer.url) }))).then((images) => {
      if (!alive) return;
      const context = canvas.getContext("2d"); if (!context) return;
      const scale = (fit ? Math.min : Math.max)(width / 1000, height / 700);
      context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, canvas.width, canvas.height);
      context.scale(dpr, dpr); context.translate((width - 1000 * scale) / 2, (height - 700 * scale) / 2); context.scale(scale, scale); context.translate(view.x, view.y); context.scale(view.k, view.k);
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
      for (const layer of images) context.drawImage(layer.image, layer.rect.x, layer.rect.y, layer.rect.w, layer.rect.h);
    }).catch(() => { if (alive) onError(); });
    return () => { alive = false; };
  }, [width, height, view, fit, overview, modules, onError]);
  return <canvas ref={ref} className="w-atlas-raster" aria-hidden="true" />;
}
