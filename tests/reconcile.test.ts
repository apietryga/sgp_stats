import { test, expect, describe } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDb, upsertEvent, upsertHeat, insertResult } from "../src/db.ts";
import { RiderResolver } from "../src/normalize.ts";
import { reconcileDb } from "../src/reconcile.ts";

interface R { rider: string; gate: number; rank: number; points: number }

function addHeat(
  db: Database,
  resolver: RiderResolver,
  o: { season: number; round: number; heat_no: number; source: string; results: R[] },
): number {
  const evId = upsertEvent(db, {
    season: o.season,
    round: o.round,
    name: "T",
    date: `${o.season}-05-01`,
    country: null,
    venue: null,
    source: o.source,
    source_url: `https://example/${o.source}`,
    raw_file: "x",
    fetched_at: "2026-01-01T00:00:00Z",
  });
  const heatId = upsertHeat(db, evId, o.heat_no, "main");
  for (const r of o.results) {
    insertResult(db, {
      heat_id: heatId,
      rider_id: resolver.resolve(r.rider),
      gate: r.gate,
      points: r.points,
      position_code: String(r.rank),
      rank: r.rank,
      source_url: `https://example/${o.source}`,
    });
  }
  return heatId;
}

function trustOf(db: Database, heatId: number): string {
  return db.query<{ t: string }, [number]>("SELECT trust_status t FROM heats WHERE id=?").get(heatId)!.t;
}
function rankOf(db: Database, heatId: number, riderId: number): number | null {
  return db
    .query<{ rank: number | null }, [number, number]>("SELECT rank FROM results WHERE heat_id=? AND rider_id=?")
    .get(heatId, riderId)!.rank;
}

describe("reconcile golden rule", () => {
  test("agreeing official source marks the base heat VERIFIED, values unchanged", () => {
    const db = openMemoryDb();
    const rr = new RiderResolver(db);
    const base = addHeat(db, rr, {
      season: 2020, round: 1, heat_no: 1, source: "sport",
      results: [{ rider: "A", gate: 1, rank: 1, points: 3 }, { rider: "B", gate: 2, rank: 2, points: 2 }],
    });
    addHeat(db, rr, {
      season: 2020, round: 1, heat_no: 1, source: "fimspeedway",
      results: [{ rider: "A", gate: 1, rank: 1, points: 3 }, { rider: "B", gate: 2, rank: 2, points: 2 }],
    });
    const stats = reconcileDb(db);
    expect(trustOf(db, base)).toBe("VERIFIED");
    expect(stats.verified).toBe(1);
    expect(rankOf(db, base, rr.resolve("A"))).toBe(1); // untouched
    db.close();
  });

  test("a CONFLICT is recorded and the original value is NOT overwritten", () => {
    const db = openMemoryDb();
    const rr = new RiderResolver(db);
    const base = addHeat(db, rr, {
      season: 2020, round: 1, heat_no: 1, source: "sport",
      results: [{ rider: "A", gate: 1, rank: 1, points: 3 }, { rider: "B", gate: 2, rank: 2, points: 2 }],
    });
    // official disagrees: A finished 2nd, B 1st
    addHeat(db, rr, {
      season: 2020, round: 1, heat_no: 1, source: "fimspeedway",
      results: [{ rider: "A", gate: 1, rank: 2, points: 2 }, { rider: "B", gate: 2, rank: 1, points: 3 }],
    });
    const stats = reconcileDb(db); // no --prefer-official
    expect(trustOf(db, base)).toBe("CONFLICT");
    expect(stats.conflict).toBe(1);
    // original base values preserved
    expect(rankOf(db, base, rr.resolve("A"))).toBe(1);
    expect(rankOf(db, base, rr.resolve("B"))).toBe(2);
    const nConflicts = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM conflicts").get()!.n;
    expect(nConflicts).toBeGreaterThan(0);
    db.close();
  });

  test("--prefer-official overwrites but still keeps an audit (conflict) row", () => {
    const db = openMemoryDb();
    const rr = new RiderResolver(db);
    const base = addHeat(db, rr, {
      season: 2020, round: 1, heat_no: 1, source: "sport",
      results: [{ rider: "A", gate: 1, rank: 1, points: 3 }, { rider: "B", gate: 2, rank: 2, points: 2 }],
    });
    addHeat(db, rr, {
      season: 2020, round: 1, heat_no: 1, source: "fimspeedway",
      results: [{ rider: "A", gate: 1, rank: 2, points: 2 }, { rider: "B", gate: 2, rank: 1, points: 3 }],
    });
    reconcileDb(db, { preferOfficial: true });
    expect(rankOf(db, base, rr.resolve("A"))).toBe(2); // overwritten with official
    const nConflicts = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM conflicts").get()!.n;
    expect(nConflicts).toBeGreaterThan(0); // audit trail retained
    db.close();
  });

  test("filling an official-only heat raises coverage without changing existing heats", () => {
    const db = openMemoryDb();
    const rr = new RiderResolver(db);
    // an existing base heat (round 1) with no official counterpart
    const base = addHeat(db, rr, {
      season: 2020, round: 1, heat_no: 1, source: "sport",
      results: [{ rider: "A", gate: 1, rank: 1, points: 3 }, { rider: "B", gate: 2, rank: 2, points: 2 }],
    });
    // an official-only heat (round 2) that the base never had
    const official = addHeat(db, rr, {
      season: 2020, round: 2, heat_no: 1, source: "fimspeedway",
      results: [{ rider: "A", gate: 1, rank: 2, points: 2 }, { rider: "C", gate: 3, rank: 1, points: 3 }],
    });
    const stats = reconcileDb(db);
    // existing base heat untouched and still unverified (no official confirmation)
    expect(trustOf(db, base)).toBe("UNVERIFIED");
    expect(rankOf(db, base, rr.resolve("A"))).toBe(1);
    // the official-only heat counts toward official coverage
    expect(trustOf(db, official)).toBe("OFFICIAL_ONLY");
    expect(stats.official_only).toBe(1);
    db.close();
  });
});
