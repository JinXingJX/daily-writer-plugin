import { Plus, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { chapterLabel, orderedChapters } from "../../domain/documents";
import { uniqueId } from "../../domain/ids";
import { IMPACT_TIER_LABELS, IMPACT_TIERS, normalizeSecret, SECRET_STATUS_LABELS, type SecretStatus, type StorySecret } from "../../story/schema";
import { useDialogs } from "../common";
import { useWriter } from "../useWriter";
import { OwnerImages } from "../images/OwnerImages";
import { TextField } from "./fields";

/** Hidden lines: the truth behind events, how it ripples, and who knows it from which chapter. */
export function SecretsTab() {
  const writer = useWriter();
  const dialogs = useDialogs();
  const { project, story, memory } = writer;
  const chapters = useMemo(() => (project ? orderedChapters(project) : []), [project]);
  if (!project || !story) return null;
  const setSecret = (id: string, patch: Partial<StorySecret>) => void writer.updateStory((plan) => { plan.secrets = plan.secrets.map((secret) => (secret.id === id ? { ...secret, ...patch } : secret)); });
  const remove = async (secret: StorySecret) => {
    if (!(await dialogs.confirm("删除暗线", `删除「${secret.title}」？`, { danger: true, confirmLabel: "删除" }))) return;
    void writer.updateStory((plan) => { plan.secrets = plan.secrets.filter((item) => item.id !== secret.id); });
  };
  const label = (chapterId: string | null) => { const index = chapterId ? chapters.findIndex((chapter) => chapter.id === chapterId) : -1; return index >= 0 ? chapterLabel(index) : "开篇前"; };
  const people = [...new Set([...project.characters.map((character) => character.name), ...story.secrets.flatMap((secret) => secret.knownBy.map((entry) => entry.who))])].slice(0, 40);
  return (
    <div className="w-notebook">
      <div className="w-notebook-col">
        <section className="w-card">
          <div className="w-row"><h3>暗线</h3><span className="w-spacer" /><button type="button" className="w-btn small" onClick={() => void writer.updateStory((plan) => { plan.secrets.push(normalizeSecret({ id: uniqueId("secret"), title: "新暗线" })); })}><Plus size={12} />添加</button></div>
          <p className="w-muted">先把真相完整写下（不进正文），再推演它怎么影响不同层面的人。人物从哪一章知道了它，记忆抽取会自动记下。</p>
          {story.secrets.map((secret) => (
            <article key={secret.id} className="w-story-item">
              <div className="w-row">
                <input className="w-input grow" value={secret.title} onChange={(event) => setSecret(secret.id, { title: event.currentTarget.value })} />
                <select className="w-select small" value={secret.status} onChange={(event) => setSecret(secret.id, { status: event.currentTarget.value as SecretStatus })}>{(Object.keys(SECRET_STATUS_LABELS) as SecretStatus[]).map((status) => <option key={status} value={status}>{SECRET_STATUS_LABELS[status]}</option>)}</select>
                <button type="button" className="w-icon-btn small" aria-label="删除" onClick={() => void remove(secret)} title="删除"><Trash2 size={12} /></button>
              </div>
              <OwnerImages owner={`secret:${secret.id}`} title={`「${secret.title}」配图`} material={`${secret.title}：${secret.truth}`} />
              <TextField label="真相" rows={3} value={secret.truth} onCommit={(value) => setSecret(secret.id, { truth: value })} />
              {IMPACT_TIERS.map((tier) => {
                const impact = secret.impacts.find((item) => item.tier === tier) ?? { tier, interest: "", misread: "", action: "" };
                const setImpact = (patch: Partial<typeof impact>) => setSecret(secret.id, { impacts: [...secret.impacts.filter((item) => item.tier !== tier), { ...impact, ...patch }] });
                return <TextField key={tier} label={`${IMPACT_TIER_LABELS[tier]}：利益／误判／行动`} value={[impact.interest, impact.misread, impact.action].join("｜")} placeholder="用｜分隔" onCommit={(value) => { const [interest = "", misread = "", action = ""] = value.split(/[|｜]/); setImpact({ interest: interest.trim(), misread: misread.trim(), action: action.trim() }); }} />;
              })}
              <div className="w-row small">
                <span>读者在</span>
                <select className="w-select small" value={secret.readerRevealChapterId ?? ""} onChange={(event) => setSecret(secret.id, { readerRevealChapterId: event.currentTarget.value || null })}>
                  <option value="">未定</option>
                  {chapters.map((chapter, position) => <option key={chapter.id} value={chapter.id}>{chapterLabel(position)} {chapter.title.slice(0, 12)}</option>)}
                </select>
                <span>知道真相</span>
              </div>
              <TextField label="揭示计划" value={secret.revealPlan} onCommit={(value) => setSecret(secret.id, { revealPlan: value })} />
              <TextField label="知情者（每行：人物｜来源）" rows={2} value={secret.knownBy.filter((entry) => entry.origin === "user").map((entry) => `${entry.who}｜${entry.source}`).join("\n")} onCommit={(value) => setSecret(secret.id, { knownBy: [...secret.knownBy.filter((entry) => entry.origin === "extracted"), ...value.split("\n").map((line) => line.split(/[|｜]/)).filter((parts) => parts[0]?.trim()).map(([who, source = ""]) => ({ who: who.trim(), chapterId: null, source: source.trim(), origin: "user" as const }))] })} />
              {secret.knownBy.some((entry) => entry.origin === "extracted") ? <p className="w-muted">从正文识别：{secret.knownBy.filter((entry) => entry.origin === "extracted").map((entry) => `${entry.who}（${label(entry.chapterId)}，${entry.source}）`).join("；")}</p> : null}
            </article>
          ))}
          {!story.secrets.length ? <p className="w-muted">还没有登记暗线。</p> : null}
        </section>
      </div>
      <div className="w-notebook-col">
        <section className="w-card">
          <h3>知情矩阵</h3>
          <p className="w-muted">格子里是人物得知真相的章节。写作和审稿会据此检查人物有没有知道不该知道的事。</p>
          {story.secrets.length && people.length ? (
            <div className="w-matrix-scroll">
              <table className="w-matrix">
                <thead><tr><th />{story.secrets.map((secret) => <th key={secret.id}>{secret.title}</th>)}</tr></thead>
                <tbody>{people.map((person) => (
                  <tr key={person}><th>{person}</th>{story.secrets.map((secret) => { const entry = secret.knownBy.find((item) => item.who === person); return <td key={secret.id} className={entry ? "known" : ""}>{entry ? label(entry.chapterId) : ""}</td>; })}</tr>
                ))}</tbody>
              </table>
            </div>
          ) : <p className="w-muted">添加暗线和人物后显示。</p>}
          {memory?.isEmpty === false ? null : <p className="w-muted">建立故事记忆后，人物得知暗线的章节会自动填入。</p>}
        </section>
      </div>
    </div>
  );
}
