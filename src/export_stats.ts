/**
 * export:stats — assemble a self-contained verification package in export/ for
 * statisticians to independently re-derive the Elo ranking.
 *
 * It is regenerated from the DB + the canonical export CSV on every run, so it
 * stays strongly synchronized with the database. Output is CSV only (universal),
 * plus a codebook, a methodology note recording the exact parameters used, and a
 * manifest with sha256 of every generated file AND every upstream source
 * artifact (the full provenance chain back to data/raw/).
 *
 * Run after `bun run export` (which writes data/gpheats_all.csv). Accepts the
 * same K flags/env as build:elo so the package reflects the parameters used:
 *   bun run export:stats --k=32 --no-provisional
 */
import { resolve, basename } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { openDb } from "./db.ts";
import { readMeta } from "./raw.ts";
import { toCsv } from "./csv.ts";
import {
  EloEngine,
  loadExportRows,
  parseArgs,
  START_ELO,
  type EloConfig,
} from "./elo.ts";

const EXPORT_DIR = resolve(import.meta.dir, "../export");

function sha256(s: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(s);
  return h.digest("hex");
}

interface ManifestRow {
  file: string;
  kind: "generated" | "source";
  rows: number | "";
  sha256: string;
  url: string;
  fetched_at: string;
}

async function main(): Promise<void> {
  const { cfg } = parseArgs(process.argv.slice(2));
  const { rows, trustCounts } = await loadExportRows();

  // Recompute Elo with the trace enabled (cheap; keeps build:elo lean).
  const engine = new EloEngine(cfg, { trace: true });
  engine.appendHeats(rows);

  const db = openDb();
  const manifest: ManifestRow[] = [];

  // helper: build a CSV, write it, and record it in the manifest
  async function emit(file: string, header: string[], data: unknown[][]): Promise<void> {
    const csv = toCsv(header, data);
    await Bun.write(resolve(EXPORT_DIR, file), csv);
    manifest.push({ file, kind: "generated", rows: data.length, sha256: sha256(csv), url: "", fetched_at: "" });
  }
  async function emitText(file: string, text: string): Promise<void> {
    await Bun.write(resolve(EXPORT_DIR, file), text);
    manifest.push({ file, kind: "generated", rows: "", sha256: sha256(text), url: "", fetched_at: "" });
  }

  // fresh directory each run
  rmSync(EXPORT_DIR, { recursive: true, force: true });
  mkdirSync(EXPORT_DIR, { recursive: true });

  // canonical rider name -> id (for joining the trace to a stable key)
  const ridById = new Map<string, number>();
  for (const r of db
    .query<{ id: number; canonical_name: string }, []>("SELECT id, canonical_name FROM riders")
    .all()) {
    ridById.set(r.canonical_name, r.id);
  }

  // --- heats.csv : the raw basis the Elo was computed on --------------------
  const heatRows = db
    .query<Record<string, unknown>, []>(
      `SELECT h.id            AS heat_id,
              e.season        AS season,
              e.round         AS round,
              e.name          AS event_name,
              e.date          AS date,
              e.country       AS country,
              e.venue         AS venue,
              h.heat_no       AS heat_no,
              h.phase         AS phase,
              r.gate          AS gate,
              rd.canonical_name AS rider,
              r.rider_id      AS rider_id,
              rs.source_key   AS official_rider_id,
              r.points        AS points,
              r.position_code AS position_code,
              r.rank          AS rank,
              h.trust_status  AS trust_status,
              e.source        AS source,
              r.source_url    AS source_url
         FROM results r
         JOIN heats  h  ON h.id = r.heat_id
         JOIN events e  ON e.id = h.event_id
         JOIN riders rd ON rd.id = r.rider_id
         LEFT JOIN rider_sources rs ON rs.rider_id = r.rider_id AND rs.source = 'fimspeedway'
        ORDER BY e.date, h.id, r.rank`,
    )
    .all();
  const HEATS_COLS = [
    "heat_id", "season", "round", "event_name", "date", "country", "venue",
    "heat_no", "phase", "gate", "rider", "rider_id", "official_rider_id",
    "points", "position_code", "rank", "trust_status", "source", "source_url",
  ];
  await emit("heats.csv", HEATS_COLS, heatRows.map((r) => HEATS_COLS.map((c) => r[c] ?? "")));

  // --- elo_steps.csv : per rider-heat computation trace ---------------------
  const STEP_COLS = [
    "heat_id", "date", "season", "round", "heat_no", "phase", "rider", "rider_id",
    "rank", "elo_before", "elo_after", "delta", "k_used", "is_provisional",
  ];
  await emit(
    "elo_steps.csv",
    STEP_COLS,
    engine.steps.map((s) => [
      s.heat_id, s.date, s.season, s.round ?? "", s.heat_no ?? "", s.phase ?? "",
      s.rider, ridById.get(s.rider) ?? "", s.rank,
      s.elo_before.toFixed(6), s.elo_after.toFixed(6), s.delta.toFixed(6),
      s.k_used, s.is_provisional ? 1 : 0,
    ]),
  );

  // --- elo_pairs.csv : per-pair basis of each delta -------------------------
  const PAIR_COLS = [
    "heat_id", "date", "season", "round", "heat_no", "phase",
    "rider_a", "rider_a_id", "rider_b", "rider_b_id", "rank_a", "rank_b",
    "elo_a_before", "elo_b_before", "expected_a", "score_a", "k_a", "k_b",
    "delta_a_from_pair", "delta_b_from_pair",
  ];
  await emit(
    "elo_pairs.csv",
    PAIR_COLS,
    engine.pairs.map((p) => [
      p.heat_id, p.date, p.season, p.round ?? "", p.heat_no ?? "", p.phase ?? "",
      p.rider_a, ridById.get(p.rider_a) ?? "", p.rider_b, ridById.get(p.rider_b) ?? "",
      p.rank_a, p.rank_b,
      p.elo_a_before.toFixed(6), p.elo_b_before.toFixed(6),
      p.expected_a.toFixed(6), p.score_a.toFixed(3), p.k_a, p.k_b,
      p.delta_a_from_pair.toFixed(6), p.delta_b_from_pair.toFixed(6),
    ]),
  );

  // --- ranking.csv ----------------------------------------------------------
  const RANK_COLS = [
    "rider", "rider_id", "current_elo", "peak_elo", "peak_date",
    "heats_raced", "wins", "win_rate", "first_season", "last_season",
  ];
  await emit(
    "ranking.csv",
    RANK_COLS,
    engine.ranking().map((r) => [
      r.rider, ridById.get(r.rider) ?? "",
      Math.round(r.elo), Math.round(r.peak_elo), r.peak_date,
      r.heats_raced, r.wins, (r.heats_raced ? r.wins / r.heats_raced : 0).toFixed(3),
      r.first_season, r.last_season,
    ]),
  );

  // --- events.csv (+ source artifact sha256) --------------------------------
  const events = db
    .query<Record<string, unknown>, []>(
      `SELECT id AS event_id, season, round, name, date, country, venue,
              source, source_url, raw_file, fetched_at
         FROM events ORDER BY season, round, source`,
    )
    .all();
  const metaCache = new Map<string, string>(); // raw_file -> sha256
  async function shaForRawFile(raw_file: unknown): Promise<string> {
    const rf = String(raw_file ?? "");
    if (!rf) return "";
    if (metaCache.has(rf)) return metaCache.get(rf)!;
    const meta = await readMeta(basename(rf));
    const sha = meta?.sha256 ?? "";
    metaCache.set(rf, sha);
    return sha;
  }
  const EVENT_COLS = [
    "event_id", "season", "round", "name", "date", "country", "venue",
    "source", "source_url", "raw_file", "fetched_at", "raw_sha256",
  ];
  const eventData: unknown[][] = [];
  for (const e of events) {
    eventData.push([
      e.event_id, e.season, e.round, e.name ?? "", e.date ?? "", e.country ?? "",
      e.venue ?? "", e.source, e.source_url, e.raw_file, e.fetched_at,
      await shaForRawFile(e.raw_file),
    ]);
  }
  await emit("events.csv", EVENT_COLS, eventData);

  // --- METHODOLOGY.md + CODEBOOK.md -----------------------------------------
  await emitText("METHODOLOGY.md", methodology(cfg, trustCounts, heatRows.length, engine));
  await emitText("CODEBOOK.md", codebook());

  // --- MANIFEST.csv : generated files + upstream source artifacts -----------
  // distinct source artifacts (events + external_totals)
  const sources = db
    .query<{ raw_file: string; source_url: string }, []>(
      `SELECT DISTINCT raw_file, source_url FROM events
        UNION SELECT DISTINCT raw_file, source_url FROM external_totals`,
    )
    .all();
  for (const s of sources) {
    if (!s.raw_file) continue;
    const meta = await readMeta(basename(s.raw_file));
    manifest.push({
      file: s.raw_file,
      kind: "source",
      rows: "",
      sha256: meta?.sha256 ?? "",
      url: meta?.url ?? s.source_url ?? "",
      fetched_at: meta?.fetched_at ?? "",
    });
  }
  const manifestCsv = toCsv(
    ["file", "kind", "rows", "sha256", "url", "fetched_at"],
    manifest.map((m) => [m.file, m.kind, m.rows, m.sha256, m.url, m.fetched_at]),
  );
  await Bun.write(resolve(EXPORT_DIR, "MANIFEST.csv"), manifestCsv);

  db.close();

  console.log(`export:stats -> ${EXPORT_DIR}`);
  for (const m of manifest.filter((m) => m.kind === "generated")) {
    console.log(`  ${m.file.padEnd(18)} ${m.rows === "" ? "" : String(m.rows).padStart(7) + " rows"}`);
  }
  console.log(`  MANIFEST.csv (${manifest.length} entries incl. ${sources.length} source artifacts)`);
}

