// Image generation for the work: composes the prompt, calls the host and records the results in the library.
import type { ImageGenerateRequest, ImageGenerateResponse } from "@daily/plugin-sdk";
import { dailyHost } from "../host";
import { uniqueId } from "../domain/ids";
import { unixTimestamp } from "../domain/util";
import { addAssets, imageFilePath, imageFilesDir, loadImageLibrary, attachImage } from "./store";
import { sizeForAspect, type AspectId, type ImageAsset, type ImageLink, type ImageModelChoice, type ImageQuality } from "./schema";

import { runWriterTask, taskContext, taskRpc } from "../worker/taskClient";

export type GenerateImageOptions = {
  signal?: AbortSignal;
  prompt: string;
  caption?: string;
  model?: ImageModelChoice;
  quality?: ImageQuality;
  aspect?: AspectId;
  /** Exact `WIDTHxHEIGHT`, overriding `aspect`. */
  size?: string;
  count?: number;
  mask?: string;
  markup?: string;
  referenceIds?: string[];
  /** Plugin-private reference files that are not library assets, e.g. a rendered map layout. */
  referencePaths?: string[];
  owners?: string[];
  /** Leaves the work's art style out, for images that have their own (e.g. a map). */
  ignoreStyle?: boolean;
  /** Transparent backgrounds give map tokens and icons. */
  background?: "transparent" | "opaque" | "auto";
  /** How the image relates to each owner (role, tags, chapter, note). */
  link?: Partial<ImageLink>;
};

export type ImageAvailability = { available: boolean; reason: string };

/** `available` is false on an older Daily, or when no OpenAI key can be found. */
export async function imageAvailability(): Promise<ImageAvailability> {
  const image = dailyHost().image;
  if (!image) return { available: false, reason: "当前的 Daily 版本还不支持生成图片，请更新 Daily。" };
  try {
    const status = await image.status();
    return status.configured ? { available: true, reason: "" } : { available: false, reason: "还没有可用的 OpenAI API Key。请在 Daily 设置里添加官方 OpenAI 服务商，或设置环境变量 OPENAI_API_KEY。" };
  } catch (error) { return { available: false, reason: friendlyImageError(error) }; }
}

export function composePrompt(prompt: string, style: string) {
  const body = prompt.trim();
  return style.trim() ? `统一美术风格：${style.trim()}\n\n${body}` : body;
}

export async function generateImages(projectId: string, options: GenerateImageOptions): Promise<ImageAsset[]> {
  if (!taskContext(options.signal)) {
    const { signal, ...input } = options;
    return runWriterTask<ImageAsset[]>("writer.images", projectId, { projectId, options: input }, { signal });
  }
  const library = await loadImageLibrary(projectId);
  const references = (options.referenceIds ?? []).map((id) => library.assets.find((asset) => asset.id === id)).filter((asset): asset is ImageAsset => Boolean(asset)).filter((asset) => asset.mime !== "image/gif" && asset.mime !== "image/svg+xml");
  const model = options.model ?? "sunburst";
  const quality = options.quality ?? "medium";
  const referencePaths = [...(options.referencePaths ?? []), ...references.map((asset) => imageFilePath(projectId, asset))];
  const request: ImageGenerateRequest = {
    prompt: composePrompt(options.prompt, options.ignoreStyle ? "" : library.style),
    model, quality, format: "webp", compression: 90,
    ...(options.mask ? { mask: options.mask } : {}),
    ...(options.markup ? { markup: options.markup } : {}),
    ...(options.background ? { background: options.background } : {}),
    size: options.size ?? sizeForAspect(options.aspect),
    n: Math.max(1, Math.min(4, Math.round(options.count ?? 1))),
    outputDir: imageFilesDir(projectId),
    ...(referencePaths.length ? { references: referencePaths } : {}),
  };
  const response = await taskRpc<ImageGenerateResponse>(options.signal, "image.generate", request);
  const now = unixTimestamp();
  const assets = response.files.map((file): ImageAsset => ({ id: taskContext(options.signal) ? `img-${response.requestId ?? taskContext(options.signal)?.task.id}-${file.path.slice(file.path.lastIndexOf("/") + 1)}`.replace(/[^A-Za-z0-9_-]/g, "-") : uniqueId("img"), file: file.path.slice(file.path.lastIndexOf("/") + 1), mime: file.mime, bytes: file.bytes, prompt: options.prompt.trim(), caption: options.caption?.trim() ?? "", model: response.model, quality, size: request.size ?? "", owners: options.owners ?? [], source: "generated", requestId: response.requestId, createdAt: now, links: {} }));
  const added = await addAssets(projectId, assets);
  if (options.link) for (const asset of added) for (const owner of asset.owners) await attachImage(projectId, asset.id, owner, options.link);
  return options.link ? (await loadImageLibrary(projectId)).assets.filter((asset) => added.some((item) => item.id === asset.id)) : added;
}

export function friendlyImageError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/not configured/i.test(message)) return "还没有可用的 OpenAI API Key。请在 Daily 设置里添加官方 OpenAI 服务商，或设置环境变量 OPENAI_API_KEY。";
  if (/permissions are too broad/i.test(message)) return "GPT Image 的凭据文件权限过宽，请对它执行 chmod 600。";
  if (/insufficient_quota/.test(message)) return "OpenAI 账户额度不足，请充值或调整项目的额度上限。";
  if (/HTTP 401/.test(message)) return "OpenAI 拒绝了这个 API Key，请检查配置。";
  if (/HTTP 403|HTTP 404/.test(message)) return "这个 API 项目没有 GPT Image 2.6 的访问权限。";
  if (/moderation|safety/i.test(message)) return "提示词被 OpenAI 的内容审核拦下了，请修改后再试。";
  if (/HTTP 429/.test(message)) return "OpenAI 限流了，请稍后再试。";
  if (/may have processed/i.test(message)) return "图片请求中断了。OpenAI 可能已经处理并计费，未自动重试；确认后可再试一次。";
  if (/image\b.*undefined|Cannot read properties of undefined/i.test(message)) return "当前的 Daily 版本还不支持生成图片，请更新 Daily。";
  return message.replace(/\s+/g, " ").trim().slice(0, 300);
}
