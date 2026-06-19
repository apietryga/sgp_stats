import { Database } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export const DB_PATH = resolve(import.meta.dir, "../data/sgp.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS riders (
  id             INTEGER PRIMARY KEY,
  canonical_name TEXT NOT NULL UNIQUE,
  country        TEXT
);

CREATE TABLE IF NOT EXISTS aliases (
  alias    TEXT PRIMARY KEY,
  rider_id INTEGER NOT NULL REFERENCES riders(id)
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  season     INTEGER NOT NULL,
  round      INTEGER NOT NULL,
  name       TEXT,
  date       TEXT,
  country    TEXT,
  venue      TEXT,
  source     TEXT NOT NULL,          -- 'sport' | 'fimspeedway'
  source_url TEXT NOT NULL,
  raw_file   TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE(season, round, source)
);

CREATE TABLE IF NOT EXISTS heats (
  id           INTEGER PRIMARY KEY,
  event_id     INTEGER NOT NULL REFERENCES events(id),
  heat_no      INTEGER NOT NULL,
  phase        TEXT NOT NULL DEFAULT 'main',   -- 'main' | 'semi' | 'lcq' | 'final'
  -- Multi-source trust, set by reconcile:
  --   VERIFIED | OFFICIAL_ONLY | CONFLICT | UNVERIFIED
  trust_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
  UNIQUE(event_id, heat_no, phase)
);

CREATE TABLE IF NOT EXISTS results (
  id            INTEGER PRIMARY KEY,
  heat_id       INTEGER NOT NULL REFERENCES heats(id),
  rider_id      INTEGER NOT NULL REFERENCES riders(id),
  gate          INTEGER,
  points        INTEGER,
  position_code TEXT,
  rank          INTEGER,
  source_url    TEXT NOT NULL
);

-- Round totals from a secondary source, used only for cross-checking
-- (gpsquads for 1995-2019, Wikipedia for 2020-2026). Not part of Elo input.
CREATE TABLE IF NOT EXISTS external_totals (
  id         INTEGER PRIMARY KEY,
  season     INTEGER NOT NULL,
  round      INTEGER NOT NULL,
  rider_id   INTEGER NOT NULL REFERENCES riders(id),
  total      INTEGER,
  source     TEXT NOT NULL,          -- 'gpsquads' | 'wikipedia'
  source_url TEXT NOT NULL,
  raw_file   TEXT NOT NULL,
  UNIQUE(season, round, rider_id, source)
);

-- Maps every source's notion of a rider's identity to our canonical rider.
-- In the 2020+ era the official_rider_id (source='fimspeedway') is a strong key:
-- when one official id maps to several spellings we may merge them automatically.
CREATE TABLE IF NOT EXISTS rider_sources (
  rider_id   INTEGER NOT NULL REFERENCES riders(id),
  source     TEXT NOT NULL,          -- 'sport' | 'fimspeedway' | 'wikipedia'
  source_key TEXT NOT NULL,          -- official_rider_id, or normalized spelling
  PRIMARY KEY (source, source_key)
);

-- Per-field provenance: which source asserted which value for a results row.
CREATE TABLE IF NOT EXISTS provenance (
  id         INTEGER PRIMARY KEY,
  result_id  INTEGER NOT NULL REFERENCES results(id),
  field      TEXT NOT NULL,          -- 'rider' | 'gate' | 'rank' | 'points'
  value      TEXT,
  source     TEXT NOT NULL,
  source_url TEXT NOT NULL,
  set_at     TEXT NOT NULL,
  UNIQUE(result_id, field, source)
);

