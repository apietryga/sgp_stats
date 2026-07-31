/**
 * Multi-rider Elo engine for Speedway Grand Prix heats.
 *
 * Each heat (2-5 riders, grouped by the global heat `id`) is scored by pairwise
 * decomposition: every pair of riders in the heat is treated as one head-to-head
 * game using the ratings held BEFORE the heat, and a rider's net change is the
 * sum of their pairwise deltas. All deltas are applied only after the whole heat
 * is computed, which makes the per-heat change zero-sum (riders neither create
 * nor destroy rating among themselves).
 *
 * Riders whose finishing code is a DNF/exclusion (a letter code: x/r/tt/t/d/m …,
 * not a numeric position) are dropped from the heat before scoring, so they
 * neither gain nor lose rating and never count as a raced heat — their opponents
 * race as if the field were that much smaller. On by default; disable with
 * `--include-dnf` for sensitivity testing.
 *
 *   E_i   = 1 / (1 + 10^((R_j - R_i) / 400))
 *   S_i   = 1 if rank_i < rank_j, 0 if worse, 0.5 if equal (tie)
 *   Δ_i   = Σ_j  K_i * (S_i - E_i)
 *
 * Input is data/gpheats_all.csv (produced by `bun run export`). The engine never
 * reads the DB so the exported file stays the single auditable source.
 */
import { resolve } from "node:path";
import { parseCsvObjects } from "./csv.ts";
import { isDnfCode } from "./codes.ts";
import { EXPORT_PATH, EXPORT_HEADER } from "./export.ts";

const OUT_DIR = resolve(import.meta.dir, "../out");
export const START_ELO = 1500;

export interface EloConfig {
  k: number; // base K-factor
  provisional: boolean; // use a higher K while a rider is new
  provisionalK: number;
  provisionalHeats: number; // number of a rider's first heats treated as provisional
  excludeDnf: boolean; // drop DNF/exclusion (letter-code) riders before scoring
}

export const DEFAULT_CONFIG: EloConfig = {
  k: 24,
  provisional: true,
  provisionalK: 40,
  provisionalHeats: 30,
  excludeDnf: true,
};

/** One rider's line in an input heat (a subset of the export schema). */
export interface HeatEntry {
  id: number; // global heat id (grouping key)
  rider: string;
  rank: number;
  season: number;
  date: string;
  trust_status?: string;
  position?: string; // finishing code (1-4 or DNF letters x/r/tt/t/d/m); drives excludeDnf
  // Optional heat-level context, carried through to the verification trace.
  round?: number;
  heat_no?: number;
  phase?: string;
  gate?: number | null;
  points?: number | null;
}

/** One rider-heat row of the computation trace (how their delta arose). */
export interface StepTrace {
  heat_id: number;
  date: string;
  season: number;
  round: number | null;
  heat_no: number | null;
  phase: string | null;
  rider: string;
  rank: number;
  elo_before: number;
  elo_after: number;
  delta: number;
  k_used: number;
  is_provisional: boolean;
}

/** One unordered-pair row of the computation trace within a heat. */
export interface PairTrace {
  heat_id: number;
  date: string;
  season: number;
  round: number | null;
  heat_no: number | null;
  phase: string | null;
  rider_a: string;
  rider_b: string;
  rank_a: number;
  rank_b: number;
  elo_a_before: number;
  elo_b_before: number;
  expected_a: number; // E_a
  score_a: number; // S_a
  k_a: number;
  k_b: number;
  delta_a_from_pair: number; // k_a * (S_a - E_a)
  delta_b_from_pair: number; // k_b * ((1-S_a) - (1-E_a))
}

export interface RiderState {
  rider: string;
  elo: number;
  peak_elo: number;
  peak_date: string;
  heats_raced: number;
  wins: number;
  first_season: number;
  last_season: number;
}

export interface HistoryPoint {
  rider: string;
  date: string;
  season: number;
  id: number;
  elo_after: number;
}

/** Expected score of A vs B under the logistic Elo curve. */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

/** Actual score of A vs B from ranks (lower rank = better). 0.5 on a tie. */
export function pairScore(rankA: number, rankB: number): number {
  if (rankA < rankB) return 1;
  if (rankA > rankB) return 0;
  return 0.5;
}

export class EloEngine {
  readonly riders = new Map<string, RiderState>();
  readonly history: HistoryPoint[] = [];
  /** Full computation trace, populated only when constructed with {trace:true}. */
  readonly steps: StepTrace[] = [];
  readonly pairs: PairTrace[] = [];
  private readonly trace: boolean;

  constructor(
    private cfg: EloConfig = DEFAULT_CONFIG,
    opts: { trace?: boolean } = {},
  ) {
    this.trace = opts.trace ?? false;
  }

