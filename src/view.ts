import type { PluginViewContext } from "@daily/plugin-sdk";

let view: PluginViewContext | null = null;
let container: HTMLElement | null = null;

export function setView(context: PluginViewContext | null, element: HTMLElement | null = null) {
  view = context;
  container = element;
}

export function viewIsVisible() {
  return (view?.visible ?? true) && document.visibilityState !== "hidden";
}

export function onViewVisibilityChange(listener: () => void): () => void {
  const off = view?.onVisibilityChange(listener);
  document.addEventListener("visibilitychange", listener);
  return () => { off?.(); document.removeEventListener("visibilitychange", listener); };
}

/** Starts UI observation while visible and releases its timers while hidden. */
export function whileViewVisible(start: () => () => void): () => void {
  let stop: (() => void) | undefined;
  const update = () => {
    if (viewIsVisible()) stop ??= start();
    else { stop?.(); stop = undefined; }
  };
  const off = onViewVisibilityChange(update);
  update();
  return () => { off(); stop?.(); };
}

/** Keys bubble inside this view before the app's shortcuts see them. */
export function onViewKeyDown(listener: (event: KeyboardEvent) => void): () => void {
  const target = container;
  const onKey = (event: KeyboardEvent) => { if (viewIsVisible()) listener(event); };
  target?.addEventListener("keydown", onKey);
  return () => target?.removeEventListener("keydown", onKey);
}

export function viewBounds() {
  return container?.getBoundingClientRect() ?? { left: 0, top: 0, width: innerWidth, height: innerHeight };
}

/** Converts pointer coordinates to the view's fixed-position coordinate space. */
export function viewPoint(x: number, y: number) {
  const bounds = viewBounds();
  return { x: x - bounds.left, y: y - bounds.top };
}

export function observeViewSize(listener: (width: number) => void): () => void {
  if (!container) return () => undefined;
  const target = container;
  const observer = new ResizeObserver(() => { if (target.clientWidth) listener(target.clientWidth); });
  observer.observe(target);
  listener(target.clientWidth);
  return () => observer.disconnect();
}
