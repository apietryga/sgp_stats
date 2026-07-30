/**
 * Audited corrections of defects in an upstream source.
 *
 * The project's rule is that nothing is invented and nothing is silently
 * overwritten. A correction is therefore only allowed when it is *derivable*
 * from the source itself (one field contradicts another and the tie-break is
 * unambiguous), and every application is written to the `corrections` table and
 * to out/date_corrections.csv so it can be audited alongside the raw artifact.
 *
 * ## The season/date-year rule
 *
 * `gpheats.rda` / `gpsquads.rda` carry both a `season` column and a full
 * timestamp per event. For two events the timestamp's *year* contradicts the
 * season column:
 *
 *   season 2000, "Speedway Grand Prix of Europe"  dated 2009-09-23
 *   season 2008, "Speedway Grand Prix of Germany" dated 2009-10-18
 *
 * `season` is the authoritative side of that contradiction:
 *   - both files agree on the same (season, wrong-date) pairing, so the defect
 *     is in the shared date field, not in one file's season label;
 *   - the day and month are consistent with the event's real slot — they fall
 *     after the season's previous round and before its end, which is what makes
 *     the round order derived from date-order come out correct;
 *   - only the year digit differs, the signature of a transcription slip.
 *
 * Left uncorrected the defect is not cosmetic: the Elo engine orders heats by
 * date, so a 2000 round would be rated as if it were raced in September 2009,
 * nine years after the riders in it had stopped racing.
 *
 * The fix rewrites only the year and keeps the month and day. It refuses to act
 * when the rewritten date would collide with a date already used by another
 * round of the same season (that would merge two distinct events), reporting the
 * row as an unresolved defect instead.
 */
import type { Database } from "bun:sqlite";

export const SEASON_YEAR_RULE = "season_year_mismatch";

export interface DateCorrection {
  season: number;
  name: string | null;
  original_date: string;
  corrected_date: string;
  rule: string;
}

/** An upstream defect we detected but deliberately did not change. */
export interface UnresolvedDefect {
  season: number;
  name: string | null;
  value: string;
  reason: string;
}

/** Extract the leading YYYY-MM-DD of a timestamp, or null if there isn't one. */
export function dateOnly(s: string | null | undefined): string | null {
  const m = (s ?? "").match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

export interface DatedRow {
  season: string | number;
  date: string;
  name?: string | null;
}

export interface CorrectionResult<T> {
  /** Input rows with `date` rewritten in place where the rule applied. */
  rows: T[];
  corrections: DateCorrection[];
  unresolved: UnresolvedDefect[];
}

/**
 * Apply the season/date-year rule to a set of source rows.
 *
 * Rows are matched on their *distinct* (season, date) pairs so one event is
 * reported once however many rider rows it has. Returns new row objects; the
 * input array is not mutated.
 */
export function correctSeasonYearMismatch<T extends DatedRow>(
  rows: T[],
): CorrectionResult<T> {
  // Dates already legitimately in use per season, so a rewrite cannot merge
  // two distinct rounds into one.
  const datesBySeason = new Map<number, Set<string>>();
  for (const r of rows) {
    const season = Number(r.season);
    const date = dateOnly(r.date);
    if (!Number.isFinite(season) || date === null) continue;
    if (Number(date.slice(0, 4)) !== season) continue; // defective, not a real slot
    if (!datesBySeason.has(season)) datesBySeason.set(season, new Set());
    datesBySeason.get(season)!.add(date);
  }

  const decided = new Map<string, string | null>(); // "season|date" -> corrected | null
  const corrections: DateCorrection[] = [];
  const unresolved: UnresolvedDefect[] = [];

  const out = rows.map((r) => {
    const season = Number(r.season);
    const date = dateOnly(r.date);
    if (!Number.isFinite(season) || date === null) return r;
    if (Number(date.slice(0, 4)) === season) return r;

    const key = `${season}|${date}`;
    if (!decided.has(key)) {
      const candidate = `${season}${date.slice(4)}`;
      if (datesBySeason.get(season)?.has(candidate)) {
        decided.set(key, null);
        unresolved.push({
          season,
          name: r.name ?? null,
          value: date,
          reason: `season/date-year mismatch, but ${candidate} is already another round of ${season}`,
        });
      } else {
        decided.set(key, candidate);
        corrections.push({
          season,
          name: r.name ?? null,
          original_date: date,
          corrected_date: candidate,
          rule: SEASON_YEAR_RULE,
        });
        datesBySeason.get(season)?.add(candidate);
      }
    }

    const fixed = decided.get(key);
    if (!fixed) return r;
    // Keep any time-of-day suffix the source carried.
    return { ...r, date: fixed + r.date.slice(10) };
  });

  return { rows: out, corrections, unresolved };
}

/** Persist applied corrections so the DB carries its own audit trail. */
export function recordCorrections(
  db: Database,
  source: string,
  corrections: DateCorrection[],
): void {
  const now = new Date().toISOString();
  db.query("DELETE FROM corrections WHERE source = ? AND rule = ?").run(
    source,
    SEASON_YEAR_RULE,
  );
  const insert = db.query(
    `INSERT INTO corrections (source, season, subject, field, original_value, corrected_value, rule, applied_at)
     VALUES (?, ?, ?, 'date', ?, ?, ?, ?)`,
  );
  for (const c of corrections) {
    insert.run(
      source,
      c.season,
      c.name,
      c.original_date,
      c.corrected_date,
      c.rule,
      now,
    );
  }
}
