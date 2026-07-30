/**
 * ingest:contrib — load heat-by-heat data contributed as CSV.
 *
 * ## Why this exists
 *
 * The two automated sources do not cover the whole championship. `gogonzo/sport`
 * stops at 2019 and fimspeedway's API exposes heat-by-heat results only from
 * 2022, publishing nothing but each round's final classification for 2020 and
 * 2021. Those two seasons therefore contribute no heats at all, which truncates
 * every career that ran through them — most visibly Artiom Łaguta, whose 2021
 * world title is invisible to a ranking that stops his record in 2019.
 *
 * There is no way to invent that data, and the project will not guess it. What
 * it can do is accept it from someone who holds it, on the same terms as every
 * other source: the file is stored raw with a sha256 before anything is parsed,
 * every row is validated, and the resulting heats are marked `source='contrib'`
 * so they are distinguishable from scraped data for the rest of the pipeline.
 *
 * ## Using it
 *
 *   1. put one CSV per season (or per round) in data/contrib/
 *   2. add a sidecar <file>.about.json describing where the data came from
 *      (see data/contrib/README.md — `origin` and `contributor` are required)
 *   3. bun run ingest:contrib
 *   4. bun run all      # reconcile / verify / export / Elo / site
 *
 * ## Row schema (header required, column order free)
 *
 *   season,round,date,name,venue,heat,phase,gate,rider,points,position,rank
 *
 *   season   int    e.g. 2021
 *   round    int    1-based round number within the season
 *   date     date   YYYY-MM-DD, must agree with `season`
 *   name     text   event name, optional
 *   venue    text   optional
 *   heat     int    heat number within the round
 *   phase    text   main | semi | lcq | final   (default: main)
 *   gate     int    starting gate 1-4, optional
 *   rider    text   rider name; spellings are resolved via config/aliases.csv
 *   points   int    points scored in the heat, optional
 *   position text   finishing code: 1-4, or x/r/t/m for a non-finish, optional
 *   rank     int    finishing position; this is the only field Elo consumes
 *
 * Validation is strict and refuses the whole file on error, because a silently
 * mis-parsed heat would corrupt every rating computed after it.
 */
import { resolve, join, basename } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { openDb, upsertEvent, upsertHeat, insertResult, clearEventHeats } from "./db.ts";
import { RiderResolver } from "./normalize.ts";
import { parseCsvObjects, toCsv } from "./csv.ts";
import { normalizePositionCode } from "./codes.ts";
import { saveRaw } from "./raw.ts";

export const CONTRIB_DIR = resolve(import.meta.dir, "../data/contrib");
const OUT_DIR = resolve(import.meta.dir, "../out");

const REQUIRED_COLUMNS = ["season", "round", "date", "heat", "rider", "rank"] as const;
const VALID_PHASES = new Set(["main", "semi", "lcq", "final"]);

export interface ContribRow {
  season: number;
  round: number;
  date: string;
  name: string | null;
  venue: string | null;
  heat: number;
  phase: string;
  gate: number | null;
  rider: string;
  points: number | null;
  position: string | null;
  rank: number;
}

export interface ParseOutcome {
  rows: ContribRow[];
  errors: string[];
}

/** Describes where a contributed file came from. Stored with the artifact. */
export interface ContribAbout {
  origin: string; // where the data was transcribed from
  contributor: string; // who supplied it
  url?: string;
  notes?: string;
}