  private state(rider: string, season: number): RiderState {
    let s = this.riders.get(rider);
    if (!s) {
      s = {
        rider,
        elo: START_ELO,
        peak_elo: START_ELO,
        peak_date: "",
        heats_raced: 0,
        wins: 0,
        first_season: season,
        last_season: season,
      };
      this.riders.set(rider, s);
    }
    return s;
  }

  /** K-factor for a rider given how many heats they have already raced. */
  private kFor(heatsRaced: number): number {
    if (this.cfg.provisional && heatsRaced < this.cfg.provisionalHeats) {
      return this.cfg.provisionalK;
    }
    return this.cfg.k;
  }

  /** Score one heat: compute pairwise deltas on pre-heat ratings, then apply. */
  processHeat(entries: HeatEntry[]): void {
    // Drop DNF/exclusion riders (letter finishing codes) so they neither move
    // ratings nor count as a raced heat, and their opponents race a smaller field.
    if (this.cfg.excludeDnf) {
      entries = entries.filter((e) => !isDnfCode(e.position));
    }
    if (entries.length < 2) return; // a single rider has nobody to compare against
    const head = entries[0]!;
    const heatId = head.id;

    // Snapshot pre-heat ratings and per-rider K (based on prior heats raced).
    const pre = entries.map((e) => {
      const s = this.state(e.rider, e.season);
      return { e, state: s, elo: s.elo, k: this.kFor(s.heats_raced), delta: 0 };
    });

    for (let i = 0; i < pre.length; i++) {
      for (let j = i + 1; j < pre.length; j++) {
        const a = pre[i]!;
        const b = pre[j]!;
        const eA = expectedScore(a.elo, b.elo);
        const sA = pairScore(a.e.rank, b.e.rank);
        const dA = a.k * (sA - eA);
        const dB = b.k * (1 - sA - (1 - eA));
        a.delta += dA;
        b.delta += dB;
        if (this.trace) {
          this.pairs.push({
            heat_id: heatId,
            date: head.date,
            season: head.season,
            round: head.round ?? null,
            heat_no: head.heat_no ?? null,
            phase: head.phase ?? null,
            rider_a: a.e.rider,
            rider_b: b.e.rider,
            rank_a: a.e.rank,
            rank_b: b.e.rank,
            elo_a_before: a.elo,
            elo_b_before: b.elo,
            expected_a: eA,
            score_a: sA,
            k_a: a.k,
            k_b: b.k,
            delta_a_from_pair: dA,
            delta_b_from_pair: dB,
          });
        }
      }
    }

    // Apply all deltas and record post-heat state.
    for (const p of pre) {
      const s = p.state;
      const eloBefore = s.elo;
      s.elo += p.delta;
      s.heats_raced += 1;
      if (p.e.rank === 1) s.wins += 1;
      s.first_season = Math.min(s.first_season, p.e.season);
      s.last_season = Math.max(s.last_season, p.e.season);
      if (s.elo > s.peak_elo) {
        s.peak_elo = s.elo;
        s.peak_date = p.e.date;
      }
      this.history.push({
        rider: s.rider,
        date: p.e.date,
        season: p.e.season,
        id: heatId,
        elo_after: s.elo,
      });
      if (this.trace) {
        this.steps.push({
          heat_id: heatId,
          date: p.e.date,
          season: p.e.season,
          round: p.e.round ?? null,
          heat_no: p.e.heat_no ?? null,
          phase: p.e.phase ?? null,
          rider: s.rider,
          rank: p.e.rank,
          elo_before: eloBefore,
          elo_after: s.elo,
          delta: p.delta,
          k_used: p.k,
          is_provisional: this.cfg.provisional && p.k === this.cfg.provisionalK,
        });
      }
    }
  }

  /**
   * Extension hook: feed more heats (same schema as the export rows) at any time
   * without changing the engine. Rows are grouped by heat `id` and processed in
   * chronological order (date, then id). Designed so 2020+ scraped data can be
   * appended on top of an already-built rating set.
   */
  appendHeats(rows: HeatEntry[]): void {
    const byHeat = new Map<number, HeatEntry[]>();
    for (const r of rows) {
      if (!byHeat.has(r.id)) byHeat.set(r.id, []);
      byHeat.get(r.id)!.push(r);
    }
    const heats = [...byHeat.values()].sort((a, b) => {
      const da = a[0]!.date;
      const db = b[0]!.date;
      if (da < db) return -1;
      if (da > db) return 1;
      return a[0]!.id - b[0]!.id;
    });
    for (const h of heats) this.processHeat(h);
  }

