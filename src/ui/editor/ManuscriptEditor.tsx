import { defaultKeymap, history, historyField, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { acceptSuggestion, aiKeymap, chinesePhrases, commentField, entityHighlighter, imageField, ghostField, setComments, setGhost, setSuggestion, suggestionField, typewriter, type CommentMark, type EntityInfo, type InlineSuggestion } from "./extensions";

export type EditorSelection = { from: number; to: number; text: string };
export type EditorApi = {
  view: () => EditorView | null;
  showSuggestion: (suggestion: InlineSuggestion | null) => void;
  /** Applies a change to the suggestion on the page (candidate, compare); no effect when there is none. */
  patchSuggestion: (patch: Partial<InlineSuggestion>) => void;
  acceptSuggestion: () => void;
  showGhost: (pos: number, text: string) => void;
  selection: () => EditorSelection;
  focus: () => void;
  revealRange: (from: number, to: number) => void;
  openSearch: () => void;
  coordsAt: (pos: number) => { left: number; top: number; bottom: number } | null;
};

type Props = {
  docKey: string;
  text: string;
  placeholder: string;
  entities: Map<string, EntityInfo>;
  comments: CommentMark[];
  typewriterMode: boolean;
  onChange: (text: string) => void;
  onSelectionChange: (selection: EditorSelection) => void;
  /** Fires whenever the suggestion on the page appears, changes or goes away, including through the keyboard. */
  onSuggestionChange?: (suggestion: InlineSuggestion | null) => void;
};

// Per-document editor state (text, selection, undo history), serialized so it survives the editor being
// remounted (preview toggle, switching views) and is rebuilt with the new instance's extensions.
type SavedState = { doc: string } & Record<string, unknown>;
const saved = new Map<string, SavedState>();
const MAX_SAVED = 60;

function saveState(key: string, state: EditorState) {
  saved.delete(key);
  saved.set(key, state.toJSON({ history: historyField }) as SavedState);
  if (saved.size > MAX_SAVED) saved.delete(saved.keys().next().value as string);
}

export const ManuscriptEditor = forwardRef<EditorApi, Props>(function ManuscriptEditor(props, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const entityCompartment = useRef(new Compartment()).current;
  const typewriterCompartment = useRef(new Compartment()).current;
  const placeholderCompartment = useRef(new Compartment()).current;
  const currentKey = useRef<string>("");

  const extensions = (): Extension[] => [
    history(),
    drawSelection(),
    highlightActiveLine(),
    EditorView.lineWrapping,
    chinesePhrases,
    search({ top: true }),
    highlightSelectionMatches({ minSelectionLength: 2 }),
    aiKeymap,
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    suggestionField,
    ghostField,
    commentField,
    imageField,
    entityCompartment.of(entityHighlighter(propsRef.current.entities)),
    typewriterCompartment.of(propsRef.current.typewriterMode ? typewriter : []),
    placeholderCompartment.of(placeholderExt(propsRef.current.placeholder)),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) propsRef.current.onChange(update.state.doc.toString());
      const suggestion = update.state.field(suggestionField, false) ?? null;
      if (suggestion !== (update.startState.field(suggestionField, false) ?? null)) propsRef.current.onSuggestionChange?.(suggestion);
      if (update.selectionSet || update.docChanged) {
        const range = update.state.selection.main;
        propsRef.current.onSelectionChange({ from: range.from, to: range.to, text: update.state.sliceDoc(range.from, range.to) });
      }
    }),
  ];

  /** Restores the document's saved state when its text is unchanged; otherwise starts fresh. */
  const stateFor = (key: string, text: string) => {
    const json = saved.get(key);
    if (json && json.doc === text) {
      try { return EditorState.fromJSON(json, { extensions: extensions() }, { history: historyField }); } catch { /* fall through */ }
    }
    return EditorState.create({ doc: text, extensions: extensions() });
  };

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({ state: stateFor(props.docKey, props.text), parent: hostRef.current });
    viewRef.current = view;
    currentKey.current = props.docKey;
    return () => { saveState(currentKey.current, view.state); view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch documents while keeping each document's undo history.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || currentKey.current === props.docKey) return;
    saveState(currentKey.current, view.state);
    view.setState(stateFor(props.docKey, props.text));
    currentKey.current = props.docKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.docKey]);

  // External text changes (applied proposals, restores, merges).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || currentKey.current !== props.docKey) return;
    const current = view.state.doc.toString();
    if (current === props.text) return;
    let start = 0;
    while (start < current.length && start < props.text.length && current[start] === props.text[start]) start += 1;
    let endCurrent = current.length;
    let endNext = props.text.length;
    while (endCurrent > start && endNext > start && current[endCurrent - 1] === props.text[endNext - 1]) { endCurrent -= 1; endNext -= 1; }
    view.dispatch({ changes: { from: start, to: endCurrent, insert: props.text.slice(start, endNext) }, userEvent: "external" });
  }, [props.text, props.docKey]);

  useEffect(() => { viewRef.current?.dispatch({ effects: entityCompartment.reconfigure(entityHighlighter(props.entities)) }); }, [props.entities, entityCompartment]);
  useEffect(() => { viewRef.current?.dispatch({ effects: typewriterCompartment.reconfigure(props.typewriterMode ? typewriter : []) }); }, [props.typewriterMode, typewriterCompartment]);
  useEffect(() => { viewRef.current?.dispatch({ effects: placeholderCompartment.reconfigure(placeholderExt(props.placeholder)) }); }, [props.placeholder, placeholderCompartment]);
  useEffect(() => { viewRef.current?.dispatch({ effects: setComments.of(props.comments) }); }, [props.comments, props.docKey]);

  useImperativeHandle(ref, () => ({
    view: () => viewRef.current,
    showSuggestion: (suggestion) => viewRef.current?.dispatch({ effects: setSuggestion.of(suggestion) }),
    patchSuggestion: (patch) => {
      const view = viewRef.current;
      const current = view?.state.field(suggestionField, false);
      if (view && current) view.dispatch({ effects: setSuggestion.of({ ...current, ...patch }) });
    },
    acceptSuggestion: () => { const view = viewRef.current; if (view) { acceptSuggestion(view); view.focus(); } },
    showGhost: (pos, text) => viewRef.current?.dispatch({ effects: setGhost.of(text ? { pos, text } : null) }),
    selection: () => {
      const view = viewRef.current;
      if (!view) return { from: 0, to: 0, text: "" };
      const range = view.state.selection.main;
      return { from: range.from, to: range.to, text: view.state.sliceDoc(range.from, range.to) };
    },
    focus: () => viewRef.current?.focus(),
    revealRange: (from, to) => {
      const view = viewRef.current;
      if (!view) return;
      const max = view.state.doc.length;
      view.dispatch({ selection: { anchor: Math.min(from, max), head: Math.min(to, max) }, effects: EditorView.scrollIntoView(Math.min(from, max), { y: "center" }) });
      view.focus();
    },
    openSearch: () => { const view = viewRef.current; if (view) openSearchPanel(view); },
    coordsAt: (pos) => viewRef.current?.coordsAtPos(pos) ?? null,
  }), []);

  return <div className="w-cm" ref={hostRef} />;
});
