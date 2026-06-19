# sgp-stats

Elo ranking of **Speedway Grand Prix** riders, computed heat-by-heat, with
multi-source provenance and a zero-hallucination policy: every heat in the
database derives from a real raw artifact saved under `data/raw/` (URL +
`fetched_at` + `sha256`). Stack: **Bun + TypeScript**, no UI framework.

## Data scope

| Era | Source | Status |
|-----|--------|--------|
| **1995–2019** | `gogonzo/sport` (`gpheats.rda`, GPL-2) | ✅ heat-by-heat (235 events, 5 477 heats) |
| **2022–2026** | fimspeedway.com official `/api/results` | ✅ heat-by-heat (45 rounds, 1 035 heats incl. semis + final) |
| 2020–2021 | fimspeedway.com official | ⚠️ classification only (no heat-by-heat upstream) → `external_totals` |
| 2020–2026 | Wikipedia season articles | ✅ round/season point totals, **cross-check only** (never fed to Elo) |
| 1995–2019 | `gpsquads.rda` | ✅ round point totals, cross-check only |

The Elo ranking covers **1995–2026** (heat-by-heat), 6 512 heats over 255 riders.
2020–2021 contribute official round classifications for cross-checking but no
Elo heats, because fimspeedway exposes no heat-by-heat data for those seasons.

## Quick start

```bash
bun install
bun run fetch        # = ingest:sport — download .rda (Python/pyreadr) + load SQLite
bun run all          # full pipeline (see below), ending with the Elo build
bun run serve        # view at http://localhost:3000
```

`bun run all` runs, in order:

```
ingest:sport → scrape:wiki → scrape:official → build:aliases → reconcile
   → verify → export → build:elo → export:stats → build:site → coverage table
```

Network steps (`scrape:wiki`, `scrape:official`) are best-effort: if they
return nothing the pipeline still completes on the data already in the DB.

### All commands

| Command | What it does |
|---------|--------------|
| `bun run fetch` / `ingest:sport` | Python downloads `gpheats.rda`/`gpsquads.rda` → CSV; TS loads them into `data/sgp.db` |
| `bun run scrape:wiki` | Fetch Wikipedia season standings → `external_totals` (cross-check) |
| `bun run scrape:official` | Official fimspeedway heats via its `/api/results` (heat-by-heat 2022–2026; classifications 2020–2026) |
| `bun run build:aliases` | Propose rider spelling-merge candidates → `out/alias_candidates.csv` |
| `bun run reconcile` | Three-source reconciliation: set `trust_status`, record provenance & conflicts |
| `bun run verify` | Credibility reports → `out/*.csv` + console summary |
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
docs/index.html          vanilla JS + SVG, dark theme
docs/data/ranking.json   career ranking rows                (~44 KB)
docs/data/history.json   { dates:[...], riders:{ name:[[date,elo,heats],…] } }  (~124 KB)
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

**Preview locally:** `bun run serve` serves `docs/` on :3000 exactly as Pages will.

**Publish:** commit `docs/` and in the repo's *Settings → Pages* choose
*Deploy from a branch → `main` → `/docs`*. The site is then served at
`https://<user>.github.io/<repo>/`. All asset paths are relative, so it works
under that sub-path with no config. Re-run `bun run build:site` (or `bun run
all`) and commit `docs/` to refresh.

## Notes

- **Data integrity fix:** the sport dataset leaves `round` blank for all of 2019
  and the last 2018 rounds, which previously collapsed a whole season into one
  "round-0 event" with 40+ riders per heat. Rounds are now derived from the
  chronological order of distinct dates per season (verified equivalent to the
  populated labels for 1995–2017), restoring correct per-GP heats.
- TypeScript `strict`; `bun test` covers the Elo zero-sum/tie invariants, the
  computation-trace identities (pair delta = K·(S−E), steps sum back), the
  `__NEXT_DATA__` parser (real fixture), and the reconciliation golden rule.
- Source attributions and licenses: see [`NOTICE`](./NOTICE). Data is collected
  for personal/statistical use, rate-limited, and **not** used for AI training.
```

# TODO
## build
- na froncie zrób slider który pozwoli szacować elo na osi czasu - początkowa data 1995, i możliwość przesuwania w prawo aż do 2026
  - na tej podstawie pokazuj jakie ELO mieli userzy w czasie 
- całość przygoruj do github pages (tylko front) - front musi pobierać dane z walidowanych przygotowanych plików json /csv - zaimplementuj wszystkie fukncjonalności na statycznych plikach
## mail 
napisz wiadomość do statystyków - zawrzyj tam źródła danych
