#!/usr/bin/env node
// Append a GEDCOM file as a new source in the multi-source SQLite database
// the chat proxy queries. Geocodes each event's place using the bundled
// gazetteer.json so Claude can run region/distance queries without a geo
// extension. Creates the DB (with full schema) if it does not yet exist.
//
// Usage: node scripts/gedcom-to-sqlite.mjs <DB.db> <PATH.ged> <SOURCE_NAME>
//
// Errors if SOURCE_NAME already exists in the sources table — callers that
// want replace semantics should DELETE rows for that source first, then
// invoke this script. The proxy's /load-gedcom?mode=replace does that.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const [, , dbPath, gedPath, sourceName] = process.argv;
if (!dbPath || !gedPath || !sourceName) {
  console.error("usage: node scripts/gedcom-to-sqlite.mjs <DB.db> <PATH.ged> <SOURCE_NAME>");
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const GAZETTEER_PATH = join(ROOT, "gazetteer.json");

// ---------- Geocoder (ported from index.html buildGeocoder) ----------

const US_STATE_ABBR = {
  AL:1,AK:1,AZ:1,AR:1,CA:1,CO:1,CT:1,DE:1,DC:1,FL:1,GA:1,HI:1,ID:1,IL:1,IN:1,IA:1,KS:1,KY:1,LA:1,
  ME:1,MD:1,MA:1,MI:1,MN:1,MS:1,MO:1,MT:1,NE:1,NV:1,NH:1,NJ:1,NM:1,NY:1,NC:1,ND:1,OH:1,OK:1,OR:1,
  PA:1,RI:1,SC:1,SD:1,TN:1,TX:1,UT:1,VT:1,VA:1,WA:1,WV:1,WI:1,WY:1,
};
const US_STATE_NAME = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",
  DE:"Delaware",DC:"District of Columbia",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",
  IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",
  MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",
  NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",
  NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",
  RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",
  VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",
};
const CA_PROV = {
  AB:1,BC:1,MB:1,NB:1,NL:1,NS:1,NT:1,NU:1,ON:1,PE:1,QC:1,SK:1,YT:1,
};
const COUNTRY_ALIASES = {
  "usa":"US","u s a":"US","u s":"US","united states":"US","united states of america":"US","us":"US","america":"US",
  "uk":"GB","u k":"GB","england":"GB","scotland":"GB","wales":"GB","great britain":"GB","britain":"GB","united kingdom":"GB","northern ireland":"GB",
  "canada":"CA","ireland":"IE","germany":"DE","deutschland":"DE","prussia":"DE","france":"FR","italy":"IT","spain":"ES","portugal":"PT",
  "netherlands":"NL","holland":"NL","belgium":"BE","switzerland":"CH","austria":"AT","poland":"PL","russia":"RU","ukraine":"UA",
  "sweden":"SE","norway":"NO","denmark":"DK","finland":"FI","australia":"AU","new zealand":"NZ","south africa":"ZA",
  "mexico":"MX","brazil":"BR","japan":"JP","china":"CN","india":"IN","czechoslovakia":"CZ","yugoslavia":"RS","bohemia":"CZ","moravia":"CZ",
};
const COUNTY_SUFFIX_RE = /\b(County|Parish|Co\.?|Borough|Census Area)\b/i;

