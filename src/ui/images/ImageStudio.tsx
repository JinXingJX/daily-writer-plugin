import { ImagePlus, Sparkles, Upload } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { dailyHost } from "../../host";
import { friendlyAiError } from "../../ai/client";
import { friendlyImageError, generateImages, imageAvailability, type ImageAvailability } from "../../images/generate";
import { draftImagePrompt } from "../../images/prompt";
import { ASPECTS, IMAGE_MODELS, IMAGE_QUALITIES, type AspectId, type ImageAsset, type ImageModelChoice, type ImageQuality } from "../../images/schema";
import { addUploadedImage, attachImage, MAX_UPLOAD_BYTES, setImageStyle } from "../../images/store";
import { CommitTextarea, Field, Modal, Spinner, Tabs } from "../common";
import { useWriter } from "../useWriter";
import { useImageLibrary, useImageUrl } from "./useImages";

export type ImageStudioRequest = {
  title: string;
  /** Records the image belongs to; generated and picked images are attached to them. */
  owners?: string[];
  /** Story material the prompt can be drafted from. */
  material?: string;
  initialPrompt?: string;
  caption?: string;
  aspect?: AspectId;
  referenceIds?: string[];
  /** When set, each result offers this action, e.g. inserting it into the page. */
  onPick?: (asset: ImageAsset) => void;
  pickLabel?: string;
};

const StudioContext = createContext<((request: ImageStudioRequest) => void) | null>(null);

export function ImageStudioProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<(ImageStudioRequest & { key: number }) | null>(null);
  const nonce = useRef(0);
  const open = useCallback((next: ImageStudioRequest) => { nonce.current += 1; setRequest({ ...next, key: nonce.current }); }, []);
  return (
    <StudioContext.Provider value={open}>
      {children}
      {request ? <ImageStudio key={request.key} request={request} onClose={() => setRequest(null)} /> : null}
    </StudioContext.Provider>
  );
}

export function useImageStudio() {
  const open = useContext(StudioContext);
  if (!open) throw new Error("ImageStudioProvider missing");
  return open;
}

export function Thumb({ asset, projectId, className = "" }: { asset: ImageAsset; projectId: string; className?: string }) {
  const { url, failed } = useImageUrl(projectId, asset);
  if (failed) return <div className={`w-thumb missing ${className}`}>图片缺失</div>;
  return url ? <img className={`w-thumb ${className}`} src={url} alt={asset.caption || asset.prompt.slice(0, 40)} /> : <div className={`w-thumb loading ${className}`}><Spinner size={12} /></div>;
}

type Tab = "generate" | "library" | "upload";