function int(v: string | undefined): number | null {
  const s = (v ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : null;
}

/**
 * Parse and validate one contributed CSV. Returns every problem found rather
 * than throwing on the first, so a contributor gets one complete list to fix.
 */
export function parseContribCsv(text: string, label = "file"): ParseOutcome {
  const objs = parseCsvObjects(text);
  const errors: string[] = [];
  if (objs.length === 0) return { rows: [], errors: [`${label}: no data rows`] };

  const header = Object.keys(objs[0]!);
  for (const col of REQUIRED_COLUMNS) {
    if (!header.includes(col)) errors.push(`${label}: missing required column '${col}'`);
  }
  if (errors.length) return { rows: [], errors };

  const rows: ContribRow[] = [];
  objs.forEach((o, i) => {
    const line = i + 2; // 1-based, plus the header
    const where = `${label}:${line}`;
    const season = int(o.season);
    const round = int(o.round);
    const heat = int(o.heat);
    const rank = int(o.rank);
    const rider = (o.rider ?? "").trim();
    const date = (o.date ?? "").trim();
    const phase = ((o.phase ?? "").trim() || "main").toLowerCase();

    if (season === null || season < 1995 || season > 2100) {
      errors.push(`${where}: bad season '${o.season}'`);
      return;
    }
    if (round === null || round < 1) {
      errors.push(`${where}: bad round '${o.round}'`);
      return;
    }
    if (heat === null || heat < 1) {
      errors.push(`${where}: bad heat '${o.heat}'`);
      return;
    }
    if (rank === null || rank < 1 || rank > 8) {
      errors.push(`${where}: bad rank '${o.rank}' (expected 1-8; use the DNF rank, not a code)`);
      return;
    }
    if (!rider) {
      errors.push(`${where}: empty rider`);
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      errors.push(`${where}: bad date '${o.date}' (expected YYYY-MM-DD)`);
      return;
    }
    if (Number(date.slice(0, 4)) !== season) {
      errors.push(`${where}: date '${date}' does not fall in season ${season}`);
      return;
    }
    if (!VALID_PHASES.has(phase)) {
      errors.push(`${where}: bad phase '${phase}' (expected ${[...VALID_PHASES].join("/")})`);
      return;
    }
    const gate = int(o.gate);
    if (gate !== null && (gate < 1 || gate > 4)) {
      errors.push(`${where}: bad gate '${o.gate}' (expected 1-4)`);
      return;
    }

    rows.push({
      season,
      round,
      date,
      name: (o.name ?? "").trim() || null,
      venue: (o.venue ?? "").trim() || null,
      heat,
      phase,
      gate,
      rider,
      points: int(o.points),
      position: normalizePositionCode(o.position) || null,
      rank,
    });
  });

  // --- per-heat structural checks -------------------------------------------
  const byHeat = new Map<string, ContribRow[]>();
  for (const r of rows) {
    const k = `${r.season}|${r.round}|${r.heat}|${r.phase}`;
    if (!byHeat.has(k)) byHeat.set(k, []);
    byHeat.get(k)!.push(r);
  }
  for (const [k, hr] of byHeat) {
    if (hr.length < 2) {
      errors.push(`${label}: heat ${k} has ${hr.length} rider(s); a heat needs at least 2`);
    }
    if (hr.length > 6) {
      errors.push(`${label}: heat ${k} has ${hr.length} riders, which is more than a heat can hold`);
    }
    const names = new Set(hr.map((r) => r.rider.toLowerCase()));
    if (names.size !== hr.length) {
      errors.push(`${label}: heat ${k} lists the same rider twice`);
    }
    const gates = hr.map((r) => r.gate).filter((g): g is number => g !== null);
    if (new Set(gates).size !== gates.length) {
      errors.push(`${label}: heat ${k} lists the same gate twice`);
    }
    // A heat needs a winner, and ranks must not be shared by finishers.
    const finishers = hr.filter((r) => r.rank <= hr.length).map((r) => r.rank);
    if (finishers.length && !finishers.includes(1)) {
      errors.push(`${label}: heat ${k} has no rank-1 rider`);
    }
  }

  // One date per (season, round): a round is a single meeting.
  const dateByRound = new Map<string, string>();
  for (const r of rows) {
    const k = `${r.season}|${r.round}`;
    const seen = dateByRound.get(k);
    if (seen === undefined) dateByRound.set(k, r.date);
    else if (seen !== r.date) {
      errors.push(`${label}: season ${r.season} round ${r.round} has two dates (${seen}, ${r.date})`);
      dateByRound.set(k, seen);
    }
  }

  return { rows, errors };
}

async function main(): Promise<void> {
  mkdirSync(CONTRIB_DIR, { recursive: true });
  const files = existsSync(CONTRIB_DIR)
    ? readdirSync(CONTRIB_DIR).filter((f) => f.toLowerCase().endsWith(".csv") && f !== "TEMPLATE.csv")
    : [];

  if (files.length === 0) {
    console.log(
      "ingest:contrib — no CSV files in data/contrib/.\n" +
        "  Drop heat-by-heat CSVs there to fill a gap the automated sources do not cover\n" +
        "  (2020-2021 in particular). See data/contrib/README.md for the schema.",
    );
    // Not an early return: any previously contributed event must still be
    // withdrawn below, so removing the CSVs really does remove their data.
  }

  const db = openDb();
  const resolver = new RiderResolver(db);
  let totalEvents = 0;
  let totalHeats = 0;
  let totalResults = 0;
  let rejected = 0;
  const loaded: unknown[][] = [];
  const seen = new Set<string>(); // "season|round" loaded in this run

  for (const file of files.sort()) {
    const path = join(CONTRIB_DIR, file);
    const text = readFileSync(path, "utf8");

    // Store the artifact raw + sha256 *before* parsing, exactly as the scrapers do.
    const aboutPath = path.replace(/\.csv$/i, ".about.json");
    let about: ContribAbout | null = null;
    if (existsSync(aboutPath)) {
      try {
        about = JSON.parse(readFileSync(aboutPath, "utf8")) as ContribAbout;
      } catch (e) {
        console.error(`  ${file}: ${aboutPath} is not valid JSON (${String(e)}). Skipped.`);
        rejected++;
        continue;
      }
    }
    if (!about?.origin || !about?.contributor) {
      console.error(
        `  ${file}: missing ${basename(aboutPath)} with "origin" and "contributor".\n` +
          `      Contributed data is only accepted with a recorded provenance. Skipped.`,
      );
      rejected++;
      continue;
    }

    const meta = await saveRaw(`contrib_${file}`, text, {
      url: about.url ?? `contrib:${file}`,
      fetched_at: new Date().toISOString(),
      content_type: "text/csv",
    });

    const { rows, errors } = parseContribCsv(text, file);
    if (errors.length) {
      console.error(`  ${file}: REJECTED, ${errors.length} problem(s):`);
      for (const e of errors.slice(0, 25)) console.error(`      ${e}`);
      if (errors.length > 25) console.error(`      … and ${errors.length - 25} more`);
      rejected++;
      continue;
    }

    // --- group into events -> heats -----------------------------------------
    const byEvent = new Map<string, ContribRow[]>();
    for (const r of rows) {
      const k = `${r.season}|${r.round}`;
      if (!byEvent.has(k)) byEvent.set(k, []);
      byEvent.get(k)!.push(r);
    }

    const tx = db.transaction(() => {
      for (const [, evRows] of byEvent) {
        const first = evRows[0]!;
        const evId = upsertEvent(db, {
          season: first.season,
          round: first.round,
          name: first.name,
          date: first.date,
          country: null,
          venue: first.venue,
          source: "contrib",
          source_url: about!.url ?? `contrib:${file}`,
          raw_file: meta.raw_file,
          fetched_at: meta.fetched_at,
        });
        clearEventHeats(db, evId); // idempotent re-run
        seen.add(`${first.season}|${first.round}`);
        totalEvents++;

        const byHeat = new Map<string, ContribRow[]>();
        for (const r of evRows) {
          const k = `${r.heat}|${r.phase}`;
          if (!byHeat.has(k)) byHeat.set(k, []);
          byHeat.get(k)!.push(r);
        }
        for (const [, hr] of byHeat) {
          const h = hr[0]!;
          const heatId = upsertHeat(db, evId, h.heat, h.phase);
          totalHeats++;
          for (const r of hr) {
            insertResult(db, {
              heat_id: heatId,
              rider_id: resolver.resolve(r.rider),
              gate: r.gate,
              points: r.points,
              position_code: r.position,
              rank: r.rank,
              source_url: about!.url ?? `contrib:${file}`,
            });
            totalResults++;
          }
        }
      }
    });
    tx();

    const seasons = [...new Set(rows.map((r) => r.season))].sort();
    console.log(
      `  ${file}: ${byEvent.size} round(s), ${rows.length} rider-rows, ` +
        `season(s) ${seasons.join(", ")} — from ${about.origin} (via ${about.contributor})`,
    );
    loaded.push([file, seasons.join(" "), byEvent.size, rows.length, about.origin, about.contributor, meta.sha256]);
  }

  // Drop contributed events whose CSV is no longer here, so deleting a file
  // actually withdraws its data instead of leaving orphans in the DB. Skipped
  // when a file was rejected this run — a validation failure must not be able
  // to silently delete data that loaded fine last time.
  let withdrawn = 0;
  if (rejected === 0) {
    const stale = db
      .query<{ id: number; season: number; round: number }, []>(
        "SELECT id, season, round FROM events WHERE source = 'contrib'",
      )
      .all()
      .filter((e) => !seen.has(`${e.season}|${e.round}`));
    const dropTx = db.transaction(() => {
      for (const e of stale) {
        clearEventHeats(db, e.id);
        db.query("DELETE FROM events WHERE id = ?").run(e.id);
        withdrawn++;
      }
    });
    dropTx();
    if (withdrawn) {
      console.log(`  withdrew ${withdrawn} contributed event(s) whose CSV is no longer present`);
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  await Bun.write(
    join(OUT_DIR, "contrib_sources.csv"),
    toCsv(["file", "seasons", "rounds", "rows", "origin", "contributor", "sha256"], loaded),
  );

  console.log(
    `ingest:contrib — ${totalEvents} event(s), ${totalHeats} heats, ${totalResults} results loaded ` +
      `as source='contrib' -> out/contrib_sources.csv`,
  );
  db.close();
}

if (import.meta.main) {
  await main();
}
