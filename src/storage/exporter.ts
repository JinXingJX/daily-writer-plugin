import { dailyHost } from "../host";
import { orderedChapters, sortedVolumes } from "../domain/documents";
import { slugify } from "../domain/ids";
import { chapterMarkdown, characterMarkdown, manuscriptChapterText, relationsMarkdown, storyMapMarkdown } from "../domain/markdown";
import { asRecord } from "../domain/util";
import type { WriterExportResult, WriterProject } from "../types";
import { imageIdsIn, replaceImageReferences, type ImageAsset } from "../images/schema";
import { imageFilePath, loadImageLibrary } from "../images/store";
import { readJson, writeJson } from "./io";
import { withWriterMutationLock } from "./lock";
import { exportManifestFile } from "./paths";
import { loadChapterText } from "./projectStore";

const WRITING_DIR = "writing";
type ExportManifest = { root: string; files: string[] };
export type ExportOptions = { finalOnly?: boolean; onProgress?: (done: number, total: number) => void };

export async function exportProject(project: WriterProject, options: ExportOptions = {}): Promise<WriterExportResult> {
  return withWriterMutationLock(() => exportUnlocked(project, options));
}

async function exportUnlocked(project: WriterProject, options: ExportOptions): Promise<WriterExportResult> {
  const workspace = dailyHost().workspace;
  const root = `${WRITING_DIR}/${project.slug}`;
  const files: string[] = [];
  const write = async (path: string, content: string) => { await workspace.writeText(path, `${content.trim()}\n`); files.push(path); };
  const assets = new Map((await loadImageLibrary(project.id)).assets.map((asset) => [asset.id, asset]));
  const usedImages = new Map<string, ImageAsset>();
  /** Points image references at the exported copies; `prefix` is the path from the file to the export root. */
  const withImages = (content: string, prefix: string) => {
    for (const id of imageIdsIn(content)) { const asset = assets.get(id); if (asset) usedImages.set(id, asset); }
    return replaceImageReferences(content, (id) => { const asset = assets.get(id); return asset ? `${prefix}images/${asset.file}` : null; });
  };
  await workspace.ensureDir(`${root}/characters`);
  await workspace.ensureDir(`${root}/chapters`);
  await workspace.ensureDir(`${root}/manuscript`);
  await write(`${root}/world.md`, `# 世界观\n\n${withImages(project.worldview, "")}`);
  await write(`${root}/background.md`, `# 背景设定\n\n${withImages(project.background, "")}`);
  await write(`${root}/outline.md`, `# 全书大纲\n\n${withImages(project.outline, "")}`);
  await write(`${root}/style-guide.md`, `# 文风指南\n\n${project.styleGuide}`);
  await write(`${root}/story-map.md`, storyMapMarkdown(project));
  await write(`${root}/character-relations.md`, relationsMarkdown(project));
  const usedCharacters = new Set<string>();
  for (const character of project.characters) {
    await write(`${root}/characters/${uniqueName(slugify(character.name, character.id), character.id, usedCharacters)}.md`, characterMarkdown(project, character));
  }

  const chapters = orderedChapters(project).filter((chapter) => !options.finalOnly || chapter.status === "final");
  const volumes = sortedVolumes(project);
  const usedChapters = new Set<string>();
  const manuscripts = new Map<string, string[]>();
  for (let index = 0; index < chapters.length; index += 1) {
    const chapter = chapters[index];
    const content = await loadChapterText(project.id, chapter.id);
    const basename = `${String(index + 1).padStart(4, "0")}-${slugify(chapter.title, chapter.id)}`;
    await write(`${root}/chapters/${uniqueName(basename, chapter.id, usedChapters)}.md`, chapterMarkdown(project, chapter, withImages(content, "../")));
    const parts = manuscripts.get(chapter.volumeId) ?? [];
    parts.push(manuscriptChapterText(chapter, content));
    manuscripts.set(chapter.volumeId, parts);
    options.onProgress?.(index + 1, chapters.length);
  }
  for (const [volumeIndex, volume] of volumes.entries()) {
    const parts = manuscripts.get(volume.id);
    if (!parts?.length) continue;
    await write(`${root}/manuscript/${String(volumeIndex + 1).padStart(2, "0")}-${slugify(volume.title, volume.id)}.txt`, `${volume.title}\n\n${parts.join("\n\n")}`);
  }

  // A host without the copy call still exports the text; the links are simply dangling.
  if (usedImages.size && workspace.copyFromPluginFiles) {
    await workspace.ensureDir(`${root}/images`);
    for (const asset of usedImages.values()) {
      const target = `${root}/images/${asset.file}`;
      await workspace.copyFromPluginFiles(imageFilePath(project.id, asset), target);
      files.push(target);
    }
  }

  const previous = await readManifest(project.id);
  for (const stale of previous?.files ?? []) {
    if (!files.includes(stale) && isGeneratedExportPath(stale, previous?.root)) await workspace.removeFile(stale);
  }
  await writeJson(exportManifestFile(project.id), { root, files } satisfies ExportManifest);
  return { path: root, files };
}

function uniqueName(basename: string, id: string, used: Set<string>) {
  let candidate = basename;
  let suffix = 2;
  if (used.has(candidate)) candidate = `${basename}-${slugify(id, "item")}`;
  while (used.has(candidate)) { candidate = `${basename}-${slugify(id, "item")}-${suffix}`; suffix += 1; }
  used.add(candidate);
  return candidate;
}

async function readManifest(projectId: string): Promise<ExportManifest | null> {
  const stored = asRecord(await readJson(exportManifestFile(projectId)).catch(() => undefined));
  if (typeof stored.root !== "string" || !Array.isArray(stored.files)) return null;
  return { root: stored.root, files: stored.files.filter((value): value is string => typeof value === "string").slice(0, 50_000) };
}

/** Only files this exporter generates may be cleaned up. */
export function isGeneratedExportPath(path: string, root: string | undefined): boolean {
  if (!root || !/^writing\/[a-z0-9][a-z0-9-]*$/.test(root) || !path.startsWith(`${root}/`)) return false;
  const relative = path.slice(root.length + 1);
  if (["world.md", "background.md", "outline.md", "style-guide.md", "story-map.md", "character-relations.md"].includes(relative)) return true;
  return /^images\/[\w-]+\.(png|jpg|webp|gif)$/.test(relative) || /^(characters|chapters)\/[a-z0-9][a-z0-9-]*\.md$/.test(relative) || /^manuscript\/[a-z0-9][a-z0-9-]*\.txt$/.test(relative);
}
