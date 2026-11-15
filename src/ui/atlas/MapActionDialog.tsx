import { ImagePlus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { listModels, modelFor } from "../../ai/models";
import type { Atlas, AtlasMap } from "../../atlas/schema";
import { detachImage } from "../../images/store";
import { Modal } from "../common";
import { Thumb, useImageStudio } from "../images/ImageStudio";
import { useImageLibrary } from "../images/useImages";

/** revise and redraw run the map pipeline; paint calls GPT Image; base only sets the first reference as the base image. */
export type MapAction = "revise" | "redraw" | "full" | "paint" | "base";
export type MapActionRequest = { action: MapAction; mapId: string; instruction: string; referenceIds: string[]; useReferenceAsBase: boolean };

const ACTIONS: { value: MapAction; label: string; hint: string; worldOnly?: boolean; needsRegions?: boolean }[] = [
  { value: "revise", label: "按要求修改", hint: "只改你说的部分（或照参考图调整），其余保持原样。", needsRegions: true },
  { value: "redraw", label: "重绘这张图的版图", hint: "按材料和参考图重新生成地区、地点和路线；同名的地方保留事件和配图。" },
  { value: "full", label: "重新生成地理版图", hint: "先生成地区、地点和路线供确认；章节事件可以单独同步，已有素材保留。", worldOnly: true },
  { value: "paint", label: "打开分阶段绘图", hint: "生成草图，确认后再画精图，最后逐个细化模块。每一步可预览、采纳或放弃。", needsRegions: true },
  { value: "base", label: "把参考图直接铺作底图", hint: "不调用 AI。之后可以在“调整布局”里把地区和地点对到图上。" },
];

export function MapActionDialog({ projectId, atlas, map, onClose, onRun }: { projectId: string; atlas: Atlas; map: AtlasMap; onClose: () => void; onRun: (request: MapActionRequest) => void }) {
  const library = useImageLibrary(projectId);
  const openStudio = useImageStudio();
  const hasRegions = atlas.regions.some((region) => region.mapId === map.id);
  const isWorld = map.id === atlas.rootMapId;
  const [action, setAction] = useState<MapAction>(hasRegions ? "revise" : "redraw");
  const [instruction, setInstruction] = useState("");
  const [useAsBase, setUseAsBase] = useState(false);
  const owned = useMemo(() => library.assets.filter((asset) => asset.owners.includes(`map:${map.id}`) && asset.mime !== "image/gif"), [library.assets, map.id]);
  const [selected, setSelected] = useState<string[] | null>(null);
  const chosen = selected ?? owned.filter((asset) => asset.source === "upload").map((asset) => asset.id).slice(0, 4);
  const [vision, setVision] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void Promise.all([listModels(), modelFor("memory")]).then(([models, selection]) => {
      const provider = models.providers.find((item) => item.id === (selection?.authConfigId ?? models.default.authConfigId));
      if (alive) setVision(Boolean(provider?.acceptsImages));
    }).catch(() => { if (alive) setVision(null); });
    return () => { alive = false; };
  }, []);

  const toggle = (id: string) => setSelected(chosen.includes(id) ? chosen.filter((item) => item !== id) : [...chosen, id].slice(0, 4));
  const usesModel = action === "revise" || action === "redraw" || action === "full";
  const blocked = (action === "revise" && !instruction.trim() && !chosen.length) || (action === "base" && !chosen.length) || (usesModel && chosen.length > 0 && vision === false);
  return (
    <Modal title={`生成/修改「${map.title}」`} width={640} onClose={onClose} footer={<>
      <button type="button" className="w-btn" onClick={onClose}>取消</button>
      <button type="button" className="w-btn primary" disabled={blocked} onClick={() => onRun({ action, mapId: map.id, instruction, referenceIds: chosen, useReferenceAsBase: useAsBase })}>{action === "paint" ? "画底图" : action === "base" ? "设为底图" : "开始"}</button>
    </>}>
      <div className="w-form">
        <div className="w-atlas-actions" role="radiogroup" aria-label="要做什么">
          {ACTIONS.filter((item) => (!item.worldOnly || isWorld) && (!item.needsRegions || hasRegions)).map((item) => (
            <label key={item.value} className={action === item.value ? "on" : ""}>
              <input type="radio" name="map-action" checked={action === item.value} onChange={() => setAction(item.value)} />
              <span><strong>{item.label}</strong><small>{item.hint}</small></span>
            </label>
          ))}
        </div>
        {action !== "base" ? <textarea className="w-textarea" rows={3} value={instruction} aria-label="要求" placeholder={action === "revise" ? "要怎么改，例如：把赤焰群山移到西南角，加一条从天京到临江城的运河" : "额外要求（可不填），例如：大陆东西狭长，北面是冰海"} onChange={(event) => setInstruction(event.currentTarget.value)} /> : null}
        <section className="w-form">
          <div className="w-row"><span className="w-field-label">参考图（已选 {chosen.length}，最多 4 张）</span><span className="w-spacer" /><button type="button" className="w-btn small" onClick={() => openStudio({ title: "添加参考图", owners: [`map:${map.id}`], material: `「${map.title}」的地图参考：${map.summary}`, pickLabel: "用作参考", onPick: (asset) => setSelected([...chosen.filter((id) => id !== asset.id), asset.id].slice(-4)) })}><ImagePlus size={12} />上传或选择</button></div>
          {owned.length ? (
            <div className="w-atlas-refs">
              {owned.map((asset) => (
                <div key={asset.id} className={`w-atlas-ref ${chosen.includes(asset.id) ? "on" : ""}`}>
                  <button type="button" className="w-thumb-pick" aria-pressed={chosen.includes(asset.id)} title={asset.caption || "参考图"} onClick={() => toggle(asset.id)}><Thumb asset={asset} projectId={projectId} /></button>
                  <button type="button" className="w-text-btn" onClick={() => { void detachImage(projectId, asset.id, `map:${map.id}`); setSelected(chosen.filter((id) => id !== asset.id)); }}><X size={11} />移出</button>
                </div>
              ))}
            </div>
          ) : <p className="w-muted">可以上传手绘草图、现成的地图或概念图。AI 会照它安排海岸、地区和地名；画底图时它决定画风。</p>}
          {usesModel && chosen.length && vision === false ? <p className="w-callout warn inline">“记忆与设定”所用的模型不能读图。请在作品设置 → 模型里换一个能读图的模型，或者不选参考图。</p> : null}
          {usesModel && chosen.length ? <label className="w-check"><input type="checkbox" checked={useAsBase} onChange={(event) => setUseAsBase(event.currentTarget.checked)} />同时把第一张参考图铺作底图</label> : null}
        </section>
        <p className="w-muted">{action === "paint" ? "画底图直接生效。" : action === "base" ? "设置立即生效，可在“详情”里改回。" : "结果先放进草稿，朱色标出改动，你采纳后才生效。"}</p>
      </div>
    </Modal>
  );
}
