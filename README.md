# sgp-stats

Elo ranking of **Speedway Grand Prix** riders, computed heat-by-heat, with
multi-source provenance and a zero-hallucination policy: every heat in the
database derives from a real raw artifact saved under `data/raw/` (URL +
`fetched_at` + `sha256`). Stack: **Bun + TypeScript**, no UI framework.

## Data scope

| Era | Source | Status |
|-----|--------|--------|
| **1995–2019** | `gogonzo/sport` (`gpheats.rda`, GPL-2) | ✅ heat-by-heat (235 events, 5 477 heats) |
| **2020–2021** | espeedway.pl live-relay protocols → `data/contrib/` | ✅ heat-by-heat (19 rounds, 437 heats incl. semis + final) |
| **2022–2026** | fimspeedway.com official `/api/results` | ✅ heat-by-heat (45 rounds, 1 035 heats incl. semis + final) |
| 2020–2026 | Wikipedia season articles | ✅ round/season point totals, **cross-check only** (never fed to Elo) |
| 1995–2019 | `gpsquads.rda` | ✅ round point totals, cross-check only |
| any | `data/contrib/*.csv` | ✅ contributed heat-by-heat, opt-in (`ingest:contrib`) |

The Elo ranking covers **1995–2026** (heat-by-heat), 6 995 heats over 271 riders.

### 2020–2021: recovered from espeedway.pl

Neither automated source covers these two seasons: `gogonzo/sport` stops at 2019,
and fimspeedway's API returns only each round's final classification for 2020–2021
(no races array), so it yields **no Elo heats** — only `external_totals` for
cross-checking. Left unfilled, every career running through 2020–2021 was truncated
at 2019. The clearest casualty was **Artiom Łaguta**: he won the 2021 world
championship, then was suspended with the other Russian riders before 2022, so the
ranking showed him with no heats after 2019 at all — his title invisible.

espeedway.pl's live-relay pages (`/live/race_detail.php?id=…`) did cover every
round of both seasons with the full 23-heat protocol. `src/scrapers/espeedway.ts`
(`bun run scrape:espeedway`) transcribes them into `data/contrib/2020.csv` and
`2021.csv`, which then load through the ordinary, strictly-validated
`ingest:contrib` path as `source='contrib'`. Two safeguards keep it honest:

- **Cross-check.** Each round is only emitted if every rider's summed heat points
  equal the classification total espeedway prints for that rider.
