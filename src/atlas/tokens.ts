// Which library images stand for things on the map: a character's avatar, an item's thumbnail, a place's token. The
// owners are the records' own: a character in the bible by its id (else by name), an item by its atlas id.
import { imageInRole, type ImageAsset, type ImageRole } from "../images/schema";
import type { WriterProject } from "../types";
import type { TokenTarget } from "./canvas";
import { PLACE_KIND_LABELS, type Atlas, type Point } from "./schema";

export function characterOwner(project: Pick<WriterProject, "characters"> | null | undefined, name: string): string {
  const character = project?.characters.find((item) => item.name === name || item.aliases.includes(name));
  return `character:${character?.id ?? name}`;
}
export const itemOwner = (itemId: string) => `item:${itemId}`;
export const placeOwner = (placeId: string) => `place:${placeId}`;

export type TokenKind = "places" | "characters" | "items";
export const TOKEN_KIND_LABELS: Record<TokenKind, string> = { places: "主要建筑和地点", characters: "人物头像", items: "物品缩略图" };

/** What can be given a token on this map, skipping owners that already have one unless `all`. */
export function tokenTargets(input: { atlas: Atlas; project: Pick<WriterProject, "characters"> | null; assets: ImageAsset[]; mapId: string; kind: TokenKind; characters?: { name: string; point: Point }[]; all?: boolean; limit?: number }): TokenTarget[] {
  const { atlas, project, assets, mapId, kind } = input;
  const has = (owner: string, role: ImageRole) => !input.all && Boolean(imageInRole(assets, owner, role));
  let targets: TokenTarget[] = [];
  if (kind === "places") {
    targets = atlas.places.filter((place) => place.mapId === mapId).sort((left, right) => right.importance - left.importance)
      .map((place) => ({ owner: placeOwner(place.id), role: "icon" as const, name: place.name, description: `${PLACE_KIND_LABELS[place.kind]}。${place.summary}`.slice(0, 200), point: place.point }));
    targets = targets.filter((target) => !has(target.owner, "icon"));
  } else if (kind === "characters") {
    targets = (input.characters ?? []).map((spot) => {
      const character = project?.characters.find((item) => item.name === spot.name || item.aliases.includes(spot.name));
      return { owner: characterOwner(project, spot.name), role: "avatar" as const, name: spot.name, description: character ? `${character.role}。${character.minimalTag} ${character.summary}`.slice(0, 200) : "", point: spot.point };
    }).filter((target) => !has(target.owner, "avatar"));
  } else {
    targets = atlas.items.map((item) => ({ owner: itemOwner(item.id), role: "thumb" as const, name: item.name, description: item.summary.slice(0, 200), point: null })).filter((target) => !has(target.owner, "thumb"));
  }
  return targets.slice(0, input.limit ?? 27);
}
