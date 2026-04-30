#!/usr/bin/env node
// Cross-source record linker for the multi-source GEDCOM SQLite database.
//
// Algorithm: blocking on multiple keys (Soundex/NYSIIS over given+surname,
// birth decade, geo state) → all-pairs scoring within each bucket → union-find
// to materialize equivalence classes.
//
// Complexity: O(N + F + Σ|b|²) where N = persons, F = facts (events for parent
// indexing), |b| = bucket size. With well-chosen blocking keys, the largest
// bucket dominates: O(N + F + M²) in practice.
//
// Usage:
//   node scripts/link-records.mjs <DB.db>
//   node scripts/link-records.mjs <DB.db> --review-threshold 0.65 --match-threshold 0.85
//
// Wipes prior `origin LIKE 'auto:%'` rows before re-running. Manual confirms /
// rejects (origin LIKE 'manual:%') are preserved.

import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import {
  canonicalGiven, canonicalSurname,
  soundex, nysiis, jaroWinkler, birthDecade,
} from "./lib/name-norm.mjs";

const args = process.argv.slice(2);
const dbPath = args[0];
function flag(name, def) {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : def;
}
const REVIEW_THRESHOLD = parseFloat(flag("review-threshold", "0.65"));
const MATCH_THRESHOLD  = parseFloat(flag("match-threshold",  "0.85"));
const VERBOSE          = args.includes("--verbose");

if (!dbPath) {
  console.error("usage: node scripts/link-records.mjs <DB.db>");
  process.exit(2);
}
if (!existsSync(dbPath)) {
  console.error(`DB does not exist: ${dbPath}`);
  process.exit(2);
}

const db = new Database(dbPath);
db.pragma("journal_mode = delete");

// Verify schema exists
const haveSources = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sources'").get();
if (!haveSources) {
  console.error("schema mismatch: this DB has no `sources` table; rebuild with multi-source gedcom-to-sqlite.mjs first");
  process.exit(2);
}

// Veto rules — uncalibrated but conservative. Once we have a labeled review
// set, fit logistic regression on the same evidence vector and drop these.
const VETO_BIRTH_YEAR_DIFF = 12;   // |birth_year_a - birth_year_b| > this → drop
const VETO_SURNAME_MIN_JW  = 0.40; // when BOTH surnames present, JW below this → drop
// (sex mismatch is also a hard drop; see scorePair)

// Load all persons + their birth event (for state) + their parents' names.
const t0 = Date.now();
const persons = db.prepare(`
  SELECT i.source_id, i.id, i.name, i.sex, i.birth_year, i.death_year, i.famc
  FROM individuals i
`).all();
const sourceCount = db.prepare("SELECT COUNT(*) AS n FROM sources").get().n;
console.error(`Loaded ${persons.length.toLocaleString()} persons across ${sourceCount} source(s)`);

// Birth events index for geo_st.
const birthEvents = db.prepare(`
  SELECT source_id, individual_id, geo_cc, geo_st
  FROM events WHERE type = 'BIRT'
`).all();
const birthByPerson = new Map();  // "src|id" -> {cc, st}
for (const e of birthEvents) {
  birthByPerson.set(`${e.source_id}|${e.individual_id}`, { cc: e.geo_cc, st: e.geo_st });
}

// Family-as-child lookup: famc → {husb, wife} per source. We need parent names
// for the parent-name-match feature.
const familiesRows = db.prepare("SELECT source_id, id, husb_id, wife_id FROM families").all();
const familyByKey = new Map();  // "src|famid" -> {husb_id, wife_id}
for (const f of familiesRows) {
  familyByKey.set(`${f.source_id}|${f.id}`, { husb_id: f.husb_id, wife_id: f.wife_id });
}

// Quick name lookup so we can resolve parent ids → names within a source.
const personName = new Map();  // "src|id" -> name
for (const p of persons) personName.set(`${p.source_id}|${p.id}`, p.name);

