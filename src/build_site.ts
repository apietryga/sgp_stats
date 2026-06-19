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

const OUT_DIR = resolve(import.meta.dir, "../out");
const WEB_HTML = resolve(import.meta.dir, "../web/index.html");
const SITE_DIR = resolve(import.meta.dir, "../docs");
const SITE_DATA = resolve(SITE_DIR, "data");

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
  for (const o of parseCsvObjects(readFileSync(histPath, "utf8"))) {
    const rider = o.rider!;
    const date = o.date ?? "";
    if (!date) continue;
    if (!perRider.has(rider)) perRider.set(rider, []);
    perRider.get(rider)!.push({ date, elo: Number(o.elo_after) });
    allDates.add(date);
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

  // --- write docs/ ----------------------------------------------------------
  mkdirSync(SITE_DATA, { recursive: true });
  await Bun.write(resolve(SITE_DATA, "ranking.json"), JSON.stringify(ranking));
  await Bun.write(resolve(SITE_DATA, "history.json"), JSON.stringify(history));
  await Bun.write(resolve(SITE_DIR, "index.html"), readFileSync(WEB_HTML, "utf8"));
  await Bun.write(resolve(SITE_DIR, ".nojekyll"), "");

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
}

if (import.meta.main) {
  await main();
}
