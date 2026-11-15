import { Brain, ClipboardCheck, RefreshCw, Send, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { friendlyAiError } from "../ai/client";
import { checklistReview } from "../ai/pipelines/checklistReview";
import { CHAPTER_REVIEW_GROUPS, CHECKLIST } from "../ai/craft/checklist";
import { summarizeChapter } from "../ai/quick";
import { chapterLabel } from "../domain/documents";
import { AUTO_PHASES, CHANGE_KIND_LABELS, EMOTION_BEAT_LABELS } from "../memory/schema";
import { startMemoryRun } from "../pipeline/templates";
import { chapterHealth, diagnoseStory, HEALTH_RULE_LABELS } from "../story/health";
import type { ChapterStatus, WriterChapterMeta } from "../types";
import { Field, NumberInput, Spinner } from "./common";
import { usePublish } from "./usePublish";
import { useWriter } from "./useWriter";

const STATUSES: { value: ChapterStatus; label: string }[] = [{ value: "draft", label: "草稿" }, { value: "writing", label: "写作中" }, { value: "review", label: "修订" }, { value: "final", label: "定稿" }];

export function ChapterInspector({ chapter, text }: { chapter: WriterChapterMeta; text: string }) {
  const writer = useWriter();
  const { project, memory } = writer;
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [groups, setGroups] = useState<string[]>(CHAPTER_REVIEW_GROUPS);
  const issues = useMemo(() => (writer.story && memory ? chapterHealth(diagnoseStory(writer.story, memory), chapter.id) : []), [writer.story, memory, chapter.id]);
  if (!project) return null;
  const card = memory?.cards.get(chapter.id);
  const fresh = card?.sourceHash === chapter.contentHash;
  const { publishing, publish } = usePublish(chapter.id);

  const runChecklist = async () => {
    setChecking(true);
    try {
      const result = await checklistReview({ project, memory, story: writer.story, chapterId: chapter.id, position: memory?.position(chapter.id) ?? 0, text, groups });
      await writer.refreshBackgroundResults();
      const failed = result.verdicts.filter((verdict) => verdict.status === "fail").length;
      writer.notify(failed ? "info" : "success", failed ? `检查表：${failed} 项没做到，已写成朱批。` : "检查表各项都做到了。", failed ? { label: "看朱批", run: () => writer.openAssist("notes") } : undefined);
    } catch (error) { writer.notify("error", friendlyAiError(error)); }
    finally { setChecking(false); }
  };

  const generateSummary = async () => {
    setBusy(true);
    try { writer.updateChapter(chapter.id, { summary: await summarizeChapter(project, chapter.title, text) }); }
    catch (error) { writer.notify("error", friendlyAiError(error)); }
    finally { setBusy(false); }
  };

  const setStatus = (status: ChapterStatus) => writer.updateChapter(chapter.id, { status });

  return (
    <section className="w-inspector">
      <div className="w-publish-bar">
        <button type="button" className="w-btn primary" disabled={!text.trim() || publishing} onClick={() => void publish()}>{publishing ? <Spinner size={12} /> : <Send size={13} />}{publishing ? "编辑部运行中" : chapter.status === "final" ? "重新发布" : "发布本章"}</button>
        <span className="w-muted">发布后后台更新记忆与设定，并起草下一章</span>
      </div>
      <div className="w-inspector-grid">
        <Field label="状态">
          <select className="w-select" value={chapter.status} onChange={(event) => setStatus(event.currentTarget.value as ChapterStatus)}>
            {STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
          </select>
        </Field>
        <Field label="视角人物">
          <select className="w-select" value={chapter.povCharacterId ?? ""} onChange={(event) => writer.updateChapter(chapter.id, { povCharacterId: event.currentTarget.value || null })}>
            <option value="">未指定</option>
            {project.characters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}
          </select>
        </Field>
        <Field label="目标字数">
          <NumberInput min={0} step={500} zeroAsEmpty placeholder="不限" value={chapter.targetWords} onCommit={(value) => writer.updateChapter(chapter.id, { targetWords: value })} />
        </Field>
        <Field label="卷">
          <select className="w-select" value={chapter.volumeId} onChange={(event) => writer.moveChapter(chapter.id, event.currentTarget.value, null)}>
            {project.volumes.map((volume) => <option key={volume.id} value={volume.id}>{volume.title}</option>)}
          </select>
        </Field>
      </div>
      <Field label="章节摘要">
        <div className="w-with-action">
          <textarea className="w-textarea" rows={3} value={chapter.summary} placeholder="一两句话概括本章；AI 写后续章节时会参考。" onChange={(event) => writer.updateChapter(chapter.id, { summary: event.currentTarget.value })} />
          <button type="button" className="w-btn small" disabled={busy || !text.trim()} onClick={() => void generateSummary()}>{busy ? <Spinner size={12} /> : <Sparkles size={12} />}AI 生成</button>
        </div>
      </Field>
      <Field label="备注（不会导出）">
        <textarea className="w-textarea" rows={2} value={chapter.notes} placeholder="写作计划、待办、灵感…" onChange={(event) => writer.updateChapter(chapter.id, { notes: event.currentTarget.value })} />
      </Field>
      {project.storyNodes.length ? (
        <Field label="关联剧情节点">
          <div className="w-check-list">
            {project.storyNodes.slice(0, 200).map((node) => (
              <label key={node.id} className="w-check">
                <input type="checkbox" checked={chapter.storyNodeIds.includes(node.id)} onChange={(event) => writer.updateChapter(chapter.id, { storyNodeIds: event.currentTarget.checked ? [...chapter.storyNodeIds, node.id] : chapter.storyNodeIds.filter((id) => id !== node.id) })} />
                {node.title}
              </label>
            ))}
          </div>
        </Field>
      ) : null}
      <div className="w-memory-card">
        <div className="w-memory-card-head">
          <Brain size={14} /><strong>本章记忆</strong>
          <span className={`w-pill ${fresh ? "ok" : "warn"}`}>{card ? (fresh ? "已是最新" : "正文已修改") : "未建立"}</span>
          <span className="w-spacer" />
          <button type="button" className="w-btn small" onClick={() => void writer.flush().then(() => startMemoryRun(project.id, AUTO_PHASES, [chapter.id])).then(() => writer.notify("info", "已加入记忆更新队列。"))}><RefreshCw size={12} />更新本章记忆</button>
        </div>
        {card ? (
          <div className="w-memory-card-body">
            <p>{card.summary}</p>
            {card.facts.length ? <ul>{card.facts.slice(0, 12).map((fact, index) => <li key={index}><b>{fact.subject}</b> · {fact.attribute}：{fact.value}</li>)}</ul> : null}
            {card.threads.length ? <p className="w-muted">伏笔：{card.threads.map((thread) => `${thread.type === "plant" ? "埋" : thread.type === "payoff" ? "收" : "推"}·${thread.title}`).join("；")}</p> : null}
            {card.hook ? <p className="w-muted">章末钩子：{card.hook}</p> : null}
            {card.emotionBeats.length ? <p className="w-muted">情绪：{card.emotionBeats.map((beat) => EMOTION_BEAT_LABELS[beat.type]).join(" ")}{card.emotionBeats.some((beat) => beat.type === "suppress") ? `（压：${card.emotionBeats.filter((beat) => beat.type === "suppress").map((beat) => beat.reason || "未说明理由").join("；")}）` : ""}</p> : null}
            {card.payoffs.length ? <p className="w-muted">兑现：{card.payoffs.map((payoff) => `${payoff.type}·${payoff.description}`).join("；")}</p> : null}
            <p className="w-muted">局面改变：{card.changes.length ? card.changes.map((kind) => CHANGE_KIND_LABELS[kind]).join("、") : "没有"}{card.newCast.length ? `｜新登场：${card.newCast.join("、")}` : ""}</p>
            <p className="w-muted">{memory ? chapterLabel(memory.position(chapter.id)) : ""}</p>
          </div>
        ) : null}
      </div>
      {issues.length ? (
        <div className="w-memory-card">
          <div className="w-memory-card-head"><strong>本章体检</strong><span className="w-pill warn">{issues.length}</span></div>
          <ul className="w-health-list">{issues.map((issue) => <li key={issue.id} className={issue.severity}><b>{HEALTH_RULE_LABELS[issue.rule]}</b>：{issue.message}</li>)}</ul>
        </div>
      ) : null}
      <div className="w-memory-card">
        <div className="w-memory-card-head">
          <ClipboardCheck size={14} /><strong>按检查表审读</strong>
          <span className="w-spacer" />
          <button type="button" className="w-btn small" disabled={checking || !text.trim() || !groups.length} onClick={() => void runChecklist()}>{checking ? <Spinner size={12} /> : null}开始</button>
        </div>
        <div className="w-check-list">
          {CHECKLIST.map((group) => (
            <label key={group.id} className="w-check" title={group.items.join("\n")}>
              <input type="checkbox" checked={groups.includes(group.id)} onChange={(event) => setGroups((current) => (event.currentTarget.checked ? [...current, group.id] : current.filter((id) => id !== group.id)))} />
              {group.title}
            </label>
          ))}
        </div>
      </div>
    </section>
  );
}
