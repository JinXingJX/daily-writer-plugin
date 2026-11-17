import { Copy, ImagePlus, Plus, RotateCcw, Star, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BUILTIN_STYLES, createStyle, deleteStyle, loadStyleLibrary, resetBuiltinStyle, restoreHiddenStyles, saveStyle, setDefaultStyle, subscribeStyles, type MapStyle, type StyleLibrary, type StylePalette } from "../../atlas/styles";
import { CommitTextarea, Field, Modal, useDialogs } from "../common";
import { Thumb, useImageStudio } from "../images/ImageStudio";
import { useImageLibrary } from "../images/useImages";
import { useWriter } from "../useWriter";

export function useStyleLibrary(projectId: string | undefined): StyleLibrary | null {
  const [library, setLibrary] = useState<StyleLibrary | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    const load = () => { void loadStyleLibrary(projectId).then((next) => { if (alive) setLibrary(next); }); };
    load();
    const stop = subscribeStyles((changed) => { if (changed === projectId) load(); });
    return () => { alive = false; stop(); };
  }, [projectId]);
  return library;
}

const COLORS: { key: keyof StylePalette; label: string }[] = [{ key: "paper", label: "纸" }, { key: "land", label: "陆地" }, { key: "ink", label: "墨线" }, { key: "water", label: "水" }, { key: "accent", label: "强调" }];

export function Swatches({ palette }: { palette: StylePalette }) {
  return <span className="w-style-swatches" aria-hidden="true">{COLORS.map((color) => <i key={color.key} style={{ background: palette[color.key] }} />)}</span>;
}

