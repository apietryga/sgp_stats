/**
 * Derive the semi-final / final phase of a round's heats.
 *
 * The `sport` dataset has no phase column: every heat of 1995-2019 arrives
 * labelled `main`, so the historic era cannot distinguish a qualifying heat from
 * the final, while the fimspeedway era (2022+) does carry phases. That gap is
 * only cosmetic for Elo (which cares about ranks, not phases) but it makes the
 * heat-by-heat view unable to say what it is showing.
 *
 * Rather than assume "heat 23 is always the final", the phase is *verified per
 * round* against the structure the format implies, and left as `main` whenever
 * the round does not match:
 *
 *   the 23-heat format (2005 onward)
 *     heats 1-20  qualifying             -> main
 *     heats 21,22 semi-finals            -> semi
 *     heat  23    final                  -> final
 *
 *   accepted only when the round really has that shape: exactly 23 heats, all
 *   of 21/22/23 present with 4 riders each, and the final's four riders are
 *   exactly two riders from each semi-final (the two that qualified).
 *
 * On the 1995-2001 (24-heat) and 2002-2004 (25-heat) formats that check does not
 * hold — heats 21-24 there are further qualifying rides, not a semi/final pair —
 * so those rounds keep `main` throughout and the view says so.
 */

export const PHASE_MAIN = "main";
export const PHASE_SEMI = "semi";
export const PHASE_FINAL = "final";

/** Riders per heat number within a single round. */
export type RoundRiders = Map<number, string[]>;

function intersectionSize(a: string[], b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

/**
 * Return heat_no -> phase for one round, or null when the round does not match
 * a structure we can verify (in which case every heat stays `main`).
 */
export function derivePhases(round: RoundRiders): Map<number, string> | null {
  const heatNos = [...round.keys()].sort((a, b) => a - b);
  if (heatNos.length !== 23) return null;
  if (heatNos[0] !== 1 || heatNos[22] !== 23) return null;

  const semi1 = round.get(21);
  const semi2 = round.get(22);
  const final = round.get(23);
  if (!semi1 || !semi2 || !final) return null;
  if (semi1.length !== 4 || semi2.length !== 4 || final.length !== 4) return null;

  const s1 = new Set(semi1);
  const s2 = new Set(semi2);
  // The final must be exactly the two qualifiers from each semi-final.
  if (intersectionSize(final, s1) !== 2) return null;
  if (intersectionSize(final, s2) !== 2) return null;

  const phases = new Map<number, string>();
  for (const h of heatNos) phases.set(h, PHASE_MAIN);
  phases.set(21, PHASE_SEMI);
  phases.set(22, PHASE_SEMI);
  phases.set(23, PHASE_FINAL);
  return phases;
}

/** Human label for a phase + heat number, used by the reports and the site. */
export function phaseLabel(phase: string, heatNo: number): string {
  if (phase === PHASE_FINAL) return "Final";
  if (phase === PHASE_SEMI) return `Semi-final ${heatNo === 22 ? 2 : 1}`;
  if (phase === "lcq") return "Last chance";
  return `Heat ${heatNo}`;
}