  /** Final ranking, sorted by current Elo descending. */
  ranking(): RiderState[] {
    return [...this.riders.values()].sort((a, b) => b.elo - a.elo);
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): { cfg: EloConfig; force: boolean } {
  const cfg: EloConfig = { ...DEFAULT_CONFIG };
  let force = false;
  const envK = process.env.ELO_K;
  if (envK && Number.isFinite(Number(envK))) cfg.k = Number(envK);
  for (const a of argv) {
    let m: RegExpMatchArray | null;
    if ((m = a.match(/^--k=(\d+(?:\.\d+)?)$/))) cfg.k = Number(m[1]);
    else if ((m = a.match(/^--provisional-k=(\d+(?:\.\d+)?)$/))) cfg.provisionalK = Number(m[1]);
    else if ((m = a.match(/^--provisional-heats=(\d+)$/))) cfg.provisionalHeats = Number(m[1]);
    else if (a === "--no-provisional") cfg.provisional = false;
    else if (a === "--include-dnf") cfg.excludeDnf = false;
    else if (a === "--force") force = true;
  }
  return { cfg, force };
}

function num(s: string | undefined): number | null {
  if (s === undefined || s === "") return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/** Read the export CSV into HeatEntry rows, validating the header. */
export async function loadExportRows(path = EXPORT_PATH): Promise<{
  rows: HeatEntry[];
  trustCounts: Record<string, number>;
}> {
  const text = await Bun.file(path).text();
  const objs = parseCsvObjects(text);
  if (objs.length && !("rider" in objs[0]! && "rank" in objs[0]!)) {
    throw new Error(`Unexpected export columns; expected ${EXPORT_HEADER.join(",")}`);
  }
  const rows: HeatEntry[] = [];
  const trustCounts: Record<string, number> = {};
  const seenHeatTrust = new Map<number, string>();
  for (const o of objs) {
    const id = num(o.id);
    const rank = num(o.rank);
    const season = num(o.season);
    if (id === null || rank === null || season === null || !o.rider) continue;
    const trust = o.trust_status || "UNVERIFIED";
    rows.push({
      id,
      rider: o.rider,
      rank,
      season,
      date: o.date ?? "",
      trust_status: trust,
      position: o.position || undefined,
      round: num(o.round) ?? undefined,
      heat_no: num(o.heat) ?? undefined,
      phase: o.phase || undefined,
      gate: num(o.field),
      points: num(o.points),
    });
    if (!seenHeatTrust.has(id)) {
      seenHeatTrust.set(id, trust);
      trustCounts[trust] = (trustCounts[trust] ?? 0) + 1;
    }
  }
  return { rows, trustCounts };
}

function round0(n: number): number {
  return Math.round(n);
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main(): Promise<void> {
  const { cfg, force } = parseArgs(process.argv.slice(2));
  const { rows, trustCounts } = await loadExportRows();

  // Safety: refuse to build on unresolved conflicts unless explicitly forced.
  const conflicts = trustCounts["CONFLICT"] ?? 0;
  if (conflicts > 0 && !force) {
    console.error(
      `build:elo refusing to start: ${conflicts} heat(s) have trust_status=CONFLICT.\n` +
        `Resolve them (see out/conflicts.csv) or re-run with --force to ignore.`,
    );
    process.exit(1);
  }
  const unverified = trustCounts["UNVERIFIED"] ?? 0;
  if (unverified > 0) {
    console.warn(
      `note: ${unverified} heat(s) entering Elo are UNVERIFIED (no independent confirmation).`,
    );
  }

  const engine = new EloEngine(cfg);
  engine.appendHeats(rows);

  const ranking = engine.ranking();
  const rankingLines = [
    "rider,current_elo,peak_elo,peak_date,heats_raced,wins,win_rate,first_season,last_season",
  ];
  for (const r of ranking) {
    const winRate = r.heats_raced ? r.wins / r.heats_raced : 0;
    rankingLines.push(
      [
        csvCell(r.rider),
        round0(r.elo),
        round0(r.peak_elo),
        r.peak_date,
        r.heats_raced,
        r.wins,
        winRate.toFixed(3),
        r.first_season,
        r.last_season,
      ].join(","),
    );
  }
  await Bun.write(resolve(OUT_DIR, "ranking.csv"), rankingLines.join("\n") + "\n");

  const histLines = ["rider,date,season,id,elo_after"];
  for (const h of engine.history) {
    histLines.push(
      [csvCell(h.rider), h.date, h.season, h.id, round0(h.elo_after)].join(","),
    );
  }
  await Bun.write(resolve(OUT_DIR, "elo_history.csv"), histLines.join("\n") + "\n");

  console.log(
    `build:elo done — K=${cfg.k}` +
      (cfg.provisional ? ` (provisional K=${cfg.provisionalK} for first ${cfg.provisionalHeats} heats)` : "") +
      (cfg.excludeDnf ? ", DNF riders excluded" : ", DNF riders included") +
      `, ${ranking.length} riders, ${engine.history.length} history points.`,
  );
  const top = ranking.slice(0, 5);
  for (const r of top) {
    console.log(
      `  ${round0(r.elo).toString().padStart(4)}  ${r.rider}  ` +
        `(peak ${round0(r.peak_elo)} @ ${r.peak_date}, ${r.heats_raced} heats)`,
    );
  }
}

if (import.meta.main) {
  await main();
}
