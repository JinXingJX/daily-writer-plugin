import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { quickActionsFor } from "../../ai/promptRegistry";
import { countWords } from "../../domain/words";
import { isComposing, Spinner } from "../common";
import type { EditorApi, EditorSelection } from "../editor/ManuscriptEditor";
import { useWriter } from "../useWriter";
import type { SelectionAi } from "./useSelectionAi";

const PRIMARY_ACTIONS = 4;

type Props = {
  ai: SelectionAi;
  selection: EditorSelection;
  editorRef: React.RefObject<EditorApi | null>;
  pageScrollRef: React.RefObject<HTMLDivElement | null>;
  /** "margin" sits beside the selection's line; "float" sits under it, when there is no margin to use. */
  placement: "margin" | "float";
  onInspire: () => void;
  onToChat: () => void;
  onIllustrate: () => void;
};

/** What to do with the selected text. It stays out of the manuscript: candidates are read on the page itself. */
export function SelectionPanel({ ai, selection, editorRef, pageScrollRef, placement, onInspire, onToChat, onIllustrate }: Props) {
  const writer = useWriter();
  const ref = useRef<HTMLDivElement>(null);
  const [custom, setCustom] = useState("");
  const [more, setMore] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const { suggestion, busy } = ai;
  const key = `${selection.from}:${selection.to}`;
  const hasSelection = Boolean(selection.text.trim()) && dismissed !== key;
  const visible = Boolean(suggestion || busy || hasSelection);
  const anchorFrom = suggestion?.from ?? selection.from;
  const anchorTo = suggestion?.to ?? selection.to;

  useEffect(() => { setMore(false); setCustom(""); }, [key]);

  useLayoutEffect(() => {
    if (!visible) return;
    const scroller = pageScrollRef.current;
    const place = () => {
      const panel = ref.current;
      const api = editorRef.current;
      if (!panel || !api || !scroller) return;
      if (placement === "float") {
        const end = api.coordsAt(anchorTo);
        if (!end) return;
        const box = scroller.getBoundingClientRect();
        panel.style.top = `${end.bottom - box.top + scroller.scrollTop + 10}px`;
        panel.style.left = `${Math.max(12, Math.min(end.left - box.left - 24, box.width - panel.offsetWidth - 12))}px`;
        return;
      }
      const parent = panel.offsetParent as HTMLElement | null;
      if (!parent) return;
      const start = api.coordsAt(anchorFrom);
      const bounds = parent.getBoundingClientRect();
      const wanted = start ? start.top - bounds.top : 0;
      panel.style.top = `${Math.max(0, Math.min(wanted, bounds.height - panel.offsetHeight - 8))}px`;
    };
    place();
    scroller?.addEventListener("scroll", place, { passive: true });
    return () => scroller?.removeEventListener("scroll", place);
  }, [anchorFrom, anchorTo, busy, editorRef, more, pageScrollRef, placement, suggestion, visible]);

  if (!visible || !writer.project) return null;
  const actions = quickActionsFor(writer.project);
  const submit = () => { if (custom.trim()) void ai.runRewrite("改写", custom.trim(), 2); };
  // Clicking the panel must not take the selection away from the editor (the text field is the exception).
  const keepSelection = (event: React.MouseEvent) => { if (!(event.target instanceof HTMLInputElement)) event.preventDefault(); };

  return (
    <section ref={ref} className={`w-selection-panel ${placement}`} aria-label="选区" onMouseDown={keepSelection}>
      <header>
        <strong>{suggestion ? suggestion.label : `选中 ${countWords(selection.text)} 字`}</strong>
        {busy ? <button type="button" className="w-text-btn" onClick={ai.cancel}>取消</button>
          : suggestion ? <button type="button" className="w-text-btn" onClick={ai.discard}>放弃 Esc</button>
          : <button type="button" className="w-text-btn" onClick={() => setDismissed(key)}>收起</button>}
      </header>

      {busy ? <p className="w-margin-ink"><Spinner size={12} /> 照样章的声音{busy}…</p> : suggestion ? (
        <>
          <p className="w-selection-caption">稿纸上是当前这一版</p>
          <div className="w-candidates">
            {suggestion.candidates.map((candidate, index) => (
              <button key={index} type="button" aria-pressed={index === suggestion.index} className={index === suggestion.index ? "active" : ""} onClick={() => ai.pick(index)}><span>{candidate}</span></button>
            ))}
          </div>
          <div className="w-row">
            <button type="button" className="w-btn w-btn-zhu small" onClick={ai.accept}>采纳 Tab</button>
            {suggestion.candidates.length > 1 ? <button type="button" className="w-text-btn" onClick={ai.next}>下一版 ⌥]</button> : null}
            <button type="button" className="w-text-btn" aria-pressed={Boolean(suggestion.compare)} onClick={ai.toggleCompare}>{suggestion.compare ? "只看新版" : "对比原文"}</button>
          </div>
        </>
      ) : (
        <>
          <div className="w-chips">
            {actions.slice(0, PRIMARY_ACTIONS).map((action) => <button key={action.id} type="button" className="w-chip-square" title={action.ask ?? action.instruction} onClick={() => void ai.runQuickAction(action)}>{action.label}</button>)}
            {actions.length > PRIMARY_ACTIONS ? <button type="button" className="w-text-btn" aria-expanded={more} onClick={() => setMore(!more)}>更多 {actions.length - PRIMARY_ACTIONS}</button> : null}
          </div>
          {more ? <div className="w-chips">{actions.slice(PRIMARY_ACTIONS).map((action) => <button key={action.id} type="button" className="w-chip-square" title={action.ask ?? action.instruction} onClick={() => void ai.runQuickAction(action)}>{action.label}</button>)}</div> : null}
          <label className="w-selection-input">
            <span>或者直接说怎么改</span>
            <input className="w-input" value={custom} placeholder="比如：再冷一点，别解释他的心情" onChange={(event) => setCustom(event.currentTarget.value)} onKeyDown={(event) => { if (!isComposing(event) && event.key === "Enter") submit(); }} />
          </label>
          <div className="w-row">
            <button type="button" className="w-text-btn" onClick={onIllustrate}>为这段配图</button>
            <button type="button" className="w-text-btn" onClick={onInspire}>这段还能怎么写</button>
            <button type="button" className="w-text-btn" onClick={onToChat}>交给对谈</button>
          </div>
        </>
      )}
    </section>
  );
}
