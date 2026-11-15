// Pixel work the painting pipeline needs: rendering layout sketches, cutting reference crops out of the overview and
// the base map, slicing generated sheets into tokens and trimming their transparent margins. Runs on a canvas, which
// every Writer view has; tests swap in a stub.

/** One source image drawn into the output: a part of it (`sx..`) to a place (`dx..`), optionally clipped. */
export type RasterLayer = { url: string; sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number; clip?: { x: number; y: number; w: number; h: number } };

export type RasterBackend = {
  editMask?: (coverageSvg: string, feather: number) => Promise<string>;
  featheredPatch?: (baseUrl: string, generatedUrl: string, maskUrl: string, width: number, height: number) => Promise<string>;
  svgToPng: (svg: string) => Promise<string>;
  /** Draws the layers onto a `width`×`height` canvas; `circle` keeps a soft-edged disc. Returns base64 PNG. */
  compose: (width: number, height: number, layers: RasterLayer[], options?: { circle?: boolean; background?: string }) => Promise<string>;
  /** Cuts a part of an image given in fractions of its size (so its pixel size need not be known). */
  cropRelative: (url: string, box: { x: number; y: number; w: number; h: number }, out: { width: number; height: number }, options?: { circle?: boolean }) => Promise<string>;
  /** Cuts a sheet into `cols`×`rows` cells, trims transparent margins and centres each on a square. */
  slice: (url: string, cols: number, rows: number) => Promise<string[]>;
};

const images = new Map<string, Promise<HTMLImageElement>>();
function load(url: string): Promise<HTMLImageElement> {
  let cached = images.get(url);
  if (!cached) {
    const image = new Image();
    image.src = url;
    cached = image.decode().then(() => image);
    images.set(url, cached);
    cached.catch(() => images.delete(url));
    while (images.size > 40) images.delete(images.keys().next().value as string);
  }
  return cached;
}

function canvasOf(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建画布。");
  return { canvas, context };
}

const base64Of = (canvas: HTMLCanvasElement) => canvas.toDataURL("image/png").split(",")[1] ?? "";

/** The box around pixels that are not (almost) transparent. */
function opaqueBox(data: ImageData): { x: number; y: number; w: number; h: number } | null {
  let minX = data.width;
  let minY = data.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < data.height; y += 1) {
    for (let x = 0; x < data.width; x += 1) {
      if (data.data[(y * data.width + x) * 4 + 3] > 12) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export const domRaster: RasterBackend = {
  async editMask(svg, feather) {
    const image = await load(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    const { canvas, context } = canvasOf(image.width, image.height);
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const distance = new Float32Array(canvas.width * canvas.height);
    const w = canvas.width, h = canvas.height;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      distance[i] = pixels.data[i * 4] > 128 && x > 0 && y > 0 && x < w - 1 && y < h - 1 ? 1e6 : 0;
      if (x) distance[i] = Math.min(distance[i], distance[i - 1] + 1);
      if (y) distance[i] = Math.min(distance[i], distance[i - w] + 1);
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x < w - 1) distance[i] = Math.min(distance[i], distance[i + 1] + 1);
      if (y < h - 1) distance[i] = Math.min(distance[i], distance[i + w] + 1);
      const t = Math.max(0, Math.min(1, (distance[i] - 3) / feather));
      pixels.data[i * 4] = pixels.data[i * 4 + 1] = pixels.data[i * 4 + 2] = 255;
      pixels.data[i * 4 + 3] = Math.round(255 * (1 - t * t * (3 - 2 * t)));
    }
    context.putImageData(pixels, 0, 0);
    return base64Of(canvas);
  },
  async featheredPatch(baseUrl, generatedUrl, maskUrl, width, height) {
    const [base, generated, mask] = await Promise.all([load(baseUrl), load(generatedUrl), load(maskUrl)]);
    const { canvas, context } = canvasOf(width, height);
    const read = (image: HTMLImageElement) => { context.clearRect(0, 0, width, height); context.drawImage(image, 0, 0, width, height); return context.getImageData(0, 0, width, height); };
    const original = read(base), result = read(generated), stencil = read(mask);
    result.data.set(patchPixels(original.data, result.data, stencil.data));
    context.putImageData(result, 0, 0);
    return base64Of(canvas);
  },
  async svgToPng(svg) {
    const image = await load(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    const { canvas, context } = canvasOf(image.width, image.height);
    context.drawImage(image, 0, 0);
    return base64Of(canvas);
  },
  async compose(width, height, layers, options = {}) {
    const { canvas, context } = canvasOf(width, height);
    if (options.background) { context.fillStyle = options.background; context.fillRect(0, 0, canvas.width, canvas.height); }
    for (const layer of layers) {
      const image = await load(layer.url);
      context.save();
      if (layer.clip) { context.beginPath(); context.rect(layer.clip.x, layer.clip.y, layer.clip.w, layer.clip.h); context.clip(); }
      context.drawImage(image, layer.sx, layer.sy, layer.sw, layer.sh, layer.dx, layer.dy, layer.dw, layer.dh);
      context.restore();
    }
    if (options.circle) {
      const radius = Math.min(canvas.width, canvas.height) / 2;
      const gradient = context.createRadialGradient(canvas.width / 2, canvas.height / 2, radius * 0.82, canvas.width / 2, canvas.height / 2, radius);
      gradient.addColorStop(0, "rgba(0,0,0,1)");
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      context.globalCompositeOperation = "destination-in";
      context.fillStyle = gradient;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    return base64Of(canvas);
  },
  async cropRelative(url, box, out, options = {}) {
    const image = await load(url);
    return domRaster.compose(out.width, out.height, [{ url, sx: box.x * image.width, sy: box.y * image.height, sw: box.w * image.width, sh: box.h * image.height, dx: 0, dy: 0, dw: out.width, dh: out.height }], options);
  },
  async slice(url, cols, rows) {
    const image = await load(url);
    const cellW = image.width / cols;
    const cellH = image.height / rows;
    const out: string[] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const { canvas, context } = canvasOf(cellW, cellH);
        context.drawImage(image, col * cellW, row * cellH, cellW, cellH, 0, 0, cellW, cellH);
        const box = opaqueBox(context.getImageData(0, 0, canvas.width, canvas.height)) ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };
        const side = Math.ceil(Math.max(box.w, box.h) * 1.08);
        const square = canvasOf(side, side);
        square.context.drawImage(canvas, box.x, box.y, box.w, box.h, (side - box.w) / 2, (side - box.h) / 2, box.w, box.h);
        out.push(base64Of(square.canvas));
      }
    }
    return out;
  },
};

/** A transparent, colour-matched patch. Pixels outside the edit mask can never replace the accepted map. */
export function patchPixels(base: Uint8ClampedArray, generated: Uint8ClampedArray, mask: Uint8ClampedArray): Uint8ClampedArray {
  const delta = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < mask.length; i += 4) if (mask[i + 3] > 100 && mask[i + 3] < 240) {
    for (let c = 0; c < 3; c++) delta[c] += base[i + c] - generated[i + c];
    count++;
  }
  const output = new Uint8ClampedArray(generated);
  for (let i = 0; i < output.length; i += 4) {
    for (let c = 0; c < 3; c++) output[i + c] += count ? Math.max(-40, Math.min(40, delta[c] / count)) : 0;
    output[i + 3] = Math.round(generated[i + 3] * (1 - mask[i + 3] / 255));
  }
  return output;
}
