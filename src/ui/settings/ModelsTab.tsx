import { useEffect, useState } from "react";
import { errorMessage, type ModelListResponse, type ModelSelection } from "../../host";
import { isAvailable, listModels, loadModelRouting, MODEL_TASKS, saveModelRouting, type ModelRouting, type ModelTask } from "../../ai/models";
import { Field, Spinner } from "../common";
import { useWriter } from "../useWriter";

const encode = (selection: ModelSelection | undefined) => (selection ? JSON.stringify([selection.authConfigId, selection.model]) : "");
function decode(value: string): ModelSelection | undefined {
  if (!value) return undefined;
  const [authConfigId, model] = JSON.parse(value) as [string, string];
  return { authConfigId, model };
}

/** Which configured model each kind of Writer AI work uses; applies to every work. */
export function ModelsTab() {
  const writer = useWriter();
  const [models, setModels] = useState<ModelListResponse | null>(null);
  const [routing, setRouting] = useState<ModelRouting>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([listModels(), loadModelRouting()])
      .then(([listed, stored]) => { if (alive) { setModels(listed); setRouting(stored); } })
      .catch((error) => { if (alive) setLoadError(errorMessage(error, "无法读取模型列表。")); });
    return () => { alive = false; };
  }, []);

  const choose = async (task: ModelTask, value: string) => {
    const next = { ...routing };
    const selection = decode(value);
    if (selection) next[task] = selection; else delete next[task];
    setRouting(next);
    try { await saveModelRouting(next); } catch (error) { writer.notify("error", `保存失败：${errorMessage(error, "未知错误")}`); }
  };

  if (loadError) return <section className="w-form"><p className="w-muted">{loadError}（需要较新的 Daily 版本，并为 Writer 授予模型权限。）</p></section>;
  if (!models) return <section className="w-form"><Spinner /></section>;
  const providerName = (id: string) => models.providers.find((provider) => provider.id === id)?.name ?? id;
  const defaultLabel = `${providerName(models.default.authConfigId)} · ${models.default.model}`;
  return (
    <section className="w-form">
      <p className="w-muted">为不同类型的 AI 工作选择模型，对所有作品生效。可选的服务商和模型来自 Daily 设置；未单独选择的跟随 Daily 默认模型。</p>
      {MODEL_TASKS.map((task) => {
        const selection = routing[task.value];
        const stale = selection && !isAvailable(models, selection);
        return (
          <Field key={task.value} label={task.label} hint={stale ? "所选模型已不在 Daily 设置里，这类任务会失败，请重新选择。" : task.description}>
            <select className="w-select" value={encode(selection)} onChange={(event) => void choose(task.value, event.currentTarget.value)}>
              <option value="">跟随 Daily 默认（{defaultLabel}）</option>
              {stale ? <option value={encode(selection)}>{providerName(selection.authConfigId ?? "")} · {selection.model}（已不可用）</option> : null}
              {models.providers.map((provider) => (
                <optgroup key={provider.id} label={provider.name}>
                  {provider.models.map((model) => <option key={model} value={encode({ authConfigId: provider.id, model })}>{model}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
        );
      })}
    </section>
  );
}