function slug(s) {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function buildGeocoder(gz) {
  const countryByCC = new Map();
  for (const c of gz.countries) { countryByCC.set(c.cc, c); COUNTRY_ALIASES[slug(c.name)] = c.cc; }
  const adminByCC = new Map(), adminBySlug = new Map();
  for (const a of gz.admin1) {
    if (!adminByCC.has(a.cc)) adminByCC.set(a.cc, new Map());
    adminByCC.get(a.cc).set(a.code, a);
    if (!adminBySlug.has(a.cc)) adminBySlug.set(a.cc, new Map());
    adminBySlug.get(a.cc).set(slug(a.name), a.code);
  }
  const countiesByState = new Map();
  for (const c of gz.us_counties) {
    if (!countiesByState.has(c.st)) countiesByState.set(c.st, new Map());
    const m = countiesByState.get(c.st);
    m.set(c.name, c); m.set(c.name + " county", c);
  }
  const cityByStateSlug = new Map(), cityByCountrySlug = new Map();
  for (const row of gz.cities) {
    const [s, cc, st, lat, lon, pop] = row;
    const k1 = cc + "|" + st;
    let m = cityByStateSlug.get(k1); if (!m) { m = new Map(); cityByStateSlug.set(k1, m); }
    const ex = m.get(s); if (!ex || ex.pop < pop) m.set(s, {lat, lon, pop});
    let m2 = cityByCountrySlug.get(cc); if (!m2) { m2 = new Map(); cityByCountrySlug.set(cc, m2); }
    const ex2 = m2.get(s); if (!ex2 || ex2.pop < pop) m2.set(s, {lat, lon, pop});
  }
  function detectCountry(parts) {
    if (!parts.length) return null;
    const last = slug(parts[parts.length - 1]);
    if (COUNTRY_ALIASES[last]) return COUNTRY_ALIASES[last];
    if (parts.length >= 2) {
      const last2 = slug(parts[parts.length - 1] + " " + parts[parts.length - 2]);
      if (COUNTRY_ALIASES[last2]) return COUNTRY_ALIASES[last2];
    }
    return null;
  }
  function detectState(parts, cc) {
    if (!parts.length) return [null, null];
    if (cc === "US") {
      for (let i = parts.length - 1; i >= 0; i--) {
        const tok = parts[i].trim(); const up = tok.toUpperCase().replace(/\.$/, "");
        if (US_STATE_ABBR[up]) return [up, i];
        const sl = slug(tok); const codes = adminBySlug.get("US");
        if (codes && codes.has(sl)) return [codes.get(sl), i];
        // also accept full-name spellings via alias map
        for (const [code, name] of Object.entries(US_STATE_NAME)) {
          if (sl === slug(name)) return [code, i];
        }
      }
      return [null, null];
    }
    if (cc === "CA") {
      for (let i = parts.length - 1; i >= 0; i--) {
        const tok = parts[i].trim(); const up = tok.toUpperCase().replace(/\.$/, "");
        if (CA_PROV[up]) return [up, i];
        const sl = slug(tok); const codes = adminBySlug.get("CA");
        if (codes && codes.has(sl)) return [codes.get(sl), i];
      }
      return [null, null];
    }
    if (cc) {
      const codes = adminBySlug.get(cc); if (!codes) return [null, null];
      for (let i = parts.length - 1; i >= 0; i--) {
        const sl = slug(parts[i]); if (codes.has(sl)) return [codes.get(sl), i];
      }
    }
    return [null, null];
  }
  function findCounty(parts, st) {
    const m = countiesByState.get(st); if (!m) return null;
    for (const tok of parts) {
      const s = slug(tok); const sClean = s.replace(/ county$/, "").replace(/ parish$/, "").trim();
      const hit = m.get(s) || m.get(sClean); if (hit) return hit;
    }
    return null;
  }
  return function geocode(place) {
    const parts = place.split(",").map(s => s.trim()).filter(Boolean);
    if (!parts.length) return null;
    const cc = detectCountry(parts) || "US";
    const [st, stIdx] = detectState(parts, cc);
    const hasCountyTok = parts.some(p => COUNTY_SUFFIX_RE.test(p));
    if (cc === "US" && st && hasCountyTok) {
      const cty = findCounty(parts, st);
      if (cty) {
        const upper = stIdx == null ? parts.length : stIdx;
        const map = cityByStateSlug.get(cc + "|" + st);
        if (map) for (let i = 0; i < upper; i++) {
          if (COUNTY_SUFFIX_RE.test(parts[i])) continue;
          const hit = map.get(slug(parts[i]));
          if (hit) return { lat: hit.lat, lon: hit.lon, level: "city", cc, st };
        }
        return { lat: cty.lat, lon: cty.lon, level: "county", cc, st };
      }
    }
    if (st) {
      const upper = stIdx == null ? parts.length : stIdx;
      const map = cityByStateSlug.get(cc + "|" + st);
      if (map) for (let i = 0; i < upper; i++) {
        if (COUNTY_SUFFIX_RE.test(parts[i])) continue;
        const hit = map.get(slug(parts[i]));
        if (hit) return { lat: hit.lat, lon: hit.lon, level: "city", cc, st };
      }
      if (cc === "US") { const cty = findCounty(parts, st); if (cty) return { lat: cty.lat, lon: cty.lon, level: "county", cc, st }; }
      const ad = adminByCC.get(cc)?.get(st); if (ad) return { lat: ad.lat, lon: ad.lon, level: "admin1", cc, st };
    }
    if (cc) {
      const map = cityByCountrySlug.get(cc);
      if (map) for (const tok of parts) {
        const hit = map.get(slug(tok));
        if (hit) return { lat: hit.lat, lon: hit.lon, level: "city", cc, st: null };
      }
      const c = countryByCC.get(cc); if (c) return { lat: c.lat, lon: c.lon, level: "country", cc, st: null };
    }
    return null;
  };
}

// ---------- GEDCOM parser ----------

const LINE_RE = /^(\d+)\s+(?:(@[^@]+@)\s+)?(\S+)(?:\s+(.*))?$/;
function parseYear(s) {
  if (!s) return null;
  const matches = s.match(/\b(\d{3,4})\b/g);
  if (!matches) return null;
  let best = null;
  for (const m of matches) {
    const y = parseInt(m, 10);
    if (y >= 1000 && y <= 2100 && (best === null || y > best)) best = y;
  }
  return best;
}

console.error(`Parsing ${gedPath}`);
const text = readFileSync(gedPath, "utf8");
const lines = text.split(/\r?\n/);

const indis = new Map();
const fams = new Map();
const events = [];

let cur = null, mode = null, curEvent = null, curDate = null, curPlace = null;
function flushEvent() {
  if (cur && mode === "INDI" && curEvent) {
    const y = parseYear(curDate);
    if (y !== null && curPlace) {
      events.push({ indi_id: cur.id, type: curEvent, year: y, place: curPlace.trim() });
    }
  }
  curEvent = curDate = curPlace = null;
}
function flushRecord() {
  flushEvent();
  if (cur && mode === "INDI") indis.set(cur.id, cur);
  else if (cur && mode === "FAM") fams.set(cur.id, cur);
  cur = null; mode = null;
}

for (const raw of lines) {
  const m = LINE_RE.exec(raw);
  if (!m) continue;
  const lvl = parseInt(m[1], 10);
  const xref = m[2] || null;
  const tag = m[3];
  const val = m[4] || "";
  if (lvl === 0) {
    flushRecord();
    if (tag === "INDI" && xref) { cur = { id: xref, name: null, sex: null, famc: null, fams: [] }; mode = "INDI"; }
    else if (tag === "FAM" && xref) { cur = { id: xref, husb: null, wife: null, chil: [] }; mode = "FAM"; }
    continue;
  }
  if (!cur) continue;
  if (lvl === 1) {
    flushEvent();
    if (mode === "INDI") {
      if (tag === "NAME" && !cur.name) cur.name = val.replace(/\//g, "").trim();
      else if (tag === "SEX" && !cur.sex) cur.sex = (val.trim()[0] || "U").toUpperCase();
      else if (tag === "FAMC" && !cur.famc) cur.famc = val.trim();
      else if (tag === "FAMS") cur.fams.push(val.trim());
      else if (["BIRT","DEAT","RESI","MARR","EMIG","IMMI","CENS","BAPM","BURI","CHR"].includes(tag)) curEvent = tag;
    } else if (mode === "FAM") {
      if (tag === "HUSB") cur.husb = val.trim();
      else if (tag === "WIFE") cur.wife = val.trim();
      else if (tag === "CHIL") cur.chil.push(val.trim());
    }
  } else if (lvl === 2 && mode === "INDI" && curEvent) {
    if (tag === "DATE") curDate = val;
    else if (tag === "PLAC") curPlace = val;
  }
}
flushRecord();

console.error(`Parsed ${indis.size.toLocaleString()} individuals, ${fams.size.toLocaleString()} families, ${events.length.toLocaleString()} dated/placed events.`);

// ---------- Geocode ----------

if (!existsSync(GAZETTEER_PATH)) {
  console.error(`gazetteer.json not found at ${GAZETTEER_PATH}; cannot geocode`);
  process.exit(1);
}
console.error("Loading gazetteer.json...");
const gazetteer = JSON.parse(readFileSync(GAZETTEER_PATH, "utf8"));
const geocode = buildGeocoder(gazetteer);

const placeCache = new Map();
const counts = { city: 0, county: 0, admin1: 0, country: 0, miss: 0 };
for (const e of events) {
  let g = placeCache.get(e.place);
  if (g === undefined) { g = geocode(e.place) || null; placeCache.set(e.place, g); }
  if (g) {
    e.lat = g.lat; e.lon = g.lon; e.geo_level = g.level; e.geo_cc = g.cc; e.geo_st = g.st;
    counts[g.level] += 1;
  } else {
    counts.miss += 1;
  }
}
console.error(`Geocoded ${events.length - counts.miss}/${events.length}: ${JSON.stringify(counts)}`);

// ---------- Open / create DB ----------

const db = new Database(dbPath);
// Single-pass build, never reopened for writes — WAL sidecars only complicate
// hot-swapping at the proxy. Default rollback journal mode is fine.
db.pragma("journal_mode = delete");
// IF NOT EXISTS lets us create-or-append. Multi-source: every data table
// carries source_id; xref ids are scoped within (source_id, id).
db.exec(`
  CREATE TABLE IF NOT EXISTS sources (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,   -- filename or label, unique per DB
    loaded_at     TEXT NOT NULL,          -- ISO timestamp
    n_individuals INTEGER,
    n_events      INTEGER,
    n_families    INTEGER
  );
  CREATE TABLE IF NOT EXISTS individuals (
    source_id   INTEGER NOT NULL,
    id          TEXT NOT NULL,            -- GEDCOM xref, scoped by source_id
    name        TEXT,
    sex         TEXT,
    birth_year  INTEGER,
    death_year  INTEGER,
    famc        TEXT,
    PRIMARY KEY (source_id, id)
  );
  CREATE TABLE IF NOT EXISTS events (
    source_id     INTEGER NOT NULL,
    individual_id TEXT NOT NULL,
    type          TEXT NOT NULL,
    year          INTEGER,
    place         TEXT,
    lat           REAL,
    lon           REAL,
    geo_level     TEXT,
    geo_cc        TEXT,
    geo_st        TEXT
  );
  CREATE TABLE IF NOT EXISTS families (
    source_id INTEGER NOT NULL,
    id        TEXT NOT NULL,
    husb_id   TEXT,
    wife_id   TEXT,
    PRIMARY KEY (source_id, id)
  );
  CREATE TABLE IF NOT EXISTS family_children (
    source_id INTEGER NOT NULL,
    family_id TEXT NOT NULL,
    child_id  TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS events_geo USING rtree(
    rowid,
    min_lat, max_lat,
    min_lon, max_lon
  );
  CREATE INDEX IF NOT EXISTS idx_events_indi   ON events(source_id, individual_id);
  CREATE INDEX IF NOT EXISTS idx_events_src    ON events(source_id);
  CREATE INDEX IF NOT EXISTS idx_events_type   ON events(type);
  CREATE INDEX IF NOT EXISTS idx_events_year   ON events(year);
  CREATE INDEX IF NOT EXISTS idx_events_place  ON events(place);
  CREATE INDEX IF NOT EXISTS idx_events_cc     ON events(geo_cc);
  CREATE INDEX IF NOT EXISTS idx_events_cc_st  ON events(geo_cc, geo_st);
  CREATE INDEX IF NOT EXISTS idx_indi_name     ON individuals(name);
  CREATE INDEX IF NOT EXISTS idx_indi_birth    ON individuals(birth_year);
  CREATE INDEX IF NOT EXISTS idx_fam_husb      ON families(source_id, husb_id);
  CREATE INDEX IF NOT EXISTS idx_fam_wife      ON families(source_id, wife_id);
  CREATE INDEX IF NOT EXISTS idx_famchil_fam   ON family_children(source_id, family_id);
  CREATE INDEX IF NOT EXISTS idx_famchil_chil  ON family_children(source_id, child_id);

  -- Cross-source person linking. Filled by scripts/link-records.mjs.
  -- person_links: candidate identity matches between two persons in different sources.
  -- person_clusters: union-find materialization over auto-confirmed links.
  CREATE TABLE IF NOT EXISTS person_links (
    link_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    source_a    INTEGER NOT NULL,
    indi_a      TEXT NOT NULL,
    source_b    INTEGER NOT NULL,
    indi_b      TEXT NOT NULL,
    score       REAL NOT NULL,
    evidence    TEXT,
    origin      TEXT NOT NULL,        -- 'auto:multi-pass-blocking-v1' | 'manual:confirmed' | 'manual:rejected'
    created_at  TEXT NOT NULL,
    UNIQUE (source_a, indi_a, source_b, indi_b)
  );
  CREATE INDEX IF NOT EXISTS idx_links_a      ON person_links(source_a, indi_a);
  CREATE INDEX IF NOT EXISTS idx_links_b      ON person_links(source_b, indi_b);
  CREATE INDEX IF NOT EXISTS idx_links_score  ON person_links(score);
  CREATE INDEX IF NOT EXISTS idx_links_origin ON person_links(origin);

  CREATE TABLE IF NOT EXISTS person_clusters (
    cluster_id  INTEGER NOT NULL,
    source_id   INTEGER NOT NULL,
    indi_id     TEXT NOT NULL,
    PRIMARY KEY (source_id, indi_id)
  );
  CREATE INDEX IF NOT EXISTS idx_clusters_id  ON person_clusters(cluster_id);

  -- Data-quality anomalies. Filled by scripts/check-data-quality.mjs.
  -- One row per (person, kind). Severity ∈ {error, warning, info}. Linker
  -- treats severity='error' on parent relationships as a signal to drop that
  -- parent from the comparison vector (so a wrongly-linked parent doesn't
  -- inflate parent_match for unrelated people).
  CREATE TABLE IF NOT EXISTS data_anomalies (
    source_id  INTEGER NOT NULL,
    indi_id    TEXT NOT NULL,
    kind       TEXT NOT NULL,
    severity   TEXT NOT NULL,
    detail     TEXT,
    PRIMARY KEY (source_id, indi_id, kind)
  );
  CREATE INDEX IF NOT EXISTS idx_anom_indi ON data_anomalies(source_id, indi_id);
  CREATE INDEX IF NOT EXISTS idx_anom_kind ON data_anomalies(kind);
`);

// Idempotent column migrations for v2.5 review labels. SQLite lacks
// "ALTER TABLE ADD COLUMN IF NOT EXISTS"; probe and add manually.
function ensureColumn(table, name, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}
ensureColumn("person_links", "label_reason", "TEXT");
ensureColumn("person_links", "label_confidence", "INTEGER");

// Reject duplicate-name uploads up front rather than after the parse work.
const dupe = db.prepare("SELECT id FROM sources WHERE name = ?").get(sourceName);
if (dupe) {
  console.error(`source name "${sourceName}" already exists (id=${dupe.id}); delete it first or pick a different name`);
  process.exit(3);
}

// Allocate source_id by inserting the row first; counts get filled in below.
const insSource = db.prepare(
  "INSERT INTO sources (name, loaded_at, n_individuals, n_events, n_families) VALUES (?, ?, 0, 0, 0)",
);
const sourceInsert = insSource.run(sourceName, new Date().toISOString());
const sourceId = Number(sourceInsert.lastInsertRowid);
console.error(`Allocated source_id=${sourceId} for "${sourceName}"`);

const insIndi  = db.prepare("INSERT INTO individuals (source_id,id,name,sex,birth_year,death_year,famc) VALUES (?,?,?,?,?,?,?)");
const insFam   = db.prepare("INSERT INTO families (source_id,id,husb_id,wife_id) VALUES (?,?,?,?)");
const insChil  = db.prepare("INSERT INTO family_children (source_id,family_id,child_id) VALUES (?,?,?)");
const insEvent = db.prepare("INSERT INTO events (source_id,individual_id,type,year,place,lat,lon,geo_level,geo_cc,geo_st) VALUES (?,?,?,?,?,?,?,?,?,?)");
const insGeo   = db.prepare("INSERT INTO events_geo (rowid,min_lat,max_lat,min_lon,max_lon) VALUES (?,?,?,?,?)");
const updSource = db.prepare("UPDATE sources SET n_individuals = ?, n_events = ?, n_families = ? WHERE id = ?");

const eventByIndi = new Map();
for (const e of events) {
  let arr = eventByIndi.get(e.indi_id);
  if (!arr) { arr = []; eventByIndi.set(e.indi_id, arr); }
  arr.push(e);
}

const tx = db.transaction(() => {
  for (const ind of indis.values()) {
    const myEvents = eventByIndi.get(ind.id) || [];
    let by = null, dy = null;
    for (const e of myEvents) {
      if (e.type === "BIRT" && by === null) by = e.year;
      if (e.type === "DEAT" && dy === null) dy = e.year;
    }
    insIndi.run(sourceId, ind.id, ind.name, ind.sex, by, dy, ind.famc);
    for (const e of myEvents) {
      const info = insEvent.run(
        sourceId, ind.id, e.type, e.year, e.place,
        e.lat ?? null, e.lon ?? null,
        e.geo_level ?? null, e.geo_cc ?? null, e.geo_st ?? null,
      );
      if (e.lat != null && e.lon != null) {
        insGeo.run(info.lastInsertRowid, e.lat, e.lat, e.lon, e.lon);
      }
    }
  }
  for (const fam of fams.values()) {
    insFam.run(sourceId, fam.id, fam.husb, fam.wife);
    for (const c of fam.chil) insChil.run(sourceId, fam.id, c);
  }
  updSource.run(indis.size, events.length, fams.size, sourceId);
});
tx();
db.close();
console.error(`Wrote source_id=${sourceId} "${sourceName}" to ${dbPath}`);
