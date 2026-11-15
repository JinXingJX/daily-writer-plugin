import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { orderedChapters, sortedVolumes, UNTITLED_CHAPTER } from "../domain/documents";
import { chapterStatusLabel } from "../domain/markdown";
import { formatWordCount } from "../domain/words";
import { useWriter } from "./useWriter";

/** Corkboard of chapter cards per volume: plan, reorder and edit summaries at a glance. */
export function BoardView() {
  const writer = useWriter();
  const { project, memory } = writer;
  const volumes = useMemo(() => (project ? sortedVolumes(project) : []), [project]);
  const [volumeId, setVolumeId] = useState<string>(volumes[0]?.id ?? "");
  const [dragging, setDragging] = useState<string | null>(null);
  if (!project) return null;
  const current = volumes.find((volume) => volume.id === volumeId) ?? volumes[0];
  const all = orderedChapters(project);
  const positions = new Map(all.map((chapter, index) => [chapter.id, index]));
  const chapters = all.filter((chapter) => chapter.volumeId === current?.id);
  const characters = new Map(project.characters.map((character) => [character.id, character.name]));
  return (
    <div className="w-board">
      <header className="w-memory-head">
        <select className="w-select small" value={current?.id} onChange={(event) => setVolumeId(event.currentTarget.value)}>{volumes.map((volume) => <option key={volume.id} value={volume.id}>{volume.title}</option>)}</select>
        <span className="w-muted">{chapters.length} 章 · {formatWordCount(chapters.reduce((total, chapter) => total + chapter.wordCount, 0))} · 拖动卡片调整顺序</span>
        <span className="w-spacer" />
        <button type="button" className="w-btn small" onClick={() => writer.addChapter({ volumeId: current?.id })}><Plus size={12} />新章节</button>
      </header>
      {current ? <textarea className="w-volume-summary" rows={2} placeholder="本卷概要…" value={current.summary} onChange={(event) => { const value = event.currentTarget.value; writer.mutateProject((draft) => { const volume = draft.volumes.find((item) => item.id === current.id); if (volume) volume.summary = value; }); }} /> : null}
      <div className="w-board-grid">
        {!chapters.length ? <p className="w-muted pad">这一卷还没有章节。</p> : null}
        {chapters.slice(0, 600).map((chapter) => {
          const card = memory?.cards.get(chapter.id);
          const progress = chapter.targetWords ? Math.min(100, (chapter.wordCount / chapter.targetWords) * 100) : 0;
          return (
            <article
              key={chapter.id}
              className={`w-board-card s-${chapter.status} ${dragging === chapter.id ? "dragging" : ""}`}
              draggable
              onDragStart={(event) => { setDragging(chapter.id); event.dataTransfer.effectAllowed = "move"; }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); if (dragging && dragging !== chapter.id) writer.moveChapter(dragging, chapter.volumeId, chapter.id); setDragging(null); }}
            >
              <div className="w-row small">
                <span className="w-tree-index">{(positions.get(chapter.id) ?? 0) + 1}</span>
                <button type="button" className="w-board-title" title="打开正文" onClick={() => writer.selectDoc({ kind: "chapter", id: chapter.id })}>{chapter.title.trim() || UNTITLED_CHAPTER}</button>
                <span className={`w-tree-status s-${chapter.status}`}>{chapterStatusLabel(chapter.status)}</span>
              </div>
              <textarea rows={4} value={chapter.summary} placeholder={card?.summary ? `（记忆）${card.summary}` : "本章要写什么…"} onChange={(event) => writer.updateChapter(chapter.id, { summary: event.currentTarget.value })} />
              <div className="w-row small w-muted">
                <span>{chapter.wordCount} 字{chapter.targetWords ? ` / ${chapter.targetWords}` : ""}</span>
                {chapter.povCharacterId ? <span>视角：{characters.get(chapter.povCharacterId)}</span> : null}
              </div>
              {chapter.targetWords ? <div className="w-progress thin"><span style={{ width: `${progress}%` }} /></div> : null}
            </article>
          );
        })}
        {chapters.length > 600 ? <p className="w-muted pad">本卷共 {chapters.length} 章，卡片墙只显示前 600 章；其余章节可在左侧目录中打开。</p> : null}
        <button type="button" className="w-board-add" onClick={() => writer.addChapter({ volumeId: current?.id })}><Plus size={16} />新章节</button>
      </div>
    </div>
  );
}
