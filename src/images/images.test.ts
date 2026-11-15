import { beforeEach, describe, expect, it } from "vitest";
import { refreshChapterDerived } from "../domain/documents";
import { contentHash } from "../domain/ids";
import { countWords } from "../domain/words";
import { manuscriptChapterText } from "../domain/markdown";
import { exportProject, isGeneratedExportPath } from "../storage/exporter";
import { createProject, saveDraft } from "../storage/projectStore";
import { installFakeHost, type FakeHost } from "../test/fakeHost";
import { composePrompt, generateImages } from "./generate";
import { imageIdsIn, imageMarkup, IMAGE_LINE, insertImageLine, isImageOwner, replaceImageReferences, sizeForAspect, stripImageMarkup } from "./schema";
import { addUploadedImage, attachImage, deleteImage, detachImage, imageFilePath, loadImageLibrary, setImageStyle } from "./store";
import type { WriterChapterMeta } from "../types";

describe("image markup", () => {
  it("is one self-contained line and survives awkward captions", () => {
    const markup = imageMarkup("img-1", "雨夜[残卷]\n第二行");
    expect(markup).toBe("![雨夜 残卷 第二行](image:img-1)");
    expect(IMAGE_LINE.exec(markup)?.[2]).toBe("img-1");
  });

  it("leaves words, hashes and plain text as if the image were not there", () => {
    const body = "他推开门。\n![雨夜的客栈](image:img-1)\n屋里没人。";
    const plain = "他推开门。\n屋里没人。";
    expect(stripImageMarkup(body)).toBe(plain);
    expect(countWords(body)).toBe(countWords(plain));
    const chapter = { wordCount: 0, contentHash: "" } as WriterChapterMeta;
    refreshChapterDerived(chapter, body);
    expect(chapter.contentHash).toBe(contentHash(plain));
    expect(manuscriptChapterText({ title: "一" } as WriterChapterMeta, body)).not.toContain("image:");
  });

  it("does not touch ordinary text or inline mentions", () => {
    const text = "正文 ![不是整行](image:x) 继续";
    expect(stripImageMarkup(text)).toBe(text);
    expect(imageIdsIn(text)).toEqual(["x"]);
    expect(stripImageMarkup("没有图")).toBe("没有图");
  });

  it("inserts after the caret's line, never inside a paragraph", () => {
    const text = "第一段。\n第二段。";
    const { insertAt, insert, caret } = insertImageLine(text, 2, "![a](image:i)");
    expect(`${text.slice(0, insertAt)}${insert}${text.slice(insertAt)}`).toBe("第一段。\n![a](image:i)\n第二段。");
    expect(caret).toBe(insertAt + insert.length);
    expect(insertImageLine("", 0, "M").insert).toBe("M");
    expect(insertImageLine("尾", 1, "M").insert).toBe("\nM");
  });

  it("rewrites references only when a target exists", () => {
    const text = "![a](image:one)\n![b](image:two)";
    expect(replaceImageReferences(text, (id) => (id === "one" ? "images/one.webp" : null))).toBe("![a](images/one.webp)\n![b](image:two)");
  });

  it("validates owners and picks API-legal sizes", () => {
    expect(isImageOwner("character:abc-1")).toBe(true);
    expect(isImageOwner("../etc")).toBe(false);
    for (const aspect of ["3:2", "2:3", "1:1", "16:9", "9:16", "4:3"] as const) {
      const [width, height] = sizeForAspect(aspect).split("x").map(Number);
      expect(width % 16 + height % 16).toBe(0);
      expect(width * height).toBeGreaterThanOrEqual(655_360);
      expect(Math.max(width, height) / Math.min(width, height)).toBeLessThanOrEqual(3);
    }
  });
});

