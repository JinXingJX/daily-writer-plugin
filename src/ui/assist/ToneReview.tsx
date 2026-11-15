import { cancelWriterTask } from "../../worker/taskClient";
import { useEffect, useRef, useState } from "react";
import { friendlyAiError } from "../../ai/client";
import { readDoc } from "../../domain/documents";
import { appendProposal } from "../../storage/proposalStore";
import { toneSummary, longestTransition } from "../../tone/detect";
import { diagnoseTone, reviseTone, saveToneReport, type ToneReport } from "../../tone/pipeline";
import { RULES, TONE_SOURCE } from "../../tone/rules";
import { Spinner } from "../common";
import { useWriter } from "../useWriter";

const DISPOSITIONS = { revise: "拟改", keep: "保留", false_positive: "误报", human: "待人审" };

/** Inline chapter review. Remounted on project/document changes by WriteView. */
export function ToneReview({ text, onClose }: { text: string; onClose: () => void }) {
  const writer = useWriter();
  const [report, setReport] = useState<ToneReport | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const live = useRef({ text, writer });
  live.current = { text, writer };
  useEffect(() => () => abort.current?.abort(), []);
  const stale = report !== null && report.source !== text;

  const run = async (task: (signal: AbortSignal) => Promise<void>) => {
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy("准备中"); setError("");
    try { await task(controller.signal); }
    catch (e) { if (!controller.signal.aborted) setError(friendlyAiError(e)); }
    finally { if (abort.current === controller) { abort.current = null; setBusy(""); } }
  };
  const diagnose = () => run(async (signal) => {
    const { project, active } = live.current.writer;
    if (!project) return;
    const next = await diagnoseTone(project, active, live.current.text, signal, setBusy);
    signal.throwIfAborted();
    setReport(next); setSubmitted(false); setSaved("");
    setSelected(next.verdicts.filter((v) => v.disposition === "revise").map((v) => v.id));
    setSaved(await saveToneReport(next));
  });
  const revise = () => run(async (signal) => {
    if (!report) return;
    const current = live.current.writer.getDraft();
    if (!current) return;
    const result = await reviseTone(current.project, report, readDoc(current.project, current.texts, report.doc) ?? "", selected, signal, setBusy);
    signal.throwIfAborted();
    const latest = live.current.writer.getDraft();
    if (!latest || latest.project.id !== report.projectId || readDoc(latest.project, latest.texts, report.doc) !== report.source) throw new Error("改写期间原稿已变化，未加入待审。请重新检测。");
    const proposals = await appendProposal(report.projectId, result.proposal);
    if (!signal.aborted) {
      live.current.writer.setProposals(proposals);
      live.current.writer.openAssist("notes");
      setSubmitted(true);
    }
  });
  const counts = report ? toneSummary(report.scan, report.verdicts) : [];
  const choices = report?.verdicts.filter((v) => v.disposition === "revise").map((v) => v.id) ?? [];
  return <section className="w-tone-review" aria-label="文风检测">
    <header className="w-row"><h3>文风检测</h3><span className="w-spacer" /><button className="w-btn small ghost" type="button" onClick={onClose}>收起</button></header>
    <p className="w-muted">检测当前整篇文档，先看证据和改法，再确认最小修改。作者的文风指南和样章优先。</p>
    <div className="w-row"><button type="button" className="w-btn small" disabled={Boolean(busy) || !text.trim()} onClick={() => void diagnose()}>{report ? "重新检测" : "开始检测"}</button>
      {busy ? <><span role="status"><Spinner size={12} /> {busy}</span><button type="button" className="w-btn small ghost" onClick={() => { cancelWriterTask(abort.current?.signal); abort.current?.abort(); }}>停止</button></> : null}
    </div>
    {error ? <p className="w-callout warn" role="alert">{error}</p> : null}
    {stale ? <p className="w-callout warn" role="status">原稿已变化，报告已过期。重新检测后才能改写。</p> : null}
    {report ? <>
      <p>{report.scan.chars} 字符 · {report.scan.paragraphs} 个可检测正文行 · {report.scan.candidates.length} 条候选</p>
      <div className="w-tone-table"><table><caption>候选去向（同一句可能命中多项）</caption><thead><tr><th>规则</th><th>候选</th><th>有效</th><th>拟改</th><th>保留</th><th>误报</th><th>人审</th></tr></thead><tbody>{counts.map((r) => <tr key={r.rule}><th scope="row">{RULES[r.rule].grade} · {RULES[r.rule].title}</th><td>{r.raw}</td><td>{r.valid}</td><td>{r.revise}</td><td>{r.keep}</td><td>{r.falsePositive}</td><td>{r.human}</td></tr>)}</tbody></table></div>
      <p className="w-muted">C 只报告：句长 CV {report.scan.sentenceCV?.toFixed(2) ?? "样本不足"}，最长连续承接 {longestTransition(report.scan, report.verdicts)} 个接口。H 人审：比喻、暗喻和拟人保留。X 排除：序号标题、这意味着、列表引导和概括替代。</p>
      {choices.length ? <div className="w-row"><button className="w-btn small ghost" type="button" disabled={Boolean(busy)} onClick={() => setSelected(choices)}>采用整套建议</button><button className="w-btn small ghost" type="button" disabled={Boolean(busy)} onClick={() => setSelected([])}>清空选择</button><span>已选 {selected.length} / {choices.length} 项</span></div> : <p>没有复核为可自动修改的项目。可以保留原稿，或查看人审项。</p>}
      <div className="w-tone-findings">{report.scan.candidates.filter((c) => report.verdicts.find((v) => v.id === c.id)?.disposition === "revise").map((c) => {
        const verdict = report.verdicts.find((v) => v.id === c.id)!;
        return <article key={c.id}><label><input type="checkbox" disabled={Boolean(busy) || stale || submitted} checked={selected.includes(c.id)} onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, c.id] : ids.filter((id) => id !== c.id))} />第 {c.line} 行 · {RULES[c.rule].title}</label><blockquote>{c.text}</blockquote><p>{verdict.reason}</p><p>建议：{verdict.suggestion}</p><small className="w-muted">研究参照：{RULES[c.rule].evidence}</small></article>;
      })}</div>
      <details><summary>全部候选与保留理由（{report.scan.candidates.length}）</summary><div className="w-tone-findings">{report.scan.candidates.map((c) => {
        const v = report.verdicts.find((v) => v.id === c.id)!;
        return <article key={c.id}><strong>第 {c.line} 行 · {RULES[c.rule].title} · {DISPOSITIONS[v.disposition]}</strong><blockquote>{c.text}</blockquote><p>{v.label} · {v.reason}</p><small className="w-muted">研究参照：{RULES[c.rule].evidence}</small></article>;
      })}</div></details>
      <div className="w-row"><button className="w-btn primary" type="button" disabled={Boolean(busy) || stale || !selected.length || !saved || submitted} onClick={() => void revise()}>确认建议，生成修改并复测</button></div>
      {submitted ? <p role="status">已加入页边的“朱批”，可在稿纸上逐处采纳和撤销。部分采纳后请重新检测实际正文。</p> : null}
      {saved ? <details><summary>报告已留存</summary><code>{saved}</code></details> : <p className="w-muted">报告尚未保存成功，重新检测可重试；保存完成前不会改写。</p>}
    </> : null}
    <p className="w-muted">方法参考 <a href={TONE_SOURCE} target="_blank" rel="noreferrer">Lieflat 的研究</a>。本插件独立实现部分指标，不是原版脚本，不计算 AI 率或判断作者身份。长文按章检测；代码、引文、对白和复杂 Markdown 行保留。</p>
  </section>;
}
