// Image tools: the assistant generates pictures itself, files them in the library and proposes placing them on the page.
import { docTitle } from "../../domain/documents";
import { arrayValue, previewText, stringValue, trimmedString } from "../../domain/util";
import { friendlyImageError, generateImages } from "../../images/generate";
import { imageMarkup, isImageOwner, type AspectId, type ImageModelChoice, type ImageQuality } from "../../images/schema";
import { loadImageLibrary } from "../../images/store";
import { locateUnique } from "../../domain/anchors";
import { docRef, docText, recordText, type ToolHandler } from "./state";

const ASPECTS = new Set<string>(["3:2", "2:3", "1:1", "16:9", "9:16", "4:3"]);

const generateImage: ToolHandler = async ({ state, signal, input }) => {
  const prompt = stringValue(input.prompt).trim();
  if (!prompt) throw new Error("prompt 不能为空。");
  const owners = arrayValue(input.attachTo).filter(isImageOwner);
  const caption = stringValue(input.caption);
  const aspect = ASPECTS.has(stringValue(input.aspect)) ? (input.aspect as AspectId) : undefined;
  const model: ImageModelChoice = input.model === "flare" ? "flare" : "sunburst";
  const quality: ImageQuality = input.quality === "low" || input.quality === "high" ? input.quality : "medium";
  const referenceIds = arrayValue(input.referenceIds).filter((item): item is string => typeof item === "string").slice(0, 8);
  let created;
  try { created = await generateImages(state.projectId, { prompt, caption, aspect, model, quality, referenceIds, owners, count: 1, signal }); }
  catch (error) { throw new Error(friendlyImageError(error)); }
  const asset = created[0];
  const attached = owners.length ? `已挂到 ${owners.join("、")}。` : "";
  const quote = trimmedString(input.afterQuote);
  if (!quote && input.placeInText !== true) return { observation: `已生成图片 ${asset.id} 并存入图库。${attached}`, result: { imageId: asset.id } };
  const ref = docRef(state, input);
  const before = await docText(state, ref);
  let at = before.length;
  if (quote) {
    const located = locateUnique(before, quote);
    if (!located.ok) return { observation: `已生成图片 ${asset.id} 并存入图库，但没能定位插入位置：${located.message} 可以用 insertText 把 ${imageMarkup(asset.id, caption)} 单独成行插入。${attached}`, result: { imageId: asset.id } };
    at = located.range.end;
  }
  const lineEnd = before.indexOf("\n", at);
  const insertAt = lineEnd < 0 ? before.length : lineEnd;
  const head = before.slice(0, insertAt);
  const after = `${head}${head && !head.endsWith("\n") ? "\n" : ""}${imageMarkup(asset.id, caption)}${before.slice(insertAt)}`;
  const outcome = recordText(state, ref, before, after, stringValue(input.summary) || `插入图片：${previewText(caption || prompt, 30)}`);
  return { observation: `已生成图片 ${asset.id}，并作为修改建议插入《${docTitle(state.draft, ref)}》。${attached}${outcome.observation}`, result: { imageId: asset.id } };
};

const listImages: ToolHandler = async ({ state, input }) => {
  const library = await loadImageLibrary(state.projectId);
  const owner = trimmedString(input.owner);
  const assets = (owner ? library.assets.filter((asset) => asset.owners.includes(owner)) : library.assets).slice(-40).reverse();
  return { observation: `${library.style ? `全书美术风格：${library.style}\n` : ""}${assets.map((asset) => `- ${asset.id}｜${asset.caption || previewText(asset.prompt, 40)}｜${asset.owners.join("、") || "未挂接"}`).join("\n") || "图库还是空的。"}` };
};

export const IMAGE_TOOLS: Record<string, ToolHandler> = { "writer.generateImage": generateImage, "writer.listImages": listImages };
