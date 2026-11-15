// CodeMirror extensions for prose: inline AI suggestions, ghost continuation, comments, entity highlights, typewriter.
import { EditorState, Prec, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { IMAGE_LINE, insertImageLine } from "../../images/schema";
import { activeImageUrl } from "../../images/store";
import { Decoration, EditorView, hoverTooltip, keymap, MatchDecorator, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";

// ---------- inline rewrite suggestion ----------
/** `compare` keeps the original on the page, struck through; otherwise the candidate stands in its place. */
export type InlineSuggestion = { from: number; to: number; candidates: string[]; index: number; label: string; compare?: boolean };
export const setSuggestion = StateEffect.define<InlineSuggestion | null>();
export const suggestionField = StateField.define<InlineSuggestion | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setSuggestion)) return effect.value;
    if (!value || !transaction.docChanged) return value;
    let touched = false;
    transaction.changes.iterChangedRanges((fromA, toA) => { if (fromA < value.to && toA > value.from) touched = true; });
    if (touched) return null;
    return { ...value, from: transaction.changes.mapPos(value.from, 1), to: transaction.changes.mapPos(value.to, -1) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => {
    if (!value) return Decoration.none;
    const widget = new SuggestionWidget(value);
    if (value.to > value.from && !value.compare) return Decoration.set([Decoration.replace({ widget }).range(value.from, value.to)]);
    const ranges: Range<Decoration>[] = [];
    if (value.to > value.from) ranges.push(Decoration.mark({ class: "cm-suggest-del" }).range(value.from, value.to));
    ranges.push(Decoration.widget({ widget, side: 1 }).range(value.to));
    return Decoration.set(ranges);
  }),
});

class SuggestionWidget extends WidgetType {
  constructor(readonly value: InlineSuggestion) { super(); }
  eq(other: SuggestionWidget) { return other.value.index === this.value.index && other.value.candidates === this.value.candidates && other.value.compare === this.value.compare; }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-suggest";
    const text = document.createElement("span");
    text.className = "cm-suggest-ins";
    text.textContent = this.value.candidates[this.value.index] ?? "";
    wrap.append(text);
    return wrap;
  }
  ignoreEvent() { return false; }
}

export function acceptSuggestion(view: EditorView): boolean {
  const value = view.state.field(suggestionField, false);
  if (!value) return false;
  const insert = value.candidates[value.index] ?? "";
  view.dispatch({ changes: { from: value.from, to: value.to, insert }, effects: setSuggestion.of(null), selection: { anchor: value.from + insert.length }, userEvent: "input.ai" });
  return true;
}

export function cycleSuggestion(view: EditorView, delta: number): boolean {
  const value = view.state.field(suggestionField, false);
  if (!value || value.candidates.length < 2) return false;
  view.dispatch({ effects: setSuggestion.of({ ...value, index: (value.index + delta + value.candidates.length) % value.candidates.length }) });
  return true;
}

// ---------- ghost continuation ----------
export type Ghost = { pos: number; text: string };
export const setGhost = StateEffect.define<Ghost | null>();
export const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setGhost)) return effect.value;
    if (value && (transaction.docChanged || transaction.selection)) return transaction.docChanged ? null : value;
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => (value ? Decoration.set([Decoration.widget({ widget: new GhostWidget(value.text), side: 1 }).range(value.pos)]) : Decoration.none)),
});

class GhostWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: GhostWidget) { return other.text === this.text; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-ghost";
    span.textContent = this.text;
    const hint = document.createElement("span");
    hint.className = "cm-suggest-hint";
    hint.textContent = "Tab 收下 · ⌘→ 收一句 · Esc 不要 · ⌘J 换一段";
    span.append(hint);
    return span;
  }
}

export function acceptGhost(view: EditorView, sentenceOnly = false): boolean {
  const ghost = view.state.field(ghostField, false);
  if (!ghost) return false;
  let insert = ghost.text;
  let rest: string | null = null;
  if (sentenceOnly) {
    const match = ghost.text.match(/^[\s\S]*?[。！？!?…」”\n]+/);
    if (match && match[0].length < ghost.text.length) { insert = match[0]; rest = ghost.text.slice(match[0].length); }
  }
  const pos = ghost.pos + insert.length;
  view.dispatch({ changes: { from: ghost.pos, insert }, selection: { anchor: pos }, userEvent: "input.ai" });
  if (rest) view.dispatch({ effects: setGhost.of({ pos, text: rest }) });
  return true;
}

export const aiKeymap = Prec.highest(keymap.of([
  { key: "Tab", run: (view) => acceptSuggestion(view) || acceptGhost(view) },
  { key: "Mod-ArrowRight", run: (view) => acceptGhost(view, true) },
  { key: "Alt-]", run: (view) => cycleSuggestion(view, 1) },
  { key: "Alt-[", run: (view) => cycleSuggestion(view, -1) },
  {
    key: "Escape",
    run: (view) => {
      const effects: StateEffect<unknown>[] = [];
      if (view.state.field(suggestionField, false)) effects.push(setSuggestion.of(null));
      if (view.state.field(ghostField, false)) effects.push(setGhost.of(null));
      if (!effects.length) return false;
      view.dispatch({ effects });
      return true;
    },
  },
]));

