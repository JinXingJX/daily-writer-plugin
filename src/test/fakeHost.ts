import { setDailyHost, type TaskContext, type TaskSnapshot, type TaskSubmitInput } from "@daily/plugin-sdk";
import { bindTaskContext } from "../worker/taskClient";
import type { AgentSession, AgentSessionEntry, AgentSessionMessageInput, ImageGenerateRequest, ModelInvokeRequest, ModelSelection } from "@daily/plugin-sdk";
import type { DailyPluginApi } from "../host";

export type FakeHost = {
  sessions: Map<string, AgentSession>;
  api: DailyPluginApi;
  privateFiles: Map<string, string>;
  workspaceFiles: Map<string, string>;
  storage: Map<string, unknown>;
  modelCalls: { prompt: string; system?: string; model?: ModelSelection; images?: string[] }[];
  imageCalls: ImageGenerateRequest[];
  /** Replaces the generated image response; throw to simulate an API failure. */
  setImage: (handler: (request: ImageGenerateRequest) => void) => void;
  setModel: (handler: (prompt: string, system?: string) => string | Promise<string>) => void;
};

/** In-memory host API with task execution in the same plugin instance. */
export function installFakeHost(): FakeHost {
  const privateFiles = new Map<string, string>();
  const workspaceFiles = new Map<string, string>();
  const storage = new Map<string, unknown>();
  const modelCalls: FakeHost["modelCalls"] = [];
  const imageCalls: ImageGenerateRequest[] = [];
  let imageHook: (request: ImageGenerateRequest) => void = () => undefined;
  let imageCounter = 0;
  let model: (prompt: string, system?: string) => string | Promise<string> = () => "{}";
  const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const listOf = (files: Map<string, string>, path: string) => {
    const prefix = path ? `${path.replace(/\/$/, "")}/` : "";
    const names = new Map<string, boolean>();
    for (const key of files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const [head, ...tail] = rest.split("/");
      names.set(head, (names.get(head) ?? false) || tail.length > 0);
    }
    return { entries: [...names].map(([name, isDirectory]) => ({ name, isDirectory, size: isDirectory ? 0 : (files.get(prefix + name) ?? "").length })) };
  };
  const sessions = new Map<string, AgentSession>();
  let stamp = 0;
  const sessionOf = (id: string) => { const session = sessions.get(id); if (!session) throw new Error(`Agent session ${id} does not exist.`); return session; };
  const notFound = () => Object.assign(new Error("File not found."), { code: "not_found" });
  const api = {
    pluginId: "daily.writer",
    request: async (method: string, payload: unknown): Promise<unknown> => {
      if (method === "model.invoke") return api.model.invoke(payload as ModelInvokeRequest);
      if (method === "image.generate") return api.image.generate(payload as ImageGenerateRequest);
      if (method === "agent.task.start") return api.agent.task.start(payload as Parameters<DailyPluginApi["agent"]["task"]["start"]>[0]);
      if (method === "agent.task.resume") return api.agent.task.resume(payload as Parameters<DailyPluginApi["agent"]["task"]["resume"]>[0]);
      if (method === "agent.task.retry") return api.agent.task.retry(payload as Parameters<DailyPluginApi["agent"]["task"]["retry"]>[0]);
      throw new Error(`Unsupported fake RPC: ${method}`);
    },
    host: { getContext: async () => ({ plugin: { identifier: "daily.writer", name: "Writer", version: "0.0.0", settings: {} } }), setDirty: async () => undefined },
    storage: {
      get: async (key: string) => structuredClone(storage.get(key) ?? null),
      set: async (key: string, value: unknown) => { storage.set(key, structuredClone(value)); },
      compareAndSet: async (key: string, expected: unknown, value: unknown) => {
        if (!equal(storage.get(key) ?? null, expected)) return false;
        storage.set(key, structuredClone(value));
        return true;
      },
      compareAndRemove: async (key: string, expected: unknown) => {
        if (!equal(storage.get(key) ?? null, expected)) return false;
        storage.delete(key);
        return true;
      },
      remove: async (key: string) => { storage.delete(key); },
      list: async () => Object.fromEntries(storage),
    },
    files: {
      readText: async (path: string) => { const value = privateFiles.get(path); if (value === undefined) throw notFound(); return value; },
      writeText: async (path: string, content: string) => { privateFiles.set(path, content); },
      readBase64: async (path: string) => { const value = privateFiles.get(path); if (value === undefined) throw notFound(); return value; },
      writeBase64: async (path: string, base64: string) => { privateFiles.set(path, base64); },
      remove: async (path: string) => { for (const key of [...privateFiles.keys()]) if (key === path || key.startsWith(`${path}/`)) privateFiles.delete(key); },
      list: async (path: string) => listOf(privateFiles, path),
      ensureDir: async () => undefined,
    },
    workspace: {
      readText: async (path: string) => { const value = workspaceFiles.get(path); if (value === undefined) throw notFound(); return value; },
      list: async (path: string) => listOf(workspaceFiles, path),
      writeText: async (path: string, content: string) => { workspaceFiles.set(path, content); },
      ensureDir: async () => undefined,
      removeFile: async (path: string) => { workspaceFiles.delete(path); },
      copyFromPluginFiles: async (from: string, to: string) => { const value = privateFiles.get(from); if (value === undefined) throw notFound(); workspaceFiles.set(to, value); },
    },
    image: {
      status: async () => ({ configured: true, source: "environment" as const, models: ["gpt-image-2.6-sunburst", "gpt-image-2.6-flare"] }),
      generate: async (payload: ImageGenerateRequest) => {
        imageCalls.push(payload);
        imageHook(payload);
        const files = Array.from({ length: payload.n ?? 1 }, () => {
          imageCounter += 1;
          const path = `${payload.outputDir}/image-${imageCounter}.webp`;
          privateFiles.set(path, "aW1hZ2U=");
          return { path, bytes: 5, mime: "image/webp" };
        });
        return { files, model: "gpt-image-2.6-sunburst", endpoint: payload.references?.length ? "/images/edits" : "/images/generations", requestId: "req", outputFormat: "webp", size: payload.size ?? "auto", usage: null };
      },
    },
    model: {
      invoke: async (payload: ModelInvokeRequest) => {
        modelCalls.push({ prompt: payload.prompt, system: payload.system, model: payload.model, images: payload.images });
        return { text: await model(payload.prompt, payload.system) };
      },
      list: async () => ({
        default: { authConfigId: "codex-default", model: "gpt-5.5" },
        providers: [{ id: "codex-default", name: "Codex", providerKind: "codex_login", models: ["gpt-5.5", "gpt-5.4-mini"], defaultModel: "gpt-5.5", acceptsImages: true }, { id: "blind", name: "Blind", providerKind: "antigravity_login", models: ["b-1"], defaultModel: "b-1", acceptsImages: false }],
      }),
    },
    network: { fetch: async () => { throw new Error("network disabled in tests"); } },
    agent: {
      list: async () => ({}),
      run: async () => ({}),
      task: { start: async () => ({}), resume: async () => ({}), cancel: async () => ({ cancelled: true }) },
      session: {
        create: async (payload?: { scope?: string; title?: string }) => {
          const session: AgentSession = { id: `session-${++stamp}`, pluginId: "daily.writer", scope: payload?.scope ?? "", title: payload?.title ?? "新对话", createdAt: stamp, updatedAt: stamp, activeEntryId: null, summary: null, entries: [] };
          sessions.set(session.id, session);
          return structuredClone(session);
        },
        list: async (scope?: string) => [...sessions.values()].filter((session) => scope === undefined || session.scope === scope).sort((left, right) => right.updatedAt - left.updatedAt).map(({ id, scope: itemScope, title, createdAt, updatedAt, entries }) => ({ id, scope: itemScope, title, createdAt, updatedAt, entryCount: entries.length })),
        get: async (sessionId: string) => structuredClone(sessionOf(sessionId)),
        remove: async (sessionId: string) => { sessions.delete(sessionId); },
        appendMessages: async (sessionId: string, messages: AgentSessionMessageInput[]) => {
          const session = sessionOf(sessionId);
          const entries = messages.map((message): AgentSessionEntry => ({ id: `entry-${++stamp}`, role: message.role, content: message.content, meta: message.meta ?? null, createdAt: stamp, run: null }));
          session.entries.push(...entries);
          session.updatedAt = ++stamp;
          return structuredClone(entries);
        },
        updateEntry: async (sessionId: string, entryId: string, patch: { content?: string; meta?: unknown }) => {
          const entry = sessionOf(sessionId).entries.find((item) => item.id === entryId);
          if (!entry) throw new Error("entry not found");
          Object.assign(entry, patch);
          return structuredClone(entry);
        },
      },
    },
  } as unknown as DailyPluginApi;
  let taskCounter = 0;
  const pending = new Map<string, Promise<TaskSnapshot>>();
  api.tasks = {
    async submit(input: TaskSubmitInput) {
      const task = { ...input, title: input.title ?? input.kind, scope: input.scope ?? "", exclusiveKey: input.exclusiveKey ?? null, progress: null, result: null, createdAt: 0, updatedAt: 0, id: `test-task-${++taskCounter}`, pluginId: api.pluginId, status: "running", attempt: 1, cursor: taskCounter, error: null } as TaskSnapshot;
      const context: TaskContext = {
        task, input: input.input, checkpoint: null, resume: null, signal: new AbortController().signal,
        update: async (patch) => { if ("checkpoint" in patch) context.checkpoint = patch.checkpoint; },
        call: async (_key, method, payload) => api.request(method, payload) as never,
      };
      bindTaskContext(context);
      const result = (async () => {
        try {
          if (input.kind === "writer.images") {
            const { generateImages } = await import("../images/generate");
            const value = input.input as { projectId: string; options: Parameters<typeof generateImages>[1] };
            return { ...task, status: "completed" as const, result: await generateImages(value.projectId, { ...value.options, signal: context.signal }) };
          }
          const { domainHandler } = await import("../worker/domainHandlers");
          const outcome = await domainHandler(context);
          return { ...task, ...outcome };
        } catch (error) {
          return { ...task, status: "failed" as const, error: error instanceof Error ? error.message : String(error) };
        }
      })();
      pending.set(task.id, result);
      return task;
    },
    get: async (id: string) => { const task = await pending.get(id); if (!task) throw new Error("Task not found"); return task; },
  } as DailyPluginApi["tasks"];
  setDailyHost(api);
  return { api, sessions, privateFiles, workspaceFiles, storage, modelCalls, imageCalls, setImage: (handler) => { imageHook = handler; }, setModel: (handler) => { model = handler; } };
}

export function uninstallFakeHost() { setDailyHost(null); }
