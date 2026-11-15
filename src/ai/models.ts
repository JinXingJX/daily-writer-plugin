// Which model each kind of AI work runs on. Providers are configured in Daily, so the choice is
// plugin-wide (shared by every work and by the background worker) rather than stored per work.
import type { ModelListResponse, ModelSelection } from "../host";
import { dailyHost } from "../host";
import { asRecord } from "../domain/util";

export type ModelTask = "assistant" | "prose" | "review" | "memory" | "ideas";
export type ModelRouting = Partial<Record<ModelTask, ModelSelection>>;

export const MODEL_TASKS: { value: ModelTask; label: string; description: string }[] = [
  { value: "assistant", label: "写作助手", description: "右侧写作助手及它创建的子 agent。" },
  { value: "prose", label: "正文生成", description: "按计划写正文、续写、改写、修订、批量修改、章节摘要。" },
  { value: "review", label: "计划与审稿", description: "章节计划、审稿、检查表审读、卡文诊断。" },
  { value: "memory", label: "记忆与设定", description: "章节记忆提取与汇总、发布后的设定更新、整理设定稿。" },
  { value: "ideas", label: "灵感与问答", description: "灵感涌现、全书问答、作家简报、模拟读者。" },
];

const ROUTING_KEY = "writer.modelRouting.v1";
const TASKS = new Set<string>(MODEL_TASKS.map((task) => task.value));

export function normalizeRouting(value: unknown): ModelRouting {
  const routing: ModelRouting = {};
  for (const [task, raw] of Object.entries(asRecord(value))) {
    const selection = asRecord(raw);
    if (!TASKS.has(task) || typeof selection.authConfigId !== "string" || typeof selection.model !== "string") continue;
    routing[task as ModelTask] = { authConfigId: selection.authConfigId, model: selection.model };
  }
  return routing;
}

export async function loadModelRouting(): Promise<ModelRouting> {
  try { return normalizeRouting(await dailyHost().storage.get(ROUTING_KEY)); } catch { return {}; }
}

export async function saveModelRouting(routing: ModelRouting) { await dailyHost().storage.set(ROUTING_KEY, routing); }

/** The model chosen for `task`, or undefined to use Daily's default. Read on every call so all views see changes at once. */
export async function modelFor(task: ModelTask): Promise<ModelSelection | undefined> {
  return (await loadModelRouting())[task];
}

export async function listModels(): Promise<ModelListResponse> { return dailyHost().model.list(); }

/** Whether the host still offers `selection`; a removed provider or model makes calls fail until it is changed. */
export function isAvailable(models: ModelListResponse, selection: ModelSelection): boolean {
  const provider = models.providers.find((option) => option.id === selection.authConfigId);
  return Boolean(provider && selection.model && provider.models.includes(selection.model));
}