/** The style library: browse, edit, add, copy, hide or delete styles, and pick the one this map paints with. */
export function StyleLibraryDialog({ projectId, currentStyleId, onUse, onClose }: { projectId: string; currentStyleId: string | null; onUse: (styleId: string) => void; onClose: () => void }) {
  const writer = useWriter();
  const dialogs = useDialogs();
  const openStudio = useImageStudio();
  const library = useStyleLibrary(projectId);
  const images = useImageLibrary(projectId);
  const [selectedId, setSelectedId] = useState<string | null>(currentStyleId);
  const style = library?.styles.find((item) => item.id === selectedId) ?? library?.styles.find((item) => item.id === library.defaultId) ?? library?.styles[0];
  const save = useCallback((patch: Partial<MapStyle>) => { if (style) void saveStyle(projectId, { ...style, ...patch }).catch((error) => writer.notify("error", error instanceof Error ? error.message : String(error))); }, [projectId, style, writer]);
  if (!library || !style) return null;
  const builtin = BUILTIN_STYLES.find((item) => item.id === style.id);
  const edited = Boolean(builtin && JSON.stringify({ ...builtin, referenceIds: [] }) !== JSON.stringify({ ...style, referenceIds: [] }));
  const remove = async () => {
    if (!(await dialogs.confirm(builtin ? "隐藏预置风格" : "删除风格", builtin ? `隐藏「${style.name}」？之后可以在列表底部恢复。` : `删除「${style.name}」？用它画好的画卷不受影响。`, { danger: true, confirmLabel: builtin ? "隐藏" : "删除" }))) return;
    try { await deleteStyle(projectId, style.id); setSelectedId(null); } catch (error) { writer.notify("error", error instanceof Error ? error.message : String(error)); }
  };
  return (
    <Modal title="画卷风格库" width={980} onClose={onClose} footer={<>
      <span className="w-muted" style={{ marginRight: "auto" }}>风格的提示词、主色和参考图会随每一块画卷交给 GPT Image。</span>
      <button type="button" className="w-btn" onClick={onClose}>关闭</button>
      <button type="button" className="w-btn primary" onClick={() => { onUse(style.id); onClose(); }}>这张图用「{style.name}」</button>
    </>}>
      <div className="w-style-editor">
        <section className="w-form">
          <div className="w-row">
            <button type="button" className="w-btn small" onClick={() => void createStyle(projectId).then((created) => setSelectedId(created.id))}><Plus size={12} />新建</button>
            <button type="button" className="w-btn small" onClick={() => void createStyle(projectId, style).then((created) => setSelectedId(created.id))}><Copy size={12} />复制</button>
          </div>
          <div className="w-style-list" role="list">
            {library.styles.map((item) => (
              <button key={item.id} type="button" role="listitem" className="w-style-row" aria-pressed={item.id === style.id} onClick={() => setSelectedId(item.id)}>
                <Swatches palette={item.palette} />
                <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <strong style={{ fontSize: 13.5 }}>{item.name}</strong>
                  <span className="w-muted" style={{ fontSize: 11.5 }}>{item.id === library.defaultId ? "默认 · " : ""}{item.id === currentStyleId ? "这张图在用 · " : ""}{item.builtin ? "预置" : "自定义"}</span>
                </span>
              </button>
            ))}
          </div>
          {library.hidden.length ? <button type="button" className="w-text-btn" onClick={() => void restoreHiddenStyles(projectId)}>恢复隐藏的 {library.hidden.length} 个预置风格</button> : null}
        </section>
        <section className="w-form" key={style.id}>
          <Field label="名称"><input className="w-input" defaultValue={style.name} onBlur={(event) => { const name = event.currentTarget.value.trim(); if (name && name !== style.name) save({ name }); }} /></Field>
          <Field label="画风提示词" hint="写画面本身：笔触、材质、用色、光线、地形怎么画、建筑什么样。"><CommitTextarea rows={7} value={style.prompt} onCommit={(prompt) => save({ prompt })} /></Field>
          <Field label="不要出现"><CommitTextarea rows={2} value={style.avoid} onCommit={(avoid) => save({ avoid })} placeholder="例如：不要卡通描边" /></Field>
          <div className="w-field"><span className="w-field-label">主色</span>
            <div className="w-style-colors">{COLORS.map((color) => <label key={color.key}><input type="color" value={style.palette[color.key]} onChange={(event) => save({ palette: { ...style.palette, [color.key]: event.currentTarget.value } })} />{color.label}</label>)}</div>
          </div>
          <div className="w-field">
            <div className="w-row"><span className="w-field-label">风格参考图（只学画法，不学内容，最多 2 张会随每块发送）</span><span className="w-spacer" />
              <button type="button" className="w-btn small" disabled={style.referenceIds.length >= 4} onClick={() => openStudio({ title: "风格参考图", material: `「${style.name}」风格的地图参考`, pickLabel: "作为风格参考", onPick: (asset) => save({ referenceIds: [...style.referenceIds.filter((id) => id !== asset.id), asset.id].slice(-4) }) })}><ImagePlus size={12} />添加</button>
            </div>
            {style.referenceIds.length ? <div className="w-thumb-row">{style.referenceIds.map((id) => { const asset = images.assets.find((item) => item.id === id); return asset ? <div key={id} style={{ position: "relative" }}><Thumb asset={asset} projectId={projectId} /><button type="button" className="w-icon-btn small" style={{ position: "absolute", top: 2, right: 2 }} aria-label="移除参考图" onClick={() => save({ referenceIds: style.referenceIds.filter((item) => item !== id) })} title="移除参考图"><X size={11} /></button></div> : null; })}</div> : null}
          </div>
          <div className="w-row">
            <button type="button" className="w-btn small" disabled={library.defaultId === style.id} onClick={() => void setDefaultStyle(projectId, style.id)}><Star size={12} />{library.defaultId === style.id ? "已是默认" : "设为默认"}</button>
            {edited ? <button type="button" className="w-btn small" onClick={() => void resetBuiltinStyle(projectId, style.id)}><RotateCcw size={12} />恢复预置内容</button> : null}
            <button type="button" className="w-btn danger small" onClick={() => void remove()}><Trash2 size={12} />{builtin ? "隐藏" : "删除"}</button>
          </div>
        </section>
      </div>
    </Modal>
  );
}
