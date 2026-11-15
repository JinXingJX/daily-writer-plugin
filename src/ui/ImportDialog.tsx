import { FileUp, FolderOpen } from "lucide-react";
import { useMemo, useState } from "react";
import { dailyHost } from "../host";
import { countWords, formatWordCount } from "../domain/words";
import { importManuscript } from "../ingest/import";
import { DEFAULT_CHAPTER_PATTERN, decodeManuscript, splitManuscript, type SplitMode } from "../ingest/splitter";
import { Field, Modal, NumberInput, Spinner } from "./common";
import { useWriter } from "./useWriter";

export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const writer = useWriter();
  const [raw, setRaw] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [mode, setMode] = useState<SplitMode>("auto");
  const [targetLength, setTargetLength] = useState(4_000);
  const [pattern, setPattern] = useState("");
  const [target, setTarget] = useState<"new" | "append">("new");
  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceFiles, setWorkspaceFiles] = useState<string[] | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const split = useMemo(() => (raw ? splitManuscript(raw, { mode, targetLength, chapterPattern: pattern || undefined }) : null), [raw, mode, targetLength, pattern]);

  const loadFile = async (file: File) => {
    setFileName(file.name);
    setTitle((current) => current || file.name.replace(/\.(txt|md|markdown)$/i, ""));
    setRaw(decodeManuscript(await file.arrayBuffer()));
  };

  const browseWorkspace = async (path: string) => {
    try {
      const entries = (await dailyHost().workspace.list(path)).entries;
      setWorkspaceFiles([...entries.filter((entry) => entry.isDirectory).map((entry) => `${entry.name}/`), ...entries.filter((entry) => !entry.isDirectory && /\.(txt|md|markdown)$/i.test(entry.name)).map((entry) => entry.name)]);
      setWorkspacePath(path);
    } catch (error) { writer.notify("error", `无法读取工作区：${error instanceof Error ? error.message : String(error)}`); }
  };

  const loadWorkspaceFile = async (name: string) => {
    const path = workspacePath ? `${workspacePath.replace(/\/$/, "")}/${name}` : name;
    if (name.endsWith("/")) { void browseWorkspace(path.replace(/\/$/, "")); return; }
    try {
      setRaw(await dailyHost().workspace.readText(path));
      setFileName(path);
      setTitle((current) => current || name.replace(/\.(txt|md|markdown)$/i, ""));
    } catch (error) { writer.notify("error", `读取失败（工作区文件需小于 16MB，更大的文件请用“选择文件”）：${error instanceof Error ? error.message : String(error)}`); }
  };

  const run = async () => {
    if (!split?.chapters.length) return;
    setProgress("准备中…");
    try {
      await writer.flush();
      const project = await importManuscript(split, target === "append" && writer.project ? { projectId: writer.project.id } : { title: title || "导入的作品", genre: genre || undefined }, (done, total) => setProgress(`写入章节 ${done}/${total}`));
      await writer.reloadProjects();
      await writer.openProjectById(project.id);
      writer.notify("success", `已导入 ${split.chapters.length} 章。建议接着建立“故事记忆”，让 AI 读懂整部作品。`);
      onImported();
    } catch (error) {
      writer.notify("error", `导入失败：${error instanceof Error ? error.message : String(error)}`);
      setProgress(null);
    }
  };

  return (
    <Modal title="导入小说" width={760} onClose={() => { if (!progress) onClose(); }} footer={<>
      {progress ? <span className="w-muted"><Spinner size={12} /> {progress}</span> : null}
      <span className="w-spacer" />
      <button type="button" className="w-btn" onClick={onClose} disabled={Boolean(progress)}>取消</button>
      <button type="button" className="w-btn primary" disabled={!split?.chapters.length || Boolean(progress)} onClick={() => void run()}>导入 {split?.chapters.length ?? 0} 章</button>
    </>}>
      {!raw ? (
        <div className={`w-dropzone ${dragOver ? "over" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={(event) => { event.preventDefault(); setDragOver(false); const file = event.dataTransfer.files[0]; if (file) void loadFile(file); }}>
          <FileUp size={22} />
          <p>把 .txt / .md 文件拖到这里，支持 UTF-8 与 GBK 编码，几百万字也没问题。</p>
          <label className="w-btn primary"><input type="file" accept=".txt,.md,.markdown,text/plain" hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void loadFile(file); }} />选择文件</label>
          <button type="button" className="w-btn" onClick={() => void browseWorkspace("")}><FolderOpen size={13} />从工作区选择</button>
          {workspaceFiles ? (
            <div className="w-workspace-list">
              <div className="w-muted">/{workspacePath}{workspacePath ? <button type="button" className="w-link" onClick={() => void browseWorkspace(workspacePath.split("/").slice(0, -1).join("/"))}>上一级</button> : null}</div>
              {workspaceFiles.map((name) => <button key={name} type="button" className="w-entity-row" onClick={() => void loadWorkspaceFile(name)}>{name}</button>)}
              {!workspaceFiles.length ? <p className="w-muted">这里没有 .txt / .md 文件。</p> : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="w-import">
          <p><b>{fileName}</b> · 约 {formatWordCount(raw.length > 3_000_000 ? Math.round(raw.length * 0.9) : countWords(raw))}<button type="button" className="w-link" onClick={() => setRaw(null)}>换一个文件</button></p>
          <div className="w-inspector-grid">
            <Field label="切分方式">
              <select className="w-select" value={mode} onChange={(event) => setMode(event.currentTarget.value as SplitMode)}>
                <option value="auto">自动（识别“第X章/卷”，失败则按长度）</option>
                <option value="heading">按章节标题</option>
                <option value="length">按长度</option>
              </select>
            </Field>
            {mode === "length" ? <Field label="每章约多少字"><NumberInput step={500} min={1_000} max={50_000} fallback={4_000} value={targetLength} onCommit={setTargetLength} /></Field> : <Field label="自定义章节标题正则（可选）" hint="默认识别：第X章/回/节、序章、楔子、番外、Chapter N"><input className="w-input" value={pattern} placeholder={DEFAULT_CHAPTER_PATTERN.slice(0, 30) + "…"} onChange={(event) => setPattern(event.currentTarget.value)} /></Field>}
          </div>
          <div className="w-inspector-grid">
            <Field label="导入到">
              <select className="w-select" value={target} onChange={(event) => setTarget(event.currentTarget.value as "new" | "append")}>
                <option value="new">新作品</option>
                {writer.project ? <option value="append">追加到当前作品「{writer.project.title}」</option> : null}
              </select>
            </Field>
            {target === "new" ? <Field label="作品名"><input className="w-input" value={title} onChange={(event) => setTitle(event.currentTarget.value)} /></Field> : null}
            {target === "new" ? <Field label="类型"><input className="w-input" value={genre} placeholder="玄幻 / 都市 / 悬疑…" onChange={(event) => setGenre(event.currentTarget.value)} /></Field> : null}
          </div>
          {split ? (
            <>
              <p className="w-muted">识别到 {split.volumes.length ? `${split.volumes.length} 卷、` : ""}{split.chapters.length} 章（{split.mode === "heading" ? "按标题" : "按长度"}）。请检查前几章的切分是否正确：</p>
              <div className="w-import-preview">
                {split.chapters.slice(0, 80).map((chapter, index) => <div key={index} className="w-row small"><span className="w-tree-index">{index + 1}</span><span className="grow">{chapter.volumeTitle ? <span className="w-muted">{chapter.volumeTitle} · </span> : null}{chapter.title}</span><span className="w-muted">{chapter.content.length} 字</span></div>)}
                {split.chapters.length > 80 ? <p className="w-muted">… 还有 {split.chapters.length - 80} 章</p> : null}
              </div>
            </>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
