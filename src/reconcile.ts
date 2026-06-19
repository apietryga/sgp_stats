/**
 * Three-source reconciliation.
 *
 * Sources of heat composition:
 *   - 'sport'       : the 1995-2019 base (gogonzo/sport)
 *   - 'fimspeedway' : the official 2020-2026 heat-by-heat data (when fetched)
 * Round-total cross-checks (NOT heat composition): 'gpsquads', 'wikipedia'.
 *
 * For each physical heat (season, round, heat_no, phase) we compare the official
 * rows against the base rows field-by-field (rider, gate, rank, points) and set
 * heats.trust_status:
 *     VERIFIED       official agrees with the base on every shared field
 *     OFFICIAL_ONLY  official is the only heat-composition source
 *     CONFLICT       official disagrees with the base (diff recorded, NOT applied)
 *     UNVERIFIED     no official source for this heat
 *
 * THE GOLDEN RULE (enrich without corrupting):
 *   - a heat/field missing from the base but present in official -> INSERT it
 *     (it already lives under the 'fimspeedway' event; we just keep + trust it);
 *   - a field that exists and AGREES -> only raise trust, never touch the value;
 *   - a field that exists and DIFFERS -> never overwrite silently: keep the
 *     original, record a CONFLICT row with both values + sources. The optional
 *     --prefer-official flag overwrites, but always with an audit row preserving
 *     the old value.
 *
 * Per-field provenance is recorded for every results row from every source.
 */
import type { Database } from "bun:sqlite";
import { openDb } from "./db.ts";

interface ResultRow {
  result_id: number;
  heat_id: number;
  season: number;
  round: number;
  heat_no: number;
  phase: string;
  source: string;
  source_url: string;
  fetched_at: string;
  rider_id: number;
  gate: number | null;
  rank: number | null;
  points: number | null;
}

const FIELDS = ["gate", "rank", "points"] as const;

export interface ReconcileStats {
  verified: number;
  official_only: number;
  unverified: number;
  conflict: number;
  filled: number; // base-missing rider rows present only in official
  overwritten: number; // only with --prefer-official
}

function loadResults(db: Database): ResultRow[] {
  return db
    .query<ResultRow, []>(
      `SELECT r.id          AS result_id,
              r.heat_id     AS heat_id,
              e.season      AS season,
              e.round       AS round,
              h.heat_no     AS heat_no,
              h.phase       AS phase,
              e.source      AS source,
              r.source_url  AS source_url,
              e.fetched_at  AS fetched_at,
              r.rider_id    AS rider_id,
              r.gate        AS gate,
              r.rank        AS rank,
              r.points      AS points
         FROM results r
         JOIN heats  h ON h.id = r.heat_id
         JOIN events e ON e.id = h.event_id`,
    )
    .all();
}

function physKey(r: { season: number; round: number; heat_no: number; phase: string }): string {
  return `${r.season}|${r.round}|${r.heat_no}|${r.phase}`;
}

/** Record per-field provenance for one results row. */
function recordProvenance(db: Database, r: ResultRow): void {
  const vals: [string, unknown][] = [
    ["gate", r.gate],
    ["rank", r.rank],
    ["points", r.points],
  ];
  for (const [field, value] of vals) {
    db.query(
      `INSERT OR REPLACE INTO provenance (result_id, field, value, source, source_url, set_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(r.result_id, field, value === null ? null : String(value), r.source, r.source_url, r.fetched_at);
  }
}

function setTrust(db: Database, heatId: number, status: string): void {
  db.query("UPDATE heats SET trust_status = ? WHERE id = ?").run(status, heatId);
}

/** Reconcile against an already-open DB handle (the caller owns its lifetime). */
export function reconcileDb(
  db: Database,
  opts: { preferOfficial?: boolean } = {},
): ReconcileStats {
  const rows = loadResults(db);
  const stats: ReconcileStats = {
    verified: 0,
    official_only: 0,
    unverified: 0,
    conflict: 0,
    filled: 0,
    overwritten: 0,
  };
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    // Fresh provenance + conflict audit each run.
    db.query("DELETE FROM provenance").run();
    db.query("DELETE FROM conflicts").run();
    for (const r of rows) recordProvenance(db, r);

    // Group every result row by physical heat, split into base vs official.
    const byHeat = new Map<string, { base: ResultRow[]; official: ResultRow[]; heatIds: Set<number> }>();
    for (const r of rows) {
      const k = physKey(r);
      if (!byHeat.has(k)) byHeat.set(k, { base: [], official: [], heatIds: new Set() });
      const g = byHeat.get(k)!;
      g.heatIds.add(r.heat_id);
      if (r.source === "fimspeedway") g.official.push(r);
      else g.base.push(r);
    }

    for (const { base, official } of byHeat.values()) {
      const baseHeatId = base[0]?.heat_id;
      const officialHeatId = official[0]?.heat_id;

      // No official source -> the heat is unverified; trust lives on the base heat.
      if (official.length === 0) {
        if (baseHeatId !== undefined) setTrust(db, baseHeatId, "UNVERIFIED");
        stats.unverified++;
        continue;
      }

      // Official exists but no base -> official is the only composition source.
      if (base.length === 0) {
        setTrust(db, officialHeatId!, "OFFICIAL_ONLY");
        stats.official_only++;
        continue;
      }

      // Both exist -> compare per rider, per field.
      const baseByRider = new Map<number, ResultRow>();
      for (const b of base) baseByRider.set(b.rider_id, b);
      let conflict = false;
      for (const o of official) {
        const b = baseByRider.get(o.rider_id);
        if (!b) {
          // Official rider absent from base composition -> a fill candidate.
          stats.filled++;
          continue;
        }
        for (const f of FIELDS) {
          const ov = o[f];
          const bv = b[f];
          if (ov === null || bv === null) continue; // can't disagree on a blank
          if (ov !== bv) {
            conflict = true;
            db.query(
              `INSERT INTO conflicts
                 (heat_id, rider_id, field, existing_value, existing_source, official_value, official_source, detected_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(b.heat_id, b.rider_id, f, String(bv), b.source, String(ov), o.source, now);
            if (opts.preferOfficial) {
              // Overwrite WITH an audit trail: the conflict row above keeps the old value.
              db.query(`UPDATE results SET ${f} = ? WHERE id = ?`).run(ov, b.result_id);
              stats.overwritten++;
            }
          }
        }
      }
      if (conflict) {
        setTrust(db, baseHeatId!, "CONFLICT");
        stats.conflict++;
      } else {
        setTrust(db, baseHeatId!, "VERIFIED");
        stats.verified++;
      }
    }
  });
  tx();
  return stats;
}

/** Open the DB at `dbPath` (default project DB), reconcile, and close it. */
export function reconcile(
  dbPath?: string,
  opts: { preferOfficial?: boolean } = {},
): ReconcileStats {
  const db = openDb(dbPath);
  try {
    return reconcileDb(db, opts);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const preferOfficial = process.argv.includes("--prefer-official");
  const s = reconcile(undefined, { preferOfficial });
  console.log(
    `reconcile — VERIFIED ${s.verified}, OFFICIAL_ONLY ${s.official_only}, ` +
      `UNVERIFIED ${s.unverified}, CONFLICT ${s.conflict}, filled ${s.filled}` +
      (preferOfficial ? `, overwritten ${s.overwritten} (--prefer-official)` : ""),
  );
  if (s.conflict > 0) {
    console.log(`  ${s.conflict} heat(s) in CONFLICT — see out/conflicts.csv after verify.`);
  }
}
