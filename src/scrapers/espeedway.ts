/**
 * espeedway.pl adapter — heat-by-heat protocols for the 2020 and 2021 SGP seasons.
 *
 * ## Why this exists
 *
 * Those two seasons are the one hole in the heat-by-heat record: gogonzo/sport
 * stops at 2019 and fimspeedway's API publishes only each round's final
 * classification for 2020-2021 (no races array). espeedway.pl's live-relay pages
 * (`/live/race_detail.php?id=<N>`) DID cover every round of both seasons, with the
 * full 23-heat protocol — each heat's four riders and their 3/2/1/0 points, plus
 * the two semi-finals (heats 21-22) and the final (heat 23).
 *
 * This scraper does NOT write to the database. It transcribes espeedway's protocols
 * into `data/contrib/2020.csv` / `data/contrib/2021.csv` (+ `.about.json`), so the
 * data enters through the existing, strictly-validated `ingest:contrib` path and is
 * tagged `source='contrib'` like any other hand-supplied data. Run:
 *
 *   bun run scrape:espeedway     # writes data/contrib/{2020,2021}.csv
 *   bun run ingest:contrib       # validates + loads
 *   bun run all                  # reconcile / Elo / site
 *
 * ## The name problem
 *
 * espeedway prints only an initial + surname ("A. Laguta", "E. Sayfutdinov") — no
 * full first names anywhere on the page. To avoid inventing riders, abbreviated
 * names are matched against the FULL canonical names already in the dataset
 * (docs/data/heats/*.json for the surrounding seasons), keyed by first-initial +
 * diacritic-folded surname. Transliteration mismatches that this cannot bridge
 * (e.g. "Sayfutdinov" vs the dataset's "Sajfutdinow") are listed in OVERRIDES,
 * each verified by hand. Any name that still resolves to zero or more-than-one
 * canonical rider aborts the run with a report — the scraper never guesses.
 */
import { resolve as pathResolve } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { nameKey } from "../normalize.ts";
import { expectedRankFromPoints } from "../codes.ts";
import { toCsv } from "../csv.ts";
import { fetchAndCache, RAW_DIR } from "../raw.ts";

const HEATS_DIR = pathResolve(import.meta.dir, "../../docs/data/heats");
const CONTRIB_DIR = pathResolve(import.meta.dir, "../../data/contrib");
const raceUrl = (id: number) => `https://www.espeedway.pl/live/race_detail.php?id=${id}`;

/**
 * espeedway race_detail ids, one per SGP round, grouped by season and ordered by
 * date. Discovered by scanning the id space for pages whose title is an SGP round
 * completed in that year (see scripts/scrape_espeedway discovery notes). Round
 * numbers are assigned by this array's order (which is date order), matching the
 * project convention used for the official 2022+ rounds.
 */
export const ROUND_IDS: Record<number, number[]> = {
  // 8 rounds: Wrocław ×2, Gorzów ×2, Praga ×2, Toruń ×2.
  2020: [6827, 6828, 6860, 6861, 6877, 6881, 6909, 6913],
  // 11 rounds: Praga ×2, Wrocław ×2, Lublin ×2, Malilla, Togliatti, Vojens, Toruń ×2.
  2021: [7141, 7142, 7169, 7172, 7183, 7184, 7195, 7216, 7241, 7268, 7269],
};

/**
 * Abbreviated espeedway name -> canonical dataset name, for cases the automatic
 * initial+surname match cannot bridge (transliteration, or a rider absent from
 * the surrounding seasons). Keyed by nameKey() of the abbreviated string. Every
 * entry is verified by hand against the round's Wikipedia article or the rider's
 * known dataset spelling.
 */
