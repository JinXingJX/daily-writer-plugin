import { dailyHost, hostErrorCode } from "../host";

export async function readJson(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await dailyHost().files.readText(path)); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
}

export async function readTextOr(path: string, fallback: string): Promise<string> {
  try { return await dailyHost().files.readText(path); }
  catch (error) { if (isMissing(error)) return fallback; throw error; }
}

export async function writeJson(path: string, value: unknown, pretty = false) {
  await ensureParent(path);
  await dailyHost().files.writeText(path, `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`);
}

export async function writeText(path: string, value: string) {
  await ensureParent(path);
  await dailyHost().files.writeText(path, value);
}

export async function removeFile(path: string) { await dailyHost().files.remove(path).catch(() => undefined); }

export async function listEntries(path: string) {
  try { return (await dailyHost().files.list(path)).entries; }
  catch { return []; }
}

const ensured = new Set<string>();
async function ensureParent(path: string) {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (!dir || ensured.has(dir)) return;
  await dailyHost().files.ensureDir(dir);
  ensured.add(dir);
}

/** Missing files are reported differently by hosts; treat not-found codes and messages as "absent". */
function isMissing(error: unknown) {
  const code = hostErrorCode(error);
  if (code === "not_found" || code === "ENOENT") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /not found|no such file|ENOENT|does not exist|不存在/i.test(message);
}
