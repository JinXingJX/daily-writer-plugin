import { focusPluginPanel } from "@daily/plugin-sdk";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { orderedChapters, ROOT_DOCS, UNTITLED_CHAPTER } from "../domain/documents";
import { isComposing } from "./common";
import { useWriter } from "./useWriter";

type Command = { id: string; label: string; hint?: string; run: () => void };

export function CommandPalette({ onClose, actions }: { onClose: () => void; actions: { label: string; hint?: string; run: () => void }[] }) {
  const writer = useWriter();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => panelRef.current ? focusPluginPanel(panelRef.current, () => closeRef.current()) : undefined, []);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  // Keep the highlighted command visible while moving with the arrow keys.
  useEffect(() => { listRef.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" }); }, [index]);
  const commands = useMemo<Command[]>(() => {
    const project = writer.project;
    if (!project) return [];
    const list: Command[] = [];
    actions.forEach((action, actionIndex) => list.push({ id: `action-${actionIndex}`, ...action }));
    for (const doc of ROOT_DOCS) list.push({ id: `doc-${doc.kind}`, label: doc.label, hint: "设定文档", run: () => writer.selectDoc({ kind: doc.kind }) });
    orderedChapters(project).forEach((chapter, position) => list.push({ id: chapter.id, label: `${position + 1}. ${chapter.title.trim() || UNTITLED_CHAPTER}`, hint: chapter.summary.slice(0, 40), run: () => writer.selectDoc({ kind: "chapter", id: chapter.id }) }));
    for (const character of project.characters) list.push({ id: `char-${character.id}`, label: `人物：${character.name}`, run: () => writer.openArchive("bible") });
    return list;
  }, [actions, writer]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands.slice(0, 60);
    const number = /^\d+$/.test(q) ? Number(q) : null;
    return commands.filter((command) => command.label.toLowerCase().includes(q) || (number !== null && command.label.startsWith(`${number}. `))).slice(0, 60);
  }, [commands, query]);
  const run = (command: Command | undefined) => { if (!command) return; onClose(); command.run(); };
  return (
    <div className="w-modal-backdrop top" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panelRef} className="w-palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="w-palette-input"><Search size={15} /><input ref={inputRef} aria-label="搜索与命令" role="combobox" aria-autocomplete="list" aria-expanded={true} aria-controls="writer-command-results" aria-activedescendant={filtered[index] ? `writer-command-${index}` : undefined} value={query} placeholder="跳转章节（输入标题或序号）、执行操作…" onChange={(event) => { setQuery(event.currentTarget.value); setIndex(0); }} onKeyDown={(event) => {
          if (isComposing(event)) return;
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
          if (event.key === "ArrowDown") { event.preventDefault(); setIndex((current) => (filtered.length ? (current + 1) % filtered.length : 0)); }
          if (event.key === "ArrowUp") { event.preventDefault(); setIndex((current) => (filtered.length ? (current - 1 + filtered.length) % filtered.length : 0)); }
          if (event.key === "Enter") { event.preventDefault(); run(filtered[index]); }
        }} /></div>
        <div className="w-palette-list" id="writer-command-results" role="listbox" ref={listRef}>
          {filtered.map((command, commandIndex) => (
            <button id={`writer-command-${commandIndex}`} role="option" aria-selected={commandIndex === index} tabIndex={-1} key={command.id} type="button" className={commandIndex === index ? "active" : ""} onMouseEnter={() => setIndex(commandIndex)} onClick={() => run(command)}>
              <span>{command.label}</span>{command.hint ? <span className="w-muted">{command.hint}</span> : null}
            </button>
          ))}
          {!filtered.length ? <p className="w-muted pad">没有匹配项</p> : null}
        </div>
      </div>
    </div>
  );
}
