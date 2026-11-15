// The image library of a work: `images/index.json` plus the binary files next to it.
import { dailyHost } from "../host";
import { uniqueId } from "../domain/ids";
import { arrayValue, asRecord, stringArray, stringValue, unixTimestamp } from "../domain/util";
import { readJson, writeJson } from "../storage/io";
import { withWriterMutationLock } from "../storage/lock";
import { projectDir } from "../storage/paths";
import { DEFAULT_LINK, isImageOwner, SINGLE_ROLES, type ImageAsset, type ImageLibrary, type ImageLink, type ImageRole } from "./schema";

export function imagesDir(projectId: string) { return `${projectDir(projectId)}/images`; }
export function imageFilesDir(projectId: string) { return `${imagesDir(projectId)}/files`; }
export function imageFilePath(projectId: string, asset: Pick<ImageAsset, "file">) { return `${imageFilesDir(projectId)}/${asset.file}`; }
function indexFile(projectId: string) { return `${imagesDir(projectId)}/index.json`; }

const SAFE_FILE = /^[\w.-]+$/;
function normalizeAsset(value: unknown): ImageAsset | null {
  const record = asRecord(value);
  const id = stringValue(record.id);
  const file = stringValue(record.file);
  if (!id || !SAFE_FILE.test(file) || file.startsWith(".")) return null;
  return { id, file, mime: stringValue(record.mime) || "image/png", bytes: Number(record.bytes) || 0, prompt: stringValue(record.prompt), caption: stringValue(record.caption), model: stringValue(record.model), quality: stringValue(record.quality), size: stringValue(record.size), owners: stringArray(record.owners, 200).filter(isImageOwner), source: record.source === "upload" ? "upload" : "generated", requestId: typeof record.requestId === "string" ? record.requestId : null, createdAt: Number(record.createdAt) || 0, links: normalizeLinks(record.links) };
}

const ROLES = new Set<ImageRole>(["base", "avatar", "thumb", "icon", "other"]);
function normalizeLinks(value: unknown): Record<string, ImageLink> {
  const links: Record<string, ImageLink> = {};
  for (const [owner, raw] of Object.entries(asRecord(value))) {
    if (!isImageOwner(owner)) continue;
    const link = asRecord(raw);
    links[owner] = { role: ROLES.has(link.role as ImageRole) ? link.role as ImageRole : "other", tags: stringArray(link.tags, 20), chapterId: typeof link.chapterId === "string" && link.chapterId ? link.chapterId : null, note: stringValue(link.note) };
  }
  return links;
}

/** Puts `link` on the asset for `owner`, keeping one image per owner in the single-image roles. */
function applyLink(library: ImageLibrary, asset: ImageAsset, owner: string, patch: Partial<ImageLink>) {
  if (!asset.owners.includes(owner)) asset.owners.push(owner);
  const next = { ...(asset.links[owner] ?? DEFAULT_LINK), ...patch };
  if (SINGLE_ROLES.includes(next.role)) for (const other of library.assets) if (other !== asset && other.links[owner]?.role === next.role) other.links[owner] = { ...other.links[owner], role: "other" };
  asset.links[owner] = next;
}

export function setImageLink(projectId: string, assetId: string, owner: string, patch: Partial<ImageLink>) {
  return mutateImageLibrary(projectId, (library) => { const asset = library.assets.find((item) => item.id === assetId); if (asset) applyLink(library, asset, owner, patch); });
}

/** Saves an image made in the plugin (a crop, a slice of a sheet) as a library asset linked to its owner. */
export async function addDerivedImage(projectId: string, input: { base64: string; mime: "image/png" | "image/webp"; caption: string; prompt?: string; owner: string; link: Partial<ImageLink> }): Promise<ImageAsset> {
  const id = uniqueId("img");
  const file = `${id}.${input.mime === "image/png" ? "png" : "webp"}`;
  await dailyHost().files.writeBase64(`${imageFilesDir(projectId)}/${file}`, input.base64);
  const asset: ImageAsset = { id, file, mime: input.mime, bytes: Math.round(input.base64.length * 0.75), prompt: input.prompt ?? "", caption: input.caption, model: "", quality: "", size: "", owners: [], source: "generated", requestId: null, createdAt: unixTimestamp(), links: {} };
  await mutateImageLibrary(projectId, (library) => { library.assets.push(asset); applyLink(library, asset, input.owner, input.link); });
  return asset;
}

export function normalizeLibrary(value: unknown): ImageLibrary {
  const record = asRecord(value);
  return { version: 1, style: stringValue(record.style), assets: arrayValue(record.assets).flatMap((item) => normalizeAsset(item) ?? []) };
}

type Listener = (projectId: string) => void;
const listeners = new Set<Listener>();
export function subscribeImageLibrary(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }

