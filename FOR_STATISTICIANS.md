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
- **Podgląd bieg po biegu:** https://apietryga.github.io/sgp_stats/heats.html
  — każdy bieg tak, jak leży w bazie (pole startowe, zawodnik, punkty, kod
  ukończenia, rank), półfinały i finał oznaczone, klasyfikacja rundy liczona z
  biegów, plus **pasek pokrycia sezonów** pokazujący wprost, których sezonów
  brakuje i dlaczego.
- **Paczka weryfikacyjna (CSV):** katalog [`export/`](https://github.com/apietryga/sgp_stats/tree/main/export) w repo.

## Zakres i wielkość

Ranking obejmuje **1995–2026** (heat-by-heat): **6 995 biegów, 271 zawodników**,
≈28 000 wierszy wynikowych (jeden zawodnik × bieg).

## Źródła danych (z pełną proweniencją)

Każdy surowy artefakt jest zapisany na dysku z URL-em, znacznikiem czasu i
sumą `sha256` — nic nie jest „dopisywane z głowy". Łańcuch proweniencji jest w
`export/MANIFEST.csv` i `export/events.csv`.

| Okres | Źródło | Rola |
|------|--------|------|
| **1995–2019** | pakiet R `gogonzo/sport`, zbiór `gpheats.rda` (licencja GPL-2) | heat-by-heat → **wchodzi do Elo** |
| **2020–2021** | protokoły live espeedway.pl → `data/contrib/` (`scrape:espeedway`) | heat-by-heat (biegi główne + półfinały + finał) → **wchodzi do Elo** |
| **2022–2026** | oficjalne API fimspeedway.com (`/api/results`) | heat-by-heat (biegi główne + półfinały + finał) → **wchodzi do Elo** |
| **2020–2021** | oficjalne fimspeedway.com | tylko klasyfikacja rundy → `external_totals` (cross-check dla danych z espeedway) |
| 1995–2019 | `gpsquads.rda` (GPL-2) | sumy punktów w rundzie — tylko cross-check |
| 2020–2026 | artykuły sezonowe Wikipedii (CC-BY-SA) | sumy punktów — niezależny cross-check |
| dowolny | `data/contrib/*.csv` | dane bieg-po-biegu przekazane ręcznie, z zapisaną proweniencją |

### Luka 2020–2021 — domknięta z espeedway.pl

Przez pewien czas **2020–2021 nie były policzone w Elo**: `gogonzo/sport` kończy
się na 2019, a API fimspeedway dla tych dwóch sezonów zwraca wyłącznie końcową
klasyfikację rundy (brak tablicy biegów). Ucinało to **każdą karierę
przechodzącą przez 2020–2021** — najgłośniejszy przykład to **Artiom Łaguta**:
mistrz świata 2021, potem zawieszony z pozostałymi zawodnikami z Rosji przed
sezonem 2022, więc ranking nie pokazywał po 2019 ani jednego jego biegu.

Lukę domknięto z **protokołów live espeedway.pl** (`/live/race_detail.php?id=…`),
które pokrywają każdą rundę obu sezonów pełnym zapisem 23 biegów.
`src/scrapers/espeedway.ts` (`bun run scrape:espeedway`) przepisuje je do
`data/contrib/2020.csv` i `2021.csv`, skąd wchodzą zwykłą, ostro walidowaną
ścieżką `ingest:contrib` jako `source='contrib'`. Dwa zabezpieczenia pilnują
rzetelności:

- **Cross-check.** Runda jest zapisana tylko wtedy, gdy suma punktów każdego
  zawodnika z biegów zgadza się z klasyfikacją, którą espeedway drukuje.
- **Zero wymyślania zawodników.** espeedway podaje tylko inicjał + nazwisko;
  każde jest dopasowane do kanonicznych pełnych nazw z sąsiednich sezonów, a
  przypadki transliteracji i rezerwy toru są w ręcznie zweryfikowanej tablicy
  `OVERRIDES` (każdy sprawdzony w artykule Wikipedii danej rundy). Nazwisko,
  które pasuje do zera lub więcej niż jednego zawodnika, przerywa scraping —
  skrypt nigdy nie zgaduje.

Efekt: `bun run audit` nie zgłasza już żadnego sezonu-luki, a kariera Łaguty
(i innych) sięga 2021. Ten sam mechanizm `data/contrib/` domknie każdą inną
lukę — wystarczy wrzucić CSV (jeden plik na sezon lub rundę) razem z plikiem
`<nazwa>.about.json` opisującym pochodzenie (`origin` + `contributor` są
wymagane — dane bez zapisanego źródła nie są przyjmowane), a potem:

```bash
bun run ingest:contrib   # zapis surowego pliku + sha256, walidacja, załadowanie
bun run all              # rekoncyliacja, Elo, strona
```

Schemat kolumn (nagłówek wymagany, kolejność dowolna):

```
season,round,date,name,venue,heat,phase,gate,rider,points,position,rank
```

jeden wiersz na zawodnika × bieg; `rank` to jedyne pole, którego używa Elo.
Walidacja jest ostra i odrzuca **cały** plik przy jakimkolwiek błędzie, wypisując
od razu wszystkie problemy (zły zakres, data niezgodna z sezonem, powtórzony
zawodnik lub pole startowe w biegu, bieg bez zwycięzcy, runda rozjechana na dwie
daty). Pełny opis: [`data/contrib/README.md`](https://github.com/apietryga/sgp_stats/blob/main/data/contrib/README.md).

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
- **Wykluczenia/DNF nie liczą się do Elo.** Zawodnik z literowym kodem finiszu
  (`x` wykluczenie, `r` wycofanie, `tt`/`t` taśma, `d` dyskwalifikacja, `m`
  defekt) jest usuwany z biegu **przed** liczeniem: nie zmienia Elo, nie zwiększa
  `heats_raced`, a rywale ścigają się o jednego mniej. Pozycje numeryczne (w tym
  `5`/`6` w rekordach powtórek) to realne finisze i zostają. Na liście biegów
  wykluczony wciąż jest widoczny (z literką jako powodem). Wyłączenie:
  `--include-dnf`.

K jest konfigurowalne (`ELO_K=… ` lub `--k=`, `--provisional-k=`,
`--provisional-heats=`, `--no-provisional`, `--include-dnf`) — zachęcam do testów
wrażliwości.

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

W obecnym wydaniu: 5 914 biegów `UNVERIFIED` (1995–2019 sport + 2020–2021
espeedway/contrib), 1 081 `OFFICIAL_ONLY` (2022–2026), **0 `CONFLICT`**. Silnik
Elo odmawia startu przy jakimkolwiek `CONFLICT` bez jawnej flagi `--force`.

## Na co zwrócić uwagę (znane ograniczenia / decyzje do dyskusji)

1. **2020–2021 z jednego źródła (`UNVERIFIED`).** Heat-by-heat pochodzi z
   protokołów espeedway.pl (przez `data/contrib/`), więc wchodzi do Elo, ale bez
   drugiego niezależnego potwierdzenia (cross-check ze `sumą` klasyfikacji jest
   wewnątrz źródła). Oficjalne klasyfikacje rund z fimspeedway (`external_totals`)
   dają dodatkowy, częściowy cross-check. Brak bramek (`gate`) — espeedway ich nie
   publikuje; nie wpływa to na Elo (liczy się `rank`).
2. **Poprawka dat (znaleziona przy okazji tego feedbacku).** W `gpheats.rda` i
   `gpsquads.rda` dwie rundy mają rok w dacie sprzeczny z własną kolumną
   `season`: GP Europy 2000 z datą `2009-09-23` i GP Niemiec 2008 z datą
   `2009-10-18`. Silnik Elo sortuje biegi po dacie, więc obie rundy były liczone
   tak, jakby odbyły się pod koniec 2009 — lata po tym, jak startujący w nich
   zawodnicy skończyli kariery. Poprawka rusza **204 z 217 zawodników**:
   Tony Rickardsson −90 Elo (5. → 18. miejsce), Todd Wiltshire −111, Mark Loram
   −98. Zmieniany jest wyłącznie rok (dzień i miesiąc zostają), a każda poprawka
   trafia do tabeli `corrections` i `out/date_corrections.csv` z oryginalną
   wartością. Jeśli uznacie, że tie-break powinien iść w drugą stronę (data nad
   `season`) — chętnie o tym podyskutuję, ale za `season` przemawia to, że oba
   pliki zgadzają się co do sezonu, a dzień i miesiąc pasują do realnego terminu
   rundy.
3. **Kontrola pokrycia (`bun run audit`).** Nowy raport odpowiada na pytanie,
   którego wcześniej nikt nie zadawał: *których biegów w ogóle nie mamy?* Sezon
   bez źródła nie wywołuje konfliktu ani nie psuje cross-checku — po prostu go
   nie ma. Raport wypisuje sezony-luki, rundy krótsze niż zwykle w danym sezonie
   (2011 r2/r11 i 2015 r1/r5 — to realne odwołania z powodu deszczu, nie brak
   danych), daty niezgodne z sezonem oraz zawodników uciętych przez lukę.
4. **Cross-check sum rundowych zgadza się ~60–67%.** To w większości różnica
   *semantyki*, nie błąd: punkty klasyfikacyjne GP (struktura półfinał/finał,
   dogrywki, jazdy taktyczne/joker = podwójne punkty) różnią się od surowej sumy
   punktów z biegów. Elo i tak liczy z **rang**, więc to nie wpływa na ratingi —
   ale warto to mieć z tyłu głowy przy porównaniach z „oficjalnymi" punktami.
5. **Numery rund 1995–2019** wyprowadzone z kolejności dat w sezonie (zbiór
   `sport` zostawiał `round` puste dla 2018/2019, co inaczej zlewało cały sezon
   w jedno „zdarzenie"). Sprawdzone jako równoważne z istniejącymi etykietami.
6. **Półfinały i finał liczą się jako osobne biegi** (rank 1–4), spójnie z erą
   1995–2019. Do dyskusji, czy chcecie je ważyć inaczej.
7. **Tożsamość zawodników:** dla ery 2020+ używamy stabilnego oficjalnego
   `official_rider_id` (auto-scala warianty pisowni); dla starszej ery mapowanie
   po nazwiskach z ręcznie zatwierdzanymi aliasami.
8. **Provisional K (40 przez 30 biegów)** i wybór `K=24` to decyzje do oceny —
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
