/**
 * build:site — assemble the static, server-free site into docs/ for GitHub Pages.
 *
 * The front-end fetches only prepared static files (no API, no DB):
 *   docs/index.html          (copied from web/index.html)
 *   docs/data/ranking.json   (career ranking rows)
 *   docs/data/history.json   ({ dates:[...], riders:{ name:[[date,elo,heats],...] } })
 *   docs/.nojekyll           (let GitHub Pages serve _-prefixed paths verbatim)
 *
 * history.json is collapsed to one point per rider per race-date (the slider's
 * granularity): the end-of-day Elo plus the rider's cumulative heat count. This
 * lets the page show the ranking "as of" any date entirely on the client.
 *
 * Run after build:elo (which writes out/ranking.csv and out/elo_history.csv).
 */
import { resolve } from "node:path";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { parseCsvObjects } from "./csv.ts";
import { openDb } from "./db.ts";
import { KNOWN_GAP_REASONS, findGapSeasons } from "./audit.ts";
import { START_ELO } from "./elo.ts";
import { isDnfCode } from "./codes.ts";

const SUBS_PATH = resolve(import.meta.dir, "../data/substitutions.csv");

const OUT_DIR = resolve(import.meta.dir, "../out");
const RAW_DIR = resolve(import.meta.dir, "../data/raw");
const WEB_HTML = resolve(import.meta.dir, "../web/index.html");
const WEB_HEATS_HTML = resolve(import.meta.dir, "../web/heats.html");
const SITE_DIR = resolve(import.meta.dir, "../docs");
const SITE_DATA = resolve(SITE_DIR, "data");
const SITE_HEATS = resolve(SITE_DATA, "heats");

interface RankRow {
  rider: string;
  current_elo: number;
  peak_elo: number;
  peak_date: string;
  heats_raced: number;
  wins: number;
  win_rate: number;
  first_season: number;
  last_season: number;
}

/** One rider's line in a heat, kept positional to keep the payload small. */
type HeatResultTuple = [
  gate: number | null,
  rider: string,
  points: number | null,
  position: string | null,
  rank: number | null,
  elo_delta: number | null, // this rider's Elo change from this heat (rounded, null if not rated)
];

/** A "reserve came in for an excluded rider" pair: [excluded, substitute]. */
type SubPair = [out: string, in_: string];

interface SiteHeat {
  no: number;
  phase: string;
  trust: string;
  rows: HeatResultTuple[];
  subs?: SubPair[]; // present only when the heat had a track-reserve substitution
}

/**
 * Curated overlay: who rode in place of an excluded rider, for heats where the
 * gate is not recorded (2020+ contrib data) so it can't be derived from a shared
 * gate. Keyed `season|round|heat_no`. See data/substitutions.csv (with sources).
 */
