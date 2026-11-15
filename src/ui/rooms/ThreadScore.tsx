import { Waypoints } from "lucide-react";
import { useMemo } from "react";
import { chapterLabel, orderedChapters, sortedVolumes } from "../../domain/documents";
import { THREAD_KIND_LABELS } from "../../memory/schema";
import { buildScore } from "../../story/score";
import { positionedThreads } from "../../story/selectors";
import { Empty } from "../common";
import type { OpenChapter } from "../story/useNotebook";
import { useWriter } from "../useWriter";

/** Every thread as a line across the chapters: where it was planted, where it stands, where it is planned to land. */
export function ThreadScore({ onOpenChapter }: { onOpenChapter: OpenChapter }) {
  const writer = useWriter();
  const { project, memory, story } = writer;
  const stamp = memory?.status.updatedAt;
  const score = useMemo(() => {
    if (!memory || memory.isEmpty) return null;
    return buildScore(positionedThreads(memory), memory.orderedIds.length, story?.thresholds.foreshadowStaleChapters ?? 30, (id) => memory.position(id));
  }, [stamp, story?.thresholds.foreshadowStaleChapters]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!project) return null;
  if (!memory || memory.isEmpty || !score) {
    return <div className="w-memory-body"><Empty icon={<Waypoints size={20} />} title="线索谱需要故事记忆">建立记忆后，每条伏笔、期待和暗线都会画成一条线，一眼看出哪条沉寂了、哪条快兑现。<div className="w-row" style={{ justifyContent: "center", marginTop: 10 }}><button type="button" className="w-btn primary" onClick={() => writer.openArchive("memory")}>去建立记忆</button></div></Empty></div>;
  }
  if (!score.rows.length) return <div className="w-memory-body"><Empty icon={<Waypoints size={20} />} title="还没有识别出线索">可以在“线索表”里手动登记伏笔和期待。</Empty></div>;

  const scale = Math.max(1, score.horizon - 1);
  const pct = (position: number) => `${(position / scale) * 100}%`;
  const chapters = orderedChapters(project);
  const volumes = sortedVolumes(project).map((volume) => ({ id: volume.id, title: volume.title, count: chapters.filter((chapter) => chapter.volumeId === volume.id).length })).filter((volume) => volume.count);

  return (
    <div className="w-memory-body">
      <div className="w-tscore-scroll">
        <div className="w-tscore">
          <div className="w-tscore-row head">
            <div className="w-tscore-label" />
            <div className="w-tscore-volumes">{volumes.map((volume) => <span key={volume.id} style={{ flex: `0 0 ${(volume.count / score.horizon) * 100}%` }}>{volume.title}</span>)}</div>
          </div>
          <div className="w-tscore-rows">
            {score.rows.map((row) => (
              <div key={row.id} className={`w-tscore-row ${row.status}`}>
                <div className="w-tscore-label">
                  <button type="button" className={`w-tscore-name ${row.stale ? "stale" : ""}`} onClick={() => writer.setStoryLens("threads")}>{row.title}</button>
                  <span>{THREAD_KIND_LABELS[row.kind]}{row.status === "paid" ? " · 已兑现" : row.status === "abandoned" ? " · 已放弃" : row.stale ? ` · ${row.silent} 章没动过` : ""}</span>
                </div>
                <div className="w-tscore-track">
                  <span className={`w-tscore-line ${row.kind}`} style={{ left: pct(row.start), width: `calc(${pct(Math.max(row.end, row.start))} - ${pct(row.start)})` }} />
                  {row.planEnd !== null ? <span className={`w-tscore-plan ${row.kind}`} style={{ left: pct(row.end), width: `calc(${pct(row.planEnd)} - ${pct(row.end)})` }} /> : null}
                  {row.ticks.map((tick, index) => <button key={index} type="button" className={`w-tscore-tick ${row.kind} ${tick.payoff ? "payoff" : ""}`} style={{ left: pct(tick.position) }} title={chapterLabel(tick.position)} aria-label={`${row.title}：${chapterLabel(tick.position)}`} onClick={() => onOpenChapter(memory.orderedIds[tick.position])} />)}
                </div>
              </div>
            ))}
            <div className="w-tscore-now" style={{ left: `calc(var(--tscore-label) + (100% - var(--tscore-label)) * ${score.current / scale})` }} aria-hidden="true" />
          </div>
          <div className="w-tscore-row foot">
            <div className="w-tscore-label" />
            <div className="w-tscore-axis">
              <span style={{ left: 0 }}>第 1 章</span>
              <span className="now" style={{ left: pct(score.current), transform: `translateX(${score.current / scale > 0.85 ? "-100%" : "-50%"})` }}>{chapterLabel(score.current)} · 你在这里</span>
            </div>
          </div>
        </div>
      </div>
      <dl className="w-tscore-legend">
        <div><dt className="expectation" /><dd>期待</dd></div>
        <div><dt className="mystery" /><dd>暗线与悬念</dd></div>
        <div><dt className="foreshadow" /><dd>伏笔</dd></div>
        <div><dt className="plan" /><dd>计划中</dd></div>
      </dl>
    </div>
  );
}
