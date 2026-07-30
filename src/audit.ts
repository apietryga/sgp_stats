/**
 * audit — season-by-season coverage of the heat-by-heat data.
 *
 * `verify` answers "do the sources agree about the heats we have?". This answers
 * the question that went unasked for longer: "which heats do we not have at
 * all?". A season with no heat-by-heat source does not raise a conflict, fail a
 * cross-check, or show up anywhere in the credibility summary — it simply is not
 * there, and every career that ran through it is silently truncated. That is how
 * the 2020-2021 gap stayed invisible until someone noticed a world champion whose
 * record stopped two years before his title.
 *
 * Reports, to out/coverage_report.csv, out/career_gaps.csv and the console:
 *
 *   - per season: rounds, heats, results, riders, sources, phase coverage
 *   - GAP        : a season inside the covered span with no heats at all
 *   - SHORT      : a round with fewer heats than that season's usual round
 *   - DATE       : a heat whose event date does not fall in its own season
 *   - career gaps: riders who raced before and after a gap season, i.e. exactly
 *     the riders whose totals and last_season the missing data understates
 */
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { openDb } from "./db.ts";
import { toCsv } from "./csv.ts";

const OUT_DIR = resolve(import.meta.dir, "../out");

export interface SeasonCoverage {
  season: number;
  rounds: number;
  heats: number;
  results: number;
  riders: number;
  sources: string;
  phased_rounds: number;
  first_date: string | null;
  last_date: string | null;
}

export interface Finding {
  kind: "GAP" | "SHORT" | "DATE";
  season: number;
  round: number | null;
  detail: string;
}

/**
 * Seasons known to have no heat-by-heat source, and why. Listed explicitly so
 * the gap is stated even in a build whose data does not yet span past it, and
 * so the reason travels with the report instead of living only in the README.
 */
export const KNOWN_GAP_REASONS: Record<number, string> = {
  2020:
    "fimspeedway's API returns only the final classification of each round for this season — " +
    "it publishes no races array, and gogonzo/sport ends at 2019. Fillable via data/contrib/.",
  2021:
    "fimspeedway's API returns only the final classification of each round for this season — " +
    "it publishes no races array, and gogonzo/sport ends at 2019. Fillable via data/contrib/.",
};

/**
 * A season is a gap when it lies inside the covered span but holds no heats.
 * Seasons before the first or after the last covered season are simply outside
 * the project's range, not gaps.
 */
export function findGapSeasons(covered: number[], span?: [number, number]): number[] {
  if (covered.length === 0) return [];
  const lo = span?.[0] ?? Math.min(...covered);
  const hi = span?.[1] ?? Math.max(...covered);
  const have = new Set(covered);
  const gaps: number[] = [];
  for (let s = lo; s <= hi; s++) if (!have.has(s)) gaps.push(s);
  return gaps;
}

interface RoundRow {
  season: number;
  round: number;
  date: string | null;
  heats: number;
}

/** Rounds holding fewer heats than the modal round of their season. */
export function findShortRounds(rounds: RoundRow[]): Finding[] {
  const bySeason = new Map<number, RoundRow[]>();
  for (const r of rounds) {
    if (!bySeason.has(r.season)) bySeason.set(r.season, []);
    bySeason.get(r.season)!.push(r);
  }
  const out: Finding[] = [];
  for (const [season, rs] of bySeason) {
    const counts = new Map<number, number>();
    for (const r of rs) counts.set(r.heats, (counts.get(r.heats) ?? 0) + 1);
    let modal = 0;
    let best = -1;
    for (const [heats, n] of counts) {
      if (n > best || (n === best && heats > modal)) {
        best = n;
        modal = heats;
      }
    }
    for (const r of rs) {
      if (r.heats < modal) {
        out.push({
          kind: "SHORT",
          season,
          round: r.round,
          detail: `${r.heats} heats vs ${modal} usual for ${season} (${r.date ?? "?"})`,
        });
      }
    }
  }
  return out.sort((a, b) => a.season - b.season || (a.round ?? 0) - (b.round ?? 0));
}

