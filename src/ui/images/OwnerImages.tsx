import { ImagePlus, Trash2, Unlink } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { orderedChapters } from "../../domain/documents";
import { IMAGE_ROLE_LABELS, imageInRole, linkOf, type ImageAsset, type ImageRole } from "../../images/schema";
import { deleteImage, detachImage, setImageCaption, setImageLink } from "../../images/store";
import { CommitTextarea, Field, Modal, useDialogs } from "../common";
import { useWriter } from "../useWriter";
import { Thumb, useImageStudio } from "./ImageStudio";
import { useImageLibrary, useImageUrl } from "./useImages";

const splitTags = (value: string) => value.split(/[、,，\s]+/).map((item) => item.trim()).filter(Boolean).slice(0, 20);

/**
 * The images attached to one record of the bible, the story plan or the map. With `roles`, the record has named slots
 * (a character's base picture and avatar, an item's thumbnail, a place's map token); every other image carries tags,
 * an optional chapter and a note.
 */
export function OwnerImages({ owner, title, material, label = "图片", roles = [], actions }: { owner: string; title: string; material: string; label?: string; roles?: ImageRole[]; actions?: ReactNode }) {
  const writer = useWriter();
  const projectId = writer.project?.id;
  const library = useImageLibrary(projectId);
  const openStudio = useImageStudio();
  const [viewing, setViewing] = useState<string | null>(null);
  const assets = useMemo(() => library.assets.filter((asset) => asset.owners.includes(owner)), [library.assets, owner]);
  const slots = useMemo(() => roles.filter((role) => role !== "other").map((role) => ({ role, asset: imageInRole(assets, owner, role) })), [assets, owner, roles]);
  const chapters = useMemo(() => (writer.project ? orderedChapters(writer.project) : []), [writer.project]);
  if (!projectId) return null;
  const shownInSlots = new Set(slots.flatMap((slot) => (slot.asset ? [slot.asset.id] : [])));
  const others = assets.filter((asset) => !shownInSlots.has(asset.id));
  const base = imageInRole(assets, owner, "base");
  const addTo = (role: ImageRole) => openStudio({
    title: `${title} · ${IMAGE_ROLE_LABELS[role]}`,
    owners: [owner],
    material: role === "avatar" ? `头像（胸像特写，简单背景）。${material}` : role === "thumb" ? `物品缩略图，单个物品居中。${material}` : role === "icon" ? `地图上用的小图标：斜上方俯视的单个建筑或地标。${material}` : material,
    referenceIds: role !== "base" && base ? [base.id] : [],
    pickLabel: `设为${IMAGE_ROLE_LABELS[role]}`,
    onPick: (asset) => { void setImageLink(projectId, asset.id, owner, { role }); },
  });
  const current = assets.find((asset) => asset.id === viewing);
  const chapterTitle = (id: string | null) => { const index = chapters.findIndex((chapter) => chapter.id === id); return index >= 0 ? `第 ${index + 1} 章` : ""; };
  return (
    <section className="w-owner-images" aria-label={label}>
      <div className="w-owner-images-head">
        <span className="w-field-label">{label}</span>
        <span style={{ display: "flex", gap: 6 }}>{actions}<button type="button" className="w-btn small" onClick={() => openStudio({ title, owners: [owner], material, referenceIds: base ? [base.id] : assets.slice(0, 2).map((asset) => asset.id) })}><ImagePlus size={12} />添加</button></span>
      </div>
      {slots.length ? (
        <div className="w-image-slots">
          {slots.map((slot) => (
            <div key={slot.role} className="w-image-slot">
              {slot.asset ? <button type="button" className="w-thumb-pick" title={slot.asset.caption || "查看"} onClick={() => setViewing(slot.asset?.id ?? null)}><Thumb asset={slot.asset} projectId={projectId} /></button>
                : <button type="button" className="w-image-slot-empty" aria-label={`添加${IMAGE_ROLE_LABELS[slot.role]}`} onClick={() => addTo(slot.role)}><ImagePlus size={14} /></button>}
              <span>{IMAGE_ROLE_LABELS[slot.role]}</span>
            </div>
          ))}
        </div>
      ) : null}
      {others.length ? <div className="w-thumb-row">{others.map((asset) => { const link = linkOf(asset, owner); const note = [chapterTitle(link.chapterId), ...link.tags].filter(Boolean).join(" · "); return <button key={asset.id} type="button" className="w-thumb-pick w-thumb-tagged" title={[asset.caption, link.note].filter(Boolean).join("\n") || "查看"} onClick={() => setViewing(asset.id)}><Thumb asset={asset} projectId={projectId} />{note ? <span>{note}</span> : null}</button>; })}</div> : null}
      {current ? <Viewer asset={current} projectId={projectId} owner={owner} roles={roles} chapters={chapters.map((chapter, index) => ({ id: chapter.id, label: `第 ${index + 1} 章 ${chapter.title}` }))} onClose={() => setViewing(null)} /> : null}
    </section>
  );
}