export const OVERRIDES: Record<string, string> = {
  // Transliteration mismatches with riders already in the dataset.
  "e. sayfutdinov": "Emil Sajfutdinow", // dataset uses the Polish transliteration
  "a. lindbaeck": "Antonio Lindbäck", // espeedway spells ä as "ae"
  "g. czugunow": "Gleb Chugunov", // 2021 Polish spelling of the 2020 "G. Chugunov"
  // Track reserves / wild cards absent from the surrounding seasons. Each first
  // name verified against the round's Wikipedia article (see table in scraper notes).
  "p. liszka": "Przemysław Liszka", // Wrocław 2020 track reserve (pl.wikipedia)
  "m. curzytek": "Michał Curzytek", // Wrocław 2020 track reserve (pl.wikipedia)
  "r. karczmarz": "Rafał Karczmarz", // Gorzów 2020 reserve (en.wikipedia)
  "e. krcmar": "Eduard Krčmář", // Praga 2020 reserve (en.wikipedia)
  "w. trofimow": "Wiktor Trofimow", // Toruń 2020 wild card, Viktor Trofimov Jr. (en.wikipedia)
  "p. chlupac": "Petr Chlupáč", // Praga 2021 reserve (pl.wikipedia)
  "t. musielak": "Tobiasz Musielak", // Wrocław 2021 reserve
  "w. lampart": "Wiktor Lampart", // Lublin 2021 reserve
  "m. swidnicki": "Mateusz Świdnicki", // Lublin 2021 reserve
  "p. aspgren": "Pontus Aspgren", // Malilla 2021 wild card (en.wikipedia)
  // These three already exist in the dataset under fimspeedway's own spelling
  // (with the official rider id + 2021 classification totals); map onto those so
  // the contributed heats and the official cross-check totals share one rider.
  "a. loktajew": "Aleksandr Loktaev", // = fimspeedway rider 1158 (Togliatti 2021)
  "w. tarasienko": "Vadim Tarasenko", // = fimspeedway rider 1159 (Togliatti 2021 wild card)
  "r. gafurow": "Renat Gafurov", // = fimspeedway rider 1162 (Togliatti 2021)
  "k. zupinski": "Karol Żupiński", // Toruń 2021 reserve
  "j. lidsey": "Jaimon Lidsey", // Toruń 2021, replaced Vaculik (en.wikipedia)
};

// --- HTML helpers -----------------------------------------------------------

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&oacute;/g, "ó")
    .replace(/&aacute;/g, "á");
}

const clean = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();

// --- Header -----------------------------------------------------------------

export interface RaceHeader {
  title: string; // e.g. "1. runda Grand Prix - Wrocław"
  date: string | null; // YYYY-MM-DD
  completedHeats: number | null; // from "Po N. biegu"
}

/** Parse the round title, date and completed-heat count from the page head. */
export function parseHeader(html: string): RaceHeader {
  const nameM = html.match(/<div class="team_name[^"]*">([\s\S]*?)<\/div>/);
  const titleM = html.match(/<title>([\s\S]*?)<\/title>/);
  const title = clean(nameM?.[1] ?? titleM?.[1]?.split("|")[0] ?? "");
  const dateM = html.match(/Ostatnia aktualizacja:\s*(\d{2})\.(\d{2})\.(\d{4})/);
  const date = dateM ? `${dateM[3]}-${dateM[2]}-${dateM[1]}` : null;
  const heatsM = (html.match(/Po\s+(\d+)\.\s*biegu/i) ?? [])[1];
  return { title, date, completedHeats: heatsM ? Number(heatsM) : null };
}

/** City/venue guessed from the title (" - City" or " w City"). */
export function venueFromTitle(title: string): string | null {
  const m = title.match(/(?:-|\bw)\s+([A-Za-zÀ-ž.\s]+?)\s*$/);
  return m ? m[1]!.trim() : null;
}

/** Round number printed in the title ("3. runda ..."), or null. */
export function roundNoFromTitle(title: string): number | null {
  const m = title.match(/^(\d+)\.\s*runda/i);
  return m ? Number(m[1]) : null;
}

/** True when the title is a main SGP round (not a Challenge/qualifier). */
export function isSgpRoundTitle(title: string): boolean {
  if (!/grand\s*prix/i.test(title)) return false;
  if (/challenge|kwalifik|qualif|eliminac|junior|u21|u-21/i.test(title)) return false;
  return true;
}

// --- Classification table (start-number, name, total) -----------------------