function methodology(
  cfg: EloConfig,
  trustCounts: Record<string, number>,
  heatRowCount: number,
  engine: EloEngine,
): string {
  const trust = Object.entries(trustCounts)
    .map(([k, v]) => `  - ${k}: ${v} heats`)
    .join("\n");
  return `# Methodology — SGP Elo

This package lets you independently re-derive every rating in \`ranking.csv\` from
\`heats.csv\`. All intermediate arithmetic is in \`elo_steps.csv\` and \`elo_pairs.csv\`.

## Model

Multi-rider Elo by pairwise decomposition. Each heat (2–5 riders, grouped by the
global heat id) is scored as every unordered pair of riders, using the ratings
held BEFORE the heat. A rider's net change is the sum of their pairwise deltas,
applied only after the whole heat is computed (so the per-heat change is
zero-sum under a uniform K).

Riders whose finishing code is a DNF/exclusion — a letter code (x/r/tt/t/d/m …),
not a numeric position — are dropped from the heat before scoring: they neither
gain nor lose rating, never count as a raced heat, and their opponents race a
smaller field. (Numeric positions 5/6 in re-run records are real finishes and
are kept.) This is on by default; \`--include-dnf\` keeps them for sensitivity
testing.

    E_i = 1 / (1 + 10^((R_j - R_i) / 400))           (expected score, col expected_a)
    S_i = 1 if rank_i < rank_j, 0 if worse, 0.5 tie  (actual score,   col score_a)
    delta_i(from pair) = K_i * (S_i - E_i)            (col delta_a_from_pair)
    delta_i(heat)      = sum of delta_i over the rider's pairs in that heat

## Parameters used for THIS export

  - start rating: ${START_ELO}
  - K: ${cfg.k}
  - provisional: ${cfg.provisional ? `yes — K=${cfg.provisionalK} for a rider's first ${cfg.provisionalHeats} heats` : "no (constant K)"}
  - chronological order: by date, then by global heat id
  - tie rule: equal rank => S = 0.5 for both riders
  - DNF exclusion: ${cfg.excludeDnf ? "yes — letter-code (x/r/tt/t/d/m) riders dropped from Elo" : "no (--include-dnf: DNF riders scored as last)"}
  - riders ranked: ${engine.ranking().length}
  - rider-heat rows: ${engine.steps.length}; pair rows: ${engine.pairs.length}; heat input rows: ${heatRowCount}

## Reproduce

1. Sort \`heats.csv\` by (date, heat_id). Group rows by heat_id.
2. Maintain a rating per rider (start ${START_ELO}) and a per-rider count of heats
   raced so far (for the provisional K).
3. For each heat, for every pair, compute E and S as above using pre-heat
   ratings; sum each rider's pair deltas; apply after the heat.
4. Your per-pair numbers should match \`elo_pairs.csv\`; per rider-heat,
   \`elo_before + delta == elo_after\` in \`elo_steps.csv\`; final ratings (rounded)
   should match \`ranking.csv.current_elo\`.

## Data scope & trust

- Heat-by-heat composition currently covers 1995–2019 (source 'sport'). The
  2020–2026 official layer ('fimspeedway') populates once a fetch backend is
  wired (see the project README, "Collecting 2020–2026").
- \`trust_status\` per heat (this export):
${trust}
  Meanings: VERIFIED = official agrees with ≥1 other source; OFFICIAL_ONLY =
  official is the only composition source; CONFLICT = official disagrees
  (original kept, diff logged); UNVERIFIED = no official confirmation.

## Cross-check caveat

Round point totals from secondary sources (gpsquads, Wikipedia) agree with the
sum of per-heat points ~67% of the time for 1995–2019. Most disagreements are a
data-semantics difference (GP classification points from semi-final/final
structure vs a raw sum of heat points), not an error. The Elo model uses only
per-heat RANKS, so this does not affect ratings.

## Provenance

\`events.csv\` and \`MANIFEST.csv\` chain every row back to a raw artifact saved on
disk (URL + fetched_at + sha256). No values are invented.
`;
}

