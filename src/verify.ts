/**
 * verify — emit credibility reports to out/ and a console summary.
 *
 *   out/verification_report.csv : one row per heat, with trust_status + the set
 *                                 of sources covering it + a points/rank sanity flag.
 *   out/credibility_summary.csv : headline counts (VERIFIED / OFFICIAL_ONLY /
 *                                 UNVERIFIED / CONFLICT), fields filled from
 *                                 official, and % of 2020-2026 heats covered by
 *                                 the official source, plus the round-total
 *                                 cross-check agreement rate.
 *   out/conflicts.csv           : every official-vs-base disagreement to resolve.
 *
 * Run reconcile first so trust_status/conflicts are populated.
 */
import { resolve } from "node:path";
import { openDb } from "./db.ts";
import { rankConsistentWithPoints } from "./codes.ts";
import { toCsv } from "./csv.ts";

const OUT_DIR = resolve(import.meta.dir, "../out");
const OFFICIAL_ERA = [2020, 2026] as const;

interface HeatAgg {
  heat_id: number;
  season: number;
  round: number;
  heat_no: number;
  phase: string;
  trust_status: string;
}

async function main(): Promise<void> {
  const db = openDb();

  // --- per-heat report ------------------------------------------------------
  const heats = db
    .query<HeatAgg, []>(
      `SELECT h.id AS heat_id, e.season, e.round, h.heat_no, h.phase, h.trust_status
         FROM heats h JOIN events e ON e.id = h.event_id`,
    )
    .all();

  // sources covering each physical heat (sport / fimspeedway)
  const sourceRows = db
    .query<{ season: number; round: number; heat_no: number; phase: string; source: string }, []>(
      `SELECT DISTINCT e.season, e.round, h.heat_no, h.phase, e.source
         FROM heats h JOIN events e ON e.id = h.event_id`,
    )
    .all();
  const sourcesByPhys = new Map<string, Set<string>>();
  for (const s of sourceRows) {
    const k = `${s.season}|${s.round}|${s.heat_no}|${s.phase}`;
    if (!sourcesByPhys.has(k)) sourcesByPhys.set(k, new Set());
    sourcesByPhys.get(k)!.add(s.source);
  }

  // points/rank consistency per heat
  const resByHeat = db
    .query<{ heat_id: number; rank: number | null; points: number | null }, []>(
      "SELECT heat_id, rank, points FROM results",
    )
    .all();
  const consistent = new Map<number, boolean>();
  for (const r of resByHeat) {
    const ok =
      r.rank === null || r.points === null || rankConsistentWithPoints(r.rank, r.points);
    consistent.set(r.heat_id, (consistent.get(r.heat_id) ?? true) && ok);
  }

  const reportRows = heats.map((h) => {
    const k = `${h.season}|${h.round}|${h.heat_no}|${h.phase}`;
    const sources = [...(sourcesByPhys.get(k) ?? new Set())].sort().join("+");
    return [
      h.season,
      h.round,
      h.heat_no,
      h.phase,
      h.trust_status,
      sources,
      consistent.get(h.heat_id) === false ? "INCONSISTENT" : "ok",
    ];
  });
  await Bun.write(
    resolve(OUT_DIR, "verification_report.csv"),
    toCsv(
      ["season", "round", "heat_no", "phase", "trust_status", "sources", "points_rank"],
      reportRows,
    ),
  );

  // --- round-total cross-check (computed heat sums vs external_totals) -------
  const computed = db
    .query<{ season: number; round: number; rider_id: number; total: number }, []>(
      `SELECT e.season, e.round, r.rider_id, SUM(r.points) AS total
         FROM results r JOIN heats h ON h.id = r.heat_id JOIN events e ON e.id = h.event_id
        WHERE e.source IN ('sport','fimspeedway')
        GROUP BY e.season, e.round, r.rider_id`,
    )
    .all();
  const computedMap = new Map<string, number>();
  for (const c of computed) computedMap.set(`${c.season}|${c.round}|${c.rider_id}`, c.total);

  const ext = db
    .query<{ season: number; round: number; rider_id: number; total: number; source: string }, []>(
      "SELECT season, round, rider_id, total, source FROM external_totals",
    )
    .all();
  let checked = 0;
  let agree = 0;
  for (const e of ext) {
    if (e.round === 0) continue; // season-total granularity, not per-round comparable
    const c = computedMap.get(`${e.season}|${e.round}|${e.rider_id}`);
    if (c === undefined) continue;
    checked++;
    if (c === e.total) agree++;
  }

  // --- credibility summary --------------------------------------------------
  const trust = Object.fromEntries(
    db
      .query<{ trust_status: string; n: number }, []>(
        "SELECT trust_status, COUNT(*) n FROM heats GROUP BY trust_status",
      )
      .all()
      .map((r) => [r.trust_status, r.n]),
  );
  const filled = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) n FROM results r JOIN heats h ON h.id=r.heat_id JOIN events e ON e.id=h.event_id
        WHERE e.source='fimspeedway'`,
    )
    .get()!.n;

  // official coverage of 2020-2026
  const eraHeats = db
    .query<{ total: number; official: number }, [number, number]>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN e.source='fimspeedway' THEN 1 ELSE 0 END) AS official
       FROM heats h JOIN events e ON e.id=h.event_id
       WHERE e.season BETWEEN ? AND ?`,
    )
    .get(OFFICIAL_ERA[0], OFFICIAL_ERA[1])!;
  const coverage = eraHeats.total ? (100 * (eraHeats.official ?? 0)) / eraHeats.total : 0;

  const summary: [string, string | number][] = [
    ["heats_total", heats.length],
    ["verified", trust["VERIFIED"] ?? 0],
    ["official_only", trust["OFFICIAL_ONLY"] ?? 0],
    ["unverified", trust["UNVERIFIED"] ?? 0],
    ["conflict", trust["CONFLICT"] ?? 0],
    ["fields_filled_from_official", filled],
    ["official_coverage_2020_2026_pct", coverage.toFixed(1)],
    ["round_totals_checked", checked],
    ["round_totals_agree", agree],
    ["round_totals_agree_pct", checked ? ((100 * agree) / checked).toFixed(1) : "n/a"],
  ];
  await Bun.write(
    resolve(OUT_DIR, "credibility_summary.csv"),
    toCsv(["metric", "value"], summary),
  );

  // --- conflicts ------------------------------------------------------------
  const conflicts = db
    .query<
      {
        season: number;
        round: number;
        heat_no: number;
        phase: string;
        rider: string | null;
        field: string;
        existing_value: string | null;
        existing_source: string | null;
        official_value: string | null;
        official_source: string | null;
        detected_at: string;
      },
      []
    >(
      `SELECT e.season, e.round, h.heat_no, h.phase, rd.canonical_name AS rider,
              c.field, c.existing_value, c.existing_source, c.official_value, c.official_source, c.detected_at
         FROM conflicts c
         JOIN heats h ON h.id = c.heat_id
         JOIN events e ON e.id = h.event_id
         LEFT JOIN riders rd ON rd.id = c.rider_id
        ORDER BY e.season, e.round, h.heat_no`,
    )
    .all();
  await Bun.write(
    resolve(OUT_DIR, "conflicts.csv"),
    toCsv(
      [
        "season",
        "round",
        "heat_no",
        "phase",
        "rider",
        "field",
        "existing_value",
        "existing_source",
        "official_value",
        "official_source",
        "detected_at",
      ],
      conflicts.map((c) => [
        c.season,
        c.round,
        c.heat_no,
        c.phase,
        c.rider,
        c.field,
        c.existing_value,
        c.existing_source,
        c.official_value,
        c.official_source,
        c.detected_at,
      ]),
    ),
  );

  db.close();

  // --- console table --------------------------------------------------------
  console.log("verify — credibility summary:");
  for (const [k, v] of summary) console.log(`  ${k.padEnd(34)} ${v}`);
  console.log(
    `  reports -> out/verification_report.csv, out/credibility_summary.csv, out/conflicts.csv`,
  );
}

if (import.meta.main) {
  await main();
}