export interface ClassRow {
  number: number;
  abbrev: string; // "A. Laguta"
  total: number | null; // null when "-" (did not ride)
}

export function parseClassification(html: string): ClassRow[] {
  const section = html.split('id="race_table"')[1]?.split('id="match_runs"')[0] ?? "";
  const rows: ClassRow[] = [];
  const trRe = /<tr>\s*<td>(\d+)<\/td>\s*<td>([^<]+)<\/td>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(section))) {
    const cells = [...m[3]!.matchAll(/<td>([^<]*)<\/td>/g)].map((c) => clean(c[1]!));
    const totalCell = cells[cells.length - 1] ?? "";
    const total = /^\d+$/.test(totalCell) ? Number(totalCell) : null;
    rows.push({ number: Number(m[1]), abbrev: clean(m[2]!), total });
  }
  return rows;
}

// --- Heats ------------------------------------------------------------------

export interface HeatEntry {
  abbrev: string; // scoring rider (the substitute, if any)
  points: number;
  code: string | null; // exclusion code on the scoring slot (t/x/...), else null
  excludedOriginal: { abbrev: string; code: string } | null; // replaced rider
}

export interface RawHeat {
  heat_no: number;
  entries: HeatEntry[]; // in finishing order (3,2,1,0 points)
}

const CODE_MAP: Record<string, string> = { W: "x", T: "t", D: "d", U: "x", R: "r", M: "m" };
const mapCode = (raw: string): string => CODE_MAP[raw.trim().toUpperCase()] ?? raw.trim().toLowerCase();

/** Parse one driver2 cell into a scoring rider, its code, and any replaced rider. */
export function parseDriverCell(cell: string): {
  abbrev: string;
  code: string | null;
  excludedOriginal: { abbrev: string; code: string } | null;
} {
  const raw = clean(cell);
  // Substitution: "Orig (T) | zm. Sub" -> the substitute took the points.
  const subM = raw.split(/\s*(?:\|\s*)?zm\.\s*/i);
  if (subM.length === 2) {
    const origPart = subM[0]!;
    const codeM = origPart.match(/\(([^)]+)\)/);
    const origAbbrev = origPart.replace(/\([^)]*\)/g, "").replace(/\|/g, "").trim();
    return {
      abbrev: clean(subM[1]!),
      code: null,
      excludedOriginal: codeM
        ? { abbrev: origAbbrev, code: mapCode(codeM[1]!) }
        : { abbrev: origAbbrev, code: "x" },
    };
  }
  const codeM = raw.match(/\(([^)]+)\)/);
  return {
    abbrev: raw.replace(/\([^)]*\)/g, "").trim(),
    code: codeM ? mapCode(codeM[1]!) : null,
    excludedOriginal: null,
  };
}

/** Parse the "Bieg po biegu" section into heats with entries in finishing order. */
export function parseHeats(html: string): RawHeat[] {
  const section = html.split('id="match_runs"')[1] ?? "";
  const heats: RawHeat[] = [];
  const blockRe = /<td class="number">(\d+)<\/td>([\s\S]*?)(?=<td class="number">|<\/div>|$)/g;
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(section))) {
    const heat_no = Number(bm[1]);
    const pairRe = /<td class="driver2">([\s\S]*?)<\/td>\s*<td class="points">([\s\S]*?)<\/td>/g;
    const entries: HeatEntry[] = [];
    let pm: RegExpExecArray | null;
    while ((pm = pairRe.exec(bm[2]!))) {
      const parsed = parseDriverCell(pm[1]!);
      const ptsRaw = clean(pm[2]!);
      const points = /^\d+$/.test(ptsRaw) ? Number(ptsRaw) : 0;
      if (!parsed.abbrev) continue;
      entries.push({ ...parsed, points });
    }
    if (entries.length) heats.push({ heat_no, entries });
  }
  return heats;
}

// --- Name resolution --------------------------------------------------------

