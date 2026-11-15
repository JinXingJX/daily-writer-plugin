import { useEffect, useState } from "react";
import { adoptArtwork, paintDraft, paintFine, paintModule, restoreArtwork } from "../../atlas/artwork";
import { smoothPath } from "../../atlas/geometry";
import { domRaster } from "../../atlas/raster";
import type { Atlas, AtlasMap, MapRect, Point } from "../../atlas/schema";
import type { MapStyle } from "../../atlas/styles";
import { dailyHost } from "../../host";
import { attachImage, imageFilesDir } from "../../images/store";
import { friendlyImageError } from "../../images/generate";
import { uniqueId } from "../../domain/ids";
import { useAssetUrls } from "../images/useImages";
import { runAtlasJob } from "./job";
import type { AtlasTool } from "./AtlasCanvas";

type Props = {
  projectId: string; atlas: Atlas; map: AtlasMap; style: MapStyle | null; busy: boolean; layoutPending: boolean;
  moduleIds: string[]; rect: MapRect | null; markup: Point[]; onTool: (tool: AtlasTool | null) => void;
  preview: string | null; onPreview: (id: string | null) => void;
  mutate: (change: (atlas: Atlas) => void) => void;
  notify: (kind: "success" | "error", message: string) => void;
  time: { chapterId: string | null; momentId: string | null; label: string };
};
export function AtlasArtworkPanel(p: Props) {
  const [instruction, setInstruction] = useState("");
  const [regionId, setRegionId] = useState("");
  const [timed, setTimed] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const art = p.map.artwork;
  const candidates = art?.candidates ?? [];
  const urls = useAssetUrls(p.projectId, [...candidates, ...(art?.tokens?.map((t) => t.assetId) ?? [])]);
  const busy = p.busy || localBusy;
  const regions = p.atlas.regions.filter((r) => r.mapId === p.map.id);
  useEffect(() => { setRegionId(""); setInstruction(""); setTimed(false); }, [p.map.id]);
  const update = (change: (map: AtlasMap) => void) => p.mutate((atlas) => { const map = atlas.maps.find((m) => m.id === p.map.id); if (map) change(map); });
  const run = async (kind: "draft" | "fine" | "module", dirtyRect?: MapRect) => {
    if (!p.style || busy) return;
    setLocalBusy(true);
    try {
      await runAtlasJob(p.projectId, kind === "draft" ? "生成草图候选" : kind === "fine" ? "生成精图预览" : "细化地图模块", async (progress, signal) => {
        progress(kind === "draft" ? "生成 3 张粗略草图，完成后请选择" : kind === "fine" ? "将已确认草图绘制成精图" : "参考已采纳地图，遮罩绘制并融合模块");
        const job = { projectId: p.projectId, atlas: p.atlas, mapId: p.map.id, style: p.style!, instruction, signal, moduleIds: p.moduleIds };
        let markup: string | undefined;
        if (p.markup.length > 1 && art?.assetId) {
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="784" viewBox="0 0 1000 700"><path d="${smoothPath(p.markup)}" stroke="#df4835" stroke-width="5" fill="none"/></svg>`;
          markup = `${imageFilesDir(p.projectId)}/ref-${uniqueId("markup")}.png`;
          await dailyHost().files.writeBase64(markup, await domRaster.svgToPng(svg));
        }
        if (kind === "draft") await paintDraft({ ...job, markup });
        else if (kind === "fine") await paintFine({ ...job, markup });
        else await paintModule({ ...job, markup, ...(dirtyRect ? { rect: dirtyRect } : regionId ? { regionId } : { rect: p.rect ?? undefined }), ...(timed ? { chapterId: p.time.chapterId, momentId: p.time.momentId } : {}) });
      });
      p.onPreview(null); p.onTool(null);
      p.notify("success", kind === "draft" ? "草图已生成，请选择并采纳后再画精图。" : "预览已生成，采纳后才会更新地图。");
    } catch (error) { p.notify("error", friendlyImageError(error)); }
    finally { setLocalBusy(false); }
  };
  return <section className="w-atlas-artwork" aria-label="分阶段绘图">
    <ol className="w-atlas-art-stages"><li className={p.layoutPending ? "active" : "done"}>1 版图</li><li className={!art?.assetId || art.stage === "draft" ? "active" : "done"}>2 草图</li><li className={art?.stage === "fine" ? "active" : ""}>3 精图</li><li className={art?.modules.length ? "active" : ""}>4 模块</li></ol>
    {p.layoutPending ? <p className="w-muted">请先采纳版图草稿，可先开启编辑布局修改地区边界。</p> : null}
    <textarea className="w-textarea" aria-label="绘图要求" rows={2} placeholder="写下修改要求，也可以在地图上圈画" value={instruction} onChange={(e) => setInstruction(e.currentTarget.value)} />
    <div className="w-row"><button type="button" className="w-btn small" disabled={!art?.assetId || busy} onClick={() => p.onTool("markup")}>在图上圈画</button>{p.markup.length ? <button type="button" className="w-text-btn" onClick={() => p.onTool(null)}>结束圈画</button> : null}</div>
    {art?.dirty.length ? <p className="w-atlas-dirty">有 {art.dirty.length} 处海岸或地形待重绘。<button type="button" className="w-text-btn" disabled={busy} onClick={() => { setRegionId(""); p.onTool("module"); }}>框选受影响区域</button><button type="button" className="w-text-btn" disabled={busy || !!art.pending || art.stage !== "fine"} onClick={() => void run("module", art.dirty[0])}>重绘第一处</button></p> : null}
    <div className="w-row"><button type="button" className="w-btn small" disabled={busy || p.layoutPending || !p.style || !!art?.pending || !regions.length} onClick={() => void run("draft")}>{candidates.length ? "再来一批草图" : "生成 3 张草图"}</button><span className="w-muted">快速 · 低质量 · 一次请求</span></div>
    {candidates.length ? <div className="w-atlas-candidates">{candidates.map((id, i) => <button key={id} type="button" aria-label={`预览草图 ${i + 1}`} aria-pressed={p.preview === id} className={p.preview === id ? "selected" : ""} onClick={() => p.onPreview(id)}>{urls.get(id) ? <img src={urls.get(id)} alt={`草图 ${i + 1}`} /> : <span>加载草图…</span>}<span>草图 {i + 1}</span></button>)}</div> : null}
    {p.preview && candidates.includes(p.preview) ? <div className="w-row"><button type="button" className="w-btn small primary" disabled={busy} onClick={() => { update((map) => adoptArtwork(map, p.preview!)); p.onPreview(null); }}>采纳这张草图</button><button type="button" className="w-btn small" onClick={() => p.onPreview(null)}>返回已采纳地图</button></div> : null}
    <div className="w-row"><button type="button" className="w-btn small primary" disabled={busy || p.layoutPending || art?.stage !== "draft" || !art.assetId || !!art.pending} onClick={() => void run("fine")}>生成精图预览</button><span className="w-muted">3440 × 2400 · 一次请求</span></div>
    {art?.pending ? <div className="w-atlas-adopt" role="status"><strong>{art.pending.kind === "fine" ? "精图" : art.pending.module?.label ?? "模块"}待确认</strong><div className="w-row"><button type="button" className="w-btn small" aria-pressed={p.preview !== "accepted"} onClick={() => p.onPreview(p.preview === "accepted" ? null : "accepted")}>{p.preview === "accepted" ? "看生成结果" : "对比原图"}</button><button type="button" className="w-btn small primary" disabled={busy} onClick={() => { update(adoptArtwork); p.onPreview(null); }}>采纳</button><button type="button" className="w-btn small" disabled={busy} onClick={() => { update((map) => { if (map.artwork) map.artwork.pending = null; }); p.onPreview(null); }}>放弃预览</button></div></div> : null}
    {art?.stage === "fine" ? <div className="w-form"><label className="w-field-label" htmlFor="atlas-module-region">细化模块 · 一次请求</label><select id="atlas-module-region" className="w-select" value={regionId} onChange={(e) => setRegionId(e.currentTarget.value)}><option value="">{p.rect ? `框选范围 ${Math.round(p.rect.w)} × ${Math.round(p.rect.h)}` : "选择地区或框选范围"}</option>{regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select><div className="w-row"><button type="button" className="w-btn small" disabled={busy} onClick={() => { setRegionId(""); p.onTool("module"); }}>框选范围</button><button type="button" className="w-btn small primary" disabled={busy || !!art.pending || (!regionId && !p.rect)} onClick={() => void run("module")}>生成模块预览</button></div><label className="w-muted"><input type="checkbox" checked={timed} onChange={(e) => setTimed(e.currentTarget.checked)} />从「{p.time.label}」起生效</label></div> : null}
    {art?.tokens?.length ? <section className="w-form"><strong>待采纳图标</strong>{art.tokens.map((t) => <div key={t.assetId} className="w-atlas-token-preview"><img src={urls.get(t.assetId)} alt={t.name} /><span>{t.name}</span><button type="button" className="w-btn small" disabled={busy} onClick={() => { void attachImage(p.projectId, t.assetId, t.owner, { role: t.role }).then(() => update((map) => { if (map.artwork) map.artwork.tokens = map.artwork.tokens?.filter((item) => item.assetId !== t.assetId); })).catch((error) => p.notify("error", friendlyImageError(error))); }}>采纳</button><button type="button" className="w-text-btn" disabled={busy} onClick={() => update((map) => { if (map.artwork) map.artwork.tokens = map.artwork.tokens?.filter((item) => item.assetId !== t.assetId); })}>放弃</button></div>)}</section> : null}
    {art?.history.length ? <button type="button" className="w-text-btn" disabled={busy} onClick={() => { update(restoreArtwork); p.onPreview(null); }}>退回上一版（保留的草图可重新采纳）</button> : null}
  </section>;
}
