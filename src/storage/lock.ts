import { dailyHost } from "../host";
import { uniqueId } from "../domain/ids";
import { asRecord, delay, finiteNumber } from "../domain/util";

const WRITER_LOCK_KEY = "writer.mutation.lock.v1";
const LOCK_LEASE_MS = 2 * 60_000;
const LOCK_HEARTBEAT_MS = 30_000;

type Lease = { owner: string; expiresAt: number };

/** Serializes Writer mutations across windows/views with a host-side compare-and-set lease. */
export async function withWriterMutationLock<T>(task: () => Promise<T>, key = WRITER_LOCK_KEY): Promise<T> {
  const owner = uniqueId("lock");
  let acquired = false;
  for (let attempt = 0; attempt < 40 && !acquired; attempt += 1) {
    acquired = await tryAcquireLease(key, owner, LOCK_LEASE_MS);
    if (!acquired) await delay(40 + attempt * 25);
  }
  if (!acquired) throw new Error("另一个写作操作正在保存，请稍后重试。");
  const timer = globalThis.setInterval(() => { void renewLease(key, owner, LOCK_LEASE_MS).catch(() => undefined); }, LOCK_HEARTBEAT_MS);
  try {
    return await task();
  } finally {
    globalThis.clearInterval(timer);
    await releaseLease(key, owner).catch(() => undefined);
  }
}

export async function tryAcquireLease(key: string, owner: string, leaseMs: number): Promise<boolean> {
  const currentValue = await dailyHost().storage.get(key);
  const current = asRecord(currentValue);
  if (typeof current.owner === "string" && current.owner !== owner && finiteNumber(current.expiresAt, 0) > Date.now()) return false;
  return dailyHost().storage.compareAndSet(key, currentValue ?? null, { owner, expiresAt: Date.now() + leaseMs } satisfies Lease);
}

export async function renewLease(key: string, owner: string, leaseMs: number): Promise<boolean> {
  const currentValue = await dailyHost().storage.get(key);
  if (asRecord(currentValue).owner !== owner) return false;
  return dailyHost().storage.compareAndSet(key, currentValue, { owner, expiresAt: Date.now() + leaseMs } satisfies Lease);
}

export async function releaseLease(key: string, owner: string): Promise<void> {
  const currentValue = await dailyHost().storage.get(key);
  if (asRecord(currentValue).owner === owner) await dailyHost().storage.compareAndRemove(key, currentValue);
}

export async function readLease(key: string): Promise<Lease | null> {
  const current = asRecord(await dailyHost().storage.get(key));
  return typeof current.owner === "string" ? { owner: current.owner, expiresAt: finiteNumber(current.expiresAt, 0) } : null;
}
