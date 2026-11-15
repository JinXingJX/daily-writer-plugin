// Assistant conversations live in host-owned agent sessions: the host records author messages,
// replies, every tool call and its result, and compacts old turns. Writer only tags entries.
import { dailyHost } from "../host";
import { asRecord } from "../domain/util";
import type { AgentSession, AgentSessionEntry, AgentSessionSummary } from "../types";
import { byteLength } from "./client";

export type MessageKind = "text" | "proposal" | "question" | "error" | "status" | "plan";
export type AgentDisplay = { id: string; title: string; content: string };
/** A writing convention the assistant suggests filing in the author notebook (`kind: "craft"`). */
export type ConventionSuggestion = { topic: string; text: string; plan: string };
export type EntryMeta = { kind?: MessageKind; proposalId?: string; displays?: AgentDisplay[]; conventions?: ConventionSuggestion[] };
export type SessionMessage = { role: "user" | "assistant"; content: string; meta?: EntryMeta; idempotencyKey?: string };

/** Host limits: 256 KiB per message, 512 KiB per request. */
const MAX_MESSAGE_BYTES = 240 * 1024;
const MAX_BATCH_BYTES = 400 * 1024;

export function entryMeta(entry: AgentSessionEntry): EntryMeta {
  return asRecord(entry.meta) as EntryMeta;
}

export function entryKind(entry: AgentSessionEntry): MessageKind {
  const meta = entryMeta(entry);
  if (meta.kind) return meta.kind;
  if (entry.run?.status === "failed") return "error";
  if (entry.run?.status === "waiting") return "question";
  return "text";
}

export const listSessions = (projectId: string): Promise<AgentSessionSummary[]> => dailyHost().agent.session.list(projectId);
export const getSession = (sessionId: string): Promise<AgentSession> => dailyHost().agent.session.get(sessionId);
export const createSession = (projectId: string, title?: string): Promise<AgentSession> => dailyHost().agent.session.create({ scope: projectId, title });
/** Stops the task the host is executing in this session; its run can then be continued. */
export const stopSession = (sessionId: string) => dailyHost().agent.session.stop(sessionId);
/** Drops a sub-agent the assistant created in this session. */
export const removeAgentTool = (sessionId: string, agentId: string) => dailyHost().agent.session.removeAgentTool(sessionId, agentId);
export const updateEntry = (sessionId: string, entryId: string, patch: { content?: string; meta?: EntryMeta }) => dailyHost().agent.session.updateEntry(sessionId, entryId, patch);

/** Appends plugin-produced messages, splitting requests to stay under the host payload limit. */
export async function appendMessages(sessionId: string, messages: SessionMessage[]): Promise<AgentSessionEntry[]> {
  const entries: AgentSessionEntry[] = [];
  let batch: SessionMessage[] = [];
  let bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    entries.push(...await dailyHost().agent.session.appendMessages(sessionId, batch));
    batch = [];
    bytes = 0;
  };
  for (const message of messages) {
    const content = truncateBytes(message.content, MAX_MESSAGE_BYTES);
    const size = byteLength(content) + 256;
    if (bytes + size > MAX_BATCH_BYTES) await flush();
    batch.push({ ...message, content });
    bytes += size;
  }
  await flush();
  return entries;
}

function truncateBytes(text: string, limit: number): string {
  if (byteLength(text) <= limit) return text;
  const head = new TextDecoder().decode(new TextEncoder().encode(text).slice(0, limit - 64)).replace(/\uFFFD$/, "");
  return `${head}\n…（内容过长，已截断）`;
}
