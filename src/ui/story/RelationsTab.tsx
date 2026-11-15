import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { chapterLabel, orderedChapters } from "../../domain/documents";
import { uniqueId } from "../../domain/ids";
import type { RelationTrack } from "../../story/schema";
import { useDialogs } from "../common";
import { useWriter } from "../useWriter";

/** Two tracks per relationship: public status and actual closeness, each change tied to an event. */
export function RelationsTab() {
  const writer = useWriter();
  const dialogs = useDialogs();
  const { project, story } = writer;
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const chapters = useMemo(() => (project ? orderedChapters(project) : []), [project]);
  if (!project || !story) return null;
  const order = (chapterId: string | null) => (chapterId ? chapters.findIndex((chapter) => chapter.id === chapterId) : -1);
  const label = (chapterId: string | null) => { const index = order(chapterId); return index >= 0 ? chapterLabel(index) : "开篇"; };
  const setTrack = (id: string, update: (track: RelationTrack) => RelationTrack) => void writer.updateStory((plan) => { plan.relations = plan.relations.map((track) => (track.id === id ? update(track) : track)); });
  const current = writer.active.kind === "chapter" ? writer.active.id : null;
  const remove = async (track: RelationTrack) => {
    if (!(await dialogs.confirm("删除关系", `删除 ${track.a} × ${track.b}？`, { danger: true, confirmLabel: "删除" }))) return;
    void writer.updateStory((plan) => { plan.relations = plan.relations.filter((item) => item.id !== track.id); });
  };
  const names = project.characters.map((character) => character.name);
  return (
    <section className="w-card">
      <div className="w-row">
        <h3>关系双轨</h3><span className="w-spacer" />
        <input className="w-input small" list="w-relation-names" placeholder="人物 A" value={a} onChange={(event) => setA(event.currentTarget.value)} />
        <input className="w-input small" list="w-relation-names" placeholder="人物 B" value={b} onChange={(event) => setB(event.currentTarget.value)} />
        <datalist id="w-relation-names">{names.map((name) => <option key={name} value={name} />)}</datalist>
        <button type="button" className="w-btn small" disabled={!a.trim() || !b.trim()} onClick={() => { void writer.updateStory((plan) => { plan.relations.push({ id: uniqueId("track"), a: a.trim(), b: b.trim(), social: [], intimacy: [] }); }); setA(""); setB(""); }}><Plus size={12} />添加</button>
      </div>
      <p className="w-muted">名分（朋友、师徒、恋人…）和真实的亲近程度（0-10）可以错开，错开就有张力。每次变化最好由一件具体的小事推动。</p>
      {story.relations.map((track) => {
        const points = [...track.intimacy].sort((left, right) => order(left.chapterId) - order(right.chapterId));
        const width = 240;
        const path = points.map((point, index) => `${index ? "L" : "M"}${points.length > 1 ? (index / (points.length - 1)) * width : width / 2},${40 - point.level * 4}`).join(" ");
        return (
          <article key={track.id} className="w-story-item">
            <div className="w-row"><b>{track.a} × {track.b}</b><span className="w-pill">{track.social[track.social.length - 1]?.status ?? "名分未定"}</span><span className="w-pill tone">亲近 {points[points.length - 1]?.level ?? "?"}/10</span><span className="w-spacer" /><button type="button" className="w-icon-btn small" aria-label="删除" onClick={() => void remove(track)}><Trash2 size={12} /></button></div>
            {points.length ? <svg className="w-relation-chart" viewBox={`-4 -4 ${width + 8} 48`} role="img" aria-label="亲近程度变化"><path d={path} /></svg> : null}
            <ul className="w-fact-list">
              {[...track.social.map((point) => ({ at: order(point.chapterId), text: `${label(point.chapterId)} 名分 → ${point.status}` })), ...points.map((point) => ({ at: order(point.chapterId), text: `${label(point.chapterId)} 亲近 ${point.level}${point.event ? `：${point.event}` : ""}${point.origin === "extracted" ? "（正文识别）" : ""}` }))].sort((left, right) => left.at - right.at).map((item, index) => <li key={index}>{item.text}</li>)}
            </ul>
            <div className="w-row small">
              <button type="button" className="w-link" onClick={async () => { const status = await dialogs.prompt("名分变化", `${current ? "在当前章节，" : ""}两人的名分变成：`); if (status?.trim()) setTrack(track.id, (item) => ({ ...item, social: [...item.social, { chapterId: current, status: status.trim() }] })); }}>记一次名分变化</button>
              <button type="button" className="w-link" onClick={async () => { const level = await dialogs.prompt("亲近程度", "0-10 的数字，以及推动它的事件（用空格隔开）"); const [value, ...event] = (level ?? "").trim().split(/\s+/); const number = Number(value); if (Number.isFinite(number)) setTrack(track.id, (item) => ({ ...item, intimacy: [...item.intimacy, { chapterId: current, level: Math.max(0, Math.min(10, Math.round(number))), event: event.join(" "), reason: "", origin: "user" }] })); }}>记一次亲近变化</button>
            </div>
          </article>
        );
      })}
      {!story.relations.length ? <p className="w-muted">还没有登记关系。记忆抽取发现两人亲疏变化时，也会自动加进来。</p> : null}
    </section>
  );
}
