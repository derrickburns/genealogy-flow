CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  user_id           TEXT PRIMARY KEY,
  email             TEXT NOT NULL,
  api_key           TEXT,
  last_login        INTEGER NOT NULL,
  gedcom_expires_at INTEGER,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_individuals (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  sex        TEXT,
  birth_year INTEGER,
  death_year INTEGER,
  data_json  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  iid    TEXT    NOT NULL,
  tag    TEXT    NOT NULL,
  year   INTEGER,
  place  TEXT,
  lat    REAL,
  lon    REAL
);

CREATE INDEX IF NOT EXISTS demo_events_iid ON demo_events(iid);
CREATE INDEX IF NOT EXISTS demo_events_year ON demo_events(year);

CREATE TABLE IF NOT EXISTS demo_families (
  id        TEXT PRIMARY KEY,
  data_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_sources (
  id        TEXT PRIMARY KEY,
  data_json TEXT NOT NULL
);
