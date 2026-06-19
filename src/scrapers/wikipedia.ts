/**
 * Independent cross-check source: Wikipedia season articles.
 *
 * Wikipedia is used ONLY to corroborate round point totals (never as heat-by-heat
 * truth and never fed into Elo). Totals land in external_totals(source='wikipedia')
 * exactly like the gpsquads totals do for 1995-2019, so verify.ts can treat both
 * uniformly as a second opinion on each rider's per-round score.
 *
 * Like the official adapter, the network (WikiFetcher) is separated from the
 * parser (parseStandings, tested against a fixture). The default fetcher uses the
 * public MediaWiki API and is best-effort: any failure is logged and skipped so
 * `bun run all` still completes.
 */
import type { Database } from "bun:sqlite";
import { openDb } from "../db.ts";
import { RiderResolver } from "../normalize.ts";
import { saveRaw, politeFetch } from "../raw.ts";

export const SOURCE = "wikipedia";
export const SEASONS = [2020, 2021, 2022, 2023, 2024, 2025, 2026];

export interface RiderTotal {
  rider: string;
  round: number; // 0 = whole-season total (the granularity Wikipedia reliably gives)
  total: number;
}

/**
 * Parse a season classification wikitable into per-rider season totals.
 * Handles the common MediaWiki shape where each rider row ends with a points
 * column. We look for `| Name ... || <points>` style rows and pick the rider
 * name cell plus the final integer points cell. Round-level granularity is
 * recorded as 0 (season total).
 */
export function parseStandings(wikitext: string): RiderTotal[] {
  const out: RiderTotal[] = [];
  // Each table data row starts with "|-" then one or more "|" cells.
  const rows = wikitext.split(/\n\|-/);
  for (const row of rows) {
    const cells = row
      .split(/\n?\|\||\n\|/)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (cells.length < 2) continue;
    // rider name: first cell containing a [[wikilink]] to a person
    let rider: string | null = null;
    for (const c of cells) {
      const m = c.match(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/);
      if (m) {
        rider = (m[2] ?? m[1]!).trim();
        break;
      }
    }
    if (!rider) continue;
    // total: the last cell that is a bare integer
    let total: number | null = null;
    for (let i = cells.length - 1; i >= 0; i--) {
      const v = cells[i]!.replace(/[^\d-]/g, "");
      if (/^\d{1,3}$/.test(v)) {
        total = Number(v);
        break;
      }
    }
    if (total === null) continue;
    out.push({ rider, round: 0, total });
  }
  return out;
}

export type WikiFetcher = (
  season: number,
) => Promise<{ wikitext: string; url: string } | null>;

/** Default fetcher: MediaWiki API wikitext for "<season> Speedway Grand Prix". */
export const defaultWikiFetcher: WikiFetcher = async (season) => {
  const page = `${season}_Speedway_Grand_Prix`;
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${page}&prop=wikitext&format=json&formatversion=2`;
  try {
    const res = await politeFetch(url, 2000, { Accept: "application/json" });
    if (!res.ok) return null;
    const json: any = await res.json();
    const wikitext = json?.parse?.wikitext;
    if (typeof wikitext !== "string") return null;
    return { wikitext, url: `https://en.wikipedia.org/wiki/${page}` };
  } catch {
    return null;
  }
};

export function storeTotals(
  db: Database,
  resolver: RiderResolver,
  season: number,
  totals: RiderTotal[],
  source_url: string,
  raw_file: string,
): number {
  let n = 0;
  const tx = db.transaction(() => {
    db.query("DELETE FROM external_totals WHERE source = 'wikipedia' AND season = ?").run(season);
    for (const t of totals) {
      const riderId = resolver.resolve(t.rider);
      db.query(
        `INSERT OR REPLACE INTO external_totals
           (season, round, rider_id, total, source, source_url, raw_file)
         VALUES (?, ?, ?, ?, 'wikipedia', ?, ?)`,
      ).run(season, t.round, riderId, t.total, source_url, raw_file);
      n++;
    }
  });
  tx();
  return n;
}

async function main(fetcher: WikiFetcher = defaultWikiFetcher): Promise<void> {
  const db = openDb();
  const resolver = new RiderResolver(db);
  let seasonsDone = 0;
  let rows = 0;
  for (const season of SEASONS) {
    const got = await fetcher(season);
    if (!got) {
      console.log(`  scrape:wiki ${season}: no article/usable data, skipped.`);
      continue;
    }
    const fetched_at = new Date().toISOString();
    const meta = await saveRaw(`wikipedia_${season}.wikitext`, got.wikitext, {
      url: got.url,
      fetched_at,
      content_type: "text/x-wiki",
    });
    const totals = parseStandings(got.wikitext);
    rows += storeTotals(db, resolver, season, totals, got.url, meta.raw_file);
    seasonsDone++;
    console.log(`  scrape:wiki ${season}: ${totals.length} rider totals.`);
  }
  console.log(`scrape:wiki — ${seasonsDone} season(s), ${rows} cross-check totals.`);
  db.close();
}

if (import.meta.main) {
  await main();
}
