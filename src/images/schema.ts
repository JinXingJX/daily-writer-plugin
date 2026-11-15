// Generated and uploaded images. The manuscript refers to them as `![caption](image:<id>)` on a line of its own;
// settings attach them through owner keys, so bible, story plan and map records need no image fields of their own.

export type ImageSource = "generated" | "upload";
export type ImageAsset = {
  id: string;
  /** File name inside `projects/<id>/images/files/`. */
  file: string;
  mime: string;
  bytes: number;
  prompt: string;
  caption: string;
  model: string;
  quality: string;
  size: string;
  /** What this image illustrates, e.g. `character:<id>`, `place:<id>`, `chapter:<id>`. */
  owners: string[];
  source: ImageSource;
  requestId: string | null;
  createdAt: number;
  /** How the image relates to each owner it is attached to; owners without an entry are plain "other" images. */
  links: Record<string, ImageLink>;
};

/**
 * base: the reference picture other images of the same subject follow (a character's full figure, an item's look).
 * avatar: a character's portrait, used as their token on the map. thumb: an item's thumbnail. icon: the small picture a
 * place, event or region shows on the map. other: everything else, sorted by tags.
 */
export type ImageRole = "base" | "avatar" | "thumb" | "icon" | "other";
export const IMAGE_ROLE_LABELS: Record<ImageRole, string> = { base: "基础图", avatar: "头像", thumb: "缩略图", icon: "地图组件", other: "其他" };
/** Roles an owner holds at most one image in. */
export const SINGLE_ROLES: ImageRole[] = ["avatar", "thumb", "icon"];
export type ImageLink = { role: ImageRole; tags: string[]; chapterId: string | null; note: string };
export const DEFAULT_LINK: ImageLink = { role: "other", tags: [], chapterId: null, note: "" };
export function linkOf(asset: ImageAsset, owner: string): ImageLink { return asset.links[owner] ?? DEFAULT_LINK; }
/** The owner's image in a role (the newest when several claim it). */
export function imageInRole(assets: ImageAsset[], owner: string, role: ImageRole): ImageAsset | undefined {
  return assets.filter((asset) => asset.owners.includes(owner) && linkOf(asset, owner).role === role).sort((left, right) => right.createdAt - left.createdAt)[0];
}
export type ImageLibrary = { version: 1; style: string; assets: ImageAsset[] };

export type ImageModelChoice = "sunburst" | "flare";
export type ImageQuality = "low" | "medium" | "high";
export const IMAGE_MODELS: { value: ImageModelChoice; label: string; hint: string }[] = [
  { value: "sunburst", label: "Sunburst", hint: "细节更好，用于定稿" },
  { value: "flare", label: "Flare", hint: "更快，用于试稿" },
];
export const IMAGE_QUALITIES: { value: ImageQuality; label: string }[] = [{ value: "low", label: "草图" }, { value: "medium", label: "标准" }, { value: "high", label: "精细" }];
export type AspectId = "3:2" | "2:3" | "1:1" | "16:9" | "9:16" | "4:3";
export const ASPECTS: { value: AspectId; label: string; size: string }[] = [
  { value: "3:2", label: "横幅 3:2", size: "1536x1024" },
  { value: "2:3", label: "竖幅 2:3", size: "1024x1536" },
  { value: "1:1", label: "方形 1:1", size: "1024x1024" },
  { value: "16:9", label: "宽幅 16:9", size: "1792x1008" },
  { value: "9:16", label: "长竖 9:16", size: "1008x1792" },
  { value: "4:3", label: "横幅 4:3", size: "1408x1056" },
];
export function sizeForAspect(aspect: AspectId | undefined) { return (ASPECTS.find((item) => item.value === aspect) ?? ASPECTS[0]).size; }

// Characters known only by name on the map use their name; names may be Chinese.
const OWNER_PATTERN = /^(character|faction|node|entity|item|power|secret|map|region|place|event|chapter|doc):[^\s:]{1,80}$/u;
export function isImageOwner(value: unknown): value is string { return typeof value === "string" && OWNER_PATTERN.test(value); }

/** A line that holds nothing but an image. */
export const IMAGE_LINE = /^[ \t]*!\[([^\]\n]*)\]\(image:([A-Za-z0-9_-]+)\)[ \t]*$/;
const IMAGE_LINES = /^[ \t]*!\[[^\]\n]*\]\(image:[A-Za-z0-9_-]+\)[ \t]*(?:\r?\n|$)/gm;
const IMAGE_REFERENCE = /!\[[^\]\n]*\]\(image:([A-Za-z0-9_-]+)\)/g;

/** Square brackets and line breaks would end the image syntax early. */
function cleanCaption(caption: string) { return caption.replace(/[[\]\r\n]/g, " ").replace(/\s+/g, " ").trim(); }
export function imageMarkup(assetId: string, caption: string) { return `![${cleanCaption(caption)}](image:${assetId})`; }

/** The text without its illustrations: what counts as words, memory input and plain-text export. */
export function stripImageMarkup(text: string) { return text.includes("](image:") ? text.replace(IMAGE_LINES, "") : text; }

export function imageIdsIn(text: string): string[] {
  if (!text.includes("](image:")) return [];
  return [...new Set([...text.matchAll(IMAGE_REFERENCE)].map((match) => match[1]))];
}

/** Puts an image on its own line after the line containing `at`, and reports where the caret should go. */
export function insertImageLine(text: string, at: number, markup: string): { insertAt: number; insert: string; caret: number } {
  const next = text.indexOf("\n", at);
  const insertAt = next < 0 ? text.length : next;
  const before = text.slice(0, insertAt);
  const insert = `${before && !before.endsWith("\n") ? "\n" : ""}${markup}`;
  return { insertAt, insert, caret: insertAt + insert.length };
}

export function replaceImageReferences(text: string, url: (assetId: string, caption: string) => string | null) {
  if (!text.includes("](image:")) return text;
  return text.replace(/!\[([^\]\n]*)\]\(image:([A-Za-z0-9_-]+)\)/g, (whole, caption: string, id: string) => {
    const target = url(id, caption);
    return target === null ? whole : `![${caption}](${target})`;
  });
}
