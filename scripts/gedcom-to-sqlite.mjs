#!/usr/bin/env node
// Convert a GEDCOM file to a SQLite database the chat proxy can query.
// Usage: node scripts/gedcom-to-sqlite.mjs <PATH.ged> <OUT.db>

import { readFileSync, unlinkSync, existsSync } from "node:fs";
import Database from "better-sqlite3";

const [, , gedPath, outPath] = process.argv;
if (!gedPath || !outPath) {
  console.error("usage: node scripts/gedcom-to-sqlite.mjs <PATH.ged> <OUT.db>");
  process.exit(2);
}

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

const indis = new Map();   // id -> {name, sex, famc, fams[]}
const fams = new Map();    // id -> {husb, wife, chil[]}
const events = [];         // {indi_id, type, year, place}

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

if (existsSync(outPath)) unlinkSync(outPath);
const db = new Database(outPath);
db.pragma("journal_mode = wal");
db.exec(`
  CREATE TABLE individuals (
    id          TEXT PRIMARY KEY,
    name        TEXT,
    sex         TEXT,         -- 'M' | 'F' | 'U'
    birth_year  INTEGER,
    death_year  INTEGER,
    famc        TEXT          -- family-as-child id
  );
  CREATE TABLE events (
    individual_id TEXT NOT NULL,
    type          TEXT NOT NULL, -- BIRT|DEAT|RESI|MARR|EMIG|IMMI|CENS|BAPM|BURI|CHR
    year          INTEGER,
    place         TEXT,
    FOREIGN KEY (individual_id) REFERENCES individuals(id)
  );
  CREATE TABLE families (
    id      TEXT PRIMARY KEY,
    husb_id TEXT,
    wife_id TEXT
  );
  CREATE TABLE family_children (
    family_id TEXT NOT NULL,
    child_id  TEXT NOT NULL,
    FOREIGN KEY (family_id) REFERENCES families(id),
    FOREIGN KEY (child_id)  REFERENCES individuals(id)
  );
  CREATE INDEX idx_events_indi  ON events(individual_id);
  CREATE INDEX idx_events_type  ON events(type);
  CREATE INDEX idx_events_year  ON events(year);
  CREATE INDEX idx_events_place ON events(place);
  CREATE INDEX idx_indi_name    ON individuals(name);
  CREATE INDEX idx_indi_birth   ON individuals(birth_year);
  CREATE INDEX idx_fam_husb     ON families(husb_id);
  CREATE INDEX idx_fam_wife     ON families(wife_id);
  CREATE INDEX idx_famchil_fam  ON family_children(family_id);
  CREATE INDEX idx_famchil_chil ON family_children(child_id);
`);

const insIndi = db.prepare("INSERT INTO individuals (id,name,sex,birth_year,death_year,famc) VALUES (?,?,?,?,?,?)");
const insFam = db.prepare("INSERT INTO families (id,husb_id,wife_id) VALUES (?,?,?)");
const insChil = db.prepare("INSERT INTO family_children (family_id,child_id) VALUES (?,?)");
const insEvent = db.prepare("INSERT INTO events (individual_id,type,year,place) VALUES (?,?,?,?)");

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
    insIndi.run(ind.id, ind.name, ind.sex, by, dy, ind.famc);
    for (const e of myEvents) insEvent.run(ind.id, e.type, e.year, e.place);
  }
  for (const fam of fams.values()) {
    insFam.run(fam.id, fam.husb, fam.wife);
    for (const c of fam.chil) insChil.run(fam.id, c);
  }
});
tx();
db.close();
console.error(`Wrote ${outPath}`);