/** first-initial + folded-surname key, e.g. "A. Laguta" -> "a|laguta". */
export function abbrevKey(abbrev: string): string {
  const parts = nameKey(abbrev).split(" ").filter(Boolean);
  const initial = parts[0]?.[0] ?? "";
  const surname = parts[parts.length - 1] ?? "";
  return `${initial}|${surname}`;
}

/** first-initial + folded-surname key for a full canonical name. */
export function canonicalKey(full: string): string {
  const parts = nameKey(full).split(" ").filter(Boolean);
  const initial = parts[0]?.[0] ?? "";
  const surname = parts[parts.length - 1] ?? "";
  return `${initial}|${surname}`;
}

/** Build initial+surname -> set of canonical full names from existing seasons. */
export function buildRoster(): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>();
  if (!existsSync(HEATS_DIR)) return idx;
  for (const f of readdirSync(HEATS_DIR)) {
    if (!/^\d{4}\.json$/.test(f)) continue;
    const j = JSON.parse(readFileSync(pathResolve(HEATS_DIR, f), "utf8"));
    for (const r of j.rounds ?? [])
      for (const h of r.heats ?? [])
        for (const row of h.rows ?? []) {
          const full = row[1] as string;
          const k = canonicalKey(full);
          if (!idx.has(k)) idx.set(k, new Set());
          idx.get(k)!.add(full);
        }
  }
  return idx;
}

export class NameResolver {
  private roster: Map<string, Set<string>>;
  private unresolved = new Map<string, string>(); // abbrev -> reason

  constructor(roster = buildRoster()) {
    this.roster = roster;
  }

  /** Resolve an abbreviated name to a canonical full name, or record why not. */
  resolve(abbrev: string): string | null {
    const ov = OVERRIDES[nameKey(abbrev)];
    if (ov) return ov;
    const cands = this.roster.get(abbrevKey(abbrev));
    if (cands && cands.size === 1) return [...cands][0]!;
    if (!cands || cands.size === 0) {
      this.unresolved.set(abbrev, "no canonical rider with that initial+surname");
    } else {
      this.unresolved.set(abbrev, `ambiguous: ${[...cands].join(" / ")}`);
    }
    return null;
  }

  report(): { abbrev: string; reason: string }[] {
    return [...this.unresolved].map(([abbrev, reason]) => ({ abbrev, reason }));
  }
}

// --- Contrib row assembly ---------------------------------------------------

export interface RoundMeta {
  season: number;
  round: number;
  date: string;
  name: string | null;
  venue: string | null;
}

const PHASE = (no: number): string => (no >= 23 ? "final" : no >= 21 ? "semi" : "main");

/**
 * Turn one parsed round into contrib CSV rows (arrays matching the header).
 * Rank follows the finishing order printed by espeedway; position is the numeric
 * place for a finisher, or the exclusion code. A replaced rider is appended as an
 * extra excluded row after the finishers (rank 5+), the way the historical set
 * ranks non-finishers alongside four finishers.
 */
export function roundToRows(
  meta: RoundMeta,
  heats: RawHeat[],
  resolver: NameResolver,
): { rows: unknown[][]; unresolved: boolean } {
  const rows: unknown[][] = [];
  let unresolved = false;
  const push = (abbrev: string, heat: number, phase: string, points: number | null, position: string, rank: number) => {
    const rider = resolver.resolve(abbrev);
    if (!rider) {
      unresolved = true;
      return;
    }
    rows.push([meta.season, meta.round, meta.date, meta.name, meta.venue, heat, phase, "", rider, points, position, rank]);
  };

  for (const h of heats) {
    const phase = PHASE(h.heat_no);
    let rank = 0;
    for (const e of h.entries) {
      rank++;
      const position = e.code ?? String(Math.min(rank, expectedRankFromPoints(e.points)));
      push(e.abbrev, h.heat_no, phase, e.points, position, rank);
    }
    // Replaced riders: excluded, ranked after the finishers.
    let extra = h.entries.length;
    for (const e of h.entries) {
      if (!e.excludedOriginal) continue;
      extra++;
      push(e.excludedOriginal.abbrev, h.heat_no, phase, null, e.excludedOriginal.code, extra);
    }
  }
  return { rows, unresolved };
}

