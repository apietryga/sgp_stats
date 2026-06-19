/**
 * Export the canonical heat-by-heat data from SQLite to data/gpheats_all.csv.
 * This is the single input to the Elo engine (src/elo.ts), so the engine never
 * touches the DB directly and the exported file is a stable, auditable artifact.
 *
 * Row schema (one row per rider per heat), a superset of the original sport
 * gpheats columns plus provenance the Elo safety-check needs:
 *   id, season, date, round, name, heat, field, rider, points, position, rank,
 *   phase, trust_status, source
 *
 * `id` is the global heat id (every rider in the same heat shares it) — this is
 * exactly the grouping key the Elo engine uses.
 */
import { resolve } from "node:path";
import { openDb } from "./db.ts";
import { toCsv } from "./csv.ts";

export const EXPORT_PATH = resolve(import.meta.dir, "../data/gpheats_all.csv");

export const EXPORT_HEADER = [
  "id",
  "season",
  "date",
  "round",
  "name",
  "heat",
  "field",
  "rider",
  "points",
  "position",
  "rank",
  "phase",
  "trust_status",
  "source",
] as const;

interface ExportRow {
  id: number;
  season: number;
  date: string | null;
  round: number;
  name: string | null;
  heat: number;
  field: number | null;
  rider: string;
  points: number | null;
  position: string | null;
  rank: number | null;
  phase: string;
  trust_status: string;
  source: string;
}

/** Read every results row joined to its heat/event/rider, source-ordered. */
export function collectRows(dbPath?: string): ExportRow[] {
  const db = openDb(dbPath);
  const rows = db
    .query<ExportRow, []>(
      `SELECT h.id            AS id,
              e.season        AS season,
              e.date          AS date,
              e.round         AS round,
              e.name          AS name,
              h.heat_no       AS heat,
              r.gate          AS field,
              rd.canonical_name AS rider,
              r.points        AS points,
              r.position_code AS position,
              r.rank          AS rank,
              h.phase         AS phase,
              h.trust_status  AS trust_status,
              e.source        AS source
         FROM results r
         JOIN heats  h  ON h.id = r.heat_id
         JOIN events e  ON e.id = h.event_id
         JOIN riders rd ON rd.id = r.rider_id
        ORDER BY e.date, h.id, r.rank`,
    )
    .all();
  db.close();
  return rows;
}

async function main(): Promise<void> {
  const rows = collectRows();
  const csv = toCsv(
    [...EXPORT_HEADER],
    rows.map((r) => [
      r.id,
      r.season,
      r.date,
      r.round,
      r.name,
      r.heat,
      r.field,
      r.rider,
      r.points,
      r.position,
      r.rank,
      r.phase,
      r.trust_status,
      r.source,
    ]),
  );
  await Bun.write(EXPORT_PATH, csv);

  const heats = new Set(rows.map((r) => r.id)).size;
  const seasons = new Set(rows.map((r) => r.season));
  console.log(
    `export: ${rows.length} rows, ${heats} heats, seasons ` +
      `${Math.min(...seasons)}-${Math.max(...seasons)} -> ${EXPORT_PATH}`,
  );
}

if (import.meta.main) {
  await main();
}