export async function loadImageLibrary(projectId: string): Promise<ImageLibrary> {
  return normalizeLibrary(await readJson(indexFile(projectId)));
}

export async function mutateImageLibrary<T>(projectId: string, mutate: (library: ImageLibrary) => T): Promise<T> {
  const result = await withWriterMutationLock(async () => {
    const library = await loadImageLibrary(projectId);
    const value = mutate(library);
    await writeJson(indexFile(projectId), library);
    return value;
  });
  for (const listener of listeners) listener(projectId);
  return result;
}

export function addAssets(projectId: string, assets: ImageAsset[]) { return mutateImageLibrary(projectId, (library) => { library.assets.push(...assets.filter((asset) => !library.assets.some((existing) => existing.id === asset.id))); return assets; }); }
export function setImageStyle(projectId: string, style: string) { return mutateImageLibrary(projectId, (library) => { library.style = style; }); }

export function attachImage(projectId: string, assetId: string, owner: string, link?: Partial<ImageLink>) {
  return mutateImageLibrary(projectId, (library) => {
    const asset = library.assets.find((item) => item.id === assetId);
    if (!asset) return;
    if (link) applyLink(library, asset, owner, link);
    else if (!asset.owners.includes(owner)) asset.owners.push(owner);
  });
}

export function detachImage(projectId: string, assetId: string, owner: string) {
  return mutateImageLibrary(projectId, (library) => {
    const asset = library.assets.find((item) => item.id === assetId);
    if (!asset) return;
    asset.owners = asset.owners.filter((item) => item !== owner);
    delete asset.links[owner];
  });
}

export function setImageCaption(projectId: string, assetId: string, caption: string) {
  return mutateImageLibrary(projectId, (library) => {
    const asset = library.assets.find((item) => item.id === assetId);
    if (asset) asset.caption = caption;
  });
}

export async function deleteImage(projectId: string, assetId: string) {
  const removed = await mutateImageLibrary(projectId, (library) => {
    const asset = library.assets.find((item) => item.id === assetId) ?? null;
    library.assets = library.assets.filter((item) => item.id !== assetId);
    return asset;
  });
  if (removed) await dailyHost().files.remove(imageFilePath(projectId, removed));
  forgetImageUrl(projectId, assetId);
}

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
/** Files above this cannot pass the host's 16 MiB request limit once encoded. */
export const MAX_UPLOAD_BYTES = 11 * 1024 * 1024;

export async function addUploadedImage(projectId: string, input: { base64: string; mime: string; bytes: number; name: string; owners: string[] }): Promise<ImageAsset> {
  const extension = EXTENSIONS[input.mime];
  if (!extension) throw new Error("只支持 PNG、JPEG、WebP 或 GIF 图片。");
  if (input.bytes > MAX_UPLOAD_BYTES) throw new Error("图片超过 11 MB，请压缩后再上传。");
  const id = uniqueId("img");
  const file = `${id}.${extension}`;
  await dailyHost().files.writeBase64(`${imageFilesDir(projectId)}/${file}`, input.base64);
  const asset: ImageAsset = { id, file, mime: input.mime, bytes: input.bytes, prompt: "", caption: input.name.replace(/\.[^.]+$/, ""), model: "", quality: "", size: "", owners: input.owners, source: "upload", requestId: null, createdAt: unixTimestamp(), links: {} };
  await addAssets(projectId, [asset]);
  return asset;
}

// ---------- displaying images ----------
let activeProjectId: string | null = null;
/** Editor widgets and Markdown only know an asset id; they resolve it against the open work. */
export function setActiveImageProject(projectId: string | null) { activeProjectId = projectId; }

const MAX_CACHED_URLS = 80;
const urls = new Map<string, Promise<string>>();

function forgetImageUrl(projectId: string, assetId: string) { urls.delete(`${projectId}/${assetId}`); }

export function imageDataUrl(projectId: string, asset: ImageAsset): Promise<string> {
  const key = `${projectId}/${asset.id}`;
  const cached = urls.get(key);
  if (cached) { urls.delete(key); urls.set(key, cached); return cached; }
  const url = dailyHost().files.readBase64(imageFilePath(projectId, asset)).then((base64) => `data:${asset.mime};base64,${base64}`);
  urls.set(key, url);
  url.catch(() => urls.delete(key));
  while (urls.size > MAX_CACHED_URLS) urls.delete(urls.keys().next().value as string);
  return url;
}

/** Resolves an asset of the open work to something an `<img>` can show. */
export async function activeImageUrl(assetId: string): Promise<string> {
  const projectId = activeProjectId;
  if (!projectId) throw new Error("没有打开的作品。");
  const asset = (await loadImageLibrary(projectId)).assets.find((item) => item.id === assetId);
  if (!asset) throw new Error("图片不存在或已被删除。");
  return imageDataUrl(projectId, asset);
}
