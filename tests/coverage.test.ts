import { describe, expect, test } from "bun:test";
import { findGapSeasons, findShortRounds } from "../src/audit.ts";
import { derivePhases, PHASE_MAIN, PHASE_SEMI, PHASE_FINAL } from "../src/phases.ts";
import { parseContribCsv } from "../src/ingest_contrib.ts";

describe("gap seasons", () => {
  test("finds seasons with no heats inside the covered span", () => {
    // The real shape of the problem: sport ends at 2019, fimspeedway starts 2022.
    const covered = [...Array(25).keys()].map((i) => 1995 + i).concat([2022, 2023, 2024]);
    expect(findGapSeasons(covered)).toEqual([2020, 2021]);
  });

  test("seasons outside the span are not gaps", () => {
    expect(findGapSeasons([1995, 1996, 1997])).toEqual([]);
  });

  test("an explicit span can extend past the data", () => {
    expect(findGapSeasons([2018, 2019], [2018, 2021])).toEqual([2020, 2021]);
  });

  test("no data means no gaps to report", () => {
    expect(findGapSeasons([])).toEqual([]);
  });
});

describe("short rounds", () => {
  test("flags a round with fewer heats than its season's usual round", () => {
    const rounds = [
      { season: 2015, round: 1, date: "2015-04-18", heats: 12 }, // rain-shortened
      { season: 2015, round: 2, date: "2015-05-16", heats: 23 },
      { season: 2015, round: 3, date: "2015-06-06", heats: 23 },
      { season: 2015, round: 4, date: "2015-06-20", heats: 23 },
    ];
    const found = findShortRounds(rounds);
    expect(found).toHaveLength(1);
    expect(found[0]!).toMatchObject({ kind: "SHORT", season: 2015, round: 1 });
    expect(found[0]!.detail).toContain("12 heats vs 23");
  });

  test("a round longer than usual (run-offs) is not flagged", () => {
    const rounds = [
      { season: 2014, round: 1, date: "2014-04-26", heats: 23 },
      { season: 2014, round: 2, date: "2014-05-17", heats: 23 },
      { season: 2014, round: 3, date: "2014-10-11", heats: 24 },
    ];
    expect(findShortRounds(rounds)).toEqual([]);
  });
});

describe("phase derivation", () => {
  const riders = (...n: string[]) => n;
  /** A 23-heat round whose final takes two riders from each semi. */
  function goodRound(): Map<number, string[]> {
    const m = new Map<number, string[]>();
    for (let h = 1; h <= 20; h++) m.set(h, riders("a", "b", "c", "d"));
    m.set(21, riders("A", "B", "C", "D"));
    m.set(22, riders("E", "F", "G", "H"));
    m.set(23, riders("A", "B", "E", "F"));
    return m;
  }

  test("labels semis and final when the structure verifies", () => {
    const p = derivePhases(goodRound())!;
    expect(p).not.toBeNull();
    expect(p.get(1)).toBe(PHASE_MAIN);
    expect(p.get(20)).toBe(PHASE_MAIN);
    expect(p.get(21)).toBe(PHASE_SEMI);
    expect(p.get(22)).toBe(PHASE_SEMI);
    expect(p.get(23)).toBe(PHASE_FINAL);
  });

  test("refuses when the final is not 2+2 from the semis", () => {
    const m = goodRound();
    m.set(23, riders("A", "B", "C", "E")); // 3 from semi 1
    expect(derivePhases(m)).toBeNull();
  });

  test("refuses on the 24-heat format, where 21-24 are not semis+final", () => {
    const m = goodRound();
    m.set(24, riders("w", "x", "y", "z"));
    expect(derivePhases(m)).toBeNull();
  });

  test("refuses a round shortened before the final", () => {
    const m = goodRound();
    m.delete(23);
    expect(derivePhases(m)).toBeNull();
  });
});

describe("contributed CSV validation", () => {
  const header = "season,round,date,heat,phase,gate,rider,points,position,rank";
  const heat = (season = 2021, h = 1) =>
    [
      `${season},1,${season}-05-14,${h},main,1,Rider One,3,1,1`,
      `${season},1,${season}-05-14,${h},main,2,Rider Two,2,2,2`,
      `${season},1,${season}-05-14,${h},main,3,Rider Three,1,3,3`,
      `${season},1,${season}-05-14,${h},main,4,Rider Four,0,4,4`,
    ].join("\n");

  test("accepts a well-formed heat", () => {
    const { rows, errors } = parseContribCsv(`${header}\n${heat()}\n`);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ season: 2021, round: 1, heat: 1, rank: 1, phase: "main" });
  });

  test("rejects a date whose year is not the season", () => {
    const bad = `${header}\n2021,1,2020-05-14,1,main,1,Rider One,3,1,1\n`;
    const { errors } = parseContribCsv(bad);
    expect(errors.join(" ")).toContain("does not fall in season 2021");
  });

  test("rejects a missing required column", () => {
    const { errors } = parseContribCsv("season,round,date,heat,rider\n2021,1,2021-05-14,1,X\n");
    expect(errors.join(" ")).toContain("missing required column 'rank'");
  });

  test("rejects the same rider twice in one heat", () => {
    const dup =
      `${header}\n` +
      `2021,1,2021-05-14,1,main,1,Rider One,3,1,1\n` +
      `2021,1,2021-05-14,1,main,2,Rider One,2,2,2\n`;
    expect(parseContribCsv(dup).errors.join(" ")).toContain("same rider twice");
  });

  test("rejects a heat with no winner", () => {
    const noWin =
      `${header}\n` +
      `2021,1,2021-05-14,1,main,1,Rider One,2,2,2\n` +
      `2021,1,2021-05-14,1,main,2,Rider Two,1,3,3\n`;
    expect(parseContribCsv(noWin).errors.join(" ")).toContain("no rank-1 rider");
  });

  test("rejects a round spread over two dates", () => {
    const twoDates =
      `${header}\n${heat()}\n` +
      `2021,1,2021-05-15,2,main,1,Rider One,3,1,1\n` +
      `2021,1,2021-05-15,2,main,2,Rider Two,2,2,2\n`;
    expect(parseContribCsv(twoDates).errors.join(" ")).toContain("has two dates");
  });

  test("reports every problem at once rather than stopping at the first", () => {
    const messy =
      `${header}\n` +
      `2021,1,2021-05-14,1,main,9,Rider One,3,1,1\n` + // bad gate
      `2021,0,2021-05-14,1,main,2,Rider Two,2,2,2\n` + // bad round
      `2021,1,not-a-date,1,main,3,Rider Three,1,3,3\n`; // bad date
    expect(parseContribCsv(messy).errors.length).toBeGreaterThanOrEqual(3);
  });

  test("defaults phase to main and keeps a declared final", () => {
    const withFinal =
      `${header}\n` +
      `2021,1,2021-05-14,23,final,1,Rider One,3,1,1\n` +
      `2021,1,2021-05-14,23,final,2,Rider Two,2,2,2\n`;
    const { rows, errors } = parseContribCsv(withFinal);
    expect(errors).toEqual([]);
    expect(rows[0]!.phase).toBe("final");
  });
});
