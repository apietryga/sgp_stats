/** Shared helpers for position codes and points<->rank consistency. */

/** Normalize a raw finishing code to a canonical token.
 * Numbers 1-4 stay as-is; letter codes (exclusion/fall/tape/engine/etc.) are
 * lowercased. Examples seen in the historical set: X, R, TT, x, T, M. */
export function normalizePositionCode(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (/^[1-4]$/.test(s)) return s;
  return s.toLowerCase();
}

/** True when the code denotes a placed finish (1-4), not a DNF/exclusion. */
export function isFinishCode(code: string): boolean {
  return /^[1-4]$/.test(code);
}

/** In SGP a heat awards 3/2/1/0 points for 1st/2nd/3rd/4th. This maps points
 * to the rank they should imply, for the verification consistency check.
 * 0 points (incl. exclusions) means "last", i.e. rank >= 4. */
export function expectedRankFromPoints(points: number): number {
  switch (points) {
    case 3:
      return 1;
    case 2:
      return 2;
    case 1:
      return 3;
    default:
      return 4; // 0 (or unusual values) -> last
  }
}

/** Whether a numeric rank is consistent with the points scored. Treats any
 * rank >= 4 as the "0 points / last" bucket (DNFs carry rank 5 historically). */
export function rankConsistentWithPoints(rank: number, points: number): boolean {
  const expected = expectedRankFromPoints(points);
  if (expected === 4) return rank >= 4;
  return rank === expected;
}