function Viewer({ asset, projectId, owner, roles, chapters, onClose }: { asset: ImageAsset; projectId: string; owner: string; roles: ImageRole[]; chapters: { id: string; label: string }[]; onClose: () => void }) {
  const { url } = useImageUrl(projectId, asset);
  const dialogs = useDialogs();
  const [caption, setCaption] = useState(asset.caption);
  const link = linkOf(asset, owner);
  const [tags, setTags] = useState(link.tags.join("、"));
  const choices: ImageRole[] = [...new Set<ImageRole>([...roles, "other"])];
  return (
    <Modal title={asset.caption || "图片"} width={820} onClose={onClose}>
      {url ? <img className="w-image-full" src={url} alt={asset.caption || asset.prompt.slice(0, 60)} /> : null}
      <div className="w-form">
        <input className="w-input" value={caption} placeholder="图注" aria-label="图注" onChange={(event) => setCaption(event.currentTarget.value)} onBlur={() => { if (caption !== asset.caption) void setImageCaption(projectId, asset.id, caption); }} />
        <div className="w-inspector-grid">
          {choices.length > 1 ? <Field label="用作"><select className="w-select" value={link.role} onChange={(event) => void setImageLink(projectId, asset.id, owner, { role: event.currentTarget.value as ImageRole })}>{choices.map((role) => <option key={role} value={role}>{IMAGE_ROLE_LABELS[role]}</option>)}</select></Field> : null}
          <Field label="关联章节"><select className="w-select" value={link.chapterId ?? ""} onChange={(event) => void setImageLink(projectId, asset.id, owner, { chapterId: event.currentTarget.value || null })}><option value="">不关联</option>{chapters.slice(0, 4_000).map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.label}</option>)}</select></Field>
        </div>
        <Field label="标签（顿号分隔）"><input className="w-input" value={tags} placeholder="例如：少年时、战甲、受伤后" onChange={(event) => setTags(event.currentTarget.value)} onBlur={() => void setImageLink(projectId, asset.id, owner, { tags: splitTags(tags) })} /></Field>
        <Field label="备注"><CommitTextarea rows={2} value={link.note} onCommit={(note) => void setImageLink(projectId, asset.id, owner, { note })} /></Field>
        {asset.prompt ? <p className="w-muted">{asset.prompt.slice(0, 400)}</p> : null}
        <div className="w-row">
          <button type="button" className="w-btn small" onClick={() => { void detachImage(projectId, asset.id, owner); onClose(); }}><Unlink size={12} />从这里移除</button>
          <button type="button" className="w-btn danger small" onClick={async () => { if (await dialogs.confirm("删除图片", "从图库彻底删除这张图？正文里引用它的位置会显示图片缺失。", { danger: true, confirmLabel: "删除" })) { await deleteImage(projectId, asset.id); onClose(); } }}><Trash2 size={12} />从图库删除</button>
        </div>
      </div>
    </Modal>
  );
}