/**
 * Cross-check: each rider's summed heat points must equal the classification
 * total espeedway prints. A mismatch means the protocol was mis-parsed; the run
 * aborts rather than emit a corrupted round.
 */
export function verifyAgainstClassification(
  heats: RawHeat[],
  classification: ClassRow[],
): string[] {
  const scored = new Map<string, number>();
  for (const h of heats)
    for (const e of h.entries) scored.set(e.abbrev, (scored.get(e.abbrev) ?? 0) + e.points);
  const errors: string[] = [];
  for (const c of classification) {
    if (c.total === null) continue; // "-" did not ride
    const got = scored.get(c.abbrev) ?? 0;
    if (got !== c.total) errors.push(`${c.abbrev}: heats sum to ${got}, classification says ${c.total}`);
  }
  return errors;
}

// --- CLI --------------------------------------------------------------------

const HEADER = [
  "season", "round", "date", "name", "venue", "heat", "phase", "gate", "rider", "points", "position", "rank",
] as const;

async function fetchRound(id: number): Promise<string> {
  const meta = await fetchAndCache(raceUrl(id), `espeedway_${id}.html`, { minGapMs: 1500 });
  return readFileSync(pathResolve(RAW_DIR, `espeedway_${id}.html`), "utf8");
}

async function main(): Promise<void> {
  const resolver = new NameResolver();
  let anyUnresolved = false;

  for (const [seasonStr, ids] of Object.entries(ROUND_IDS)) {
    const season = Number(seasonStr);
    if (!ids.length) {
      console.log(`  ${season}: no round ids configured — skipped`);
      continue;
    }
    const allRows: unknown[][] = [];
    // Fetch + parse every round first so round numbers can be assigned by date.
    const parsed = [];
    for (const id of ids) {
      const html = await fetchRound(id);
      const header = parseHeader(html);
      if (!header.date) throw new Error(`id ${id}: no date parsed`);
      if (Number(header.date.slice(0, 4)) !== season)
        throw new Error(`id ${id}: date ${header.date} is not in season ${season}`);
      const heats = parseHeats(html);
      const classification = parseClassification(html);
      const cErr = verifyAgainstClassification(heats, classification);
      if (cErr.length)
        throw new Error(`id ${id} (${header.title}): classification mismatch:\n    ${cErr.join("\n    ")}`);
      const maxHeat = Math.max(...heats.map((h) => h.heat_no));
      if (maxHeat !== 23)
        console.log(`  ! id ${id} (${header.title}): ${heats.length} heats, max heat ${maxHeat} (expected 23)`);
      parsed.push({ id, header, heats });
    }
    parsed.sort((a, b) => a.header.date!.localeCompare(b.header.date!));

    parsed.forEach((p, i) => {
      const meta: RoundMeta = {
        season,
        round: i + 1,
        date: p.header.date!,
        name: p.header.title,
        venue: venueFromTitle(p.header.title),
      };
      const titleRound = roundNoFromTitle(p.header.title);
      if (titleRound !== null && titleRound !== meta.round)
        console.log(`  ! id ${p.id}: title says round ${titleRound}, date order gives ${meta.round}`);
      const { rows } = roundToRows(meta, p.heats, resolver);
      allRows.push(...rows);
    });

    if (resolver.report().length) {
      anyUnresolved = true;
      continue; // don't write a partial season
    }

    const csv = toCsv([...HEADER], allRows);
    await Bun.write(pathResolve(CONTRIB_DIR, `${season}.csv`), csv);
    console.log(`  ${season}: ${parsed.length} rounds, ${allRows.length} rider-rows -> data/contrib/${season}.csv`);
  }

  const report = resolver.report();
  if (report.length) {
    console.error(`\nUnresolved rider names (${report.length}) — add each to OVERRIDES with a verified full name:`);
    for (const r of report) console.error(`  "${nameKey(r.abbrev)}": "",   // ${r.abbrev} — ${r.reason}`);
    process.exit(1);
  }
  if (anyUnresolved) process.exit(1);
}

if (import.meta.main) {
  await main();
}