// ---------- comments ----------
export type CommentMark = { id: string; from: number; to: number; severity: string; text: string; active?: boolean };
export const setComments = StateEffect.define<CommentMark[]>();
export const commentField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setComments)) {
        next = Decoration.set(effect.value.filter((mark) => mark.to > mark.from && mark.to <= transaction.state.doc.length).sort((left, right) => left.from - right.from).map((mark) => Decoration.mark({ class: `cm-comment ${mark.severity}${mark.active ? " active" : ""}`, attributes: { title: mark.text, "data-comment": mark.id } }).range(mark.from, mark.to)));
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// ---------- entity highlights with hover cards ----------
export type EntityInfo = { name: string; category: string; summary: string };
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function entityHighlighter(entities: Map<string, EntityInfo>): Extension {
  const names = [...entities.keys()].filter((name) => name.length >= 2).sort((left, right) => right.length - left.length).slice(0, 600);
  if (!names.length) return [];
  const matcher = new MatchDecorator({ regexp: new RegExp(names.map(escapeRegExp).join("|"), "gu"), decoration: (match) => Decoration.mark({ class: `cm-entity cm-entity-${entities.get(match[0])?.category ?? "other"}` }) });
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = matcher.createDeco(view); }
    update(update: ViewUpdate) { this.decorations = matcher.updateDeco(update, this.decorations); }
  }, { decorations: (instance) => instance.decorations });
  const tooltip = hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos);
    for (const name of names) {
      let index = line.text.indexOf(name);
      while (index >= 0) {
        const from = line.from + index;
        if (pos >= from && pos <= from + name.length) {
          const info = entities.get(name) as EntityInfo;
          return { pos: from, end: from + name.length, above: true, create: () => { const dom = document.createElement("div"); dom.className = "cm-entity-card"; const title = document.createElement("strong"); title.textContent = `${info.name} · ${info.category}`; const body = document.createElement("p"); body.textContent = info.summary || "暂无档案"; dom.append(title, body); return { dom }; } };
        }
        index = line.text.indexOf(name, index + 1);
      }
    }
    return null;
  }, { hoverTime: 350 });
  return [plugin, tooltip];
}

// ---------- inline images ----------
class ImageWidget extends WidgetType {
  constructor(readonly assetId: string, readonly caption: string) { super(); }
  eq(other: ImageWidget) { return other.assetId === this.assetId && other.caption === this.caption; }
  toDOM(view: EditorView) {
    const figure = document.createElement("figure");
    figure.className = "cm-image";
    const image = document.createElement("img");
    image.alt = this.caption;
    figure.append(image);
    if (this.caption) { const caption = document.createElement("figcaption"); caption.textContent = this.caption; figure.append(caption); }
    image.addEventListener("load", () => view.requestMeasure());
    activeImageUrl(this.assetId).then((url) => { image.src = url; }).catch((error: unknown) => {
      image.remove();
      const missing = document.createElement("div");
      missing.className = "cm-image-missing";
      missing.textContent = error instanceof Error ? error.message : "图片无法显示";
      figure.prepend(missing);
      view.requestMeasure();
    });
    return figure;
  }
  // Rough height, so scrolling through a chapter does not jump before images load.
  get estimatedHeight() { return 320; }
  ignoreEvent() { return false; }
}

function imageDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  if (!doc.toString().includes("](image:")) return Decoration.none;
  const selection = state.selection.main;
  const ranges: Range<Decoration>[] = [];
  for (let number = 1; number <= doc.lines; number += 1) {
    const line = doc.line(number);
    const match = IMAGE_LINE.exec(line.text);
    if (!match) continue;
    const widget = new ImageWidget(match[2], match[1]);
    // On the line the caret is on, the source stays editable with the picture below it.
    const editing = selection.from <= line.to && selection.to >= line.from;
    ranges.push(editing ? Decoration.widget({ widget, block: true, side: 1 }).range(line.to) : Decoration.replace({ widget, block: true }).range(line.from, line.to));
  }
  return Decoration.set(ranges);
}

// Block decorations have to come from a state field.
export const imageField = StateField.define<DecorationSet>({
  create: imageDecorations,
  update(value, transaction) {
    // Moving the caret only matters in a document that has images.
    if (transaction.docChanged || (transaction.selection && value !== Decoration.none)) return imageDecorations(transaction.state);
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Inserts an image on its own line after the caret's line, as an ordinary undoable edit. */
export function insertImageAtCaret(view: EditorView, markup: string) {
  const { insertAt, insert, caret } = insertImageLine(view.state.doc.toString(), view.state.selection.main.to, markup);
  view.dispatch({ changes: { from: insertAt, insert }, selection: { anchor: caret } });
  view.focus();
}

// ---------- typewriter scrolling ----------
export const typewriter: Extension = EditorView.updateListener.of((update) => {
  if (!update.selectionSet && !update.docChanged) return;
  const head = update.state.selection.main.head;
  const view = update.view;
  globalThis.requestAnimationFrame(() => { if (view.state.selection.main.head === head) view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) }); });
});

export const chinesePhrases = EditorState.phrases.of({
  "Find": "查找", "Replace": "替换", "next": "下一个", "previous": "上一个", "all": "全部", "match case": "区分大小写", "regexp": "正则", "by word": "整词", "replace": "替换", "replace all": "全部替换", "close": "关闭", "current match": "当前匹配", "replaced $ matches": "已替换 $ 处", "replaced match on line $": "已替换第 $ 行", "on line": "行", "Go to line": "跳转到行", "go": "跳转",
});
