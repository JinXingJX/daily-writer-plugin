import { whileViewVisible } from "../../view";
import { Pause, Play } from "lucide-react";
import { useEffect, useMemo } from "react";
import { eventPosition, type TimeAxis } from "../../atlas/timeline";
import type { AtlasEvent } from "../../atlas/schema";
import type { WriterProject } from "../../types";

const STEP_MS = 900;
export const SPANS: { value: string; label: string; span: number | null }[] = [{ value: "all", label: "累积至此", span: null }, { value: "10", label: "最近 10 章", span: 10 }, { value: "1", label: "仅这一章", span: 1 }];

type Props = { project: WriterProject; axis: TimeAxis; events: AtlasEvent[]; cursor: number; onCursor: (cursor: number) => void; span: string; onSpan: (span: string) => void; playing: boolean; onPlaying: (playing: boolean) => void };

export function AtlasTimeline({ project, axis, events, cursor, onCursor, span, onSpan, playing, onPlaying }: Props) {
  const total = axis.stops.length;
  useEffect(() => {
    if (!playing) return;
    if (cursor >= total - 1) { onPlaying(false); return; }
    return whileViewVisible(() => {
      const timer = globalThis.setTimeout(() => onCursor(cursor + 1), STEP_MS);
      return () => globalThis.clearTimeout(timer);
    });
  }, [cursor, onCursor, onPlaying, playing, total]);

  const percent = (index: number) => (total <= 1 ? 0 : (index / (total - 1)) * 100);
  const bars = useMemo(() => {
    const buckets = Math.min(total, 240);
    const counts = new Array<number>(Math.max(1, buckets)).fill(0);
    for (const event of events) { const position = eventPosition(axis, event); if (position >= 0) counts[Math.min(buckets - 1, Math.floor((position / Math.max(1, total)) * buckets))] += event.importance; }
    const highest = Math.max(1, ...counts);
    return counts.map((count) => count / highest);
  }, [axis, events, total]);
  const volumes = useMemo(() => {
    const bands: { id: string; title: string; start: number; end: number }[] = [];
    axis.stops.forEach((stop, index) => {
      if (!stop.volumeId) return;
      const last = bands[bands.length - 1];
      if (last?.id === stop.volumeId) last.end = index;
      else bands.push({ id: stop.volumeId, title: project.volumes.find((volume) => volume.id === stop.volumeId)?.title ?? "", start: index, end: index });
    });
    return bands;
  }, [axis.stops, project.volumes]);

  if (!total) return null;
  const stop = axis.stops[Math.min(cursor, total - 1)];
  const here = events.filter((event) => eventPosition(axis, event) === cursor);
  const time = here.find((event) => event.storyTime)?.storyTime;
  return (
    <div className="w-atlas-timeline" role="group" aria-label="时间轴">
      <div className="w-atlas-time-head">
        <button type="button" className="w-icon-btn small" aria-label={playing ? "暂停" : "播放"} onClick={() => { if (!playing && cursor >= total - 1) onCursor(0); onPlaying(!playing); }} title={playing ? "暂停" : "播放"}>{playing ? <Pause size={13} /> : <Play size={13} />}</button>
        <strong>{stop.label}</strong>
        {stop.kind === "future" ? <span className="w-pill">后续</span> : stop.kind === "past" ? <span className="w-pill">前史</span> : null}
        {time ? <span className="w-muted">{time}</span> : null}
        <span className="w-muted">{here.length ? `${here.length} 个事件` : ""}</span>
        <span className="w-spacer" />
        <select className="w-select small" aria-label="显示范围" value={span} onChange={(event) => onSpan(event.currentTarget.value)}>{SPANS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
      </div>
      <div className="w-atlas-track">
        <div className="w-atlas-volumes" aria-hidden="true">{volumes.map((band, index) => <span key={band.id} className={index % 2 ? "alt" : ""} style={{ left: `${percent(band.start)}%`, width: `${percent(band.end) - percent(band.start)}%` }} title={band.title}>{band.title}</span>)}</div>
        <div className="w-atlas-bars" aria-hidden="true">{bars.map((height, index) => <i key={index} style={{ height: `${Math.round(height * 100)}%` }} />)}</div>
        {axis.chapterStart > 0 ? <div className="w-atlas-past" aria-hidden="true" title="前史" style={{ width: `${percent(axis.chapterStart - 0.5)}%` }} /> : null}
        {axis.chapterStart + axis.chapterCount < total ? <div className="w-atlas-future" aria-hidden="true" title="后续" style={{ left: `${percent(axis.chapterStart + axis.chapterCount - 0.5)}%` }} /> : null}
        {axis.writtenThrough >= axis.chapterStart ? <div className="w-atlas-now" aria-hidden="true" title="写到这里" style={{ left: `${percent(axis.writtenThrough)}%` }} /> : null}
        <input type="range" aria-label="故事时间" min={0} max={Math.max(0, total - 1)} step={1} value={Math.min(cursor, total - 1)} aria-valuetext={stop.label} onChange={(event) => { onPlaying(false); onCursor(Number(event.currentTarget.value)); }} />
      </div>
    </div>
  );
}