// Pull error-severity anomalies that flag a parent relationship as suspect.
// When present, drop that parent from the comparison vector — a wrongly-linked
// parent (e.g. mother dead at child's birth) shouldn't inflate parent_match.
const suspectMother = new Set();  // "src|child_id"
const suspectFather = new Set();
const haveAnoms = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='data_anomalies'").get();
if (haveAnoms) {
  const anoms = db.prepare(
    "SELECT source_id, indi_id, kind FROM data_anomalies WHERE severity = 'error'"
  ).all();
  for (const a of anoms) {
    const key = `${a.source_id}|${a.indi_id}`;
    if (a.kind === "mother_unborn_at_child_birth" || a.kind === "mother_dead_at_birth") suspectMother.add(key);
    if (a.kind === "father_unborn_at_child_birth" || a.kind === "father_dead_before_birth") suspectFather.add(key);
  }
  console.error(`Loaded data anomalies: ${suspectMother.size} children with suspect mother, ${suspectFather.size} with suspect father`);
}

// Build the canonical record for each person we will compare on.
function buildRecord(p) {
  const givenC   = canonicalGiven(p.name);
  const surC     = canonicalSurname(p.name);
  const surSdx   = soundex(surC);
  const surNys   = nysiis(surC);
  const givNys   = nysiis(givenC);
  const dec      = birthDecade(p.birth_year);
  const birthKey = birthByPerson.get(`${p.source_id}|${p.id}`) || {};
  let fatherSur = null, motherSur = null;
  if (p.famc) {
    const fam = familyByKey.get(`${p.source_id}|${p.famc}`);
    if (fam) {
      const personKey = `${p.source_id}|${p.id}`;
      const fa = (fam.husb_id && !suspectFather.has(personKey))
        ? personName.get(`${p.source_id}|${fam.husb_id}`)
        : null;
      const mo = (fam.wife_id && !suspectMother.has(personKey))
        ? personName.get(`${p.source_id}|${fam.wife_id}`)
        : null;
      fatherSur = canonicalSurname(fa);
      motherSur = canonicalSurname(mo);
    }
  }
  return {
    source_id: p.source_id, id: p.id, name: p.name,
    sex: p.sex || null,
    given: givenC, surname: surC,
    surSdx, surNys, givNys,
    birth_year: p.birth_year, decade: dec,
    geo_cc: birthKey.cc || null, geo_st: birthKey.st || null,
    father_surname: fatherSur, mother_surname: motherSur,
  };
}

const records = persons.map(buildRecord);
console.error(`Built canonical records in ${Date.now() - t0} ms`);

// Blocking. K=4 passes; each person enters up to K buckets.
function blockingKeys(r) {
  const keys = [];
  if (r.surSdx && r.decade != null)
    keys.push("K1:" + r.surSdx + ":" + r.decade);
  if (r.givNys && r.surNys)
    keys.push("K2:" + r.givNys + ":" + r.surNys);
  if (r.surSdx && r.geo_st)
    keys.push("K3:" + r.surSdx + ":" + r.geo_st);
  if (r.father_surname && r.decade != null)
    keys.push("K4:" + soundex(r.father_surname) + ":" + r.decade);
  return keys;
}

const buckets = new Map();
for (let i = 0; i < records.length; i++) {
  for (const k of blockingKeys(records[i])) {
    let arr = buckets.get(k);
    if (!arr) { arr = []; buckets.set(k, arr); }
    arr.push(i);
  }
}

// Bucket size diagnostics
let bucketTotal = 0, biggest = 0, biggestKey = null;
for (const [k, arr] of buckets) {
  bucketTotal += arr.length;
  if (arr.length > biggest) { biggest = arr.length; biggestKey = k; }
}
console.error(`Blocked into ${buckets.size.toLocaleString()} buckets; ${bucketTotal.toLocaleString()} person-bucket entries; max bucket ${biggest} (${biggestKey})`);

