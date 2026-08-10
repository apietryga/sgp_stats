/**
 * Official source adapter: fimspeedway.com (the SGP's own results service).
 *
 * IMPORTANT — what the live site actually exposes (probed 2026-06):
 *   fimspeedway.com is a Next.js *pages-router* app. Its <script id="__NEXT_DATA__">
 *   payload contains ONLY the championship + the list of seasons; it carries NO
 *   heat-by-heat data. The round results are fetched client-side from a separate
 *   GraphQL backend (https://eventrack.io/sgp/graphql) behind a bearer token that
 *   is embedded in the JS bundle. `/_next/data/{buildId}/sgp/results.json` returns 404.
 *
 * Consequences for the prompt's fetch ladder:
 *   1) __NEXT_DATA__  -> yields seasons (see extractSeasons), but NOT heats.
 *   2) RSC __next_f   -> N/A (this is pages-router, not app-router).
 *   3) _next/data     -> 404.
 *   4) a real backend -> required to obtain heats. Two options, both pluggable
 *      via the RoundFetcher interface below:
 *        - Playwright DOM render of the public round page (sanctioned fallback);
 *        - the eventrack GraphQL API (needs an explicitly-authorized token).
 *
 * This module therefore separates the *network* (RoundFetcher, swap in later)
 * from the *parsing/mapping* (parseNextData / extractSeasons / extractRound),
 * which are fully implemented and unit-tested against a saved fixture. Until a
 * fetcher backend is wired in, scrape:official records that no heats are
 * available and exits cleanly so the rest of the pipeline still runs.
 */
import type { Database } from "bun:sqlite";
import { openDb, upsertEvent, upsertHeat, clearEventHeats } from "../db.ts";
import { RiderResolver } from "../normalize.ts";
import { saveRaw, politeFetch } from "../raw.ts";

export const SOURCE = "fimspeedway";
export const SEASONS = [2020, 2021, 2022, 2023, 2024, 2025, 2026];

/** fimspeedway's own season ids (from /sgp/results __NEXT_DATA__) for 2020-2026. */
export const SEASON_IDS: Record<number, number> = {
  2020: 33, 2021: 32, 2022: 7, 2023: 8, 2024: 25, 2025: 63, 2026: 67,
};
const CHAMPIONSHIP_ID = 3; // SGP
const apiUrl = (seasonId: number) =>
  `https://fimspeedway.com/api/results?seasonId=${seasonId}&championshipId=${CHAMPIONSHIP_ID}`;

// --- Normalized shape that reconcile.ts consumes (backend-independent) -------

export interface OfficialResult {
  gate: number | null; // 1-4 (A-D mapped)
  rider: string;
  official_rider_id: string | null;
  points: number | null;
  rank: number | null;
}

export interface OfficialHeat {
  heat_no: number;
  phase: string; // 'main' | 'semi' | 'lcq' | 'final'
  results: OfficialResult[];
}

export interface OfficialRound {
  season: number;
  round: number;
  name: string | null;
  date: string | null; // YYYY-MM-DD
  country: string | null;
  venue: string | null;
  source_url: string;
  heats: OfficialHeat[];
}

export interface SeasonRef {
  id: number;
  title: string;
  slug: string;
}

// --- Parsing (pure, unit-tested) --------------------------------------------

/** Extract and parse the <script id="__NEXT_DATA__"> JSON blob from page HTML. */
export function parseNextData(html: string): any {
  const m = html.match(
    /<script id="__NEXT_DATA__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!m) throw new Error("no __NEXT_DATA__ script found");
  return JSON.parse(m[1]!);
}

/** Season list from a results/calendar __NEXT_DATA__ payload. */
export function extractSeasons(nextData: any): SeasonRef[] {
  const seasons = nextData?.props?.pageProps?.seasons;
  if (!Array.isArray(seasons)) return [];
  return seasons
    .map((s) => ({ id: Number(s.id), title: String(s.title), slug: String(s.slug) }))
    .filter((s) => Number.isFinite(s.id));
}

const GATE_LETTERS: Record<string, number> = { A: 1, B: 2, C: 3, D: 4 };

/** Map a gate value (letter A-D, or a 1-4 number/string) to a 1-4 number. */
export function gateToNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return raw >= 1 && raw <= 4 ? raw : null;
  const s = String(raw).trim().toUpperCase();
  if (s in GATE_LETTERS) return GATE_LETTERS[s]!;
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : null;
}

