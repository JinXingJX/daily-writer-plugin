import { focusPluginPanel } from "@daily/plugin-sdk";
import { observeViewSize } from "../view";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { LoaderCircle, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { activeImageUrl } from "../images/store";

/** Matches the same view width as the CSS container queries. */
export function useMediaQuery(query: string) {
  const limit = Number(/max-width:\s*(\d+)px/.exec(query)?.[1]);
  const [matches, setMatches] = useState(false);
  useEffect(() => observeViewSize((width) => setMatches(width <= limit)), [limit]);
  return matches;
}

export function Spinner({ size = 14 }: { size?: number }) { return <LoaderCircle size={size} className="spin" aria-hidden="true" />; }

const REMARK_PLUGINS = [remarkGfm];
// Manuscripts separate paragraphs with single newlines, so keep them as line breaks.
const PROSE_PLUGINS = [remarkGfm, remarkBreaks];

function AssetImage({ assetId, caption }: { assetId: string; caption: string }) {
  const [state, setState] = useState<{ url: string | null; error: string }>({ url: null, error: "" });
  useEffect(() => {
    let alive = true;
    activeImageUrl(assetId).then((url) => { if (alive) setState({ url, error: "" }); }).catch((error: unknown) => { if (alive) setState({ url: null, error: error instanceof Error ? error.message : "图片无法显示" }); });
    return () => { alive = false; };
  }, [assetId]);
  if (state.error) return <span className="cm-image-missing">{state.error}</span>;
  return <span className="w-md-image">{state.url ? <img src={state.url} alt={caption} /> : <Spinner size={12} />}{caption ? <span className="w-md-caption">{caption}</span> : null}</span>;
}

const IMAGE_SCHEME = "image:";
const allowAssetUrls = (url: string) => (url.startsWith(IMAGE_SCHEME) ? url : defaultUrlTransform(url));
const MARKDOWN_COMPONENTS: Components = {
  img: ({ src, alt }) => (typeof src === "string" && src.startsWith(IMAGE_SCHEME) ? <AssetImage assetId={src.slice(IMAGE_SCHEME.length)} caption={alt ?? ""} /> : null),
};

export function Markdown({ content, className = "", prose = false }: { content: string; className?: string; prose?: boolean }) {
  return <div className={`w-markdown ${className}`}><ReactMarkdown remarkPlugins={prose ? PROSE_PLUGINS : REMARK_PLUGINS} urlTransform={allowAssetUrls} components={MARKDOWN_COMPONENTS}>{content}</ReactMarkdown></div>;
}

export function Tabs<T extends string>({ value, items, onChange, size = "md" }: { value: T; items: { value: T; label: ReactNode; badge?: number }[]; onChange: (value: T) => void; size?: "sm" | "md" }) {
  return (
    <div className={`w-tabs ${size}`} role="tablist">
      {items.map((item) => (
        <button key={item.value} type="button" role="tab" aria-selected={value === item.value} tabIndex={value === item.value ? 0 : -1} onKeyDown={(event) => { const index = items.indexOf(item); const next = event.key === "ArrowRight" ? (index + 1) % items.length : event.key === "ArrowLeft" ? (index - 1 + items.length) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1; if (next < 0) return; event.preventDefault(); onChange(items[next].value); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus(); }} className={value === item.value ? "active" : ""} onClick={() => onChange(item.value)}>
          {item.label}{item.badge ? <span className="w-badge">{item.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return <div className="w-empty">{icon ? <div className="w-empty-icon">{icon}</div> : null}<strong>{title}</strong>{children ? <div className="w-empty-body">{children}</div> : null}</div>;
}

/** True while an IME is composing (Chinese input): Enter then confirms a candidate, not the form. */
export function isComposing(event: { nativeEvent: KeyboardEvent } | KeyboardEvent) {
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  return native.isComposing || native.keyCode === 229;
}

// Open modals, innermost last: Escape only closes the top one (a confirm stacked on settings, for example).

export function Modal({ title, onClose, children, footer, width = 560 }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const panelRef = useRef<HTMLElement>(null);
  const titleId = useId();
  useEffect(() => panelRef.current ? focusPluginPanel(panelRef.current, () => closeRef.current()) : undefined, []);
  return (
    <div className="w-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={panelRef} tabIndex={-1} aria-labelledby={titleId} className="w-modal" style={{ width: `min(${width}px, calc(100cqw - 32px))` }} role="dialog" aria-modal="true">
        <header className="w-modal-head"><strong id={titleId}>{title}</strong><button type="button" className="w-icon-btn" title="关闭 Esc" aria-label="关闭" onClick={onClose}><X size={16} /></button></header>
        <div className="w-modal-body">{children}</div>
        {footer ? <footer className="w-modal-foot">{footer}</footer> : null}
      </section>
    </div>
  );
}

// Dialogs stay inside the workbench and use its visual theme.
type DialogRequest = { kind: "confirm"; title: string; message: string; danger?: boolean; confirmLabel?: string; resolve: (value: boolean) => void } | { kind: "prompt"; title: string; message: string; initial: string; resolve: (value: string | null) => void };
type DialogApi = { confirm: (title: string, message: string, options?: { danger?: boolean; confirmLabel?: string }) => Promise<boolean>; prompt: (title: string, message: string, initial?: string) => Promise<string | null> };
const DialogContext = createContext<DialogApi | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const confirm = useCallback<DialogApi["confirm"]>((title, message, options) => new Promise((resolve) => setRequest({ kind: "confirm", title, message, ...options, resolve })), []);
  const prompt = useCallback<DialogApi["prompt"]>((title, message, initial = "") => new Promise((resolve) => { setValue(initial); setRequest({ kind: "prompt", title, message, initial, resolve }); }), []);
  useEffect(() => { if (request?.kind === "prompt") globalThis.setTimeout(() => inputRef.current?.select(), 0); }, [request]);
  const close = (result: boolean) => {
    if (!request) return;
    if (request.kind === "confirm") request.resolve(result);
    else request.resolve(result ? value : null);
    setRequest(null);
  };
  return (
    <DialogContext.Provider value={{ confirm, prompt }}>
      {children}
      {request ? (
        <Modal title={request.title} onClose={() => close(false)} width={440} footer={<>
          <button type="button" className="w-btn" onClick={() => close(false)}>取消</button>
          <button type="button" className={`w-btn ${request.kind === "confirm" && request.danger ? "danger" : "primary"}`} onClick={() => close(true)}>{request.kind === "confirm" ? request.confirmLabel ?? "确定" : "确定"}</button>
        </>}>
          <p className="w-dialog-text">{request.message}</p>
          {request.kind === "prompt" ? <input ref={inputRef} className="w-input" value={value} onChange={(event) => setValue(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter" && !isComposing(event)) close(true); }} /> : null}
        </Modal>
      ) : null}
    </DialogContext.Provider>
  );
}

export function useDialogs(): DialogApi {
  const value = useContext(DialogContext);
  if (!value) throw new Error("DialogProvider missing");
  return value;
}

/**
 * Number field that commits on blur or Enter. Clamping on every keystroke makes values impossible to type
 * (entering "20000" with a minimum of 8000 would snap to 8000 at the first "2").
 */
export function NumberInput({ value, onCommit, min, max, step, fallback, zeroAsEmpty = false, className = "w-input", placeholder, title }: { value: number; onCommit: (value: number) => void; min?: number; max?: number; step?: number; fallback?: number; zeroAsEmpty?: boolean; className?: string; placeholder?: string; title?: string }) {
  const show = (number: number) => (zeroAsEmpty && !number ? "" : String(number));
  const [text, setText] = useState(() => show(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(show(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = () => {
    const parsed = Number(text);
    let next = text.trim() === "" || !Number.isFinite(parsed) ? fallback ?? min ?? 0 : parsed;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    if (!step || Number.isInteger(step)) next = Math.round(next);
    setText(show(next));
    if (next !== value) onCommit(next);
  };
  return (
    <input
      className={className} type="number" inputMode="numeric" min={min} max={max} step={step} value={text} placeholder={placeholder} title={title}
      onFocus={() => { focused.current = true; }}
      onChange={(event) => setText(event.currentTarget.value)}
      onBlur={() => { focused.current = false; commit(); }}
      onKeyDown={(event) => { if (event.key === "Enter" && !isComposing(event)) commit(); }}
    />
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="w-field"><span className="w-field-label">{label}</span>{children}{hint ? <span className="w-field-hint">{hint}</span> : null}</label>;
}

export function formatTime(seconds: number) {
  if (!seconds) return "";
  const date = new Date(seconds * 1000);
  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

/** Multi-line text that commits on blur, so typing in long prompt fields does not rewrite the project on every key. */
export function CommitTextarea({ value, onCommit, rows = 6, className = "w-textarea", placeholder, readOnly = false }: { value: string; onCommit: (value: string) => void; rows?: number; className?: string; placeholder?: string; readOnly?: boolean }) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(value); }, [value]);
  return (
    <textarea
      className={className} rows={rows} value={text} placeholder={placeholder} readOnly={readOnly}
      onFocus={() => { focused.current = true; }}
      onChange={(event) => setText(event.currentTarget.value)}
      onBlur={() => { focused.current = false; if (text !== value) onCommit(text); }}
    />
  );
}