-- Audit log of official-vs-existing disagreements found during reconciliation.
CREATE TABLE IF NOT EXISTS conflicts (
  id              INTEGER PRIMARY KEY,
  heat_id         INTEGER NOT NULL REFERENCES heats(id),
  rider_id        INTEGER REFERENCES riders(id),
  field           TEXT NOT NULL,
  existing_value  TEXT,
  existing_source TEXT,
  official_value  TEXT,
  official_source TEXT,
  detected_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_results_heat  ON results(heat_id);
CREATE INDEX IF NOT EXISTS idx_results_rider ON results(rider_id);
CREATE INDEX IF NOT EXISTS idx_heats_event   ON heats(event_id);
CREATE INDEX IF NOT EXISTS idx_events_season ON events(season, round);
CREATE INDEX IF NOT EXISTS idx_ext_totals    ON external_totals(season, round);
`;

export function openDb(path: string = DB_PATH): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Forward-only migrations for DBs created before a column existed. */
function migrate(db: Database): void {
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(heats)")
    .all()
    .map((c) => c.name);
  if (!cols.includes("trust_status")) {
    db.exec("ALTER TABLE heats ADD COLUMN trust_status TEXT NOT NULL DEFAULT 'UNVERIFIED'");
  }
}

/** Open a fresh in-memory DB with the schema applied (for tests). */
export function openMemoryDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export interface EventInput {
  season: number;
  round: number;
  name: string | null;
  date: string | null;
  country: string | null;
  venue: string | null;
  source: string;
  source_url: string;
  raw_file: string;
  fetched_at: string;
}

/** Insert or fetch an event by (season, round, source). Returns event id. */
export function upsertEvent(db: Database, e: EventInput): number {
  const existing = db
    .query<{ id: number }, [number, number, string]>(
      "SELECT id FROM events WHERE season = ? AND round = ? AND source = ?",
    )
    .get(e.season, e.round, e.source);
  if (existing) {
    db.query(
      `UPDATE events SET name=?, date=?, country=?, venue=?, source_url=?, raw_file=?, fetched_at=? WHERE id=?`,
    ).run(e.name, e.date, e.country, e.venue, e.source_url, e.raw_file, e.fetched_at, existing.id);
    return existing.id;
  }
  const info = db
    .query(
      `INSERT INTO events (season, round, name, date, country, venue, source, source_url, raw_file, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      e.season,
      e.round,
      e.name,
      e.date,
      e.country,
      e.venue,
      e.source,
      e.source_url,
      e.raw_file,
      e.fetched_at,
    );
  return Number(info.lastInsertRowid);
}

/** Insert or fetch a heat by (event_id, heat_no, phase). Returns heat id. */
export function upsertHeat(
  db: Database,
  event_id: number,
  heat_no: number,
  phase: string,
): number {
  const existing = db
    .query<{ id: number }, [number, number, string]>(
      "SELECT id FROM heats WHERE event_id = ? AND heat_no = ? AND phase = ?",
    )
    .get(event_id, heat_no, phase);
  if (existing) return existing.id;
  const info = db
    .query("INSERT INTO heats (event_id, heat_no, phase) VALUES (?, ?, ?)")
    .run(event_id, heat_no, phase);
  return Number(info.lastInsertRowid);
}

export interface ResultInput {
  heat_id: number;
  rider_id: number;
  gate: number | null;
  points: number | null;
  position_code: string | null;
  rank: number | null;
  source_url: string;
}

export function insertResult(db: Database, r: ResultInput): void {
  db.query(
    `INSERT INTO results (heat_id, rider_id, gate, points, position_code, rank, source_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.heat_id, r.rider_id, r.gate, r.points, r.position_code, r.rank, r.source_url);
}

/** Remove every heat+result for one event so an ingest can be re-run idempotently.
 * Also clears the derived audit rows (provenance, conflicts) that reference them,
 * so re-running with foreign keys enabled never trips a constraint. */
export function clearEventHeats(db: Database, event_id: number): void {
  const heatSel = "SELECT id FROM heats WHERE event_id = ?";
  db.query(
    `DELETE FROM provenance WHERE result_id IN
       (SELECT id FROM results WHERE heat_id IN (${heatSel}))`,
  ).run(event_id);
  db.query(`DELETE FROM conflicts WHERE heat_id IN (${heatSel})`).run(event_id);
  db.query(`DELETE FROM results WHERE heat_id IN (${heatSel})`).run(event_id);
  db.query("DELETE FROM heats WHERE event_id = ?").run(event_id);
}
