CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  user_id           TEXT PRIMARY KEY,
  owner_uuid        TEXT UNIQUE,
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

-- Per-user GEDCOM data seeded from browser-parsed GEDCOM.
-- Multi-source: each user may persist multiple named trees.

CREATE TABLE IF NOT EXISTS ged_sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tree_uuid     TEXT UNIQUE,
  user_id       TEXT    NOT NULL,
  owner_user_id TEXT,
  owner_uuid    TEXT,
  owner_email   TEXT,
  name          TEXT    NOT NULL,
  content_hash  TEXT,
  uploaded_at   INTEGER,
  content_changed_at INTEGER,
  top_pci_id    TEXT,
  top_pci_name  TEXT,
  top_pci_score REAL,
  loaded_at     TEXT    NOT NULL,
  n_individuals INTEGER DEFAULT 0,
  n_events      INTEGER DEFAULT 0,
  n_families    INTEGER DEFAULT 0,
  is_default    INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ged_sources_user_name ON ged_sources(user_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS ged_sources_owner_uuid_name ON ged_sources(owner_uuid, name) WHERE owner_uuid IS NOT NULL;
CREATE INDEX IF NOT EXISTS ged_sources_content_hash ON ged_sources(content_hash);

CREATE TABLE IF NOT EXISTS tree_shares (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tree_kind         TEXT    NOT NULL,
  tree_key          TEXT    NOT NULL,
  owner_email       TEXT    NOT NULL,
  shared_with_email TEXT    NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tree_shares_unique ON tree_shares(tree_kind, tree_key, shared_with_email);
CREATE INDEX IF NOT EXISTS tree_shares_shared_with ON tree_shares(shared_with_email);
CREATE INDEX IF NOT EXISTS tree_shares_tree ON tree_shares(tree_kind, tree_key);

CREATE TABLE IF NOT EXISTS ged_individuals (
  source_id  INTEGER NOT NULL,
  id         TEXT    NOT NULL,
  name       TEXT,
  sex        TEXT,
  birth_year INTEGER,
  death_year INTEGER,
  famc       TEXT,
  PRIMARY KEY (source_id, id)
);
CREATE INDEX IF NOT EXISTS ged_indi_name  ON ged_individuals(name);
CREATE INDEX IF NOT EXISTS ged_indi_birth ON ged_individuals(birth_year);
CREATE INDEX IF NOT EXISTS ged_indi_death ON ged_individuals(death_year);

CREATE TABLE IF NOT EXISTS ged_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     INTEGER NOT NULL,
  individual_id TEXT    NOT NULL,
  type          TEXT    NOT NULL,
  year          INTEGER,
  place         TEXT,
  lat           REAL,
  lon           REAL
);
CREATE INDEX IF NOT EXISTS ged_evt_src  ON ged_events(source_id);
CREATE INDEX IF NOT EXISTS ged_evt_indi ON ged_events(source_id, individual_id);
CREATE INDEX IF NOT EXISTS ged_evt_year ON ged_events(year);
CREATE INDEX IF NOT EXISTS ged_evt_type ON ged_events(type);

CREATE TABLE IF NOT EXISTS ged_families (
  source_id INTEGER NOT NULL,
  id        TEXT    NOT NULL,
  husb_id   TEXT,
  wife_id   TEXT,
  PRIMARY KEY (source_id, id)
);
CREATE INDEX IF NOT EXISTS ged_fam_husb ON ged_families(source_id, husb_id);
CREATE INDEX IF NOT EXISTS ged_fam_wife ON ged_families(source_id, wife_id);

CREATE TABLE IF NOT EXISTS ged_family_children (
  source_id INTEGER NOT NULL,
  family_id TEXT    NOT NULL,
  child_id  TEXT    NOT NULL,
  PRIMARY KEY (source_id, family_id, child_id)
);
CREATE INDEX IF NOT EXISTS ged_fc_child ON ged_family_children(source_id, child_id);
