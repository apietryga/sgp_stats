import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { openDb } from "./db.ts";

export const ALIASES_CSV = resolve(import.meta.dir, "../config/aliases.csv");
export const CANDIDATES_CSV = resolve(import.meta.dir, "../out/alias_candidates.csv");

/** Remove diacritics and collapse whitespace/case for comparison. */
export function stripDiacritics(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[ł]/g, "l") // ł has no combining form
    .replace(/[Ł]/g, "L");
}

/** A normalized comparison key: lower, no diacritics, single spaces. */
export function nameKey(s: string): string {
  return stripDiacritics(s).toLowerCase().replace(/\s+/g, " ").trim();
}

/** Classic Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** Similarity in [0,1] based on edit distance over the longer string. */
export function similarity(a: string, b: string): number {
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (ka === kb) return 1;
  const maxLen = Math.max(ka.length, kb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(ka, kb) / maxLen;
}

/**
 * Resolves source rider names to canonical rider ids, creating riders on first
 * sight. Honors the manually-approved config/aliases.csv. Caches in memory.
 */
export class RiderResolver {
  private byKey = new Map<string, number>(); // nameKey -> rider_id

  constructor(private db: Database) {
    // Warm from the DB first so an alias whose canonical name is an existing
    // rider resolves to it, instead of ensureRider() trying to re-insert the
    // name and hitting the UNIQUE constraint on riders.canonical_name.
    this.warmCache();
    this.loadAliasFile();
  }

  /** Load approved alias -> canonical pairs from config/aliases.csv into the DB. */
  private loadAliasFile(): void {
    if (!existsSync(ALIASES_CSV)) return;
    const raw = readFileSync(ALIASES_CSV, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#") || /^alias\s*,/i.test(t)) continue;
      const [alias, canonical] = splitCsvLine(t);
      if (!alias || !canonical) continue;
      const rid = this.ensureRider(canonical);
      this.db
        .query("INSERT OR REPLACE INTO aliases (alias, rider_id) VALUES (?, ?)")
        .run(alias, rid);
      this.byKey.set(nameKey(alias), rid);
    }
  }

  private warmCache(): void {
    for (const r of this.db
      .query<{ id: number; canonical_name: string }, []>(
        "SELECT id, canonical_name FROM riders",
      )
      .all()) {
      this.byKey.set(nameKey(r.canonical_name), r.id);
    }
    for (const a of this.db
      .query<{ alias: string; rider_id: number }, []>(
        "SELECT alias, rider_id FROM aliases",
      )
      .all()) {
      this.byKey.set(nameKey(a.alias), a.rider_id);
    }
  }

  /** Get or create a rider id for a canonical name. */
  ensureRider(canonical: string, country: string | null = null): number {
    const key = nameKey(canonical);
    const hit = this.byKey.get(key);
    if (hit !== undefined) {
      if (country) {
        this.db
          .query("UPDATE riders SET country = COALESCE(country, ?) WHERE id = ?")
          .run(country, hit);
      }
      return hit;
    }
    const info = this.db
      .query("INSERT INTO riders (canonical_name, country) VALUES (?, ?)")
      .run(canonical.trim(), country);
    const id = Number(info.lastInsertRowid);
    this.byKey.set(key, id);
    return id;
  }

  /**
   * Resolve using the official rider id as the strong key (2020+ era). If we have
   * already seen this official id, reuse that canonical rider and — when the new
   * spelling differs — auto-merge by registering it as an alias (an official id
   * mapping to two spellings is a certain signal they are the same person). The
   * official id is also recorded in rider_sources. Falls back to name resolution
   * when no official id is given.
   */
  resolveByOfficialId(
    officialId: string | null,
    name: string,
    source = "fimspeedway",
  ): number {
    if (!officialId) return this.resolve(name);
    const existing = this.db
      .query<{ rider_id: number }, [string, string]>(
        "SELECT rider_id FROM rider_sources WHERE source = ? AND source_key = ?",
      )
      .get(source, officialId);
    if (existing) {
      const key = nameKey(name);
      if (!this.byKey.has(key)) {
        // new spelling for a known official id -> auto-merge as an alias
        this.db
          .query("INSERT OR REPLACE INTO aliases (alias, rider_id) VALUES (?, ?)")
          .run(name, existing.rider_id);
        this.byKey.set(key, existing.rider_id);
      }
      return existing.rider_id;
    }
    const rid = this.resolve(name);
    this.db
      .query("INSERT OR REPLACE INTO rider_sources (rider_id, source, source_key) VALUES (?, ?, ?)")
      .run(rid, source, officialId);
    return rid;
  }

  /** Resolve any source spelling to a rider id (creates one if unseen). */
  resolve(name: string, country: string | null = null): number {
    const key = nameKey(name);
    const hit = this.byKey.get(key);
    if (hit !== undefined) {
      if (country) {
        this.db
          .query("UPDATE riders SET country = COALESCE(country, ?) WHERE id = ?")
          .run(country, hit);
      }
      return hit;
    }
    return this.ensureRider(name, country);
  }
}

function splitCsvLine(line: string): [string, string] {
  // Minimal CSV: handles optional quotes around the two fields.
  const m = line.match(/^\s*"?([^",]+)"?\s*,\s*"?([^"]+?)"?\s*$/);
  if (m) return [m[1]!.trim(), m[2]!.trim()];
  const parts = line.split(",");
  return [(parts[0] ?? "").trim(), (parts[1] ?? "").trim()];
}

/**
 * build:aliases — propose merges between similarly-spelled rider names that are
 * NOT already linked, for MANUAL review. Writes out/alias_candidates.csv.
 * Never merges automatically.
 */
function buildAliasCandidates(threshold = 0.88): void {
  const db = openDb();
  const riders = db
    .query<{ id: number; canonical_name: string }, []>(
      "SELECT id, canonical_name FROM riders ORDER BY canonical_name",
    )
    .all();
  // Count heats per rider so the reviewer can keep the better-attested spelling.
  const heatCount = new Map<number, number>();
  for (const row of db
    .query<{ rider_id: number; n: number }, []>(
      "SELECT rider_id, COUNT(*) n FROM results GROUP BY rider_id",
    )
    .all()) {
    heatCount.set(row.rider_id, row.n);
  }

  const rows: string[] = [
    "score,name_a,heats_a,name_b,heats_b,suggested_canonical",
  ];
  let pairs = 0;
  for (let i = 0; i < riders.length; i++) {
    for (let j = i + 1; j < riders.length; j++) {
      const a = riders[i]!;
      const b = riders[j]!;
      // Cheap length prefilter before the O(n*m) distance.
      if (Math.abs(a.canonical_name.length - b.canonical_name.length) > 4) continue;
      const score = similarity(a.canonical_name, b.canonical_name);
      if (score >= threshold && score < 1) {
        const ha = heatCount.get(a.id) ?? 0;
        const hb = heatCount.get(b.id) ?? 0;
        const canonical = ha >= hb ? a.canonical_name : b.canonical_name;
        rows.push(
          `${score.toFixed(3)},${csv(a.canonical_name)},${ha},${csv(b.canonical_name)},${hb},${csv(canonical)}`,
        );
        pairs++;
      }
    }
  }
  writeFileSync(CANDIDATES_CSV, rows.join("\n") + "\n");
  console.log(
    `build:aliases — ${riders.length} riders scanned, ${pairs} candidate pair(s) >= ${threshold} written to ${CANDIDATES_CSV}`,
  );
  console.log(
    "Review them, then copy confirmed merges into config/aliases.csv as: alias,canonical_name",
  );
  db.close();
}

function csv(s: string): string {
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

if (import.meta.main && process.argv.includes("--build")) {
  buildAliasCandidates();
}