describe("image library", () => {
  let host: FakeHost;
  let projectId: string;
  beforeEach(async () => { host = installFakeHost(); projectId = (await createProject({ title: "测试" })).id; });

  it("records what the host saved and applies the art style", async () => {
    await setImageStyle(projectId, "水墨淡彩");
    const [asset] = await generateImages(projectId, { prompt: "雨夜的客栈", caption: "客栈", aspect: "1:1", quality: "high", model: "flare", owners: ["chapter:c1"] });
    expect(host.imageCalls[0]).toMatchObject({ prompt: composePrompt("雨夜的客栈", "水墨淡彩"), size: "1024x1024", quality: "high", model: "flare", format: "webp", n: 1, outputDir: `projects/${projectId}/images/files` });
    expect(host.imageCalls[0].references).toBeUndefined();
    expect(asset).toMatchObject({ caption: "客栈", prompt: "雨夜的客栈", owners: ["chapter:c1"], source: "generated" });
    expect(host.privateFiles.has(imageFilePath(projectId, asset))).toBe(true);
    expect((await loadImageLibrary(projectId)).assets).toHaveLength(1);
  });

  it("sends reference images by private path, skipping formats the API cannot edit", async () => {
    const [first] = await generateImages(projectId, { prompt: "立绘" });
    const gif = await addUploadedImage(projectId, { base64: "AA==", mime: "image/gif", bytes: 1, name: "a.gif", owners: [] });
    await generateImages(projectId, { prompt: "同一个人", referenceIds: [first.id, gif.id, "missing"] });
    expect(host.imageCalls[1].references).toEqual([imageFilePath(projectId, first)]);
  });

  it("keeps a failed request out of the library", async () => {
    host.setImage(() => { throw new Error("OpenAI HTTP 429 (insufficient_quota): no credit."); });
    await expect(generateImages(projectId, { prompt: "x" })).rejects.toThrow("insufficient_quota");
    expect((await loadImageLibrary(projectId)).assets).toHaveLength(0);
  });

  it("attaches, detaches and deletes", async () => {
    const [asset] = await generateImages(projectId, { prompt: "x" });
    await attachImage(projectId, asset.id, "character:lin");
    await attachImage(projectId, asset.id, "character:lin");
    expect((await loadImageLibrary(projectId)).assets[0].owners).toEqual(["character:lin"]);
    await detachImage(projectId, asset.id, "character:lin");
    expect((await loadImageLibrary(projectId)).assets[0].owners).toEqual([]);
    await deleteImage(projectId, asset.id);
    expect((await loadImageLibrary(projectId)).assets).toHaveLength(0);
    expect(host.privateFiles.has(imageFilePath(projectId, asset))).toBe(false);
  });

  it("rejects uploads the host could not carry or show", async () => {
    await expect(addUploadedImage(projectId, { base64: "AA==", mime: "image/bmp", bytes: 1, name: "a.bmp", owners: [] })).rejects.toThrow();
    await expect(addUploadedImage(projectId, { base64: "AA==", mime: "image/png", bytes: 12 * 1024 * 1024, name: "a.png", owners: [] })).rejects.toThrow("11 MB");
  });

  it("exports the images a chapter uses, with working relative links", async () => {
    const project = await createProject({ title: "导出" });
    const [asset] = await generateImages(project.id, { prompt: "x" });
    const chapter = { id: "c1", volumeId: project.volumes[0].id, title: "第一章", summary: "", status: "draft", rank: 1024, povCharacterId: null, storyNodeIds: [], wordCount: 0, contentHash: "", targetWords: 0, notes: "", updatedAt: 0 } as WriterChapterMeta;
    const base = { project, texts: {} };
    const body = `他推开门。\n${imageMarkup(asset.id, "客栈")}`;
    const next = { project: { ...project, chapters: [chapter] }, texts: { c1: body } };
    const { draft } = await saveDraft(base, next);
    const result = await exportProject(draft.project);
    const chapterFile = result.files.find((file) => file.includes("/chapters/")) as string;
    expect(host.workspaceFiles.get(chapterFile)).toContain(`![客栈](../images/${asset.file})`);
    expect(host.workspaceFiles.has(`${result.path}/images/${asset.file}`)).toBe(true);
    const manuscript = result.files.find((file) => file.endsWith(".txt")) as string;
    expect(host.workspaceFiles.get(manuscript)).not.toContain("image:");
    expect(isGeneratedExportPath(`${result.path}/images/${asset.file}`, result.path)).toBe(true);
    expect(isGeneratedExportPath(`${result.path}/images/../secret.txt`, result.path)).toBe(false);
  });
});
