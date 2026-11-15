let counter = 0;

/** Collision-resistant id usable as a file name: `[a-z0-9-]` only. */
export function uniqueId(prefix: string): string {
  counter = (counter + 1) % 1_679_616;
  const random = Math.floor(Math.random() * 2_176_782_336).toString(36);
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36).padStart(4, "0")}${random}`;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isSafeId(value: unknown): value is string { return typeof value === "string" && SAFE_ID.test(value); }

/** Returns `value` when it is already a safe file-name id, otherwise a stable hashed id derived from it. */
export function safeIdFrom(value: unknown, prefix: string): string {
  if (isSafeId(value)) return value;
  const source = typeof value === "string" && value.trim() ? value : uniqueId(prefix);
  return `${prefix}-${contentHash(source)}`;
}

export function projectIdValue(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (id && id.length <= 128 && id !== "." && id !== ".." && !/[\\/\p{Cc}]/u.test(id)) return id;
  throw new Error("Writer project id is invalid.");
}

/** 53-bit string hash (cyrb53) rendered in base36 together with the length. */
export function contentHash(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${hash.toString(36)}${value.length.toString(36)}`;
}

export function slugify(value: string, fallback: string) {
  const clean = (input: string) => input.toLowerCase().replace(/[^a-z0-9\s/_-]/g, "-").replace(/[\s/_-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean(value) || clean(fallback) || `item-${contentHash(`${value}\0${fallback}`)}`;
}