- **No invented riders.** espeedway prints only an initial + surname; each is
  matched to the dataset's canonical full names (surrounding seasons), with
  transliteration cases and track reserves listed in a hand-verified `OVERRIDES`
  table (each checked against the round's Wikipedia article). A name that resolves
  to zero or more than one rider aborts the scrape rather than guess.

To reproduce or extend to other gaps, see [`data/contrib/README.md`](./data/contrib/README.md).

## Quick start

```bash
bun install
bun run fetch        # = ingest:sport — download .rda (Python/pyreadr) + load SQLite
bun run all          # full pipeline (see below), ending with the Elo build
bun run serve        # view at http://localhost:3000
```

`bun run all` runs, in order:

```
ingest:sport → scrape:wiki → scrape:official → ingest:contrib → build:aliases
   → reconcile → verify → audit → export → build:elo → export:stats
   → build:site → coverage table
```

Network steps (`scrape:wiki`, `scrape:official`) are best-effort: if they
return nothing the pipeline still completes on the data already in the DB.

### All commands

| Command | What it does |
|---------|--------------|
| `bun run fetch` / `ingest:sport` | Python downloads `gpheats.rda`/`gpsquads.rda` → CSV; TS loads them into `data/sgp.db` |
| `bun run scrape:wiki` | Fetch Wikipedia season standings → `external_totals` (cross-check) |
| `bun run scrape:official` | Official fimspeedway heats via its `/api/results` (heat-by-heat 2022–2026; classifications 2020–2026) |
| `bun run ingest:contrib` | Load contributed heat-by-heat CSVs from `data/contrib/` (fills gaps no source covers) |
| `bun run build:aliases` | Propose rider spelling-merge candidates → `out/alias_candidates.csv` |
| `bun run reconcile` | Three-source reconciliation: set `trust_status`, record provenance & conflicts |
| `bun run verify` | Credibility reports → `out/*.csv` + console summary |
| `bun run audit` | Season-by-season **coverage**: gap seasons, short rounds, bad dates, stranded careers |
| `bun run export` | DB → `data/gpheats_all.csv` (the Elo engine's only input) |
| `bun run build:elo` / `build` | Compute Elo → `out/ranking.csv`, `out/elo_history.csv` |
| `bun run export:stats` | Build the statistician verification package → `export/` (see [Export for statisticians](#export-for-statisticians)) |
| `bun run build:site` | Build the static GitHub Pages site → `docs/` (see [Static site](#static-site-github-pages)) |
| `bun run serve` | Static preview of `docs/` on :3000 — identical to GitHub Pages |
| `bun test` | Unit tests |

## Elo engine (`src/elo.ts`)

Multi-rider Elo by **pairwise decomposition**. Each heat (2–5 riders, grouped by
the global heat `id`) is scored as every head-to-head pair, using the ratings
held *before* the heat; a rider's net change is the sum of their pairwise deltas,
applied only after the whole heat is computed (so per-heat change is zero-sum).

```
E_i = 1 / (1 + 10^((R_j - R_i) / 400))
S_i = 1 if rank_i < rank_j, 0 if worse, 0.5 if equal (tie)
Δ_i = Σ_j  K_i · (S_i − E_i)
```

- New rider starts at **1500**.
- **K** is configurable; **provisional** K is higher while a rider is new.

### Changing K

```bash
ELO_K=32 bun run build:elo                  # via env
bun run build:elo --k=32                      # via CLI
bun run build:elo --provisional-k=50 --provisional-heats=20
bun run build:elo --no-provisional            # constant K for everyone
```

Defaults: `K=24`, provisional `K=40` for a rider's first `30` heats.

Per rider the engine collects `current_elo`, `peak_elo` + peak date,
`heats_raced`, `wins`, `win_rate`, `first_season`, `last_season`, plus the full
`elo_after` history of every heat.

### Safety interlock

`build:elo` refuses to start if any heat has `trust_status = CONFLICT`
(unresolved official-vs-base disagreement) unless you pass `--force`, and it
always prints how many heats entering Elo are `UNVERIFIED`.

## Extending to 2020+

The engine is built to **append** future seasons without modification:

```ts
import { EloEngine } from "./src/elo.ts";
const engine = new EloEngine();
engine.appendHeats(historicalRows);   // 1995–2019
engine.appendHeats(scrapedRows2020s); // same row schema, sorted by date then id
```

`appendHeats(rows)` accepts the same schema as `data/gpheats_all.csv`, groups by
heat `id`, sorts chronologically, and continues on top of the existing ratings.

### The official source (fimspeedway.com)

fimspeedway.com is a Next.js **pages-router** app. Its `__NEXT_DATA__` on
`/sgp/results` carries only the season list, but the site exposes its **own**
first-party JSON API that returns a season's full results (rounds + races +
per-heat rankings) in one call — no third-party token, no browser needed:

```
GET https://fimspeedway.com/api/results?seasonId={id}&championshipId=3
```

`scrape:official` (`src/scrapers/fimspeedway.ts`) fetches this per season
(`SEASON_IDS` maps year→id), saves the raw payload (+ `.meta.json`, sha256)
**before** parsing, then `extractRoundFromApi` maps each scored round to the
normalized `OfficialRound` and `ingestOfficialRound` stores it under
`source='fimspeedway'`. Field mapping: `colorId`→gate (1–4), `rank`, `points`,
and `entry.object.id`→`official_rider_id` (stable rider identity, which
`resolveByOfficialId` uses to auto-merge spelling variants).

**Coverage reality (probed):**

- **2022–2026** — full heat-by-heat (main heats + semi-finals + final). Fed to Elo.
- **2020–2021** — fimspeedway has **no** heat-by-heat data, only each round's
  final classification. Those are stored as `external_totals` (cross-check),
  not heats, so 2020–2021 add round totals but no Elo heats.
- Round classifications for **all** of 2020–2026 are also stored as
  `external_totals(source='fimspeedway')` for an independent per-round check.

### Collecting 2020–2026

It already works out of the box — no backend to wire:

```bash
bun run scrape:official     # GET /api/results per season → save raw → ingest
bun run reconcile           # sets trust_status (OFFICIAL_ONLY for 2022-2026 heats)
bun run verify              # coverage + credibility reports
bun run export && bun run build:elo   # rebuild Elo through 2026
# …or just: bun run all
```

`scrape:official` is rate-limited (≥2 s/season) and retries each season a few
times, honouring robots/ToS and the `ai-train=no` signal (enforced in
`src/raw.ts`). Re-runs are idempotent. To refresh an in-progress season later,
just run it again — newly completed rounds are appended.

> The round pages (`/results/{slug}`) also SSR the same `round` object into
> `__NEXT_DATA__` (`pageProps.round`), and `extractRoundFromApi` accepts that
> shape too — a fallback if the season API ever changes. A pluggable
> `RoundFetcher` type remains exported for a Playwright-based alternative.

### Reconciliation — the golden rule

`src/reconcile.ts` matches official heats to base heats by
`(season, round, heat_no, phase)` + rider set and sets `trust_status`:

- `VERIFIED` — official agrees with the base on every shared field
- `OFFICIAL_ONLY` — official is the only heat-composition source
- `CONFLICT` — official disagrees (full diff recorded; value **not** changed)
- `UNVERIFIED` — no official source for this heat

Enrich without corrupting: missing data present only in official is **inserted**;
agreeing data only **raises trust**; differing data is **never silently
overwritten** — the original is kept and a `CONFLICT` row logs both values and
sources. `reconcile --prefer-official` will overwrite, but always with an audit
row preserving the old value. Per-field provenance is recorded for every row.

## Reports (`out/`)

- `ranking.csv`, `elo_history.csv` — the Elo outputs
- `verification_report.csv` — per heat: `trust_status`, covering sources, points/rank sanity
- `credibility_summary.csv` — trust counts, fields filled from official, % official coverage of 2020–2026, round-total agreement
- `conflicts.csv` — every official-vs-base disagreement to resolve
- `alias_candidates.csv` — proposed rider spelling merges (manual review)
- `coverage_report.csv` — per season: rounds, heats, results, riders, sources, rounds with a final
- `coverage_findings.csv` — gap seasons, short rounds, date/season mismatches
- `career_gaps.csv` — riders racing when a gap season begins, i.e. whose totals it understates
- `date_corrections.csv` — every upstream date defect corrected, with the original value
- `contrib_sources.csv` — contributed files loaded, with origin, contributor and sha256

### Coverage audit (`bun run audit`)

`verify` asks whether the sources agree about the heats we have. `audit` asks the
question that went unasked for much longer: **which heats do we not have at all?**

A season with no source raises no conflict and fails no cross-check — it simply
is not there, and every career running through it is silently truncated. That is
how the 2020–2021 gap survived unnoticed until a reader spotted a world champion
whose record stopped two years before his title. The audit reports:

| Finding | Meaning |
|---------|---------|
| `GAP` | a season inside the covered span with no heats at all |
| `SHORT` | a round with fewer heats than that season's usual round |
| `DATE` | a heat whose event date does not fall in its own season |
| career gaps | riders racing when a gap begins — the ones whose totals it understates |

`SHORT` is informational: a rain-shortened meeting looks exactly like missing
heats from the data alone. The four currently flagged (2011 r2, 2011 r11, 2015
r1, 2015 r5) are genuine abandonments, not data loss.

### Cross-check caveat

The round-total cross-check (computed heat-point sums vs `gpsquads` / Wikipedia /
official `fimspeedway` classifications) agrees ~60–67% of the time. Most
disagreements are a *data semantics* difference, not an error: GP classification
points (semi-final/final structure, run-offs, tactical/joker doubles) differ from
a raw sum of per-heat points. Elo uses only per-heat ranks, so this does not
affect ratings.

## Export for statisticians

`bun run export:stats` builds a self-contained verification package in `export/`,
regenerated from the DB and `data/gpheats_all.csv` on every run (so it always
matches the database). It is CSV-only and lets a statistician **independently
re-derive every rating**:

| File | What it is |
|------|------------|
| `heats.csv` | the raw basis: one row per rider per heat (`rider_id`, `official_rider_id`, gate, points, rank, `trust_status`, `source`, `source_url`) |
| `elo_steps.csv` | per rider-heat trace: `elo_before`, `elo_after`, `delta`, `k_used`, `is_provisional` |
| `elo_pairs.csv` | the literal basis of each delta: per pair `expected_a` (E), `score_a` (S), `k_a`/`k_b`, `delta_*_from_pair` |
| `ranking.csv` | final ranking with `rider_id` |
| `events.csv` | event metadata + `raw_file`/`fetched_at`/`raw_sha256` provenance |
| `METHODOLOGY.md` | the formula and the **exact parameters used** for this export (K, provisional, start, tie rule, sort order) |
| `CODEBOOK.md` | column dictionary for every file |
| `MANIFEST.csv` | sha256 of each generated file **and** of every upstream source artifact (the provenance chain back to `data/raw/`) |

Load it anywhere:

```r
heats <- read.csv("export/heats.csv")                 # R
```
```python
import pandas as pd; heats = pd.read_csv("export/heats.csv")   # Python
```
```stata
import delimited "export/heats.csv", clear              // Stata
```

To verify: recompute pairwise Elo from `heats.csv` (sorted by date then
`heat_id`) following `METHODOLOGY.md`; your per-pair numbers should match
`elo_pairs.csv`, `elo_before + delta == elo_after` in `elo_steps.csv`, and the
rounded final ratings should match `ranking.csv`. Check integrity and origin
against `MANIFEST.csv` (`sha256sum -c`-style).

> CSV only by request. Parquet / R `.rds` / Stata `.dta` are available with no
> new installs (system `python3` has pandas + pyarrow + pyreadr) if you later
> want columnar or native formats.

## Static site (GitHub Pages)

`bun run build:site` assembles a fully static, server-free front-end into
`docs/` — the front-end fetches only prepared static files (no API, no DB):

```
docs/index.html               ranking + time slider; vanilla JS + SVG, dark theme
docs/heats.html               heat-by-heat browser (see below)
docs/data/ranking.json        career ranking rows                (~44 KB)
docs/data/history.json        { dates:[...], riders:{ name:[[date,elo,heats],…] } }  (~124 KB)
docs/data/heats/index.json    per-season coverage + the gap seasons and why
docs/data/heats/<season>.json that season's rounds → heats → rider rows (~45 KB each)
docs/.nojekyll
```

`history.json` is collapsed to one end-of-day point per rider per race-date, so
the page can compute the **ranking as of any date entirely on the client**.

**Time slider.** Drag the slider (1995 → 2026, one stop per race-date) and the
table re-ranks every rider by their Elo *as of that date* — for each rider the
last end-of-day rating on/before the selected date (riders who hadn't debuted
yet drop out). At the far right it equals the live ranking. The per-rider chart
marks the selected date. The result is historically faithful — e.g. the slider
shows Tony Rickardsson on top in 2002 and Tomasz Gollob in 2010 (both then-world
champions).

**Heat-by-heat browser (`docs/heats.html`).** The evidence under the ranking:
pick a season and round and see every heat as stored — starting gate (in the
speedway gate colours), rider, points, finishing code and rank — with semi-finals
and the final labelled where the format has them, plus the round classification
summed from those heats. Click a rider to highlight every ride they took in the
meeting; `?season=2019&round=10` deep-links a round.

It opens on a **coverage strip** over every season, and the seasons with no
heat-by-heat data are shown in red with the reason spelled out, rather than
being quietly absent. Only the selected season's JSON is fetched, so the page
stays light despite the full set being ~1 MB.

**Preview locally:** `bun run serve` serves `docs/` on :3000 exactly as Pages will.

**Publish:** commit `docs/` and in the repo's *Settings → Pages* choose
*Deploy from a branch → `main` → `/docs`*. The site is then served at
`https://<user>.github.io/<repo>/`. All asset paths are relative, so it works
under that sub-path with no config. Re-run `bun run build:site` (or `bun run
all`) and commit `docs/` to refresh.

## Notes

- **Data integrity fix (rounds):** the sport dataset leaves `round` blank for all
  of 2019 and the last 2018 rounds, which previously collapsed a whole season
  into one "round-0 event" with 40+ riders per heat. Rounds are now derived from
  the chronological order of distinct dates per season (verified equivalent to
  the populated labels for 1995–2017), restoring correct per-GP heats.
- **Data integrity fix (dates):** two events in `gpheats.rda`/`gpsquads.rda` carry
  a date whose year contradicts their own `season` column — the 2000 GP of Europe
  is dated `2009-09-23` and the 2008 GP of Germany `2009-10-18`. Because the Elo
  engine orders heats by date, both rounds were being rated as if raced in late
  2009, years after the riders in them had stopped racing; correcting them moves
  204 of 217 riders, Tony Rickardsson by −90 Elo (5th → 18th) and Todd Wiltshire
  by −111. `src/corrections.ts` rewrites the year only, keeps month and day,
  refuses when the result would collide with another round of that season, and
  logs every application to the `corrections` table and `out/date_corrections.csv`.
- **Phases for 1995–2019.** The sport dataset has no phase column, so the historic
  era arrived entirely as `main`. `src/phases.ts` labels heats 21/22 as semi-finals
  and 23 as the final, but only for rounds that *verify* against that structure —
  exactly 23 heats, and a final made of two riders from each semi. 153 of 235
  rounds match; the 24-heat (1995–2001) and 25-heat (2002–2004) formats do not and
  keep `main` throughout. Elo is unaffected (it reads ranks, not phases).
- **Upstream boundary is reported, not enforced.** The sport ingest used to drop
  everything after 2019 outright. It now ingests whatever the source carries and
  announces seasons past the expected boundary, so a future upstream refresh that
  finally adds 2020–2021 cannot be silently discarded.
- TypeScript `strict`; `bun test` covers the Elo zero-sum/tie invariants, the
  computation-trace identities (pair delta = K·(S−E), steps sum back), the
  `__NEXT_DATA__` parser (real fixture), and the reconciliation golden rule.
- Source attributions and licenses: see [`NOTICE`](./NOTICE). Data is collected
  for personal/statistical use, rate-limited, and **not** used for AI training.

# TODO
- [?] uzupełnienie danych 2020 - 2021
  Jeśli chodzi o heat-by-heat (każdy bieg z obsadą, kolejnością, punktami itd.), to są tylko kilka sensownych źródeł.

  1. Baansportfansite / Live (najlepsze)

  To prawdopodobnie jedyne kompletne źródło dla SGP 2020–2021.

  live.baansportfansite.nl
  zawiera:
  obsady biegów,
  wyniki każdego biegu,
  czasy,
  zmiany zawodników,
  półfinały i finał.

  Społeczność speedwaya często wskazuje je jako źródło pełnych danych heat-by-heat.

  2. JK Speedway Scorecards

  Bardzo dobra baza PDF-ów.

  Znajdziesz tam scorecard dla każdej rundy SGP 2020 i 2021. Zawierają praktycznie wszystko potrzebne do odtworzenia biegów.

  3. Speedway Updates

  Live coverage każdej rundy.

  Często mają:

  każdy bieg,
  punkty,
  klasyfikację na żywo.

  Nie wiem jednak, czy archiwum z 2020 nadal jest kompletne.

  1. Wikipedia (Najlepsza do parsowania/scrapowania)
  Zarówno polska, jak i angielska Wikipedia mają niezwykle pedantycznie prowadzone artykuły dla każdej rundy SGP.

  Polska Wikipedia: Szukaj haseł dla poszczególnych lat (np. "Grand Prix IMŚ na żużlu 2020"). Wewnątrz artykułu lub w podlinkowanych artykułach o konkretnych rundach (np. "Grand Prix Polski na żużlu 2020") znajdziesz szczegółowe tabele (macierze) z wynikami bieg po biegu dla każdego zawodnika.

  Angielska Wikipedia: Hasła takie jak "2020 Speedway Grand Prix" zawierają sekcje lub podstrony dla każdej rundy ze szczegółowymi "Heat details". Tabele HTML łatwo zamienić na JSON/CSV za pomocą prostego skryptu.

  2. Historia Sportu Żużlowego (speedway.hg.pl)
  Strona prowadzona przez Romana Lacha to absolutny "Święty Graal" polskich statystyk żużlowych.

  Wejdź w sekcję SGP -> wybierz rok 2020 lub 2021.

  Znajdziesz tam pełne protokoły meczowe, wypisane tekstowo (często w czytelnym formacie typu 1. Zmarzlik (3,2,1,3,3) 12). Możesz użyć wyrażeń regularnych (RegEx), aby szybko rozbić ciągi punktów na poszczególne biegi.

  3. WP SportoweFakty (Archiwum)
  Największy polski portal żużlowy ma w swoim archiwum artykuły publikowane tuż po zawodach.

  Wpisz w Google: site:sportowefakty.wp.pl "Speedway Grand Prix" "wyniki" "2020".

  Zawsze publikują pełen protokół zawodów, często w formacie: Bieg po biegu: 1. Zmarzlik, Woffinden, Janowski, Madsen. To wymaga nieco więcej pracy przy czyszczeniu danych, ale jest w 100% rzetelne.

  4. Oficjalne komunikaty FIM (Dokumenty PDF)
  FIM (Międzynarodowa Federacja Motocyklowa) po każdych zawodach publikuje oficjalny protokół w formacie PDF. Mimo że danych brakuje w API fimspeedway.com, same pliki PDF nadal leżą na serwerach FIM.

  Znajdziesz je na stronie fim-moto.com w sekcji dokumentów (Sports -> Track Racing -> SGP -> Documents) lub szukając w Google np. FIM Speedway Grand Prix 2020 round results filetype:pdf.

  Z PDF-ów można wyciągnąć dane za pomocą bibliotek (np. pdfplumber w Pythonie) lub po prostu przepisać je ręcznie.
- [?] prosty mechanizm do uzupełnienia danych przez przycisk
  - twardy przycisk - sprawdzaj datę następnego SGP i jeśli ostatnia jest w przeszłości to pozwól scrapować nowe dane
  - biorąc pod uwagę że teraz projekt jest hostowany na github pages `https://apietryga.com/sgp_stats/` zaprojektuj rozwiązanie które pozwoli na aktualizację 'twardych danych' (zbiorów danych csv bieg po biegu - źródeł danych tej appki) przez przycisk w app. Niech to rozwiązanie nie wymaga dużo UI innego narzędzia - tak żebyś jak najwięcej mógł zrobić z cli / kodu i tak, żeby było trwałe jak github pages. 
- [?] pod .chart-box dodaj paginowaną historię biegów zawodnika z podstawowymi informacjami (Case Tarasienko 1500 ELO, ale win 0.0 - nie wiadomo o co chodzi)
- [ ] 