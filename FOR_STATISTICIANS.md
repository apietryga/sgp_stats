# SGP Elo — informacja dla statystyków

Cześć,

przesyłam do niezależnej weryfikacji projekt liczący **ranking Elo żużlowców
Speedway Grand Prix** bieg po biegu (heat-by-heat) za lata **1995–2026**.
Wszystko jest publiczne i odtwarzalne — poniżej źródła, metoda, surowe dane i
rzeczy, na które warto zwrócić uwagę.

## Linki

- **Kod + dane (repo):** https://github.com/apietryga/sgp_stats
- **Wyniki na żywo (GitHub Pages):** https://apietryga.github.io/sgp_stats/
  — tabela rankingowa + **suwak czasu 1995→2026** (pokazuje ranking „na dany
  dzień") + wykres Elo każdego zawodnika.
- **Paczka weryfikacyjna (CSV):** katalog [`export/`](https://github.com/apietryga/sgp_stats/tree/main/export) w repo.

## Zakres i wielkość

Ranking obejmuje **1995–2026** (heat-by-heat): **6 512 biegów, 255 zawodników**,
≈26 100 wierszy wynikowych (jeden zawodnik × bieg).

## Źródła danych (z pełną proweniencją)

Każdy surowy artefakt jest zapisany na dysku z URL-em, znacznikiem czasu i
sumą `sha256` — nic nie jest „dopisywane z głowy". Łańcuch proweniencji jest w
`export/MANIFEST.csv` i `export/events.csv`.

| Okres | Źródło | Rola |
|------|--------|------|
| **1995–2019** | pakiet R `gogonzo/sport`, zbiór `gpheats.rda` (licencja GPL-2) | heat-by-heat → **wchodzi do Elo** |
| **2022–2026** | oficjalne API fimspeedway.com (`/api/results`) | heat-by-heat (biegi główne + półfinały + finał) → **wchodzi do Elo** |
| **2020–2021** | oficjalne fimspeedway.com | tylko klasyfikacja rundy — **brak danych bieg-po-biegu u źródła** → trafia do `external_totals` (cross-check), **NIE wchodzi do Elo** |
| 1995–2019 | `gpsquads.rda` (GPL-2) | sumy punktów w rundzie — tylko cross-check |
| 2020–2026 | artykuły sezonowe Wikipedii (CC-BY-SA) | sumy punktów — niezależny cross-check |

Uwaga kluczowa: **2020–2021 nie są policzone w Elo**, bo fimspeedway nie
udostępnia dla tych sezonów wyników bieg-po-biegu (tylko końcową klasyfikację
rundy). Jeśli macie wskazówkę co do wiarygodnego heat-by-heat dla 2020–2021,
chętnie je dołączę.

## Metoda liczenia Elo

Wieloosobowe Elo przez **dekompozycję na pary** (pairwise). Każdy bieg (2–5
zawodników, grupowany po globalnym `heat_id`) jest liczony jako wszystkie pary
zawodników, z użyciem ratingów **sprzed** biegu; zmiana zawodnika = suma jego
delt parowych, **stosowana dopiero po przeliczeniu całego biegu** (więc zmiana w
obrębie biegu jest zero-sumowa przy jednolitym K).

```
E_i = 1 / (1 + 10^((R_j − R_i) / 400))        # oczekiwany wynik (kolumna expected_a)
S_i = 1 jeśli rank_i < rank_j, 0 jeśli gorszy, 0.5 przy remisie   # wynik faktyczny (score_a)
Δ_i (z pary) = K_i · (S_i − E_i)               # kolumna delta_a_from_pair
Δ_i (bieg)   = suma Δ_i po wszystkich parach zawodnika w tym biegu
```

Parametry użyte w tym wydaniu (zapisane też w `export/METHODOLOGY.md`):

- rating startowy nowego zawodnika: **1500**
- **K = 24**; okres „provisional": **K = 40 dla pierwszych 30 biegów** zawodnika
- porządek chronologiczny: po dacie, a w obrębie daty po globalnym `heat_id`
- remis (równy rank) → S = 0.5 dla obu
- **Elo używa wyłącznie pozycji w biegu (rank), nie punktów.** Punkty są w danych
  tylko informacyjnie (półfinały/finał mają 0 pkt, ale realny rank 1–4).

K jest konfigurowalne (`ELO_K=… ` lub `--k=`, `--provisional-k=`,
`--provisional-heats=`, `--no-provisional`) — zachęcam do testów wrażliwości.

## Surowe dane i pełna odtwarzalność (`export/`)

Generowane jednym poleceniem `bun run export:stats`, regenerowane z bazy przy
każdym uruchomieniu (więc zawsze spójne z DB). Format **CSV** (uniwersalny):

| Plik | Co zawiera |
|------|-----------|
| `heats.csv` | surowa podstawa: wiersz na zawodnika×bieg — `heat_id, season, round, event_name, date, country, venue, heat_no, phase, gate, rider, rider_id, official_rider_id, points, position_code, rank, trust_status, source, source_url` |
| `elo_steps.csv` | ślad per zawodnik×bieg: `elo_before, elo_after, delta, k_used, is_provisional` (+ klucze) |
| `elo_pairs.csv` | **dosłowna podstawa każdej delty** — per para: `expected_a (E), score_a (S), k_a, k_b, delta_a_from_pair, …` (≈39 300 wierszy) |
| `ranking.csv` | końcowy ranking z `rider_id` |
| `events.csv` | metadane rund + `raw_file/fetched_at/raw_sha256` |
| `METHODOLOGY.md` | wzór + dokładne parametry tego wydania |
| `CODEBOOK.md` | słownik wszystkich kolumn |
| `MANIFEST.csv` | `sha256` każdego pliku **oraz** każdego artefaktu źródłowego (łańcuch do `data/raw/`) |

Wczytanie:

```r
heats <- read.csv("heats.csv")                          # R
```
```python
import pandas as pd; heats = pd.read_csv("heats.csv")    # Python
```
```stata
import delimited "heats.csv", clear                      // Stata
```

**Jak zweryfikować niezależnie:** posortujcie `heats.csv` po (date, heat_id),
przeliczcie Elo parami wg `METHODOLOGY.md` — Wasze liczby par powinny zgadzać się
z `elo_pairs.csv`, w `elo_steps.csv` musi zachodzić `elo_before + delta =
elo_after`, a zaokrąglone ratingi końcowe = `ranking.csv.current_elo`. (CSV-only
na życzenie; Parquet / R `.rds` / Stata `.dta` mogę dorzucić bez instalacji
dodatków.)

## Wiarygodność i statusy (`trust_status` w `heats.csv`)

Po rekoncyliacji wielu źródeł każdy bieg ma status:

- `VERIFIED` — oficjalne zgodne z ≥1 innym źródłem
- `OFFICIAL_ONLY` — tylko źródło oficjalne (tak są oznaczone biegi 2022–2026)
- `CONFLICT` — sprzeczność (zapisana z obiema wartościami, **bez nadpisania**)
- `UNVERIFIED` — brak niezależnego potwierdzenia (tak są oznaczone biegi sport 1995–2019)

W obecnym wydaniu: 5 477 biegów `UNVERIFIED` (1995–2019), 1 035 `OFFICIAL_ONLY`
(2022–2026), **0 `CONFLICT`**. Silnik Elo odmawia startu przy jakimkolwiek
`CONFLICT` bez jawnej flagi `--force`.

## Na co zwrócić uwagę (znane ograniczenia / decyzje do dyskusji)

1. **2020–2021 poza Elo** — brak heat-by-heat u źródła (opisane wyżej).
2. **Cross-check sum rundowych zgadza się ~60–67%.** To w większości różnica
   *semantyki*, nie błąd: punkty klasyfikacyjne GP (struktura półfinał/finał,
   dogrywki, jazdy taktyczne/joker = podwójne punkty) różnią się od surowej sumy
   punktów z biegów. Elo i tak liczy z **rang**, więc to nie wpływa na ratingi —
   ale warto to mieć z tyłu głowy przy porównaniach z „oficjalnymi" punktami.
3. **Numery rund 1995–2019** wyprowadzone z kolejności dat w sezonie (zbiór
   `sport` zostawiał `round` puste dla 2018/2019, co inaczej zlewało cały sezon
   w jedno „zdarzenie"). Sprawdzone jako równoważne z istniejącymi etykietami.
4. **Półfinały i finał liczą się jako osobne biegi** (rank 1–4), spójnie z erą
   1995–2019. Do dyskusji, czy chcecie je ważyć inaczej.
5. **Tożsamość zawodników:** dla ery 2020+ używamy stabilnego oficjalnego
   `official_rider_id` (auto-scala warianty pisowni); dla starszej ery mapowanie
   po nazwiskach z ręcznie zatwierdzanymi aliasami.
6. **Provisional K (40 przez 30 biegów)** i wybór `K=24` to decyzje do oceny —
   parametry są jawne i łatwe do zmiany.

## Co byłoby dla mnie najcenniejsze

Ocena doboru `K`/provisional, traktowania półfinałów/finału i jazd taktycznych,
sensowności metody pairwise dla 2–5 zawodników w biegu, oraz czy rozbieżność
cross-checku sum rundowych to dla Was problem czy akceptowalna różnica semantyki.

## Licencje / atrybucje

Dane `sport` (`gpheats`/`gpsquads`) — GPL-2; Wikipedia — CC-BY-SA 4.0; wyniki
fimspeedway — dane publiczne, pobierane z limitem zapytań, z poszanowaniem
robots.txt/ToS, **nieużywane do trenowania modeli AI**. Szczegóły w pliku
[`NOTICE`](https://github.com/apietryga/sgp_stats/blob/main/NOTICE). Pełna
dokumentacja techniczna (po angielsku) jest w [`README.md`](https://github.com/apietryga/sgp_stats/blob/main/README.md).

Z góry dzięki za każdą uwagę,
Antoni
