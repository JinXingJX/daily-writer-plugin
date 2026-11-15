export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
export function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
export function trimmedString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
export function textOr(value: unknown, fallback: string): string { const trimmed = typeof value === "string" ? value.trim() : ""; return trimmed || fallback; }
export function nullableString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
export function stringArray(value: unknown, limit = 1_000): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()).slice(0, limit) : [];
}
export function finiteNumber(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
export function clampNumber(value: unknown, fallback: number, min: number, max: number): number { return Math.min(max, Math.max(min, finiteNumber(value, fallback))); }
export function dedupeById<T extends { id: string }>(items: T[]): T[] { return [...new Map(items.map((item) => [item.id, item])).values()]; }
export function upsertById<T extends { id: string }>(items: T[], item: T) {
  const index = items.findIndex((current) => current.id === item.id);
  if (index >= 0) items[index] = item; else items.push(item);
}
export function jsonEqual(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
export function unixTimestamp() { return Math.floor(Date.now() / 1000); }
export function delay(milliseconds: number) { return new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds)); }
export function previewText(content: string, limit: number) { return content.length > limit ? `${content.slice(0, limit)}…` : content; }
export function tailText(content: string, limit: number) { return content.length > limit ? `…${content.slice(content.length - limit)}` : content; }

/** Runs `worker` over `items` with bounded parallelism, preserving result order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
