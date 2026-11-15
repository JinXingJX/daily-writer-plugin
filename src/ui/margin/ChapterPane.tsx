import { Search } from "lucide-react";
import { useDeferredValue, useMemo } from "react";
import { chapterLabel, orderedChapters, readDoc } from "../../domain/documents";
import { THREAD_KIND_LABELS } from "../../memory/schema";
import { lastSeenBefore, relevantThreads } from "../../story/selectors";
import { ChapterInspector } from "../ChapterInspector";
import { HistoryTab } from "../assist/HistoryTab";
import type { EditorApi } from "../editor/ManuscriptEditor";
import { useWriter } from "../useWriter";

/** "本章": who is on stage, which threads are due, and the chapter's tools. */
export function ChapterPane({ editorRef }: { editorRef: React.RefObject<EditorApi | null> }) {
  const writer = useWriter();
  const { project, draft, active, memory, prefs } = writer;
  const rawText = project && draft ? readDoc(project, draft.texts, active) ?? "" : "";
  const text = useDeferredValue(rawText);
  const chapter = active.kind === "chapter" ? project?.chapters.find((item) => item.id === active.id) : undefined;
  const position = project && chapter ? orderedChapters(project).findIndex((item) => item.id === chapter.id) : -1;

  const cast = useMemo(() => {
    if (!memory || memory.isEmpty || position < 0) return [];
    return memory.entitiesIn(text, 12).filter((entity) => entity.category === "character").slice(0, 5).map((entity) => {
      const state = Object.values(memory.stateAt(entity.id, position)).pop();
      const seen = lastSeenBefore(memory, entity.name, position);
      return { id: entity.id, name: entity.name, state: state ? `${state.attribute}：${state.value}` : entity.summary, gap: seen >= 0 ? position - seen : null, seen };
    });
  }, [memory, position, text]);
  const threads = useMemo(() => (memory && !memory.isEmpty && position >= 0 ? relevantThreads(memory, position, cast.map((item) => item.name), 4) : []), [cast, memory, position]);
  if (!project) return null;

  const review = () => writer.openAssist("chat", true, { text: "以责任编辑的身份审读当前章节：找出逻辑漏洞、与前文或设定矛盾、节奏拖沓、人物动机不足之处，用批注标出，不要直接改正文。最后总结 3 条最重要的修改建议。", send: true });

  return (
    <div className="w-chapter-pane">
      {cast.length ? (
        <section>
          <h2>这一章的人</h2>
          {cast.map((item) => <div key={item.id} className="w-pane-row"><strong>{item.name}</strong><span>{[item.state, item.gap !== null && item.gap >= 2 ? `上次出场${chapterLabel(item.seen)}，隔了 ${item.gap} 章` : ""].filter(Boolean).join(" · ")}</span></div>)}
        </section>
      ) : null}
      {threads.length ? (
        <section>
          <h2>该动的线</h2>
          {threads.map((thread) => <div key={thread.id} className="w-pane-row"><strong>{thread.title}</strong><span>{THREAD_KIND_LABELS[thread.kind]}{thread.plantedAt >= 0 ? `，${chapterLabel(thread.plantedAt)}埋下，已等 ${position - thread.plantedAt} 章` : ""}</span></div>)}
        </section>
      ) : null}
      <section>
        <h2>工具</h2>
        <div className="w-chips">
          {chapter ? <button type="button" className="w-chip-square" onClick={review}>审读本章</button> : null}
          <button type="button" className={`w-chip-square ${writer.toneOpen ? "active" : ""}`} aria-pressed={writer.toneOpen} onClick={() => writer.setToneOpen(!writer.toneOpen)}>文风检测</button>
          <button type="button" className={`w-chip-square ${prefs.markdownPreview ? "active" : ""}`} aria-pressed={prefs.markdownPreview} onClick={() => writer.setPrefs({ markdownPreview: !prefs.markdownPreview })}>预览 ⌘⇧P</button>
          <button type="button" className="w-chip-square" disabled={prefs.markdownPreview} onClick={() => editorRef.current?.openSearch()}><Search size={12} />查找 ⌘F</button>
        </div>
      </section>
      {chapter ? <details open><summary>章节信息</summary><ChapterInspector chapter={chapter} text={rawText} /></details> : null}
      <details><summary>历史版本</summary><HistoryTab /></details>
    </div>
  );
}
