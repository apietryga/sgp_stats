import { test, expect, describe } from "bun:test";
import {
  EloEngine,
  expectedScore,
  pairScore,
  START_ELO,
  type EloConfig,
  type HeatEntry,
} from "../src/elo.ts";

const UNIFORM: EloConfig = { k: 24, provisional: false, provisionalK: 40, provisionalHeats: 30 };

function heat(id: number, riders: [string, number][]): HeatEntry[] {
  return riders.map(([rider, rank]) => ({
    id,
    rider,
    rank,
    season: 2000,
    date: "2000-01-01",
  }));
}

describe("pairwise primitives", () => {
  test("equal ratings give expected score 0.5", () => {
    expect(expectedScore(1500, 1500)).toBeCloseTo(0.5, 10);
  });

  test("expected scores of a pair sum to 1", () => {
    expect(expectedScore(1600, 1400) + expectedScore(1400, 1600)).toBeCloseTo(1, 10);
  });

  test("pairScore: a tie scores 0.5 for both sides", () => {
    expect(pairScore(3, 3)).toBe(0.5);
    expect(pairScore(1, 4)).toBe(1);
    expect(pairScore(4, 1)).toBe(0);
  });
});

describe("EloEngine", () => {
  test("a new rider starts at 1500", () => {
    const e = new EloEngine(UNIFORM);
    e.processHeat(heat(1, [["A", 1], ["B", 2]]));
    // both existed before the heat with START_ELO
    expect(e.history.length).toBe(2);
  });

  test("per-heat deltas are zero-sum under a uniform K", () => {
    const e = new EloEngine(UNIFORM);
    e.processHeat(heat(1, [["A", 1], ["B", 2], ["C", 3], ["D", 4]]));
    const total = [...e.riders.values()].reduce((s, r) => s + r.elo, 0);
    expect(total).toBeCloseTo(4 * START_ELO, 6); // no rating created or destroyed
  });

  test("zero-sum holds with mixed pre-heat ratings", () => {
    const e = new EloEngine(UNIFORM);
    // seed different ratings via prior heats
    e.processHeat(heat(1, [["A", 1], ["B", 4]]));
    e.processHeat(heat(2, [["C", 1], ["D", 4]]));
    const before = [...e.riders.values()].reduce((s, r) => s + r.elo, 0);
    e.processHeat(heat(3, [["A", 2], ["B", 1], ["C", 4], ["D", 3]]));
    const after = [...e.riders.values()].reduce((s, r) => s + r.elo, 0);
    expect(after).toBeCloseTo(before, 6);
  });

  test("a full tie between equal-rated riders changes nothing", () => {
    const e = new EloEngine(UNIFORM);
    // both rank 4 (e.g. both excluded) and both start at 1500 -> S=0.5, E=0.5
    e.processHeat(heat(1, [["A", 4], ["B", 4]]));
    expect(e.riders.get("A")!.elo).toBeCloseTo(START_ELO, 10);
    expect(e.riders.get("B")!.elo).toBeCloseTo(START_ELO, 10);
  });

  test("winner gains, loser loses by the same amount (equal ratings)", () => {
    const e = new EloEngine(UNIFORM);
    e.processHeat(heat(1, [["A", 1], ["B", 2]]));
    const a = e.riders.get("A")!.elo - START_ELO;
    const b = e.riders.get("B")!.elo - START_ELO;
    expect(a).toBeGreaterThan(0);
    expect(a).toBeCloseTo(-b, 10);
    expect(a).toBeCloseTo(UNIFORM.k * 0.5, 10); // K*(1 - 0.5)
  });

  test("provisional K makes early heats move ratings faster", () => {
    const prov = new EloEngine({ ...UNIFORM, provisional: true });
    const flat = new EloEngine(UNIFORM);
    prov.processHeat(heat(1, [["A", 1], ["B", 2]]));
    flat.processHeat(heat(1, [["A", 1], ["B", 2]]));
    const provGain = prov.riders.get("A")!.elo - START_ELO;
    const flatGain = flat.riders.get("A")!.elo - START_ELO;
    expect(provGain).toBeGreaterThan(flatGain);
  });

  test("wins, heats_raced and seasons are tracked", () => {
    const e = new EloEngine(UNIFORM);
    e.processHeat(heat(1, [["A", 1], ["B", 2]]));
    e.processHeat([
      { id: 2, rider: "A", rank: 2, season: 2001, date: "2001-01-01" },
      { id: 2, rider: "B", rank: 1, season: 2001, date: "2001-01-01" },
    ]);
    const a = e.riders.get("A")!;
    expect(a.heats_raced).toBe(2);
    expect(a.wins).toBe(1);
    expect(a.first_season).toBe(2000);
    expect(a.last_season).toBe(2001);
  });

  test("trace records pair deltas as k*(S-E) and steps that sum back", () => {
    const e = new EloEngine(UNIFORM, { trace: true });
    e.processHeat(heat(1, [["A", 1], ["B", 2], ["C", 3], ["D", 4]]));
    // every pair: delta_a_from_pair == k_a * (score_a - expected_a)
    for (const p of e.pairs) {
      expect(p.delta_a_from_pair).toBeCloseTo(p.k_a * (p.score_a - p.expected_a), 9);
      expect(p.delta_b_from_pair).toBeCloseTo(p.k_b * (1 - p.score_a - (1 - p.expected_a)), 9);
      expect(p.expected_a).toBeCloseTo(0.5, 9); // equal starting ratings
    }
    // per rider: sum of pair deltas == the step delta == elo_after - elo_before
    for (const s of e.steps) {
      const fromPairs = e.pairs
        .filter((p) => p.heat_id === s.heat_id)
        .reduce((acc, p) => acc + (p.rider_a === s.rider ? p.delta_a_from_pair : p.rider_b === s.rider ? p.delta_b_from_pair : 0), 0);
      expect(fromPairs).toBeCloseTo(s.delta, 9);
      expect(s.elo_before + s.delta).toBeCloseTo(s.elo_after, 9);
    }
    // zero-sum under uniform K
    const total = e.steps.reduce((acc, s) => acc + s.delta, 0);
    expect(total).toBeCloseTo(0, 6);
  });

  test("trace stays empty unless enabled", () => {
    const e = new EloEngine(UNIFORM);
    e.processHeat(heat(1, [["A", 1], ["B", 2]]));
    expect(e.steps.length).toBe(0);
    expect(e.pairs.length).toBe(0);
  });

  test("appendHeats orders by date then id regardless of input order", () => {
    const e = new EloEngine(UNIFORM);
    const rows: HeatEntry[] = [
      { id: 20, rider: "A", rank: 2, season: 2001, date: "2001-05-02" },
      { id: 20, rider: "B", rank: 1, season: 2001, date: "2001-05-02" },
      { id: 10, rider: "A", rank: 1, season: 2001, date: "2001-05-01" },
      { id: 10, rider: "B", rank: 2, season: 2001, date: "2001-05-01" },
    ];
    e.appendHeats(rows);
    const hist = e.history.filter((h) => h.rider === "A");
    expect(hist[0]!.id).toBe(10); // earlier date processed first
    expect(hist[1]!.id).toBe(20);
  });
});