function codebook(): string {
  return `# Codebook

## heats.csv — the raw basis (one row per rider per heat)
- heat_id: global heat id; all riders in one heat share it (Elo grouping key)
- season, round: competition season and round number (round derived from date order)
- event_name, date, country, venue: event metadata
- heat_no: heat number within the event; phase: main | semi | lcq | final
- gate: starting gate 1–4
- rider: canonical rider name; rider_id: stable internal id
- official_rider_id: fimspeedway rider id when known (2020+), else blank
- points: heat points scored (3/2/1/0); position_code: finish code (1–4 or x/r/t…)
- rank: finishing rank (1=best); lower is better; ties share a rank
- trust_status: VERIFIED | OFFICIAL_ONLY | CONFLICT | UNVERIFIED
- source: 'sport' | 'fimspeedway'; source_url: where the row came from

## elo_steps.csv — per rider-heat computation step
- heat_id, date, season, round, heat_no, phase: heat keys
- rider, rider_id, rank
- elo_before: rating before this heat; elo_after: rating after
- delta: net change this heat (= elo_after - elo_before)
- k_used: K-factor applied; is_provisional: 1 if the provisional K was used

## elo_pairs.csv — per-pair basis of each delta
- heat_id + keys; rider_a/rider_b (+ ids); rank_a/rank_b
- elo_a_before/elo_b_before: pre-heat ratings used for this pair
- expected_a: E_a = 1/(1+10^((elo_b-elo_a)/400)); score_a: S_a (1/0/0.5)
- k_a/k_b: K-factors; delta_a_from_pair = k_a*(score_a-expected_a),
  delta_b_from_pair = k_b*((1-score_a)-(1-expected_a))

## ranking.csv — final ranking (sorted by current_elo desc)
- rider, rider_id, current_elo, peak_elo, peak_date
- heats_raced, wins (rank==1), win_rate, first_season, last_season

## events.csv — event metadata + source provenance
- event_id, season, round, name, date, country, venue
- source, source_url, raw_file, fetched_at, raw_sha256 (sha256 of the raw artifact)

## MANIFEST.csv — integrity & provenance chain
- file, kind (generated|source), rows, sha256, url, fetched_at
- 'generated' rows: sha256 of each file in this package
- 'source' rows: the upstream raw artifacts (data/raw/…) with their recorded sha256
`;
}

if (import.meta.main) {
  await main();
}
