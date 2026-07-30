import { describe, expect, test } from "bun:test";
import { correctSeasonYearMismatch, SEASON_YEAR_RULE } from "../src/corrections.ts";

describe("season/date-year correction", () => {
  test("rewrites only the year when the date contradicts the season", () => {
    const rows = [
      { season: "2000", date: "2000-05-06 17:00:00", name: "GP of Czech Republic" },
      { season: "2000", date: "2009-09-23 17:00:00", name: "GP of Europe" },
    ];
    const { rows: fixed, corrections, unresolved } = correctSeasonYearMismatch(rows);

    expect(fixed[0]!.date).toBe("2000-05-06 17:00:00"); // untouched
    expect(fixed[1]!.date).toBe("2000-09-23 17:00:00"); // year only; time kept
    expect(unresolved).toEqual([]);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({
      season: 2000,
      original_date: "2009-09-23",
      corrected_date: "2000-09-23",
      rule: SEASON_YEAR_RULE,
    });
  });

  test("reports one correction per event, not per rider row", () => {
    const rows = Array.from({ length: 4 }, () => ({
      season: "2008",
      date: "2009-10-18",
      name: "GP of Germany",
    }));
    const { rows: fixed, corrections } = correctSeasonYearMismatch(rows);
    expect(corrections).toHaveLength(1);
    expect(fixed.every((r) => r.date === "2008-10-18")).toBe(true);
  });

  test("leaves rows alone when the date already matches the season", () => {
    const rows = [{ season: "2015", date: "2015-04-18", name: "Warsaw" }];
    const { rows: fixed, corrections } = correctSeasonYearMismatch(rows);
    expect(fixed[0]!.date).toBe("2015-04-18");
    expect(corrections).toEqual([]);
  });

  test("refuses to correct when it would collide with another round", () => {
    // 2001-06-02 is already a real round of 2001, so rewriting 2009-06-02
    // would merge two distinct meetings into one event.
    const rows = [
      { season: "2001", date: "2001-06-02", name: "GP of Sweden" },
      { season: "2001", date: "2009-06-02", name: "GP of Europe" },
    ];
    const { rows: fixed, corrections, unresolved } = correctSeasonYearMismatch(rows);
    expect(corrections).toEqual([]);
    expect(fixed[1]!.date).toBe("2009-06-02"); // left as-is, never silently merged
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.reason).toContain("already another round");
  });

  test("does not mutate the caller's rows", () => {
    const rows = [{ season: "2000", date: "2009-09-23", name: "GP of Europe" }];
    correctSeasonYearMismatch(rows);
    expect(rows[0]!.date).toBe("2009-09-23");
  });
});
