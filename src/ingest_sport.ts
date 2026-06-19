/**
 * Module A (part 2): load the intermediate CSVs produced by ingest_sport.py
 * into the canonical SQLite DB. Covers seasons 1995-2019. Every results row's
 * source_url points at the real gpheats.rda artifact recorded in data/raw/.
 */
import { resolve, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { openDb, upsertEvent, upsertHeat, insertResult, clearEventHeats } from "./db.ts";
import { RiderResolver } from "./normalize.ts";
import { parseCsvObjects, toCsv } from "./csv.ts";
import { normalizePositionCode } from "./codes.ts";
import type { RawMeta } from "./raw.ts";

const RAW_DIR = resolve(import.meta.dir, "../data/raw");
const HEATS_DIR = resolve(import.meta.dir, "../data/heats");
const MAX_SEASON = 2019; // boundary with the fimspeedway era

interface HeatRow {
  id: string;
  season: string;
  date: string;
  round: string;
  name: string;
  heat: string;
  field: string;
  rider: string;
  points: string;
  position: string;
  rank: string;
}

function num(s: string): number | null {
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

function dateOnly(s: string): string | null {
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

/**
 * Derive a 1-based round number per event from the chronological order of
 * distinct dates within a season. The sport dataset leaves `round` blank for
 * some events (all of 2019, the last rounds of 2018), which otherwise collapse
 * every GP of a season into a single round-0 "event" with 40+ riders per heat.
 * Every season has exactly one date per round (verified), so date-order is an
 * equivalent and gap-free numbering that also matches the populated labels.
 * Returns a map keyed by `${season}_${date}` -> round.
 */
function deriveRoundsByDate(
  items: { season: string; date: string }[],
  maxSeason = Infinity,
): Map<string, number> {
  const datesBySeason = new Map<number, Set<string>>();
  for (const it of items) {
    const season = num(it.season);
    const date = dateOnly(it.date);
    if (season === null || date === null || season > maxSeason) continue;
    if (!datesBySeason.has(season)) datesBySeason.set(season, new Set());
    datesBySeason.get(season)!.add(date);
  }
  const map = new Map<string, number>();
  for (const [season, set] of datesBySeason) {
    [...set].sort().forEach((date, i) => map.set(`${season}_${date}`, i + 1));
  }
  return map;
}

/** Best-effort country from an event name like "Speedway Grand Prix of Poland". */
function countryFromName(name: string): string | null {
  const m = name.match(/Grand Prix of (?:the )?([A-Z][A-Za-z .'-]+?)\s*$/);
  if (m) return m[1]!.trim();
  return null;
}

async function loadMeta(file: string): Promise<RawMeta> {
  const p = join(RAW_DIR, file + ".meta.json");
  if (!existsSync(p)) {
    throw new Error(
      `Missing ${file}.meta.json — run the Python ingest first (bun run ingest:sport).`,
    );
  }
  return (await Bun.file(p).json()) as RawMeta;
}

async function main(): Promise<void> {
  const heatsCsv = join(RAW_DIR, "_gpheats.csv");
  if (!existsSync(heatsCsv)) {
    throw new Error("data/raw/_gpheats.csv not found — run the Python ingest first.");
  }
  mkdirSync(HEATS_DIR, { recursive: true });

  const gpheatsMeta = await loadMeta("sport_gpheats.rda");
  const gpsquadsMeta = await loadMeta("sport_gpsquads.rda");
  const sourceUrl = gpheatsMeta.url;

  const db = openDb();
  const resolver = new RiderResolver(db);

  // --- gpsquads: venue (place) per event + cross-check totals ---------------
  // gpheats `id` is a global *heat* id (4 riders share it); the event is keyed
  // by (season, round). gpsquads uses its own event-id space, so we join venue
  // on (season, round) too.
  const squads = parseCsvObjects(await Bun.file(join(RAW_DIR, "_gpsquads.csv")).text());
  const squadRoundByDate = deriveRoundsByDate(
    squads.map((s) => ({ season: s.season ?? "", date: s.date ?? "" })),
    MAX_SEASON,
  );
  const placeByEvent = new Map<string, string>();
  for (const s of squads) {
    const season = num(s.season ?? "");
    const date = dateOnly(s.date ?? "");
    if (season === null || date === null || !s.place) continue;
    const round = squadRoundByDate.get(`${season}_${date}`);
    if (round !== undefined) placeByEvent.set(`${season}_${round}`, s.place);
  }

  // --- gpheats: group rows by event (season, round), then by heat ------------
  const rows = parseCsvObjects(await Bun.file(heatsCsv).text()) as unknown as HeatRow[];
  const heatRoundByDate = deriveRoundsByDate(rows, MAX_SEASON);
  const byEvent = new Map<string, HeatRow[]>();
  for (const r of rows) {
    const season = num(r.season);
    const date = dateOnly(r.date);
    if (season === null || date === null || season > MAX_SEASON) continue;
    const round = heatRoundByDate.get(`${season}_${date}`);
    if (round === undefined) continue;
    const key = `${season}_${round}`;
    if (!byEvent.has(key)) byEvent.set(key, []);
    byEvent.get(key)!.push(r);
  }

  const insertAll = db.transaction(() => {
    let events = 0;
    let heats = 0;
    let results = 0;
    for (const [eventKey, eventRows] of byEvent) {
      const first = eventRows[0]!;
      const season = num(first.season)!;
      const round = Number(eventKey.split("_")[1]); // derived round (date-order)
      const name = first.name || null;
      const date = dateOnly(first.date);
      const venue = placeByEvent.get(eventKey) ?? null;
      const country = name ? countryFromName(name) : null;

      const evId = upsertEvent(db, {
        season,
        round,
        name,
        date,
        country,
        venue,
        source: "sport",
        source_url: sourceUrl,
        raw_file: gpheatsMeta.raw_file,
        fetched_at: gpheatsMeta.fetched_at,
      });
      clearEventHeats(db, evId); // idempotent re-run
      events++;

      // group this event's rows by heat number
      const byHeat = new Map<number, HeatRow[]>();
      for (const r of eventRows) {
        const h = num(r.heat);
        if (h === null) continue;
        if (!byHeat.has(h)) byHeat.set(h, []);
        byHeat.get(h)!.push(r);
      }
      const heatCsvRows: unknown[][] = [];
      for (const [heatNo, hr] of [...byHeat.entries()].sort((a, b) => a[0] - b[0])) {
        const heatId = upsertHeat(db, evId, heatNo, "main");
        heats++;
        for (const r of hr) {
          const riderId = resolver.resolve(r.rider);
          insertResult(db, {
            heat_id: heatId,
            rider_id: riderId,
            gate: num(r.field),
            points: num(r.points),
            position_code: normalizePositionCode(r.position),
            rank: num(r.rank),
            source_url: sourceUrl,
          });
          results++;
          heatCsvRows.push([
            heatNo,
            num(r.field),
            r.rider,
            num(r.points),
            normalizePositionCode(r.position),
            num(r.rank),
          ]);
        }
      }

      // human-eyeball CSV per event
      const fname = `${season}_r${String(round).padStart(2, "0")}_${slug(name)}.csv`;
      Bun.write(
        join(HEATS_DIR, fname),
        toCsv(["heat", "gate", "rider", "points", "position_code", "rank"], heatCsvRows),
      );
    }
    return { events, heats, results };
  });

  const { events, heats, results } = insertAll();

  // --- external totals (gpsquads) for 1995-2019 cross-check ------------------
  const totalsTx = db.transaction(() => {
    db.query("DELETE FROM external_totals WHERE source = 'gpsquads'").run();
    let n = 0;
    for (const s of squads) {
      const season = num(s.season ?? "");
      const date = dateOnly(s.date ?? "");
      const total = num(s.points ?? "");
      if (season === null || date === null || !s.rider) continue;
      if (season > MAX_SEASON) continue;
      const round = squadRoundByDate.get(`${season}_${date}`);
      if (round === undefined) continue;
      const riderId = resolver.resolve(s.rider);
      db.query(
        `INSERT OR REPLACE INTO external_totals
           (season, round, rider_id, total, source, source_url, raw_file)
         VALUES (?, ?, ?, ?, 'gpsquads', ?, ?)`,
      ).run(season, round, riderId, total, gpsquadsMeta.url, gpsquadsMeta.raw_file);
      n++;
    }
    return n;
  });
  const totals = totalsTx();

  const riders = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM riders").get()!.n;
  console.log(
    `Module A loaded: ${events} events, ${heats} heats, ${results} results, ` +
      `${riders} riders, ${totals} gpsquads totals (seasons 1995-${MAX_SEASON}).`,
  );
  db.close();
}

function slug(name: string | null): string {
  return (name ?? "event")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

await main();