function loadSubstitutions(): Map<string, SubPair[]> {
  const map = new Map<string, SubPair[]>();
  if (!existsSync(SUBS_PATH)) return map;
  for (const o of parseCsvObjects(readFileSync(SUBS_PATH, "utf8"))) {
    if (!o.excluded_rider || !o.substitute_rider) continue;
    const key = `${o.season}|${o.round}|${o.heat}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push([o.excluded_rider, o.substitute_rider]);
  }
  return map;
}

/**
 * Substitution pairs for one heat: derived from a shared starting gate (an
 * excluded rider and a finisher on the same gate — the re-run replacement), plus
 * any curated pairs from the overlay. Deduped by excluded|substitute.
 */
function heatSubs(rows: HeatResultTuple[], explicit: SubPair[] | undefined): SubPair[] {
  const pairs: SubPair[] = [];
  const byGate = new Map<number, HeatResultTuple[]>();
  for (const r of rows) {
    if (r[0] == null) continue;
    if (!byGate.has(r[0])) byGate.set(r[0], []);
    byGate.get(r[0])!.push(r);
  }
  for (const g of byGate.values()) {
    if (g.length < 2) continue;
    const out = g.filter((r) => isDnfCode(r[3]));
    const rode = g.filter((r) => !isDnfCode(r[3]));
    for (const f of rode) for (const d of out) pairs.push([d[1], f[1]]);
  }
  if (explicit) pairs.push(...explicit);
  const seen = new Set<string>();
  return pairs.filter(([o, i]) => {
    const k = `${o}|${i}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

interface SiteRound {
  round: number;
  date: string | null;
  name: string | null;
  venue: string | null;
  country: string | null;
  source: string;
  heats: SiteHeat[];
  /** Round classification computed by summing this round's heat points. */
  totals: [rider: string, points: number][];
}

/**
 * Emit the heat-by-heat browser's data: one file per season plus an index that
 * states, per season, what is actually in this build — including the seasons
 * that hold nothing, and why. The gap is part of the data, not an absence the
 * reader is left to infer.
 */
async function buildHeatData(
  eloDelta: Map<string, number>,
): Promise<{ seasons: number[]; bytes: number }> {
  const db = openDb();

  const rows = db
    .query<
      {
        season: number;
        round: number;
        date: string | null;
        name: string | null;
        venue: string | null;
        country: string | null;
        source: string;
        heat_id: number;
        heat_no: number;
        phase: string;
        trust: string;
        gate: number | null;
        rider: string;
        points: number | null;
        position: string | null;
        rank: number | null;
      },
      []
    >(
      `SELECT e.season, e.round, e.date, e.name, e.venue, e.country, e.source,
              h.id AS heat_id, h.heat_no, h.phase, h.trust_status AS trust,
              r.gate, rd.canonical_name AS rider, r.points,
              r.position_code AS position, r.rank
         FROM results r
         JOIN heats  h  ON h.id = r.heat_id
         JOIN events e  ON e.id = h.event_id
         JOIN riders rd ON rd.id = r.rider_id
        ORDER BY e.season, e.round, h.heat_no, h.phase, r.rank, rd.canonical_name`,
    )
    .all();

  // season -> round -> heat
  const bySeason = new Map<number, Map<number, SiteRound>>();
  const heatIndex = new Map<string, SiteHeat>();
  const totals = new Map<string, Map<string, number>>();

  for (const r of rows) {
    if (!bySeason.has(r.season)) bySeason.set(r.season, new Map());
    const seasonRounds = bySeason.get(r.season)!;
    if (!seasonRounds.has(r.round)) {
      seasonRounds.set(r.round, {
        round: r.round,
        date: r.date,
        name: r.name,
        venue: r.venue,
        country: r.country,
        source: r.source,
        heats: [],
        totals: [],
      });
    }
    const round = seasonRounds.get(r.round)!;

    const hk = `${r.heat_id}`;
    let heat = heatIndex.get(hk);
    if (!heat) {
      heat = { no: r.heat_no, phase: r.phase, trust: r.trust, rows: [] };
      heatIndex.set(hk, heat);
      round.heats.push(heat);
    }
    heat.rows.push([
      r.gate,
      r.rider,
      r.points,
      r.position,
      r.rank,
      eloDelta.get(`${r.rider}|${r.heat_id}`) ?? null,
    ]);

    const tk = `${r.season}|${r.round}`;
    if (!totals.has(tk)) totals.set(tk, new Map());
    const t = totals.get(tk)!;
    t.set(r.rider, (t.get(r.rider) ?? 0) + (r.points ?? 0));
  }

  mkdirSync(SITE_HEATS, { recursive: true });
  let bytes = 0;
  const seasonMeta: Record<string, unknown>[] = [];
  const subsOverlay = loadSubstitutions();

  for (const [season, seasonRounds] of [...bySeason].sort((a, b) => a[0] - b[0])) {
    const roundList = [...seasonRounds.values()].sort((a, b) => a.round - b.round);
    for (const round of roundList) {
      round.heats.sort((a, b) => a.no - b.no || a.phase.localeCompare(b.phase));
      for (const h of round.heats) {
        const subs = heatSubs(h.rows, subsOverlay.get(`${season}|${round.round}|${h.no}`));
        if (subs.length) h.subs = subs;
      }
      const t = totals.get(`${season}|${round.round}`);
      round.totals = t
        ? [...t.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        : [];
    }
    const file = resolve(SITE_HEATS, `${season}.json`);
    await Bun.write(file, JSON.stringify({ season, rounds: roundList }));
    bytes += Bun.file(file).size;

    const heatCount = roundList.reduce((s, r) => s + r.heats.length, 0);
    const resultCount = roundList.reduce(
      (s, r) => s + r.heats.reduce((n, h) => n + h.rows.length, 0),
      0,
    );
    const riders = new Set<string>();
    for (const r of roundList) for (const h of r.heats) for (const row of h.rows) riders.add(row[1]);
    seasonMeta.push({
      season,
      rounds: roundList.length,
      heats: heatCount,
      results: resultCount,
      riders: riders.size,
      sources: [...new Set(roundList.map((r) => r.source))].sort(),
      finals: roundList.filter((r) => r.heats.some((h) => h.phase === "final")).length,
      first_date: roundList[0]?.date ?? null,
      last_date: roundList[roundList.length - 1]?.date ?? null,
    });
  }

  // --- gap seasons ----------------------------------------------------------
  // Anything missing inside the span the project has data for, plus the seasons
  // we already know carry no heat source (stated even when the build's own data
  // does not reach past them, so the page never quietly omits them).
  const covered = [...bySeason.keys()].sort((a, b) => a - b);
  const externalMax = db
    .query<{ s: number | null }, []>("SELECT MAX(season) AS s FROM external_totals")
    .get()?.s;
  const spanHi = Math.max(covered[covered.length - 1] ?? 0, externalMax ?? 0);
  const gapSet = new Set(
    findGapSeasons(covered, covered.length ? [covered[0]!, spanHi] : undefined),
  );
  for (const y of Object.keys(KNOWN_GAP_REASONS).map(Number)) {
    if (!covered.includes(y)) gapSet.add(y);
  }
  const gaps = [...gapSet]
    .sort((a, b) => a - b)
    .map((season) => ({
      season,
      reason:
        KNOWN_GAP_REASONS[season] ??
        "no heat-by-heat data for this season in this build",
    }));

  db.close();

  // A season vanishing entirely (heats=0 for a season that previously had
  // data) doesn't always show up as a global last_event regression — e.g. a
  // mid-career season disappearing while a newer season gains a round. Guard
  // against it the same way as assertNoRegression: don't publish over a
  // season we've already reported unless every previously-covered season is
  // still covered (or the escape hatch is set for a deliberate correction).
  if (process.env.ALLOW_DATA_REGRESSION !== "1") {
    const prevIdxPath = resolve(SITE_HEATS, "index.json");
    if (existsSync(prevIdxPath)) {
      try {
        const prevIndex = JSON.parse(readFileSync(prevIdxPath, "utf8"));
        const prevSeasons: number[] = Array.isArray(prevIndex?.seasons)
          ? prevIndex.seasons.map((s: any) => s.season)
          : [];
        const coveredSet = new Set(covered);
        const dropped = prevSeasons.filter((s) => !coveredSet.has(s));
        if (dropped.length) {
          throw new Error(
            `build:site regression guard: season(s) ${dropped.join(", ")} would drop out of ` +
              `heats/index.json entirely. A data source likely failed or returned partial ` +
              `results this run. Refusing to publish over already-correct data. ` +
              `Set ALLOW_DATA_REGRESSION=1 if this is an intentional correction.`,
          );
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("build:site regression guard")) throw e;
        // malformed previous index — nothing sound to compare against
      }
    }
  }

  const index = {
    built_at: new Date().toISOString(),
    seasons: seasonMeta,
    gaps,
  };
  const idxFile = resolve(SITE_HEATS, "index.json");
  await Bun.write(idxFile, JSON.stringify(index));
  bytes += Bun.file(idxFile).size;

  return { seasons: covered, bytes };
}

/**
 * Next scheduled SGP round after the data we already hold, read from the
 * freshly-scraped official season payload (data/raw/fimspeedway_<year>.json).
 * fimspeedway's season API lists every round including not-yet-raced ones, each
 * with a `startsAt` date, so the earliest round dated after `lastEvent` is "the
 * next round". Returns null when no raw payload is present (e.g. a local build
 * with no scrape) or the season lists nothing later — the site then just shows
 * the last-updated date and relies on the weekly cron for refresh.
 */
export function readNextEventDate(lastEvent: string | null): string | null {
  const year = lastEvent ? Number(lastEvent.slice(0, 4)) : new Date().getFullYear();
  // A round dated in the past can still show up here if our own heat ingestion
  // fell behind the published schedule (e.g. a scrape came back partial/empty
  // for the current season) — that round already happened, it just isn't in
  // our data yet. Reporting it as "next" would be actively wrong, so floor the
  // candidate at today: better to show nothing than a stale date.
  const todayISO = new Date().toISOString().slice(0, 10);
  // Check the last-event season first, then the next year (a January build may
  // already have next season's schedule but no races yet).
  for (const y of [year, year + 1]) {
    const path = resolve(RAW_DIR, `fimspeedway_${y}.json`);
    if (!existsSync(path)) continue;
    try {
      const season = JSON.parse(readFileSync(path, "utf8"));
      const rounds = Array.isArray(season?.rounds) ? season.rounds : [];
      const dates = rounds
        .map((r: any) => (typeof r?.startsAt === "string" ? r.startsAt.slice(0, 10) : null))
        .filter((d: string | null): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort();
      const next = dates.find((d: string) => (!lastEvent || d > lastEvent) && d >= todayISO);
      if (next) return next;
    } catch {
      /* malformed raw payload — fall through to null */
    }
  }
  return null;
}

/**
 * scrape:official / scrape:wiki are best-effort (pipeline.ts): a season that
 * fails or comes back partial does not stop the pipeline, it just leaves the
 * DB with less data than before (the DB itself is rebuilt from scratch every
 * run — see data/*.db in .gitignore). Left unchecked, that silently publishes
 * a regression over already-correct data (this happened 2026-08-09: the
 * 2026 season's heats went missing from a single run and got published,
 * even though fimspeedway's schedule for 2026 was still fetched fine).
 *
 * Guard against that class of bug here: compare what we're about to publish
 * against what's already published (docs/data/*.json, tracked in git) and
 * refuse to overwrite it with something that goes backwards. This makes
 * `bun run build:site` — a critical pipeline step — fail loudly instead, so
 * the CI job fails and nothing gets committed. Set ALLOW_DATA_REGRESSION=1
 * to bypass for a deliberate correction (e.g. removing a bad date).
 */
export function assertNoRegression(lastEvent: string | null, dateCount: number): void {
  if (process.env.ALLOW_DATA_REGRESSION === "1") {
    console.warn("  (ALLOW_DATA_REGRESSION=1 set — skipping regression guard)");
    return;
  }
  const prevStatusPath = resolve(SITE_DATA, "status.json");
  const prevHistoryPath = resolve(SITE_DATA, "history.json");
  if (!existsSync(prevStatusPath) || !existsSync(prevHistoryPath)) return; // first build

  let prevLastEvent: string | null = null;
  let prevDateCount = 0;
  try {
    prevLastEvent = JSON.parse(readFileSync(prevStatusPath, "utf8"))?.last_event ?? null;
    const prevHistory = JSON.parse(readFileSync(prevHistoryPath, "utf8"));
    prevDateCount = Array.isArray(prevHistory?.dates) ? prevHistory.dates.length : 0;
  } catch {
    return; // malformed previous file — nothing sound to compare against
  }

  if (prevLastEvent && (!lastEvent || lastEvent < prevLastEvent)) {
    throw new Error(
      `build:site regression guard: last_event would go backwards ` +
        `(${prevLastEvent} -> ${lastEvent ?? "null"}). A data source likely failed ` +
        `or returned partial results this run (check scrape:official / scrape:wiki ` +
        `logs above). Refusing to publish over already-correct data. ` +
        `Set ALLOW_DATA_REGRESSION=1 if this is an intentional correction.`,
    );
  }
  if (dateCount < prevDateCount) {
    throw new Error(
      `build:site regression guard: history.dates would shrink ` +
        `(${prevDateCount} -> ${dateCount} dates). A data source likely failed ` +
        `or returned partial results this run (check scrape:official / scrape:wiki ` +
        `logs above). Refusing to publish over already-correct data. ` +
        `Set ALLOW_DATA_REGRESSION=1 if this is an intentional correction.`,
    );
  }
}

async function main(): Promise<void> {
  const rankPath = resolve(OUT_DIR, "ranking.csv");
  const histPath = resolve(OUT_DIR, "elo_history.csv");
  if (!existsSync(rankPath) || !existsSync(histPath)) {
    throw new Error("Missing out/ranking.csv or out/elo_history.csv — run `bun run build:elo` first.");
  }

  // --- ranking.json ---------------------------------------------------------
  const ranking: RankRow[] = parseCsvObjects(readFileSync(rankPath, "utf8")).map((o) => ({
    rider: o.rider!,
    current_elo: Number(o.current_elo),
    peak_elo: Number(o.peak_elo),
    peak_date: o.peak_date ?? "",
    heats_raced: Number(o.heats_raced),
    wins: Number(o.wins),
    win_rate: Number(o.win_rate),
    first_season: Number(o.first_season),
    last_season: Number(o.last_season),
  }));

  // --- history.json : collapse to one end-of-day point per rider ------------
  // elo_history.csv is globally chronological, so each rider's rows are already
  // in time order. For each rider we keep the last Elo of each date plus the
  // running heat count through that date.
  const perRider = new Map<string, { date: string; elo: number }[]>();
  const allDates = new Set<string>();
  // Per-heat Elo change for each rider, keyed `${rider}|${heatId}`. elo_history is
  // globally chronological, so each rider's rows arrive in order; the delta is the
  // step from their previous end-of-heat Elo (START_ELO before their debut). Both
  // sides are the rounded values written to elo_history.csv, so deltas reconcile
  // exactly with the Elo numbers shown on the curve and ranking.
  const eloDelta = new Map<string, number>();
  const prevElo = new Map<string, number>();
  for (const o of parseCsvObjects(readFileSync(histPath, "utf8"))) {
    const rider = o.rider!;
    const date = o.date ?? "";
    if (!date) continue;
    if (!perRider.has(rider)) perRider.set(rider, []);
    const after = Number(o.elo_after);
    perRider.get(rider)!.push({ date, elo: after });
    allDates.add(date);
    const heatId = Number(o.id);
    if (Number.isFinite(heatId)) {
      const before = prevElo.get(rider) ?? START_ELO;
      eloDelta.set(`${rider}|${heatId}`, after - before);
      prevElo.set(rider, after);
    }
  }

  const riders: Record<string, [string, number, number][]> = {};
  for (const [rider, recs] of perRider) {
    const pts: [string, number, number][] = [];
    let cum = 0;
    for (let k = 0; k < recs.length; k++) {
      cum++;
      const cur = recs[k]!;
      const next = recs[k + 1];
      if (!next || next.date !== cur.date) pts.push([cur.date, cur.elo, cum]);
    }
    riders[rider] = pts;
  }
  const dates = [...allDates].sort();
  const history = { dates, riders };

  // --- status.json : when the data was last refreshed + next round ----------
  const lastEvent = dates.length ? dates[dates.length - 1]! : null;
  assertNoRegression(lastEvent, dates.length);
  const status = {
    built_at: new Date().toISOString(),
    last_event: lastEvent,
    next_event: readNextEventDate(lastEvent),
  };

  // --- write docs/ ----------------------------------------------------------
  mkdirSync(SITE_DATA, { recursive: true });
  await Bun.write(resolve(SITE_DATA, "ranking.json"), JSON.stringify(ranking));
  await Bun.write(resolve(SITE_DATA, "history.json"), JSON.stringify(history));
  await Bun.write(resolve(SITE_DATA, "status.json"), JSON.stringify(status));
  await Bun.write(resolve(SITE_DIR, "index.html"), readFileSync(WEB_HTML, "utf8"));
  await Bun.write(resolve(SITE_DIR, "heats.html"), readFileSync(WEB_HEATS_HTML, "utf8"));
  await Bun.write(resolve(SITE_DIR, ".nojekyll"), "");

  const heats = await buildHeatData(eloDelta);

  const rankBytes = Bun.file(resolve(SITE_DATA, "ranking.json")).size;
  const histBytes = Bun.file(resolve(SITE_DATA, "history.json")).size;
  console.log(
    `build:site -> docs/  (${ranking.length} riders, ${dates.length} race-dates ` +
      `${dates[0]}…${dates[dates.length - 1]})`,
  );
  console.log(
    `  data/ranking.json ${(rankBytes / 1024).toFixed(0)} KB · ` +
      `data/history.json ${(histBytes / 1024).toFixed(0)} KB`,
  );
  console.log(
    `  heats.html + data/heats/ ${(heats.bytes / 1024).toFixed(0)} KB ` +
      `(${heats.seasons.length} season files)`,
  );
  console.log(
    `  data/status.json  updated ${status.built_at.slice(0, 10)} · ` +
      `data through ${status.last_event ?? "—"} · ` +
      `next round ${status.next_event ?? "(unknown)"}`,
  );
}

if (import.meta.main) {
  await main();
}
