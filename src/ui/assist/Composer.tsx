import { ArrowUp, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { orderedChapters } from "../../domain/documents";
import { isComposing } from "../common";
import { useWriter } from "../useWriter";
import { ASSIST_COMMANDS, type AssistCommand } from "./commands";

export type Mode = "agent" | "qa" | "organize";
export type Scope = "selection" | "chapter" | "book";


type Option = { key: string; label: string; hint?: string; pick: () => void };
type Props = {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  running: boolean;
  placeholder: string;
  mode: Mode;
  scope: Scope;
  onScope: (scope: Scope) => void;
  hasSelection: boolean;
  inChapter: boolean;
  /** What the assistant is reading for this message. */
  reading: string;
  onCommand: (command: AssistCommand) => void;
};

export function Composer({ inputRef, value, onChange, onSubmit, onStop, running, placeholder, mode, scope, onScope, hasSelection, inChapter, reading, onCommand }: Props) {
  const writer = useWriter();
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  // Escape hides the menu for the token at this offset until the author types elsewhere.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const token = useMemo(() => {
    const before = value.slice(0, caret);
    const match = before.match(/([@#])([^\s@#]{0,20})$/) ?? (/^\/\S*$/.test(before) ? before.match(/^(\/)(\S*)$/) : null);
    return match && caret - match[0].length !== dismissedAt ? { trigger: match[1], query: match[2], start: caret - match[0].length } : null;
  }, [value, caret, dismissedAt]);

  const insert = (start: number, text: string) => {
    const next = `${value.slice(0, start)}${text}${value.slice(caret)}`;
    onChange(next);
    const position = start + text.length;
    globalThis.setTimeout(() => { inputRef.current?.setSelectionRange(position, position); setCaret(position); }, 0);
  };

  const options = useMemo<Option[]>(() => {
    if (!token || !writer.project) return [];
    const { start, query } = token;
    if (token.trigger === "/") {
      return ASSIST_COMMANDS.filter((command) => (!command.needsChapter || inChapter) && command.label.includes(query)).slice(0, 8).map((command) => ({ key: command.label, label: `/${command.label}`, hint: command.hint, pick: () => onCommand(command) }));
    }
    if (token.trigger === "@") {
      const names = new Set<string>([...writer.project.characters.map((character) => character.name), ...(writer.memory?.entities ?? []).map((entity) => entity.name)]);
      return [...names].filter((name) => name.includes(query)).slice(0, 8).map((name) => ({ key: name, label: name, pick: () => insert(start, `@${name} `) }));
    }
    return orderedChapters(writer.project).map((chapter, index) => ({ chapter, index })).filter(({ chapter, index }) => chapter.title.includes(query) || String(index + 1).startsWith(query)).slice(0, 8).map(({ chapter, index }) => ({ key: chapter.id, label: `${index + 1}. ${chapter.title}`, pick: () => insert(start, `#第${index + 1}章「${chapter.title}」 `) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, writer.project, writer.memory, inChapter, value, caret]);

  const pickHighlighted = () => options[Math.min(highlight, options.length - 1)]?.pick();
  const scoped = mode === "agent";

  return (
    <form className={`w-composer ${mode}`} onSubmit={(event) => { event.preventDefault(); if (!running) onSubmit(); }}>
      {options.length ? (
        <div className="w-mention-menu" role="listbox">
          {options.map((option, index) => <button key={option.key} type="button" role="option" aria-selected={index === highlight} className={index === highlight ? "active" : ""} onMouseDown={(event) => { event.preventDefault(); option.pick(); }}><span>{option.label}</span>{option.hint ? <small>{option.hint}</small> : null}</button>)}
        </div>
      ) : null}
      <div className="w-composer-top">
        {scoped ? (
          <div className="w-scope" role="group" aria-label="范围">
            {([{ value: "selection", label: "选区" }, { value: "chapter", label: inChapter ? "本章" : "本文" }, { value: "book", label: "全书" }] as const).map((item) => <button key={item.value} type="button" aria-pressed={scope === item.value} className={scope === item.value ? "active" : ""} disabled={item.value === "selection" && !hasSelection} onClick={() => onScope(item.value)}>{item.label}</button>)}
          </div>
        ) : <span className="w-scope-mode">{mode === "qa" ? "问全书 · 答案带出处" : "整理设定稿"}</span>}
        <span className="w-composer-reading" title={reading}>{reading}</span>
      </div>
      <textarea
        ref={inputRef}
        rows={2}
        value={value}
        aria-label="对 AI 说"
        placeholder={placeholder}
        onChange={(event) => { onChange(event.currentTarget.value); setCaret(event.currentTarget.selectionStart); setHighlight(0); }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={(event) => {
          // Enter while an IME is composing confirms the candidate; it must not send or pick from the menu.
          if (isComposing(event)) return;
          if (options.length && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDismissedAt(token?.start ?? null); return; }
          if (options.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setHighlight((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length); return; }
          if (options.length && (event.key === "Enter" || event.key === "Tab")) { event.preventDefault(); pickHighlighted(); return; }
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!running) onSubmit(); }
        }}
      />
      <div className="w-composer-bar">
        <span>{running ? "AI 正在处理，可随时停止" : "/ 命令　@ 人物　# 章节"}</span>
        {running ? (
          <button type="button" className="w-send stop" onClick={onStop} title="停止" aria-label="停止"><Square size={11} fill="currentColor" /></button>
        ) : <button type="submit" className="w-send" disabled={!value.trim()} aria-label="发送"><ArrowUp size={15} /></button>}
      </div>
    </form>
  );
}
