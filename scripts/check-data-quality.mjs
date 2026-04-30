#!/usr/bin/env node
// Spot likely errors in genealogical source data and write them to
// data_anomalies. The record linker consults this table and drops parent
// fields on the affected child when severity='error', so a wrongly-linked
// mother/father doesn't inflate parent_match and drag false positives in.
//
// Anomaly kinds (severity in parens):
//   death_before_birth                (error)   death year < birth year
//   implausible_lifespan              (warning) age > 122 years
//   mother_unborn_at_child_birth      (error)   child born before mother's birth
//   mother_dead_at_birth              (error)   mother died before child's birth
//   mother_too_young                  (warning) mother < 12 at child's birth
//   mother_too_old                    (warning) mother > 55 at child's birth (modern egg
//                                               freezing pushes higher; bumped if needed)
//   father_unborn_at_child_birth      (error)   child born before father's birth
//   father_dead_before_birth          (error)   child born >9mo after father's death
//   father_too_young                  (warning) father < 13 at child's birth
//   father_too_old                    (warning) father > 80 at child's birth
//
// Severity does NOT auto-correct the data — it just flags it for the linker
// and the review UI. Manual edits in the source GEDCOM are still the canonical
// fix.
//
// Usage: node scripts/check-data-quality.mjs <DB.db>

import { existsSync } from "node:fs";
import Database from "better-sqlite3";

const dbPath = process.argv[2];
if (!dbPath) { console.error("usage: node check-data-quality.mjs <db>"); process.exit(2); }
if (!existsSync(dbPath)) { console.error(`DB does not exist: ${dbPath}`); process.exit(2); }

const db = new Database(dbPath);
db.pragma("journal_mode = delete");

// Ensure the table exists (also created by gedcom-to-sqlite.mjs; idempotent).
db.exec(`
  CREATE TABLE IF NOT EXISTS data_anomalies (
    source_id INTEGER NOT NULL,
    indi_id   TEXT NOT NULL,
    kind      TEXT NOT NULL,
    severity  TEXT NOT NULL,
    detail    TEXT,
    PRIMARY KEY (source_id, indi_id, kind)
  );
  CREATE INDEX IF NOT EXISTS idx_anom_indi ON data_anomalies(source_id, indi_id);
  CREATE INDEX IF NOT EXISTS idx_anom_kind ON data_anomalies(kind);
`);

// Re-run from scratch each pass — anomalies are derived state.
db.prepare("DELETE FROM data_anomalies").run();

const ins = db.prepare(`
  INSERT OR REPLACE INTO data_anomalies (source_id, indi_id, kind, severity, detail)
  VALUES (?, ?, ?, ?, ?)
`);

const t0 = Date.now();
const counts = {};
function record(source_id, indi_id, kind, severity, detail) {
  ins.run(source_id, indi_id, kind, severity, detail ? JSON.stringify(detail) : null);
  counts[kind] = (counts[kind] || 0) + 1;
}

// --- Lifespan / date-order ---
const indiRows = db.prepare(
  "SELECT source_id, id, birth_year, death_year FROM individuals " +
  "WHERE birth_year IS NOT NULL OR death_year IS NOT NULL"
).all();
for (const r of indiRows) {
  if (r.birth_year != null && r.death_year != null) {
    if (r.death_year < r.birth_year) {
      record(r.source_id, r.id, "death_before_birth", "error",
        { birth: r.birth_year, death: r.death_year });
    } else if (r.death_year - r.birth_year > 122) {
      record(r.source_id, r.id, "implausible_lifespan", "warning",
        { birth: r.birth_year, death: r.death_year, age: r.death_year - r.birth_year });
    }
  }
}

// --- Parent age at child's birth ---
// Joins each (family, child) with the husband and wife births/deaths.
const fams = db.prepare(`
  SELECT f.source_id, f.id AS fam_id,
         f.husb_id, hi.birth_year AS husb_birth, hi.death_year AS husb_death,
         f.wife_id, wi.birth_year AS wife_birth, wi.death_year AS wife_death,
         fc.child_id, ci.birth_year AS child_birth
  FROM families f
  JOIN family_children fc ON fc.source_id = f.source_id AND fc.family_id = f.id
  JOIN individuals ci ON ci.source_id = f.source_id AND ci.id = fc.child_id
  LEFT JOIN individuals hi ON hi.source_id = f.source_id AND hi.id = f.husb_id
  LEFT JOIN individuals wi ON wi.source_id = f.source_id AND wi.id = f.wife_id
  WHERE ci.birth_year IS NOT NULL
`).all();

for (const r of fams) {
  // Father side
  if (r.husb_id && r.husb_birth != null) {
    const age = r.child_birth - r.husb_birth;
    if (age < 0) {
      record(r.source_id, r.child_id, "father_unborn_at_child_birth", "error",
        { father: r.husb_id, father_birth: r.husb_birth, child_birth: r.child_birth });
    } else if (age < 13) {
      record(r.source_id, r.child_id, "father_too_young", "warning",
        { father: r.husb_id, father_age: age });
    } else if (age > 80) {
      record(r.source_id, r.child_id, "father_too_old", "warning",
        { father: r.husb_id, father_age: age });
    }
  }
  // Posthumous father is allowed up to ~9 months (we only have year precision,
  // so use 1 year as the slack — death_year+1 still being plausible).
  if (r.husb_id && r.husb_death != null && r.child_birth - r.husb_death > 1) {
    record(r.source_id, r.child_id, "father_dead_before_birth", "error",
      { father: r.husb_id, father_death: r.husb_death, child_birth: r.child_birth });
  }
  // Mother side
  if (r.wife_id && r.wife_birth != null) {
    const age = r.child_birth - r.wife_birth;
    if (age < 0) {
      record(r.source_id, r.child_id, "mother_unborn_at_child_birth", "error",
        { mother: r.wife_id, mother_birth: r.wife_birth, child_birth: r.child_birth });
    } else if (age < 12) {
      record(r.source_id, r.child_id, "mother_too_young", "warning",
        { mother: r.wife_id, mother_age: age });
    } else if (age > 55) {
      record(r.source_id, r.child_id, "mother_too_old", "warning",
        { mother: r.wife_id, mother_age: age });
    }
  }
  if (r.wife_id && r.wife_death != null && r.child_birth - r.wife_death > 0) {
    record(r.source_id, r.child_id, "mother_dead_at_birth", "error",
      { mother: r.wife_id, mother_death: r.wife_death, child_birth: r.child_birth });
  }
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.error(`Found ${total} anomalies in ${Date.now() - t0} ms:`);
for (const [kind, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.error(`  ${n.toString().padStart(5)} ${kind}`);
}

db.close();
