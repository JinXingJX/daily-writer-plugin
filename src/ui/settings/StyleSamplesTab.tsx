import { Globe, Plus, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PRESET_SAMPLES } from "../../ai/presetSamples";
import { AGENT_SAMPLE_BUDGET } from "../../ai/styleSamples";
import { fetchChapter } from "../../ingest/webChapter";
import { addSample, listSamples, loadSample, MAX_SAMPLE_CHARS, removeSample, type StyleSample } from "../../storage/sampleStore";
import { Field, Spinner, useDialogs } from "../common";
import { useWriter } from "../useWriter";

/** The work's style samples: the model reads them and writes in their voice. */
export function StyleSamplesTab() {
  const writer = useWriter();
  const dialogs = useDialogs();
  const projectId = writer.project?.id ?? "";
  const [samples, setSamples] = useState<StyleSample[] | null>(null);
  const [preview, setPreview] = useState<{ id: string; text: string } | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");

  const reload = useCallback(async () => { if (projectId) setSamples(await listSamples(projectId)); }, [projectId]);
  useEffect(() => { void reload(); }, [reload]);

  const add = async (sampleTitle: string, body: string) => {
    setBusy(true);
    try {
      await addSample(projectId, sampleTitle, body);
      setTitle("");
      setText("");
      await reload();
    } catch (error) { writer.notify("error", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const total = (samples ?? []).reduce((sum, sample) => sum + sample.chars, 0);
  return (
    <section className="w-form">
      <p className="w-muted">样章决定这部作品的文风：写作助手和所有写正文的功能都会直接读样章原文，自己揣摩叙述口吻、节奏和对白，照这个声音写。可以是你自己写过的章节，也可以是你想靠近的作者的片段。总字数超过约 {Math.round(AGENT_SAMPLE_BUDGET / 10_000)} 万字时，每篇只取开头；单篇最多保存 {MAX_SAMPLE_CHARS / 10_000} 万字。</p>
      <div className="w-row">
        <label className="w-btn"><input type="file" accept=".txt,.md,.markdown,text/plain" multiple hidden onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          void (async () => { for (const file of files) await add(file.name.replace(/\.[^.]+$/, ""), await file.text()); })();
        }} /><Upload size={13} />导入文件</label>
        <span className="w-muted small">{samples ? `${samples.length} 篇，共 ${total} 字` : ""}</span>
      </div>
      {samples === null ? <Spinner /> : samples.length ? (
        <ul className="w-list">
          {samples.map((sample) => (
            <li key={sample.id} className="w-row">
              <button type="button" className="w-link grow" onClick={async () => setPreview(preview?.id === sample.id ? null : { id: sample.id, text: await loadSample(projectId, sample.id) })}>{sample.title}</button>
              <span className="w-muted small">{sample.chars} 字</span>
              <button type="button" className="w-btn ghost small" aria-label="删除" onClick={async () => {
                if (!(await dialogs.confirm("删除样章", `删除「${sample.title}」？`, { danger: true, confirmLabel: "删除" }))) return;
                await removeSample(projectId, sample.id);
                if (preview?.id === sample.id) setPreview(null);
                await reload();
              }} title="删除"><Trash2 size={12} /></button>
            </li>
          ))}
        </ul>
      ) : <p className="w-muted">还没有样章。没有样章时，AI 跟着你已经写好的章节写。</p>}
      {preview ? <pre className="w-prompt-preview">{preview.text}</pre> : null}
      <h4>预制样章</h4>
      <p className="w-muted small">点“添加”会把样章复制进这部作品，之后可以照常删掉。标“原创”的是 Writer 自带的仿写片段，没有用到原作的文字。</p>
      <ul className="w-list">
        {PRESET_SAMPLES.map((preset) => (
          <li key={preset.id} className="w-row">
            <span className="grow"><b>{preset.title}</b> <span className="w-muted small">{preset.style}</span></span>
            <button type="button" className="w-btn small" disabled={busy || Boolean(samples?.some((sample) => sample.title === preset.title))} onClick={() => void add(preset.title, preset.text)}><Plus size={12} />{samples?.some((sample) => sample.title === preset.title) ? "已添加" : "添加"}</button>
          </li>
        ))}
      </ul>
      <h4>从网页导入</h4>
      <p className="w-muted small">填免费章节的链接，抓到的正文只存在这部作品里，供你自己写作参考。付费、需要登录或者用脚本加载正文的页面抓不到，可以改用粘贴。</p>
      <div className="w-row">
        <input className="w-input grow" value={url} placeholder="https://…" onChange={(event) => setUrl(event.currentTarget.value)} />
        <button type="button" className="w-btn" disabled={busy || !/^https?:\/\//.test(url.trim())} onClick={async () => {
          setBusy(true);
          try {
            const chapter = await fetchChapter(url);
            setBusy(false);
            await add(chapter.title || "网页样章", chapter.text);
            setUrl("");
          } catch (error) { writer.notify("error", error instanceof Error ? error.message : String(error)); setBusy(false); }
        }}>{busy ? <Spinner size={12} /> : <Globe size={13} />}抓取</button>
      </div>
      <h4>粘贴一段</h4>
      <Field label="标题"><input className="w-input" value={title} placeholder="例如：第六章" onChange={(event) => setTitle(event.currentTarget.value)} /></Field>
      <textarea className="w-textarea" rows={6} value={text} placeholder="把样章正文粘贴在这里" onChange={(event) => setText(event.currentTarget.value)} />
      <div className="w-row"><button type="button" className="w-btn primary" disabled={busy || !text.trim()} onClick={() => void add(title, text)}>{busy ? <Spinner size={12} /> : null}添加样章</button></div>
    </section>
  );
}
