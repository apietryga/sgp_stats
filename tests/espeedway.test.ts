import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  parseHeader,
  parseHeats,
  parseClassification,
  parseDriverCell,
  verifyAgainstClassification,
  abbrevKey,
  canonicalKey,
  roundToRows,
  NameResolver,
  venueFromTitle,
  roundNoFromTitle,
} from "../src/scrapers/espeedway.ts";

const FIX = resolve(import.meta.dir, "fixtures");
// Real espeedway.pl live-relay page: 1st round of the 2020 SGP, Wrocław.
const html = readFileSync(resolve(FIX, "espeedway_round.html"), "utf8");

describe("espeedway header parsing", () => {
  test("title, venue, round number and date", () => {
    const h = parseHeader(html);
    expect(h.title).toBe("1. runda Grand Prix - Wrocław");
    expect(h.date).toBe("2020-08-28");
    expect(h.completedHeats).toBe(23);
    expect(venueFromTitle(h.title)).toBe("Wrocław");
    expect(roundNoFromTitle(h.title)).toBe(1);
  });
});

describe("espeedway heat parsing", () => {
  const heats = parseHeats(html);

  test("all 23 heats parsed in order", () => {
    expect(heats.length).toBe(23);
    expect(heats.map((h) => h.heat_no)).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
  });

  test("a normal heat lists four riders in finishing order with 3/2/1/0", () => {
    const h1 = heats[0]!;
    expect(h1.entries.map((e) => e.abbrev)).toEqual([
      "A. Laguta", "T. Woffinden", "A. Lindbaeck", "N. K. Iversen",
    ]);
    expect(h1.entries.map((e) => e.points)).toEqual([3, 2, 1, 0]);
    expect(h1.entries.every((e) => e.code === null && e.excludedOriginal === null)).toBe(true);
  });

  test("an exclusion marker on the scoring slot is captured as a code, not a name", () => {
    const h18 = heats[17]!; // F. Lindgren (W), 0 pts, last
    const last = h18.entries[3]!;
    expect(last.abbrev).toBe("F. Lindgren");
    expect(last.code).toBe("x"); // W -> excluded
    expect(last.points).toBe(0);
  });

  test("a substitution keeps the substitute as scorer and records the replaced rider", () => {
    const h4 = heats[3]!; // "G. Chugunov (T) | zm. P. Liszka", 0 pts
    const slot = h4.entries[3]!;
    expect(slot.abbrev).toBe("P. Liszka"); // the substitute took the slot
    expect(slot.excludedOriginal).toEqual({ abbrev: "G. Chugunov", code: "t" });
  });
});

describe("parseDriverCell", () => {
  test("plain name", () => {
    expect(parseDriverCell(" A. Laguta")).toEqual({ abbrev: "A. Laguta", code: null, excludedOriginal: null });
  });
  test("name with exclusion code", () => {
    expect(parseDriverCell("F. Lindgren (W)")).toEqual({ abbrev: "F. Lindgren", code: "x", excludedOriginal: null });
  });
  test("substitution", () => {
    expect(parseDriverCell("G. Chugunov  (T) | zm.  P. Liszka")).toEqual({
      abbrev: "P. Liszka",
      code: null,
      excludedOriginal: { abbrev: "G. Chugunov", code: "t" },
    });
  });
});

describe("classification cross-check", () => {
  test("every rider's heat points sum to the printed classification total", () => {
    const heats = parseHeats(html);
    const classification = parseClassification(html);
    expect(classification.length).toBe(18); // 16 + 2 track reserves
    expect(verifyAgainstClassification(heats, classification)).toEqual([]);
  });
});

describe("name resolution", () => {
  test("initial + folded surname keys match across transliteration", () => {
    expect(abbrevKey("A. Laguta")).toBe("a|laguta");
    expect(canonicalKey("Artiom Łaguta")).toBe("a|laguta"); // ł -> l
    expect(abbrevKey("N. K. Iversen")).toBe("n|iversen"); // first initial + last token
    expect(canonicalKey("Niels Kristian Iversen")).toBe("n|iversen");
  });

  test("resolves against a roster; flags unknown and ambiguous names without guessing", () => {
    const roster = new Map<string, Set<string>>([
      ["a|laguta", new Set(["Artiom Łaguta"])],
      ["p|pawlicki", new Set(["Piotr Pawlicki", "Przemysław Pawlicki"])], // ambiguous
    ]);
    const r = new NameResolver(roster);
    expect(r.resolve("A. Laguta")).toBe("Artiom Łaguta");
    expect(r.resolve("E. Sayfutdinov")).toBe("Emil Sajfutdinow"); // via OVERRIDES
    expect(r.resolve("P. Pawlicki")).toBeNull(); // ambiguous -> not guessed
    expect(r.resolve("X. Nobody")).toBeNull(); // unknown
    const report = r.report();
    expect(report.map((x) => x.abbrev).sort()).toEqual(["P. Pawlicki", "X. Nobody"]);
  });
});

describe("contrib row assembly", () => {
  test("phase from heat number and rank from finishing order", () => {
    const heats = parseHeats(html);
    // A roster covering the full field so every name resolves.
    const roster = new Map<string, Set<string>>();
    const add = (k: string, full: string) => {
      if (!roster.has(k)) roster.set(k, new Set());
      roster.get(k)!.add(full);
    };
    for (const [k, full] of [
      ["a|laguta", "Artiom Łaguta"], ["t|woffinden", "Tai Woffinden"], ["a|lindback", "Antonio Lindbäck"],
      ["n|iversen", "Niels Kristian Iversen"], ["l|madsen", "Leon Madsen"], ["m|zagar", "Matej Žagar"],
      ["m|michelsen", "Mikkel Michelsen"], ["m|fricke", "Max Fricke"], ["m|janowski", "Maciej Janowski"],
      ["b|zmarzlik", "Bartosz Zmarzlik"], ["p|dudek", "Patryk Dudek"], ["j|doyle", "Jason Doyle"],
      ["m|vaculik", "Martin Vaculik"], ["f|lindgren", "Fredrik Lindgren"], ["g|chugunov", "Gleb Chugunov"],
      ["p|liszka", "Przemysław Liszka"],
    ] as const) add(k, full);
    // Sayfutdinov comes through OVERRIDES; Laguta/Lindbaeck via the roster keys above.
    const resolver = new NameResolver(roster);
    const { rows, unresolved } = roundToRows(
      { season: 2020, round: 1, date: "2020-08-28", name: "1. runda", venue: "Wrocław" },
      heats,
      resolver,
    );
    expect(unresolved).toBe(false);
    // 23 heats * 4 + one extra excluded (substitution in heat 4) = 93 rows
    expect(rows.length).toBe(93);
    // column order: season,round,date,name,venue,heat,phase,gate,rider,points,position,rank
    const finals = rows.filter((r) => r[6] === "final");
    expect(finals.length).toBe(4);
    expect(finals[0]).toEqual([2020, 1, "2020-08-28", "1. runda", "Wrocław", 23, "final", "", "Artiom Łaguta", 3, "1", 1]);
    const semis = rows.filter((r) => r[6] === "semi");
    expect(semis.length).toBe(8); // heats 21 + 22
    // the replaced rider is appended after the four finishers (rank 5, code t)
    const chug = rows.find((r) => r[5] === 4 && r[8] === "Gleb Chugunov")!;
    expect(chug[10]).toBe("t");
    expect(chug[11]).toBe(5);
  });
});