async function main(): Promise<void> {
  const db = openDb();

  const seasons = db
    .query<SeasonCoverage, []>(
      `SELECT e.season                                  AS season,
              COUNT(DISTINCT e.id)                      AS rounds,
              COUNT(DISTINCT h.id)                      AS heats,
              COUNT(r.id)                               AS results,
              COUNT(DISTINCT r.rider_id)                AS riders,
              GROUP_CONCAT(DISTINCT e.source)           AS sources,
              MIN(e.date)                               AS first_date,
              MAX(e.date)                               AS last_date,
              0                                         AS phased_rounds
         FROM events e
         JOIN heats  h ON h.event_id = e.id
         JOIN results r ON r.heat_id = h.id
        GROUP BY e.season
        ORDER BY e.season`,
    )
    .all();

  const phased = new Map<number, number>();
  for (const row of db
    .query<{ season: number; n: number }, []>(
      `SELECT e.season AS season, COUNT(DISTINCT e.id) AS n
         FROM events e JOIN heats h ON h.event_id = e.id
        WHERE h.phase = 'final'
        GROUP BY e.season`,
    )
    .all()) {
    phased.set(row.season, row.n);
  }
  for (const s of seasons) s.phased_rounds = phased.get(s.season) ?? 0;

  const rounds = db
    .query<RoundRow, []>(
      `SELECT e.season AS season, e.round AS round, e.date AS date, COUNT(h.id) AS heats
         FROM events e JOIN heats h ON h.event_id = e.id
        GROUP BY e.id ORDER BY e.season, e.round`,
    )
    .all();

  const findings: Finding[] = [];

  // --- gap seasons ----------------------------------------------------------
  const covered = seasons.map((s) => s.season);
  const gaps = findGapSeasons(covered);
  for (const g of gaps) {
    findings.push({
      kind: "GAP",
      season: g,
      round: null,
      detail:
        KNOWN_GAP_REASONS[g] ??
        "no heat-by-heat data for this season — every career running through it is truncated",
    });
  }

  // --- short rounds ---------------------------------------------------------
  findings.push(...findShortRounds(rounds));

  // --- date/season disagreement (should be empty; corrections.ts fixes these)
  for (const r of db
    .query<{ season: number; round: number; date: string }, []>(
      `SELECT season, round, date FROM events
        WHERE date IS NOT NULL AND CAST(substr(date,1,4) AS INTEGER) <> season`,
    )
    .all()) {
    findings.push({
      kind: "DATE",
      season: r.season,
      round: r.round,
      detail: `event date ${r.date} does not fall in season ${r.season} — Elo would order this round by the wrong year`,
    });
  }

  // --- riders stranded by a gap season --------------------------------------
  const careerGaps: unknown[][] = [];
  if (gaps.length) {
    const lo = Math.min(...gaps);
    const hi = Math.max(...gaps);
    for (const row of db
      .query<{ rider: string; before: number; after: number; last_before: number }, [number, number, number, number]>(
        `SELECT rd.canonical_name AS rider,
                SUM(CASE WHEN e.season < ? THEN 1 ELSE 0 END) AS before,
                SUM(CASE WHEN e.season > ? THEN 1 ELSE 0 END) AS after,
                MAX(CASE WHEN e.season < ? THEN e.season END)  AS last_before
           FROM results r
           JOIN heats h  ON h.id = r.heat_id
           JOIN events e ON e.id = h.event_id
           JOIN riders rd ON rd.id = r.rider_id
          GROUP BY r.rider_id
         HAVING before > 0 AND last_before >= ?
          ORDER BY before DESC`,
      )
      .all(lo, hi, lo, lo - 3)) {
      // Riders active right up to the gap: either their career resumes after it
      // (so the gap is a hole in the middle) or it appears to end at the gap.
      careerGaps.push([
        row.rider,
        row.last_before,
        row.after > 0 ? "resumes after gap" : "record ends at gap",
        row.before,
        row.after,
      ]);
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  await Bun.write(
    resolve(OUT_DIR, "coverage_report.csv"),
    toCsv(
      ["season", "rounds", "heats", "results", "riders", "sources", "rounds_with_final", "first_date", "last_date"],
      seasons.map((s) => [
        s.season,
        s.rounds,
        s.heats,
        s.results,
        s.riders,
        s.sources,
        s.phased_rounds,
        s.first_date,
        s.last_date,
      ]),
    ),
  );
  await Bun.write(
    resolve(OUT_DIR, "coverage_findings.csv"),
    toCsv(["kind", "season", "round", "detail"], findings.map((f) => [f.kind, f.season, f.round, f.detail])),
  );
  await Bun.write(
    resolve(OUT_DIR, "career_gaps.csv"),
    toCsv(["rider", "last_season_before_gap", "effect", "heats_before", "heats_after"], careerGaps),
  );

  // --- console --------------------------------------------------------------
  console.log("audit — heat-by-heat coverage by season\n");
  console.log(
    "  season  rounds   heats  results  riders  sources          finals",
  );
  const bySeason = new Map(seasons.map((s) => [s.season, s]));
  const lo = covered.length ? Math.min(...covered) : 0;
  const hi = covered.length ? Math.max(...covered) : 0;
  for (let y = lo; y <= hi; y++) {
    const s = bySeason.get(y);
    if (!s) {
      console.log(`  ${y}       —       —        —       —  (no heat data)   —   <-- GAP`);
      continue;
    }
    console.log(
      `  ${s.season}  ${String(s.rounds).padStart(6)}  ${String(s.heats).padStart(6)}  ` +
        `${String(s.results).padStart(7)}  ${String(s.riders).padStart(6)}  ${(s.sources ?? "").padEnd(16)} ` +
        `${String(s.phased_rounds).padStart(5)}`,
    );
  }

  const counts = { GAP: 0, SHORT: 0, DATE: 0 };
  for (const f of findings) counts[f.kind]++;
  console.log(
    `\nfindings: ${counts.GAP} gap season(s), ${counts.SHORT} short round(s), ` +
      `${counts.DATE} date/season mismatch(es)`,
  );
  for (const f of findings.filter((f) => f.kind !== "SHORT")) {
    console.log(`  ${f.kind}  ${f.season}${f.round ? ` r${f.round}` : ""}: ${f.detail}`);
  }
  if (counts.SHORT) {
    console.log(
      `  ${counts.SHORT} round(s) ran short of their season's usual length (rain-shortened ` +
        `meetings look identical to missing heats here) — see out/coverage_findings.csv`,
    );
  }
  if (careerGaps.length) {
    const ends = careerGaps.filter((c) => c[2] === "record ends at gap");
    console.log(
      `\n${careerGaps.length} rider(s) were racing when the gap starts; ${ends.length} of them ` +
        `have no record after it. Their totals and last_season are understated:`,
    );
    for (const c of careerGaps.slice(0, 10)) {
      console.log(`  ${String(c[0]).padEnd(24)} last raced ${c[1]}, ${c[2]} (${c[3]} heats before)`);
    }
    if (careerGaps.length > 10) console.log(`  … and ${careerGaps.length - 10} more — see out/career_gaps.csv`);
    console.log(
      `\nFilling a gap season needs heat-by-heat data the automated sources do not publish.\n` +
        `See data/contrib/README.md — contributed CSVs are ingested by \`bun run ingest:contrib\`.`,
    );
  }
  console.log(
    "\nreports -> out/coverage_report.csv, out/coverage_findings.csv, out/career_gaps.csv",
  );

  db.close();
}

if (import.meta.main) {
  await main();
}