/** Pull the numeric rider id out of a "/riders/{id}" style link or id field. */
export function officialRiderId(rider: any): string | null {
  if (rider == null) return null;
  if (typeof rider.id === "number" || typeof rider.id === "string") return String(rider.id);
  const href = rider.href ?? rider.url ?? rider.link;
  if (typeof href === "string") {
    const m = href.match(/\/riders?\/([A-Za-z0-9_-]+)/);
    if (m) return m[1]!;
  }
  return null;
}

function normPhase(raw: unknown): string {
  const s = String(raw ?? "main").toLowerCase();
  if (/final/.test(s)) return "final";
  if (/semi/.test(s)) return "semi";
  if (/lcq|last\s*chance/.test(s)) return "lcq";
  return "main";
}

function dateOnly(s: unknown): string | null {
  const m = String(s ?? "").match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map a round payload (from any backend) to the normalized OfficialRound.
 * Accepts either a __NEXT_DATA__ pageProps object holding an `event`, or a raw
 * event/result object (e.g. a GraphQL `data.event`). Heat and rider field names
 * are matched defensively so the same mapper works across the site's shapes.
 */
export function extractRound(
  payload: any,
  ctx: { season: number; round: number; source_url: string },
): OfficialRound | null {
  const event =
    payload?.props?.pageProps?.event ??
    payload?.pageProps?.event ??
    payload?.data?.event ??
    payload?.event ??
    payload;
  if (!event) return null;

  const rawHeats: any[] = event.heats ?? event.races ?? event.runs ?? [];
  const heats: OfficialHeat[] = [];
  for (const h of rawHeats) {
    const heat_no = num(h.heat_no ?? h.number ?? h.no ?? h.heat);
    if (heat_no === null) continue;
    const phase = normPhase(h.phase ?? h.type ?? h.stage);
    const rawResults: any[] = h.results ?? h.riders ?? h.scores ?? [];
    const results: OfficialResult[] = [];
    for (const r of rawResults) {
      const riderObj = r.rider ?? r;
      const name =
        r.rider_name ?? riderObj?.name ?? riderObj?.full_name ?? riderObj?.fullName ?? r.name;
      if (!name) continue;
      results.push({
        gate: gateToNumber(r.gate ?? r.helmet ?? r.start ?? r.position_start),
        rider: String(name).trim(),
        official_rider_id: officialRiderId(riderObj),
        points: num(r.points ?? r.score ?? r.pts),
        rank: num(r.rank ?? r.place ?? r.position ?? r.finish),
      });
    }
    if (results.length) heats.push({ heat_no, phase, results });
  }
  if (!heats.length) return null;

  return {
    season: ctx.season,
    round: ctx.round,
    name: event.name ?? event.title ?? null,
    date: dateOnly(event.date ?? event.starts_at ?? event.start_date),
    country: event.country ?? event.country_name ?? null,
    venue: event.venue ?? event.stadium ?? event.place ?? null,
    source_url: ctx.source_url,
    heats,
  };
}

// --- Concrete mapper for fimspeedway's own /api/results round shape ---------
// A round there carries `races[]`; each scoring race has tags (heat/sf/final),
// a startsAt, and results[0].rankings[] of { rank, points, colorId(=gate),
// entry.object{ id, firstName, lastName, country } }. Practice/qualif races and
// the full-field "qualif" classification (18 riders, 0 points) are skipped.

/** Race phase from its tag slugs, or null for non-scoring races (skip). */
export function phaseFromTags(tags: any[]): string | null {
  const s = (tags ?? []).map((t) => String(t?.slug ?? "").toLowerCase());
  if (s.some((x) => x.includes("practice"))) return null;
  if (s.some((x) => x.includes("final"))) return "final";
  if (s.some((x) => x === "sf" || x.includes("semi"))) return "semi";
  if (s.some((x) => x === "lcq" || x.includes("last"))) return "lcq";
  if (s.includes("heat")) return "main";
  return null; // qualif / standings / other -> not a scoring heat
}

/** Heat number within its phase from tag slugs (heatN / sfN / finalN) or title. */
export function heatNoFromTags(tags: any[], title: unknown): number | null {
  for (const x of (tags ?? []).map((t) => String(t?.slug ?? ""))) {
    const m = x.match(/^(?:heat|sf|final|lcq)(\d+)$/i);
    if (m) return Number(m[1]);
  }
  const mt = String(title ?? "").match(/(\d+)/);
  return mt ? Number(mt[1]) : 1;
}

/** Map a fimspeedway /api/results (or round-page) round object to OfficialRound. */
export function extractRoundFromApi(
  round: any,
  ctx: { season: number; round: number; source_url: string },
): OfficialRound | null {
  const races = [...(round?.races ?? [])].sort((a, b) =>
    String(a?.startsAt ?? "").localeCompare(String(b?.startsAt ?? "")),
  );
  const heats: OfficialHeat[] = [];
  for (const race of races) {
    const phase = phaseFromTags(race?.tags);
    if (!phase) continue;
    const rankings = race?.results?.[0]?.rankings;
    if (!Array.isArray(rankings) || rankings.length < 2) continue;
    // skip a full-field classification masquerading as a race (e.g. 18 entries)
    if (rankings.length > 6) continue;
    const heat_no = heatNoFromTags(race?.tags, race?.title);
    if (heat_no === null) continue;
    const results: OfficialResult[] = [];
    for (const rk of rankings) {
      const obj = rk?.entry?.object;
      const name = obj ? `${obj.firstName ?? ""} ${obj.lastName ?? ""}`.trim() : "";
      const rank = num(rk?.rank);
      if (!name || rank === null) continue;
      results.push({
        gate: gateToNumber(rk?.colorId),
        rider: name,
        official_rider_id: obj?.id != null ? String(obj.id) : null,
        points: num(rk?.points),
        rank,
      });
    }
    if (results.length >= 2) heats.push({ heat_no, phase, results });
  }
  if (!heats.length) return null;
  return {
    season: ctx.season,
    round: ctx.round,
    name: round?.title ?? null,
    date: dateOnly(round?.startsAt),
    country: round?.venue?.country?.name ?? null,
    venue: round?.venue?.title ?? round?.venue?.city ?? null,
    source_url: ctx.source_url,
    heats,
  };
}

export interface RoundStanding {
  rider: string;
  official_rider_id: string | null;
  total: number;
}

/**
 * Round-level final classification (rider -> GP points) from results[0].rankings.
 * This is the ONLY official data available for 2020-2021 (those seasons carry no
 * heat-by-heat races), and a useful per-round cross-check for 2022+. Stored as
 * external_totals (never fed to Elo).
 */
export function extractRoundStandings(round: any): RoundStanding[] {
  const rankings = round?.results?.[0]?.rankings;
  if (!Array.isArray(rankings)) return [];
  const out: RoundStanding[] = [];
  for (const rk of rankings) {
    const obj = rk?.entry?.object;
    const name = obj ? `${obj.firstName ?? ""} ${obj.lastName ?? ""}`.trim() : "";
    const total = num(rk?.points);
    if (!name || total === null) continue;
    out.push({ rider: name, official_rider_id: obj?.id != null ? String(obj.id) : null, total });
  }
  return out;
}

// --- Network (pluggable; deferred until a backend is authorized) ------------

export class OfficialDataUnavailable extends Error {
  constructor(detail: string) {
    super(
      `fimspeedway heats unavailable: ${detail}\n` +
        `The live site keeps heat data in a GraphQL backend, not in __NEXT_DATA__.\n` +
        `Wire a RoundFetcher backend (Playwright DOM render, or an authorized API token) ` +
        `into scrape:official to enable official ingestion.`,
    );
    this.name = "OfficialDataUnavailable";
  }
}

/** A backend that returns the raw payload for one round, plus its source URL. */
export type RoundFetcher = (
  season: number,
  round: number,
) => Promise<{ payload: unknown; url: string } | null>;

// --- DB ingestion of official rounds (into the 'fimspeedway' source slot) ----

/**
 * Store one official round under source='fimspeedway' (a staging slot parallel
 * to the 'sport' events). reconcile.ts later compares it against the base data.
 * Provenance and rider_sources are recorded for every value asserted here.
 */
export function ingestOfficialRound(
  db: Database,
  resolver: RiderResolver,
  round: OfficialRound,
  raw_file: string,
  fetched_at: string,
): { heats: number; results: number } {
  const evId = upsertEvent(db, {
    season: round.season,
    round: round.round,
    name: round.name,
    date: round.date,
    country: round.country,
    venue: round.venue,
    source: SOURCE,
    source_url: round.source_url,
    raw_file,
    fetched_at,
  });
  clearEventHeats(db, evId);
  let heats = 0;
  let results = 0;
  for (const h of round.heats) {
    const heatId = upsertHeat(db, evId, h.heat_no, h.phase);
    heats++;
    for (const r of h.results) {
      // official_rider_id is the strong identity key; it also auto-merges
      // spelling variants and records rider_sources (see normalize.ts).
      const riderId = resolver.resolveByOfficialId(r.official_rider_id, r.rider, SOURCE);
      const info = db
        .query(
          `INSERT INTO results (heat_id, rider_id, gate, points, position_code, rank, source_url)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(heatId, riderId, r.gate, r.points, r.rank === null ? null : String(r.rank), r.rank, round.source_url);
      const resultId = Number(info.lastInsertRowid);
      for (const [field, value] of [
        ["rider", r.rider],
        ["gate", r.gate],
        ["rank", r.rank],
        ["points", r.points],
      ] as const) {
        db.query(
          `INSERT OR REPLACE INTO provenance (result_id, field, value, source, source_url, set_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(resultId, field, value === null ? null : String(value), SOURCE, round.source_url, fetched_at);
      }
      results++;
    }
  }
  return { heats, results };
}

// --- CLI --------------------------------------------------------------------

/** Fetch one season's full results payload from fimspeedway's own public API,
 * retrying a few times (the endpoint is large and occasionally slow). */
async function fetchSeason(seasonId: number, attempts = 4): Promise<any | null> {
  const url = apiUrl(seasonId);
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await politeFetch(url, 2500, { Accept: "application/json" });
      if (res.ok) {
        const json: any = await res.json();
        if (json && Array.isArray(json.rounds)) return json;
      }
    } catch {
      /* retry */
    }
    await Bun.sleep(2000 * i);
  }
  return null;
}

