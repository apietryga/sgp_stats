/**
 * `bun run all` — the full pipeline, in order:
 *   ingest:sport -> scrape:wiki -> scrape:official -> build:aliases
 *     -> reconcile -> verify -> export -> build:elo
 * then a coverage/credibility table.
 *
 * Network steps (wiki, official) are best-effort: if they produce nothing the
 * pipeline still completes on the data already in the DB. Steps that would
 * corrupt results if skipped (ingest, export, elo) are critical.
 */
import { openDb } from "./db.ts";

interface Step {
  label: string;
  script: string; // a package.json script name
  critical: boolean;
  // skip (treat as ok) when this predicate is true — used so a failed best-effort
  // re-run doesn't abort when usable data is already present.
  skipFailIf?: () => boolean;
}

function sportAlreadyIngested(): boolean {
  try {
    const db = openDb();
    const n = db.query<{ n: number }, []>(
      "SELECT COUNT(*) n FROM events WHERE source='sport'",
    ).get()!.n;
    db.close();
    return n > 0;
  } catch {
    return false;
  }
}

async function run(step: Step): Promise<boolean> {
  console.log(`\n=== ${step.label} (bun run ${step.script}) ===`);
  const proc = Bun.spawn(["bun", "run", step.script], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code === 0) return true;
  if (!step.critical) {
    console.warn(`  (${step.script} exited ${code}; non-critical, continuing)`);
    return true;
  }
  if (step.skipFailIf?.()) {
    console.warn(`  (${step.script} exited ${code}, but required data already present; continuing)`);
    return true;
  }
  console.error(`  ${step.script} failed (exit ${code}) and is critical. Stopping.`);
  return false;
}

function coverageTable(): void {
  const db = openDb();
  console.log("\n========== COVERAGE / CREDIBILITY ==========");
  const trust = db
    .query<{ trust_status: string; n: number }, []>(
      "SELECT trust_status, COUNT(*) n FROM heats GROUP BY trust_status ORDER BY n DESC",
    )
    .all();
  const total = trust.reduce((s, t) => s + t.n, 0);
  console.log(`heats: ${total}`);
  for (const t of trust) {
    const pct = total ? ((100 * t.n) / total).toFixed(1) : "0";
    console.log(`  ${t.trust_status.padEnd(14)} ${String(t.n).padStart(6)}  ${pct}%`);
  }
  const era = db
    .query<{ season: number; total: number; official: number }, []>(
      `SELECT e.season,
              COUNT(*) total,
              SUM(CASE WHEN e.source='fimspeedway' THEN 1 ELSE 0 END) official
         FROM heats h JOIN events e ON e.id=h.event_id
        WHERE e.season BETWEEN 2020 AND 2026
        GROUP BY e.season ORDER BY e.season`,
    )
    .all();
  console.log("official coverage 2020-2026:");
  if (era.length === 0) console.log("  (no 2020-2026 heats in DB yet)");
  for (const r of era) {
    const pct = r.total ? ((100 * (r.official ?? 0)) / r.total).toFixed(0) : "0";
    console.log(`  ${r.season}: ${r.official ?? 0}/${r.total} official (${pct}%)`);
  }
  db.close();
}

async function main(): Promise<void> {
  const steps: Step[] = [
    { label: "1. Ingest sport 1995-2019", script: "ingest:sport", critical: true, skipFailIf: sportAlreadyIngested },
    { label: "2. Wikipedia cross-check totals", script: "scrape:wiki", critical: false },
    { label: "3. Official heats (fimspeedway)", script: "scrape:official", critical: false },
    { label: "4. Contributed heats (data/contrib)", script: "ingest:contrib", critical: false },
    { label: "5. Build alias candidates", script: "build:aliases", critical: false },
    { label: "6. Reconcile sources", script: "reconcile", critical: true },
    { label: "7. Verify / credibility report", script: "verify", critical: true },
    { label: "8. Audit coverage by season", script: "audit", critical: true },
    { label: "9. Export reconciled heats", script: "export", critical: true },
    { label: "10. Build Elo ranking", script: "build:elo", critical: true },
    { label: "11. Export verification package", script: "export:stats", critical: true },
    { label: "12. Build static site (docs/)", script: "build:site", critical: true },
  ];
  for (const s of steps) {
    const ok = await run(s);
    if (!ok) process.exit(1);
  }
  coverageTable();
  console.log("\nPipeline complete. Serve the view with `bun run serve`.");
}

if (import.meta.main) {
  await main();
}