// Score one pair. Weights sum to 1.0. Returns null on a hard veto.
const vetoStats = { sex: 0, birthYear: 0, surname: 0 };
function scorePair(a, b) {
  // Hard vetoes — drop the pair entirely. These keep noisy mid-band false
  // positives out of the review queue without needing labeled data first.
  if (a.sex && b.sex && a.sex !== b.sex && a.sex !== "U" && b.sex !== "U") {
    vetoStats.sex++; return null;
  }
  if (Number.isFinite(a.birth_year) && Number.isFinite(b.birth_year)
      && Math.abs(a.birth_year - b.birth_year) > VETO_BIRTH_YEAR_DIFF) {
    vetoStats.birthYear++; return null;
  }
  if (a.surname && b.surname) {
    const jw = jaroWinkler(a.surname, b.surname);
    if (jw < VETO_SURNAME_MIN_JW) { vetoStats.surname++; return null; }
  }

  const evidence = {};
  let total = 0;

  // 0.25: jaroWinkler given
  const givSim = jaroWinkler(a.given, b.given);
  total += 0.25 * givSim; evidence.given = +givSim.toFixed(3);

  // 0.25: jaroWinkler surname
  const surSim = jaroWinkler(a.surname, b.surname);
  total += 0.25 * surSim; evidence.surname = +surSim.toFixed(3);

  // 0.20: birth-year proximity (0 at >5 years apart, 1 if equal)
  let byProx = 0;
  if (Number.isFinite(a.birth_year) && Number.isFinite(b.birth_year)) {
    const d = Math.abs(a.birth_year - b.birth_year);
    byProx = d === 0 ? 1 : Math.max(0, 1 - d / 5);
  }
  total += 0.20 * byProx; evidence.birth = +byProx.toFixed(3);

  // 0.20: parent surname match (either parent matching counts)
  let parentSim = 0;
  for (const ap of [a.father_surname, a.mother_surname]) {
    if (!ap) continue;
    for (const bp of [b.father_surname, b.mother_surname]) {
      if (!bp) continue;
      const s = jaroWinkler(ap, bp);
      if (s > parentSim) parentSim = s;
    }
  }
  total += 0.20 * parentSim; evidence.parents = +parentSim.toFixed(3);

  // 0.10: geo-state match (same admin1)
  let geoSim = 0;
  if (a.geo_cc && b.geo_cc && a.geo_cc === b.geo_cc) {
    if (a.geo_st && b.geo_st && a.geo_st === b.geo_st) geoSim = 1;
    else geoSim = 0.5;
  }
  total += 0.10 * geoSim; evidence.geo = +geoSim.toFixed(3);

  return { total, evidence };
}

// Score within each bucket, dedupe by canonical pair key.
const candidatePairs = new Map();  // "minKey~maxKey" -> {a, b, score, evidence}
let totalScored = 0;
for (const arr of buckets.values()) {
  if (arr.length < 2) continue;
  for (let i = 0; i < arr.length; i++) {
    const a = records[arr[i]];
    for (let j = i + 1; j < arr.length; j++) {
      const b = records[arr[j]];
      // Different sources only — same-source dedup is a separate problem.
      if (a.source_id === b.source_id) continue;
      const ka = a.source_id + "|" + a.id;
      const kb = b.source_id + "|" + b.id;
      const pairKey = ka < kb ? ka + "~" + kb : kb + "~" + ka;
      if (candidatePairs.has(pairKey)) continue;
      totalScored++;
      const sc = scorePair(a, b);
      if (sc === null) continue;
      if (sc.total < REVIEW_THRESHOLD) continue;
      candidatePairs.set(pairKey, { a, b, score: sc.total, evidence: sc.evidence });
    }
  }
}
const vetoTotal = vetoStats.sex + vetoStats.birthYear + vetoStats.surname;
console.error(`Scored ${totalScored.toLocaleString()} unique pairs; vetoed ${vetoTotal.toLocaleString()} (sex=${vetoStats.sex}, birth=${vetoStats.birthYear}, surname=${vetoStats.surname}); ${candidatePairs.size.toLocaleString()} above review threshold ${REVIEW_THRESHOLD}`);

// One-to-one constraint: each person matches at most ONE other person per
// other source. Greedy by score descending — picks the highest-scoring
// non-conflicting pair, drops the rest. Prevents single-link clustering from
// merging sibling sets via shared-parent + close-birth-year evidence.
{
  const sortedPairs = Array.from(candidatePairs.entries())
    .sort((a, b) => b[1].score - a[1].score);
  const usedFor = new Map();  // "srcA|indiA|srcB" -> indiB already claimed
  const survivors = new Map();
  let dominated = 0;
  for (const [pairKey, cp] of sortedPairs) {
    const a = cp.a, b = cp.b;
    const aSlot = a.source_id + "|" + a.id + "|" + b.source_id;
    const bSlot = b.source_id + "|" + b.id + "|" + a.source_id;
    const aClaim = usedFor.get(aSlot);
    const bClaim = usedFor.get(bSlot);
    if (aClaim && aClaim !== b.id) { dominated++; continue; }
    if (bClaim && bClaim !== a.id) { dominated++; continue; }
    usedFor.set(aSlot, b.id);
    usedFor.set(bSlot, a.id);
    survivors.set(pairKey, cp);
  }
  candidatePairs.clear();
  for (const [k, v] of survivors) candidatePairs.set(k, v);
  console.error(`One-to-one: kept ${survivors.size.toLocaleString()}, dropped ${dominated.toLocaleString()} dominated pairs`);
}

