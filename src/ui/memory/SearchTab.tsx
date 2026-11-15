import { Replace, Search } from "lucide-react";
import { useRef, useState } from "react";
import { chapterLabel } from "../../domain/documents";
import { replaceInBook, searchBook, type SearchHit } from "../../storage/bookOps";
import { isComposing, Spinner, useDialogs } from "../common";
import { useWriter } from "../useWriter";

export function SearchTab({ onOpenChapter }: { onOpenChapter: (id: string, quote?: string) => void }) {
  const writer = useWriter();
  const dialogs = useDialogs();
  const { project } = writer;
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [regex, setRegex] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  // What the current hits were found with; replacing always uses this, not whatever is typed now.
  const [searched, setSearched] = useState<{ query: string; regex: boolean } | null>(null);
  const [progress, setProgress] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  if (!project) return null;

  const run = async () => {
    if (!query) return;
    await writer.flush();
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setHits([]);
    setSearched({ query, regex });
    try {
      const result = await searchBook(project, query, { regex }, (done, total, partial) => { setProgress(`${done}/${total}`); setHits([...partial]); }, controller.signal);
      setHits(result);
      setSelected(new Set(result.map((hit) => hit.chapterId)));
    } catch (error) {
      setHits(null);
      setSearched(null);
      writer.notify("error", regex ? `正则表达式有误或查找失败：${error instanceof Error ? error.message : String(error)}` : error instanceof Error ? error.message : String(error));
    }
    finally { setBusy(false); setProgress(""); }
  };

  const replace = async () => {
    if (!hits || !searched) return;
    const chosen = hits.filter((hit) => selected.has(hit.chapterId));
    if (!chosen.length) return;
    const count = chosen.reduce((total, hit) => total + hit.count, 0);
    const what = replacement ? `替换为“${replacement}”` : "删除（替换为空）";
    if (!(await dialogs.confirm("全书替换", `在 ${chosen.length} 章中把 ${count} 处“${searched.query}”${what}？每章替换前都会保存历史版本。`, { danger: !replacement, confirmLabel: "替换" }))) return;
    setBusy(true);
    try {
      await writer.flush();
      const result = await replaceInBook(project, searched.query, replacement, chosen.map((hit) => hit.chapterId), { regex: searched.regex });
      writer.adopt(result.project, result.texts);
      writer.notify("success", `已替换 ${result.replaced} 处。`);
      setHits(null);
      setSearched(null);
    } catch (error) { writer.notify("error", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const total = hits?.reduce((sum, hit) => sum + hit.count, 0) ?? 0;
  const chosenCount = hits?.filter((hit) => selected.has(hit.chapterId)).length ?? 0;
  const stale = Boolean(searched && (searched.query !== query || searched.regex !== regex));
  return (
    <div className="w-outline">
      <div className="w-search-form">
        <input className="w-input grow" placeholder="在全书原文中查找" value={query} onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter" && !isComposing(event)) void run(); }} />
        <label className="w-check"><input type="checkbox" checked={regex} onChange={(event) => setRegex(event.currentTarget.checked)} />正则</label>
        <button type="button" className="w-btn primary" disabled={busy || !query} onClick={() => void run()}>{busy ? <Spinner size={12} /> : <Search size={13} />}查找</button>
      </div>
      <div className="w-search-form">
        <input className="w-input grow" placeholder="替换为（可选）" value={replacement} onChange={(event) => setReplacement(event.currentTarget.value)} />
        <button type="button" className="w-btn" disabled={busy || !hits?.length || !chosenCount} onClick={() => void replace()}><Replace size={13} />替换所选 {chosenCount ? `${chosenCount} 章` : "章节"}</button>
      </div>
      {hits ? (
        <div className="w-row small">
          <span className="w-muted">{busy ? `搜索中 ${progress}… ` : ""}“{searched?.query}”：{hits.length} 章 · {total} 处</span>
          {hits.length && !busy ? <><button type="button" className="w-link" onClick={() => setSelected(new Set(hits.map((hit) => hit.chapterId)))}>全选</button><button type="button" className="w-link" onClick={() => setSelected(new Set())}>清空</button></> : null}
          {stale ? <span className="w-pill warn">查找内容已修改，替换仍按“{searched?.query}”进行；按 Enter 重新查找</span> : null}
        </div>
      ) : null}
      {hits?.map((hit) => (
        <article key={hit.chapterId} className="w-search-hit">
          <label className="w-check"><input type="checkbox" checked={selected.has(hit.chapterId)} onChange={(event) => { const checked = event.currentTarget.checked; setSelected((current) => { const next = new Set(current); if (checked) next.add(hit.chapterId); else next.delete(hit.chapterId); return next; }); }} /><b>{chapterLabel(hit.position)} {project.chapters.find((chapter) => chapter.id === hit.chapterId)?.title}</b><span className="w-muted">{hit.count} 处</span></label>
          {hit.snippets.map((snippet, index) => <button key={index} type="button" className="w-snippet" onClick={() => onOpenChapter(hit.chapterId, snippet.match)}>…{snippet.before}<mark>{snippet.match}</mark>{snippet.after}…</button>)}
        </article>
      ))}
    </div>
  );
}
