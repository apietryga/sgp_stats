import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  parseNextData,
  extractSeasons,
  extractRound,
  extractRoundFromApi,
  phaseFromTags,
  gateToNumber,
  officialRiderId,
} from "../src/scrapers/fimspeedway.ts";

const FIX = resolve(import.meta.dir, "fixtures");

describe("__NEXT_DATA__ parsing (real fixture)", () => {
  test("extractSeasons reads the season list from the real results payload", () => {
    // The fixture is the actual __NEXT_DATA__ JSON captured from /sgp/results,
    // wrapped back into a <script> tag to exercise parseNextData end-to-end.
    const json = readFileSync(resolve(FIX, "fimspeedway_results_nextdata.json"), "utf8");
    const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${json}</script></body></html>`;
    const data = parseNextData(html);
    expect(data.page).toContain("results");
    const seasons = extractSeasons(data);
    expect(seasons.length).toBeGreaterThan(0);
    // every season has a numeric id and a title like a year
    for (const s of seasons) {
      expect(Number.isFinite(s.id)).toBe(true);
      expect(s.title).toMatch(/^\d{4}$/);
    }
  });
});

describe("gate + rider id helpers", () => {
  test("gate letters A-D map to 1-4; numbers pass through; junk -> null", () => {
    expect(gateToNumber("A")).toBe(1);
    expect(gateToNumber("d")).toBe(4);
    expect(gateToNumber(3)).toBe(3);
    expect(gateToNumber("2")).toBe(2);
    expect(gateToNumber("Z")).toBeNull();
    expect(gateToNumber(null)).toBeNull();
  });

  test("officialRiderId pulls the id from a /riders/{id} link or id field", () => {
    expect(officialRiderId({ id: 4321 })).toBe("4321");
    expect(officialRiderId({ href: "/riders/zmarzlik-99" })).toBe("zmarzlik-99");
    expect(officialRiderId({ name: "No Id" })).toBeNull();
  });
});

describe("extractRound mapping", () => {
  // A representative round payload in the __NEXT_DATA__ pageProps.event shape.
  // (The live site serves equivalent data from its GraphQL backend; the mapper
  // is intentionally tolerant of field-name variants.)
  const payload = {
    props: {
      pageProps: {
        event: {
          name: "FIM Speedway Grand Prix of Poland",
          date: "2024-05-04T18:00:00+02:00",
          venue: "Stadion Narodowy",
          country: "Poland",
          heats: [
            {
              heat_no: 1,
              phase: "main",
              results: [
                { gate: "A", rider: { name: "Bartosz Zmarzlik", href: "/riders/123" }, points: 3, rank: 1 },
                { gate: "B", rider: { name: "Leon Madsen", href: "/riders/456" }, points: 2, rank: 2 },
                { gate: "C", rider: { name: "Maciej Janowski", href: "/riders/789" }, points: 1, rank: 3 },
                { gate: "D", rider: { name: "Jack Holder", href: "/riders/999" }, points: 0, rank: 4 },
              ],
            },
            {
              heat_no: 2,
              phase: "final",
              riders: [{ helmet: "A", rider_name: "Bartosz Zmarzlik", score: 3, place: 1 }],
            },
          ],
        },
      },
    },
  };

  test("maps event metadata, gates, ranks and official ids", () => {
    const round = extractRound(payload, {
      season: 2024,
      round: 1,
      source_url: "https://fimspeedway.com/sgp/results/x",
    });
    expect(round).not.toBeNull();
    expect(round!.date).toBe("2024-05-04");
    expect(round!.venue).toBe("Stadion Narodowy");
    expect(round!.heats.length).toBe(2);
    const h1 = round!.heats[0]!;
    expect(h1.results.map((r) => r.gate)).toEqual([1, 2, 3, 4]);
    expect(h1.results[0]!.official_rider_id).toBe("123");
    expect(h1.results[0]!.rider).toBe("Bartosz Zmarzlik");
    // alternate field names (helmet/rider_name/score/place) still parse
    const h2 = round!.heats[1]!;
    expect(h2.phase).toBe("final");
    expect(h2.results[0]!.gate).toBe(1);
    expect(h2.results[0]!.rank).toBe(1);
  });

  test("returns null when there are no heats", () => {
    expect(extractRound({ event: { name: "x", heats: [] } }, { season: 2024, round: 1, source_url: "u" })).toBeNull();
  });
});

describe("extractRoundFromApi (real /api/results round fixture)", () => {
  test("phaseFromTags classifies scoring vs non-scoring races", () => {
    expect(phaseFromTags([{ slug: "heat" }, { slug: "heat8" }])).toBe("main");
    expect(phaseFromTags([{ slug: "sf" }, { slug: "sf1" }])).toBe("semi");
    expect(phaseFromTags([{ slug: "final" }, { slug: "final1" }])).toBe("final");
    expect(phaseFromTags([{ slug: "practice" }])).toBeNull();
    expect(phaseFromTags([{ slug: "qualif" }])).toBeNull();
  });

  test("maps main heats + semis + final, gate from colorId, skips the 18-rider standings", () => {
    const round = JSON.parse(
      readFileSync(resolve(FIX, "fimspeedway_api_round.json"), "utf8"),
    );
    const out = extractRoundFromApi(round, {
      season: 2024,
      round: 1,
      source_url: "https://fimspeedway.com/results/2024-boll-fim-speedway-gp-of-croatia",
    });
    expect(out).not.toBeNull();
    expect(out!.date).toBe("2024-04-27");
    expect(out!.country).toBe("Croatia");
    // fixture has Heat 8 (main), Semi final 1 (semi), Final (final), qualif(18 -> skipped)
    const phases = out!.heats.map((h) => h.phase).sort();
    expect(phases).toEqual(["final", "main", "semi"]);
    const h8 = out!.heats.find((h) => h.phase === "main")!;
    expect(h8.heat_no).toBe(8);
    // colorId -> gate, real Heat 8 result
    const madsen = h8.results.find((r) => r.rider === "Leon Madsen")!;
    expect(madsen.gate).toBe(2);
    expect(madsen.rank).toBe(1);
    expect(madsen.points).toBe(3);
    expect(madsen.official_rider_id).toBe("744"); // stable rider id (entry.object.id)
    // no heat should carry the 18-rider field
    expect(out!.heats.every((h) => h.results.length <= 5)).toBe(true);
  });
});