function ImageStudio({ request, onClose }: { request: ImageStudioRequest; onClose: () => void }) {
  const writer = useWriter();
  const projectId = writer.project?.id as string;
  const library = useImageLibrary(projectId);
  const [tab, setTab] = useState<Tab>("generate");
  const [prompt, setPrompt] = useState(request.initialPrompt ?? "");
  const [instruction, setInstruction] = useState("");
  const [caption, setCaption] = useState(request.caption ?? "");
  const [model, setModel] = useState<ImageModelChoice>("sunburst");
  const [quality, setQuality] = useState<ImageQuality>("medium");
  const [aspect, setAspect] = useState<AspectId>(request.aspect ?? "3:2");
  const [count, setCount] = useState(1);
  const [references, setReferences] = useState<string[]>(request.referenceIds ?? []);
  const [drafting, setDrafting] = useState(false);
  const [submitting, setGenerating] = useState(false);
  const imageTasks = writer.tasks.filter((task) => task.kind === "writer.images");
  const generating = submitting || imageTasks.some((task) => ["queued", "running", "cancelling"].includes(task.status));
  const [results, setResults] = useState<ImageAsset[]>([]);
  useEffect(() => {
    const latest = [...imageTasks].sort((a, b) => b.cursor - a.cursor).find((task) => task.status === "completed");
    if (!latest) return;
    let stopped = false;
    void dailyHost().tasks.get(latest.id).then((task) => { if (!stopped && Array.isArray(task.result)) setResults(task.result as ImageAsset[]); });
    return () => { stopped = true; };
  }, [imageTasks.map((task) => `${task.id}:${task.status}`).join(",")]);
  const [error, setError] = useState("");
  const [availability, setAvailability] = useState<ImageAvailability | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => { void imageAvailability().then((value) => { if (alive.current) setAvailability(value); }); }, []);

  const owners = useMemo(() => request.owners ?? [], [request.owners]);
  const assets = useMemo(() => {
    const belongs = (asset: ImageAsset) => (asset.owners.some((owner) => owners.includes(owner)) ? 0 : 1);
    return [...library.assets].sort((left, right) => belongs(left) - belongs(right) || right.createdAt - left.createdAt);
  }, [library.assets, owners]);

  const draft = async () => {
    if (!writer.project || !request.material || drafting) return;
    setDrafting(true);
    setError("");
    try { const text = await draftImagePrompt(writer.project, writer.memory, request.material, instruction); if (alive.current) setPrompt(text); }
    catch (cause) { if (alive.current) setError(friendlyAiError(cause)); }
    finally { if (alive.current) setDrafting(false); }
  };

  const generate = async () => {
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    setError("");
    try {
      const created = await generateImages(projectId, { prompt, caption, model, quality, aspect, count, referenceIds: references, owners });
      if (alive.current) setResults((current) => [...created, ...current]);
    } catch (cause) { if (alive.current) setError(friendlyImageError(cause)); }
    finally { if (alive.current) setGenerating(false); }
  };

  const pick = async (asset: ImageAsset) => {
    await Promise.all(owners.map((owner) => attachImage(projectId, asset.id, owner)));
    if (request.onPick) { request.onPick(asset); onClose(); }
    else writer.notify("success", "已加入。");
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    try {
      if (file.size > MAX_UPLOAD_BYTES) throw new Error("图片超过 11 MB，请压缩后再上传。");
      const base64 = await readBase64(file);
      const asset = await addUploadedImage(projectId, { base64, mime: file.type, bytes: file.size, name: file.name, owners });
      if (request.onPick) { request.onPick(asset); onClose(); }
      else { writer.notify("success", "已上传。"); setResults((current) => [asset, ...current]); setTab("generate"); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const toggleReference = (id: string) => setReferences((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id].slice(0, 8)));
  const label = request.onPick ? request.pickLabel ?? "使用这张" : null;
  const referable = assets.filter((asset) => asset.mime !== "image/gif" && asset.mime !== "image/svg+xml").slice(0, 24);

  return (
    <Modal title={request.title} width={860} onClose={onClose}>
      <div className="w-settings-tabs"><Tabs size="sm" value={tab} onChange={setTab} items={[{ value: "generate", label: "AI 生成" }, { value: "library", label: "从图库选", badge: library.assets.length }, { value: "upload", label: "上传" }]} /></div>
      {error ? <div className="w-callout warn inline" role="alert">{error}</div> : null}
      {tab === "generate" ? (
        <div className="w-image-studio">
          <section className="w-form">
            {availability && !availability.available ? <div className="w-callout warn inline">{availability.reason}</div> : null}
            {request.material ? (
              <div className="w-studio-draft">
                <input className="w-input" value={instruction} placeholder="想怎么画（可不填），例如：只画背影、雨夜" onChange={(event) => setInstruction(event.currentTarget.value)} />
                <button type="button" className="w-btn small" disabled={drafting} onClick={() => void draft()}>{drafting ? <Spinner size={12} /> : <Sparkles size={12} />}写提示词</button>
              </div>
            ) : null}
            <Field label="画面描述"><textarea className="w-textarea" rows={7} value={prompt} placeholder="谁、在哪、在做什么、光线和构图。画面里不要文字。" onChange={(event) => setPrompt(event.currentTarget.value)} /></Field>
            <Field label="图注（可不填）"><input className="w-input" value={caption} onChange={(event) => setCaption(event.currentTarget.value)} /></Field>
            <div className="w-inspector-grid">
              <Field label="模型"><select className="w-select" value={model} onChange={(event) => setModel(event.currentTarget.value as ImageModelChoice)}>{IMAGE_MODELS.map((item) => <option key={item.value} value={item.value}>{item.label}：{item.hint}</option>)}</select></Field>
              <Field label="质量"><select className="w-select" value={quality} onChange={(event) => setQuality(event.currentTarget.value as ImageQuality)}>{IMAGE_QUALITIES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field>
              <Field label="比例"><select className="w-select" value={aspect} onChange={(event) => setAspect(event.currentTarget.value as AspectId)}>{ASPECTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field>
              <Field label="张数"><select className="w-select" value={count} onChange={(event) => setCount(Number(event.currentTarget.value))}>{[1, 2, 3, 4].map((item) => <option key={item} value={item}>{item}</option>)}</select></Field>
            </div>
            <Field label="全书美术风格" hint="每张图都会带上，让插图风格统一。"><CommitTextarea rows={2} value={library.style} placeholder="例如：水墨淡彩，留白多，色调偏冷" onCommit={(value) => void setImageStyle(projectId, value)} /></Field>
            {referable.length ? (
              <Field label={`参考图（已选 ${references.length}）`} hint="选了参考图时会沿用其中的人物和物件，用于保持同一角色的长相。">
                <div className="w-thumb-row">{referable.map((asset) => <button key={asset.id} type="button" className={`w-thumb-pick ${references.includes(asset.id) ? "active" : ""}`} aria-pressed={references.includes(asset.id)} title={asset.caption || asset.prompt.slice(0, 60)} onClick={() => toggleReference(asset.id)}><Thumb asset={asset} projectId={projectId} /></button>)}</div>
              </Field>
            ) : null}
            <div className="w-row">
              <button type="button" className="w-btn primary" disabled={!prompt.trim() || generating || availability?.available === false} onClick={() => void generate()}>{generating ? <Spinner size={12} /> : <ImagePlus size={13} />}{generating ? "生成中，通常要一两分钟…" : "生成"}</button>
              <span className="w-muted">每次生成都会消耗你的 OpenAI API 额度。</span>
            </div>
          </section>
          <section className="w-studio-results" aria-label="生成结果">
            {results.length ? results.map((asset) => (
              <figure key={asset.id} className="w-studio-result">
                <Thumb asset={asset} projectId={projectId} />
                <figcaption>{label ? <button type="button" className="w-btn small primary" onClick={() => void pick(asset)}>{label}</button> : <span className="w-muted">已保存到图库</span>}<button type="button" className="w-btn small" onClick={() => { setPrompt(asset.prompt); toggleReference(asset.id); }}>以此为参考</button></figcaption>
              </figure>
            )) : <p className="w-muted">生成的图片会出现在这里，并自动保存到本作的图库。</p>}
          </section>
        </div>
      ) : null}
      {tab === "library" ? (
        <div className="w-thumb-grid">
          {assets.length ? assets.map((asset) => <button key={asset.id} type="button" className="w-thumb-pick" title={asset.caption || asset.prompt.slice(0, 80)} onClick={() => void pick(asset)}><Thumb asset={asset} projectId={projectId} /></button>) : <p className="w-muted">图库还是空的。</p>}
        </div>
      ) : null}
      {tab === "upload" ? (
        <label className="w-dropzone"><Upload size={18} /><span>选择一张 PNG、JPEG、WebP 或 GIF 图片（11 MB 以内）</span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(event) => void upload(event.currentTarget.files?.[0])} /></label>
      ) : null}
    </Modal>
  );
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片失败。"));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}
