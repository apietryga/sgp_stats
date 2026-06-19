import { resolve, join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

export const RAW_DIR = resolve(import.meta.dir, "../data/raw");
export const USER_AGENT =
  "sgp-stats/0.1 (personal speedway statistics; contact: antoni.pietryga@linkhouse.co)";

export interface RawMeta {
  url: string;
  fetched_at: string; // ISO 8601 UTC
  sha256: string;
  bytes: number;
  content_type?: string;
  /** Relative path (from project root) to the stored artifact. */
  raw_file: string;
}

function sha256Hex(data: Uint8Array | string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(data);
  return h.digest("hex");
}

/** Project-relative path for storing in the DB (portable across machines). */
function relFromRoot(absPath: string): string {
  const root = resolve(import.meta.dir, "..");
  return absPath.startsWith(root + "/") ? absPath.slice(root.length + 1) : absPath;
}

/**
 * Persist a raw artifact and its sidecar .meta.json. Returns the metadata.
 * The .meta.json records url/fetched_at/sha256 so every downstream row can be
 * audited back to a real file on disk.
 */
export async function saveRaw(
  filename: string,
  body: Uint8Array | string,
  meta: { url: string; fetched_at: string; content_type?: string },
): Promise<RawMeta> {
  mkdirSync(RAW_DIR, { recursive: true });
  const absPath = join(RAW_DIR, filename);
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const sha256 = sha256Hex(bytes);
  await Bun.write(absPath, bytes);
  const rawMeta: RawMeta = {
    url: meta.url,
    fetched_at: meta.fetched_at,
    sha256,
    bytes: bytes.byteLength,
    content_type: meta.content_type,
    raw_file: relFromRoot(absPath),
  };
  await Bun.write(absPath + ".meta.json", JSON.stringify(rawMeta, null, 2));
  return rawMeta;
}

/** Read an existing artifact's metadata if present (used for sha-based caching). */
export async function readMeta(filename: string): Promise<RawMeta | null> {
  const metaPath = join(RAW_DIR, filename + ".meta.json");
  if (!existsSync(metaPath)) return null;
  try {
    return (await Bun.file(metaPath).json()) as RawMeta;
  } catch {
    return null;
  }
}

/** Verify the artifact on disk still matches the recorded sha256. */
export async function verifyRaw(filename: string): Promise<boolean> {
  const meta = await readMeta(filename);
  if (!meta) return false;
  const absPath = join(RAW_DIR, filename);
  if (!existsSync(absPath)) return false;
  const bytes = new Uint8Array(await Bun.file(absPath).arrayBuffer());
  return sha256Hex(bytes) === meta.sha256;
}

let lastFetch = 0;

/** Rate-limited fetch: ensures at least `minGapMs` between successive calls. */
export async function politeFetch(
  url: string,
  minGapMs = 2000,
  headers: Record<string, string> = {},
): Promise<Response> {
  const wait = lastFetch + minGapMs - Date.now();
  if (wait > 0) await Bun.sleep(wait);
  lastFetch = Date.now();
  return fetch(url, { headers: { "User-Agent": USER_AGENT, ...headers } });
}

/**
 * Fetch a URL and store it raw, unless a valid cached copy already exists
 * (verified by sha256). Returns the artifact metadata. Re-uses cache so the
 * same round is never downloaded twice.
 */
export async function fetchAndCache(
  url: string,
  filename: string,
  opts: { minGapMs?: number; headers?: Record<string, string> } = {},
): Promise<RawMeta> {
  if (await verifyRaw(filename)) {
    const meta = await readMeta(filename);
    if (meta) return meta;
  }
  const res = await politeFetch(url, opts.minGapMs ?? 2000, opts.headers);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const body = new Uint8Array(await res.arrayBuffer());
  return saveRaw(filename, body, {
    url,
    fetched_at: new Date().toISOString(),
    content_type: res.headers.get("content-type") ?? undefined,
  });
}
