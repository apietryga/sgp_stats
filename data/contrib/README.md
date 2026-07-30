# Contributed heat-by-heat data

This directory is how heat-by-heat results get into the database when no
automated source publishes them.

## Why it is needed

| Seasons | Source | Heat-by-heat? |
|---------|--------|---------------|
| 1995–2019 | `gogonzo/sport` (`gpheats.rda`) | yes |
| **2020–2021** | — | **no source** |
| 2022–2026 | fimspeedway `/api/results` | yes |

`gogonzo/sport` was last updated through 2019, and fimspeedway's API returns
only each round's final classification for 2020 and 2021 — no races array. So
those two seasons currently contribute **no heats**, and every career that ran
through them is cut off at 2019. Artiom Łaguta is the clearest casualty: he won
the 2021 world championship, was suspended along with the other Russian riders
before the 2022 season, and so has no heats after 2019 at all — the ranking shows
him retiring two years before his title.

The project will not guess those results. It will accept them from someone who
has them, on the same terms as every other source: stored raw with a sha256
before parsing, validated row by row, and tagged `source='contrib'` so it stays
distinguishable from scraped data downstream.

## How to contribute a season

1. Put one CSV per season (or per round) here, e.g. `2021.csv`.
2. Add a sidecar `2021.about.json` recording where it came from:

   ```json
   {
     "origin": "official SGP round programmes, transcribed by hand",
     "contributor": "Jan Kowalski",
     "url": "https://example.org/optional-link",
     "notes": "anything worth knowing about the transcription"
   }
   ```

   `origin` and `contributor` are **required** — a file without them is skipped.
   Provenance is the whole point; data with no recorded origin is not better
   than no data.

3. Load and rebuild:

   ```bash
   bun run ingest:contrib
   bun run all
   ```

`bun run audit` will then show the season as covered instead of as a gap.

## CSV schema

Header row required; column order does not matter. See `TEMPLATE.csv`.

| Column | Required | Meaning |
|--------|----------|---------|
| `season` | ✅ | e.g. `2021` |
| `round` | ✅ | 1-based round number within the season |
| `date` | ✅ | `YYYY-MM-DD`; the year must match `season` |
| `name` | | event name, e.g. `Speedway Grand Prix of Poland` |
| `venue` | | e.g. `Wrocław` |
| `heat` | ✅ | heat number within the round |
| `phase` | | `main` (default), `semi`, `lcq`, `final` |
| `gate` | | starting gate, 1–4 |
| `rider` | ✅ | rider name — variant spellings resolve through `config/aliases.csv` |
| `points` | | points scored in that heat |
| `position` | | finishing code: `1`–`4`, or `x`/`r`/`t`/`m` for a non-finish |
| `rank` | ✅ | finishing position — **the only field the Elo engine reads** |

One row per rider per heat, so a normal heat is four rows sharing the same
`season,round,heat,phase`.

### `rank` vs `position`

`rank` must always be a number. A rider who was excluded or did not finish still
gets a rank — put them last (e.g. `4`, or `5` alongside the four finishers, which
is what the historical dataset does) and record *why* in `position`. The engine
scores a shared rank as a draw, so riders who all failed to finish can share one.

### Validation

The whole file is rejected if anything is wrong, and every problem is listed at
once. Checks: required columns; season/round/heat/rank ranges; `date` matching
`season`; known `phase`; gate in 1–4; at least two and at most six riders per
heat; no duplicated rider or gate within a heat; a rank-1 finisher in every heat;
one date per round.

Nothing is written to the database until the file passes.
