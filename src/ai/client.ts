import { dailyHost } from "../host";
import { delay } from "../domain/util";
import { modelFor, type ModelTask } from "./models";
import { taskRpc } from "../worker/taskClient";

/** Host cap is 256KB per prompt; keep headroom for the system prompt envelope. */
export const MAX_PROMPT_BYTES = 240 * 1024;

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type InvokeOptions = { task: ModelTask; system: string; prompt: string; temperature?: number; maxOutputTokens?: number; signal?: AbortSignal; retries?: number; effort?: ReasoningEffort; /** Plugin-private image files shown to the model; check `assertVision` first. */ images?: string[] };
export type ModelUsage = { calls: number; inputChars: number; outputChars: number };

type UsageListener = (usage: { inputChars: number; outputChars: number }) => void;
const usageListeners = new Set<UsageListener>();
/** Counts model calls made while the listener is registered (a view runs one background job at a time). Returns the unsubscribe. */
export function trackModelUsage(listener: UsageListener): () => void {
  usageListeners.add(listener);
  return () => { usageListeners.delete(listener); };
}

export class ModelError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

export function byteLength(text: string) { return new TextEncoder().encode(text).length; }

/** Single model call with retry/backoff for rate limits, timeouts and transient network errors. */
export async function invokeText(options: InvokeOptions): Promise<string> {
  if (byteLength(options.prompt) > MAX_PROMPT_BYTES) throw new ModelError("上下文超过模型请求上限，请减小上下文预算。", false);
  const attempts = Math.max(1, (options.retries ?? 3) + 1);
  const model = await modelFor(options.task);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) throw new ModelError("已取消。", false);
    try {
      // The host call itself can't be cancelled; a pause/cancel stops waiting on it.
      const response = await abortable(taskRpc<{ text: string }>(options.signal, "model.invoke", { system: options.system, prompt: options.prompt, temperature: options.temperature, maxOutputTokens: options.maxOutputTokens, ...(model ? { model } : {}), ...(options.effort ? { reasoningEffort: options.effort } : {}), ...(options.images?.length ? { images: options.images } : {}) }), options.signal);
      const text = typeof response?.text === "string" ? response.text : "";
      for (const listener of usageListeners) listener({ inputChars: options.prompt.length + options.system.length, outputChars: text.length });
      return text;
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) throw new ModelError("已取消。", false);
      // A host timeout means the call ran ~10 minutes; one more try is enough before surfacing it.
      if (!isRetryable(error) || attempt === attempts - 1 || (attempt >= 1 && isTimeout(error))) break;
      await abortable(delay(Math.min(30_000, 2_000 * 2 ** attempt) + Math.random() * 500), options.signal);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ModelError(message, isRetryable(lastError));
}

/** Throws when the model routed to `task` cannot be shown images. */
export async function assertVision(task: ModelTask) {
  const [models, selection] = await Promise.all([dailyHost().model.list(), modelFor(task)]);
  const provider = models.providers.find((option) => option.id === (selection?.authConfigId ?? models.default.authConfigId));
  if (!provider) return;
  if (provider.acceptsImages === undefined) throw new ModelError("当前的 Daily 版本还不能让模型读参考图，请更新 Daily。", false);
  if (!provider.acceptsImages) throw new ModelError(`「${provider.name}」不能读图。请在作品设置 → 模型里为“记忆与设定”换一个能读图的模型，或去掉参考图。`, false);
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ModelError("已取消。", false));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function isTimeout(error: unknown) {
  return /timed out|timeout/i.test(error instanceof Error ? error.message : String(error));
}

/** Calls the model expecting JSON; repairs fenced/wrapped output and asks once more if parsing fails. */
export async function invokeJson<T>(options: InvokeOptions, parse: (value: unknown) => T): Promise<T> {
  const first = await invokeText(options);
  try { return parse(extractJson(first)); }
  catch {
    const retry = await invokeText({ ...options, prompt: `${options.prompt}\n\n【注意】上一次输出不是合法 JSON。请只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释。`, temperature: 0.2 });
    return parse(extractJson(retry));
  }
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try { return JSON.parse(candidate); } catch { /* fall through */ }
  const start = candidate.search(/[[{]/);
  if (start < 0) throw new Error("No JSON found in model output.");
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return JSON.parse(candidate.slice(start, index + 1).replace(/,\s*([}\]])/g, "$1"));
    }
  }
  throw new Error("Unterminated JSON in model output.");
}

function isRetryable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /429|rate|quota exceeded|Too Many|timeout|timed out|ECONNRESET|socket|network|502|503|504|overloaded|temporarily|Transport error|error decoding response body|stream (event|timed out)|connection (reset|closed)|unexpected EOF/i.test(message) && !/api key|unauthorized/i.test(message);
}

export function isTransientAiError(error: unknown) { return isRetryable(error); }

export function friendlyAiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Stopped before it finished/.test(message)) return "已停止。可以从断点继续，或重新发送。";
  if (/already running a task/.test(message)) return "这个对话里还有一个 AI 任务在后台运行，请等它结束或先停止它（也可以新建对话）。";
  if (/Interrupted before it finished/.test(message)) return "任务被中断了（应用重启或插件重新加载），可以重新发送。";
  if (/Transport error|error decoding response body|stream event/i.test(message)) return "与 AI 服务的连接在生成途中断开（通常是网络或代理波动），可以从断点继续。";
  if (/timed out|timeout/i.test(message)) return "AI 请求超时。若反复出现，请更新 Daily 后重启（旧版本对插件模型调用只给 30 秒），或在作品设置中调小上下文预算。";
  if (/kind=connect|error sending request|dns|tcp connect|TLS|certificate/i.test(message)) return "无法连接 AI 服务。请检查网络、代理和证书设置后重试。";
  if (/429|quota|RESOURCE_EXHAUSTED|Too Many Requests/i.test(message)) return "AI 服务限流或额度不足，请稍后重试，或在设置中切换模型。";
  if (/Unknown model provider|is not available for provider/.test(message)) return "为这类任务选的模型已不可用（可能在 Daily 设置里被删除了）。请在作品设置 → 模型里重新选择。";
  if (/api key|unauthorized|billing|login|auth/i.test(message)) return "AI 请求未通过鉴权。请在设置中检查模型登录状态和账户。";
  return message.replace(/\s+/g, " ").trim().slice(0, 300);
}