export interface ScrapeStats {
  seasons: number;
  rounds: number;
  heats: number;
  results: number;
  totals: number; // round-classification rows stored as external_totals
  failed: string[];
}

/** Store one round's official classification as external_totals (cross-check). */
function storeOfficialTotals(
  db: Database,
  resolver: RiderResolver,
  season: number,
  round: number,
  standings: RoundStanding[],
  source_url: string,
  raw_file: string,
): number {
  let n = 0;
  for (const s of standings) {
    const riderId = resolver.resolveByOfficialId(s.official_rider_id, s.rider, SOURCE);
    db.query(
      `INSERT OR REPLACE INTO external_totals
         (season, round, rider_id, total, source, source_url, raw_file)
       VALUES (?, ?, ?, ?, 'fimspeedway', ?, ?)`,
    ).run(season, round, riderId, s.total, source_url, raw_file);
    n++;
  }
  return n;
}

/**
 * scrape:official — for each season 2020-2026, GET fimspeedway's own
 * /api/results (no third-party token), save the raw payload (+ .meta sha256)
 * BEFORE parsing, then map every scored round (main heats + semis + final) and
 * ingest under source='fimspeedway'. Best-effort + retried per season; a season
 * that keeps failing is reported but does not abort the others.
 */
export async function scrapeOfficial(dbPath?: string): Promise<ScrapeStats> {
  const db = openDb(dbPath);
  const resolver = new RiderResolver(db);
  const stats: ScrapeStats = { seasons: 0, rounds: 0, heats: 0, results: 0, totals: 0, failed: [] };
  db.query("DELETE FROM external_totals WHERE source = 'fimspeedway'").run();

  for (const [yearStr, seasonId] of Object.entries(SEASON_IDS)) {
    const year = Number(yearStr);
    const season = await fetchSeason(seasonId);
    if (!season) {
      stats.failed.push(String(year));
      console.log(`  ${year}: fetch failed after retries`);
      continue;
    }
    const fetched_at = new Date().toISOString();
    // Save the raw season artifact once (the real fetched bytes) before parsing.
    const meta = await saveRaw(`fimspeedway_${year}.json`, JSON.stringify(season), {
      url: apiUrl(seasonId),
      fetched_at,
      content_type: "application/json",
    });
    const rounds = [...season.rounds].sort((a: any, b: any) =>
      String(a?.startsAt ?? "").localeCompare(String(b?.startsAt ?? "")),
    );
    let roundNo = 0;
    let scoredRounds = 0;
    let standingsRounds = 0;
    for (const r of rounds) {
      const source_url = `https://fimspeedway.com/results/${r?.slug ?? ""}`;
      const parsed = extractRoundFromApi(r, { season: year, round: 0, source_url });
      const standings = extractRoundStandings(r);
      if (!parsed && standings.length && process.env.SGP_DEBUG_SCRAPE === "1") {
        // Temporary diagnostic for the 2026-08 regression: a round has a
        // classification but extractRoundFromApi found no heats — dump the
        // shape of an actual scoring race (not practice) plus the round-level
        // classification, to see what changed.
        const races: any[] = Array.isArray(r?.races) ? r.races : [];
        const scoring = races.find((race) => phaseFromTags(race?.tags));
        console.log(
          `  [debug] ${year} ${r?.slug}: races=${races.length} scoring=${!!scoring} ` +
            `scoringSample=${JSON.stringify(scoring ?? null).slice(0, 1500)} ` +
            `roundResultsKeys=${JSON.stringify(Object.keys(r?.results?.[0] ?? {}))} ` +
            `roundResultsSample=${JSON.stringify(r?.results?.[0] ?? null).slice(0, 800)}`,
        );
      }
      if (!parsed && !standings.length) continue; // future/empty round
      roundNo++;
      if (parsed) {
        parsed.round = roundNo;
        const { heats, results } = ingestOfficialRound(db, resolver, parsed, meta.raw_file, fetched_at);
        stats.heats += heats;
        stats.results += results;
        stats.rounds++;
        scoredRounds++;
      }
      if (standings.length) {
        stats.totals += storeOfficialTotals(db, resolver, year, roundNo, standings, source_url, meta.raw_file);
        standingsRounds++;
      }
    }
    stats.seasons++;
    console.log(
      `  ${year}: ${scoredRounds} round(s) with heats, ${standingsRounds} with official classification`,
    );
  }
  db.close();
  return stats;
}

async function main(): Promise<void> {
  const stats = await scrapeOfficial();
  console.log(
    `scrape:official — ${stats.rounds} rounds, ${stats.heats} heats, ` +
      `${stats.results} results, ${stats.totals} classification totals across ${stats.seasons} season(s).` +
      (stats.failed.length ? ` Failed: ${stats.failed.join(", ")}.` : ""),
  );
}

if (import.meta.main) {
  await main();
}