// Wipe prior auto links; preserve manual.
db.prepare("DELETE FROM person_links WHERE origin LIKE 'auto:%'").run();
const insLink = db.prepare(`
  INSERT INTO person_links (source_a, indi_a, source_b, indi_b, score, evidence, origin, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (source_a, indi_a, source_b, indi_b) DO UPDATE SET
    score = excluded.score,
    evidence = excluded.evidence,
    origin = CASE WHEN person_links.origin LIKE 'manual:%' THEN person_links.origin ELSE excluded.origin END
`);
const now = new Date().toISOString();
const ORIGIN = "auto:multi-pass-blocking-v1";
let inserted = 0, autoMatch = 0, reviewQueue = 0;
const tx = db.transaction(() => {
  for (const cp of candidatePairs.values()) {
    const a = cp.a, b = cp.b;
    // Always store with (source_a, indi_a) being the lexicographically smaller pair so reverse lookups work.
    let sa = a.source_id, ia = a.id, sb = b.source_id, ib = b.id;
    if (`${sb}|${ib}` < `${sa}|${ia}`) { [sa, sb] = [sb, sa]; [ia, ib] = [ib, ia]; }
    insLink.run(sa, ia, sb, ib, cp.score, JSON.stringify(cp.evidence), ORIGIN, now);
    inserted++;
    if (cp.score >= MATCH_THRESHOLD) autoMatch++;
    else reviewQueue++;
  }
});
tx();
console.error(`Inserted ${inserted} candidate links: ${autoMatch} auto-match (≥${MATCH_THRESHOLD}), ${reviewQueue} review queue`);

// Materialize person_clusters via union-find over confirmed + auto-match links.
db.prepare("DELETE FROM person_clusters").run();
const clusterEdges = db.prepare(`
  SELECT source_a, indi_a, source_b, indi_b
  FROM person_links
  WHERE (origin LIKE 'auto:%' AND score >= ?) OR origin = 'manual:confirmed'
`).all(MATCH_THRESHOLD);
const parent = new Map();
function find(x) {
  let p = parent.get(x);
  if (p === undefined) { parent.set(x, x); return x; }
  while (p !== x) { parent.set(x, parent.get(p) ?? p); x = p; p = parent.get(x) ?? x; }
  return x;
}
function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); }
// Seed with every linked person so singletons get their own cluster id only if needed.
for (const e of clusterEdges) {
  const ka = e.source_a + "|" + e.indi_a, kb = e.source_b + "|" + e.indi_b;
  find(ka); find(kb); union(ka, kb);
}
const componentToId = new Map();
let nextClusterId = 1;
const insCluster = db.prepare("INSERT INTO person_clusters (cluster_id, source_id, indi_id) VALUES (?, ?, ?)");
const txCluster = db.transaction(() => {
  for (const key of parent.keys()) {
    const root = find(key);
    let cid = componentToId.get(root);
    if (cid === undefined) { cid = nextClusterId++; componentToId.set(root, cid); }
    const [src, indi] = key.split("|", 2);
    insCluster.run(cid, Number(src), indi);
  }
});
txCluster();
console.error(`Built ${componentToId.size} clusters across ${parent.size} linked persons`);

if (VERBOSE && candidatePairs.size > 0) {
  console.error("\nTop-10 highest-scoring links:");
  const sorted = Array.from(candidatePairs.values()).sort((a, b) => b.score - a.score).slice(0, 10);
  for (const cp of sorted) {
    console.error(`  ${cp.score.toFixed(3)}  [${cp.a.source_id}] ${cp.a.name}  ↔  [${cp.b.source_id}] ${cp.b.name}  ev=${JSON.stringify(cp.evidence)}`);
  }
}

db.close();
console.error(`Done in ${Date.now() - t0} ms`);
