import { type TaskContext } from "@daily/plugin-sdk";
import { MemoryView } from "../memory/view";
import { runWriterTask, taskContext } from "./taskClient";

type Wire = null | boolean | number | string | Wire[] | { [key: string]: Wire };
function encode(value: unknown): Wire {
  if (value === undefined || value instanceof AbortSignal) return null;
  if (typeof value === "function") return { __taskValue: "progress" };
  if (value instanceof MemoryView) return { __taskValue: "memory", project: encode(value.project) };
  if (value instanceof Map) return { __taskValue: "map", entries: encode([...value]) };
  if (value instanceof Set) return { __taskValue: "set", entries: encode([...value]) };
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "signal").map(([key, item]) => [key, encode(item)]));
  return value as null | boolean | number | string;
}

export async function decodeTaskArgs(args: unknown[], context: TaskContext): Promise<unknown[]> {
  const decode = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) return Promise.all(value.map(decode));
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.__taskValue === "memory") return MemoryView.load(record.project as MemoryView["project"]);
      if (record.__taskValue === "progress") return (...args: unknown[]) => { void context.update({ progress: { message: args.map(String).join(" / ") } }).catch(() => undefined); };
      if (record.__taskValue === "map") return new Map(await decode(record.entries) as [unknown, unknown][]);
      if (record.__taskValue === "set") return new Set(await decode(record.entries) as unknown[]);
      return Object.fromEntries(await Promise.all(Object.entries(record).map(async ([key, item]) => [key, await decode(item)])));
    }
    return value;
  };
  return Promise.all(args.map(async (value) => {
    const decoded = await decode(value);
    if (decoded && typeof decoded === "object" && ("project" in decoded || "session" in decoded)) Object.assign(decoded, { signal: context.signal });
    return decoded;
  }));
}

/** Whole domain operations run in the worker, including multi-call pipelines. */
export function domainTask<T>(name: string, args: unknown[], scope: string, signal?: AbortSignal): Promise<T> | null {
  if (taskContext(signal)) return null;
  return runWriterTask<T>(`writer.${name}`, scope, { name, args: encode(args) }, { signal, exclusiveKey: name === "generateAtlasDraft" ? `atlas:${scope}` : undefined });
}
