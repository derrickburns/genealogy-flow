#!/usr/bin/env node
/**
 * Seeds a catalog GEDCOM into:
 *   - D1 tables: demo_individuals, demo_events, demo_families, demo_sources (optional legacy demo path)
 *   - R2: demo/<slug>.json  (pre-processed JSON for VIP catalog loading)
 *   - R2: demo/demo.json    (sanitized public demo when slug is golden-rosenberg)
 *
 * Prereqs:
 *   - wrangler.toml with correct database_id and bucket name
 *   - A GEDCOM file in the project root (or pass path as first arg)
 *   - gazetteer.json in the project root (or skip geocoding if absent)
 *
 * Usage:
 *   node scripts/seed-demo.mjs [path/to/file.ged] [path/to/gazetteer.json] [catalog-slug]
 *   CLOUDFLARE_API_TOKEN=... node scripts/seed-demo.mjs
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EVENT_TAGS_SET = new Set(["BIRT","DEAT","RESI","MARR","EMIG","IMMI","CENS","BAPM","BURI","CHR","OCCU","EDUC","RELI","NATU","WILL"]);
function isEventTag(tag) { return EVENT_TAGS_SET.has(tag); }
function extractYear(dateStr) {
  const m = /\b(1[0-9]{3}|20[0-2][0-9])\b/.exec(dateStr);
  return m ? parseInt(m[1], 10) : null;
}

const gedPath = process.argv[2] ?? "Golden-Rosenberg.ged";
const gazPath = process.argv[3] ?? "gazetteer.json";
const catalogSlug = (process.argv[4] ?? "golden-rosenberg").toLowerCase();
if (catalogSlug === "demo") {
  console.error("Catalog slug 'demo' is reserved for the sanitized public DEMO dataset.");
  process.exit(1);
}

if (!existsSync(gedPath)) {
  console.error(`GEDCOM file not found: ${gedPath}`);
  console.error("Usage: node scripts/seed-demo.mjs [path/to/Golden-Rosenberg.ged] [path/to/gazetteer.json]");
  process.exit(1);
}

console.log(`Parsing ${gedPath}...`);
const gedcom = parseGedcom(readFileSync(gedPath, "utf8"));
console.log(`  ${gedcom.individuals.size} individuals, ${gedcom.families.size} families, ${gedcom.sources.size} sources`);

// Load gazetteer for geocoding (optional)
let gazetteer = null;
if (existsSync(gazPath)) {
  console.log(`Loading gazetteer from ${gazPath}...`);
  gazetteer = JSON.parse(readFileSync(gazPath, "utf8"));
  console.log(`  ${Object.keys(gazetteer).length} place entries`);
} else {
  console.log("No gazetteer.json found - skipping geocoding (lat/lon will be null)");
}

function geocode(place) {
  if (!gazetteer || !place) return { lat: null, lon: null };
  const norm = place.toLowerCase().trim();
  const entry = gazetteer[norm];
  if (entry) return { lat: entry.lat, lon: entry.lon };
  return { lat: null, lon: null };
}

const LIVING_MAX_AGE = 115;
function nameLooksPrivate(value) {
  return /\b(living|private|redacted|withheld)\b/i.test(String(value ?? ""));
}
function hasExplicitDeathEvidence(ind) {
  if (ind.death_year != null) return true;
  return (ind.events || []).some(e => e.tag === "DEAT" && (e.year != null || e.date || e.place));
}
function isPrivateDemoPerson(ind, currentYear = new Date().getUTCFullYear()) {
  if (nameLooksPrivate(ind.name)) return true;
  if (hasExplicitDeathEvidence(ind)) return false;
  if (ind.birth_year == null) return true;
  return currentYear - ind.birth_year < LIVING_MAX_AGE;
}

function sanitizePublicDemo(input) {
  const currentYear = new Date().getUTCFullYear();
  const livingIds = new Set();
  const livingLabels = new Map();
  let livingCount = 0;
  const individuals = input.individuals.map(ind => {
    const living = isPrivateDemoPerson(ind, currentYear);
    if (living) {
      livingCount++;
      livingIds.add(ind.id);
      livingLabels.set(ind.id, `Living person ${livingCount}`);
    }
    return {
      id: ind.id,
      name: living ? livingLabels.get(ind.id) : ind.name,
      sex: living ? "U" : ind.sex,
      birth_year: living ? null : ind.birth_year,
      death_year: living ? null : ind.death_year,
      famc: living ? null : ind.famc,
      fams: living ? [] : ind.fams,
      events: living ? [] : (ind.events || []).map(e => ({ ...e, sources: [] })),
      notes: [],
      sources: [],
    };
  });
  const families = input.families.map(fam => {
    const members = [fam.husb, fam.wife, ...(fam.chil || [])].filter(Boolean);
    const hasLivingMember = members.some(id => livingIds.has(id));
    return {
      id: fam.id,
      husb: fam.husb && livingIds.has(fam.husb) ? null : fam.husb,
      wife: fam.wife && livingIds.has(fam.wife) ? null : fam.wife,
      chil: (fam.chil || []).filter(id => !livingIds.has(id)),
      marr: hasLivingMember ? null : fam.marr,
      div: hasLivingMember ? null : fam.div,
    };
  }).filter(fam => fam.husb || fam.wife || (fam.chil || []).length);
  return {
    individuals,
    families,
    sources: [],
    privacy: {
      tier: "public-demo",
      living_people: "anonymized",
      living_details: "removed",
    },
  };
}

// Build the processed JSON blob (same format as parse-gedcom output)
const EVENT_TAGS = new Set(["BIRT","DEAT","RESI","MARR","EMIG","IMMI","CENS","BAPM","BURI","CHR"]);
const demoJson = {
  individuals: [],
  families: [],
  sources: [],
};

for (const [id, ind] of gedcom.individuals) {
  const events = ind.events
    .filter(e => EVENT_TAGS.has(e.tag))
    .map(e => ({
      tag: e.tag,
      date: e.date || null,
      year: e.year,
      place: e.place || null,
      ...geocode(e.place),
      sources: e.sources.map(s => ({ src_id: s.src_id, page: s.page, url: s.url })),
    }));
  demoJson.individuals.push({
    id,
    name: ind.name || null,
    sex: ind.sex || null,
    birth_year: ind.events.find(e => e.tag === "BIRT")?.year ?? null,
    death_year: ind.events.find(e => e.tag === "DEAT")?.year ?? null,
    famc: ind.famc,
    fams: ind.fams,
    events,
    notes: ind.notes,
    sources: ind.sources.map(s => ({ src_id: s.src_id, page: s.page, url: s.url })),
  });
}

for (const [id, fam] of gedcom.families) {
  demoJson.families.push({ id, husb: fam.husb, wife: fam.wife, chil: fam.chil,
    marr: fam.marr ? { date: fam.marr.date, year: fam.marr.year, place: fam.marr.place } : null,
    div: fam.div ? { date: fam.div.date, year: fam.div.year } : null,
  });
}

for (const [id, src] of gedcom.sources) {
  demoJson.sources.push({ id, title: src.title, auth: src.auth, publ: src.publ });
}

const jsonPath = join(tmpdir(), `${catalogSlug}.json`);
writeFileSync(jsonPath, JSON.stringify(demoJson));
console.log(`\nWritten demo JSON (${(Buffer.byteLength(readFileSync(jsonPath)) / 1024).toFixed(1)} KB)`);

const publicDemoJson = sanitizePublicDemo(demoJson);
const publicJsonPath = join(tmpdir(), "demo-public.json");
writeFileSync(publicJsonPath, JSON.stringify(publicDemoJson));
console.log(`Written sanitized public DEMO JSON (${(Buffer.byteLength(readFileSync(publicJsonPath)) / 1024).toFixed(1)} KB)`);

// SQLite single-quoted string literal helper
function sqlStr(v) {
  if (v == null) return "NULL";
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function sqlNum(v) { return v != null ? v : "NULL"; }

// Upload to R2 via Cloudflare REST API (fast - no wrangler startup overhead)
const CF_ACCOUNT = "210e31e10a253d4117ed00eac6fa2ff8";
const D1_DB_ID  = "8c0eda38-4eb8-4c2f-b6c2-dafc96c2c059";
const CF_TOKEN  = process.env.CLOUDFLARE_API_TOKEN;
if (!CF_TOKEN) { console.error("CLOUDFLARE_API_TOKEN not set"); process.exit(1); }

async function r2Put(key, filePath, contentType) {
  const data = readFileSync(filePath);
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/r2/buckets/genealogy-flow/objects/${key}`,
    { method: "PUT", headers: { "Authorization": `Bearer ${CF_TOKEN}`, "Content-Type": contentType }, body: data }
  );
  if (!resp.ok) throw new Error(`R2 PUT ${key} failed: ${resp.status} ${await resp.text()}`);
}

// D1 REST API - execute SQL directly, no wrangler per-call overhead
async function d1Query(sql) {
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/d1/database/${D1_DB_ID}/query`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
    }
  );
  const j = await resp.json();
  if (!resp.ok || j.success === false) throw new Error(`D1 query failed: ${JSON.stringify(j.errors ?? j)}`);
  return j;
}

console.log(`\nUploading catalog JSON to R2 as demo/${catalogSlug}.json...`);
await r2Put(`demo/${catalogSlug}.json`, jsonPath, "application/json");
console.log("  done");

if (catalogSlug === "golden-rosenberg") {
  console.log("Uploading sanitized public DEMO JSON to R2 as demo/demo.json...");
  await r2Put("demo/demo.json", publicJsonPath, "application/json");
  console.log("  done");
}

if (existsSync(gazPath)) {
  console.log("Uploading gazetteer.json to R2...");
  await r2Put("geocodes/gazetteer.json", gazPath, "application/json");
  console.log("  done");
}

// Apply schema via D1 REST API
console.log("\nApplying D1 schema...");
const schemaSQL = readFileSync("schema.sql", "utf8");
for (const stmt of schemaSQL.split(";").map(s => s.trim()).filter(Boolean)) {
  await d1Query(stmt);
}
console.log("  schema applied");

// Seed all tables in batches using D1 REST API (fast - direct HTTP, no wrangler overhead)
const BATCH = 50;

console.log(`\nSeeding D1 demo_individuals (${demoJson.individuals.length})...`);
for (let i = 0; i < demoJson.individuals.length; i += BATCH) {
  const stmts = demoJson.individuals.slice(i, i + BATCH).map(ind => {
    const data = JSON.stringify({ famc: ind.famc, fams: ind.fams, events: ind.events, notes: ind.notes, sources: ind.sources });
    return `INSERT OR REPLACE INTO demo_individuals (id, name, sex, birth_year, death_year, data_json) VALUES (${sqlStr(ind.id)}, ${sqlStr(ind.name)}, ${sqlStr(ind.sex)}, ${sqlNum(ind.birth_year)}, ${sqlNum(ind.death_year)}, ${sqlStr(data)})`;
  });
  await d1Query(stmts.join("; "));
  process.stdout.write(`  ${Math.min(i + BATCH, demoJson.individuals.length)}/${demoJson.individuals.length}\r`);
}
console.log();

console.log("Seeding D1 demo_events...");
const allEvents = [];
for (const ind of demoJson.individuals) {
  for (const ev of ind.events) allEvents.push({ iid: ind.id, ...ev });
}
for (let i = 0; i < allEvents.length; i += BATCH) {
  const stmts = allEvents.slice(i, i + BATCH).map(ev =>
    `INSERT INTO demo_events (iid, tag, year, place, lat, lon) VALUES (${sqlStr(ev.iid)}, ${sqlStr(ev.tag)}, ${sqlNum(ev.year)}, ${sqlStr(ev.place)}, ${sqlNum(ev.lat)}, ${sqlNum(ev.lon)})`
  );
  await d1Query(stmts.join("; "));
  process.stdout.write(`  ${Math.min(i + BATCH, allEvents.length)}/${allEvents.length}\r`);
}
console.log();

console.log("Seeding D1 demo_families...");
for (let i = 0; i < demoJson.families.length; i += BATCH) {
  const stmts = demoJson.families.slice(i, i + BATCH).map(fam =>
    `INSERT OR REPLACE INTO demo_families (id, data_json) VALUES (${sqlStr(fam.id)}, ${sqlStr(JSON.stringify(fam))})`
  );
  await d1Query(stmts.join("; "));
}
console.log(`  ${demoJson.families.length} families seeded`);

console.log("Seeding D1 demo_sources...");
for (let i = 0; i < demoJson.sources.length; i += BATCH) {
  const stmts = demoJson.sources.slice(i, i + BATCH).map(src =>
    `INSERT OR REPLACE INTO demo_sources (id, data_json) VALUES (${sqlStr(src.id)}, ${sqlStr(JSON.stringify(src))})`
  );
  await d1Query(stmts.join("; "));
}
console.log(`  ${demoJson.sources.length} sources seeded`);

console.log("\nDemo seed complete.");

function run(cmd) {
  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (e) {
    console.error(`Command failed: ${cmd}`);
    process.exit(1);
  }
}

// Inline GEDCOM parser (mirrors src/gedcom/parser.ts logic)
function parseGedcom(text) {
  const LINE_RE = /^(\d+)\s+(@[^@]+@|[A-Z_]+)\s*(.*)?$/;
  const individuals = new Map();
  const families = new Map();
  const sources = new Map();

  let curType = null;
  let curId = null;
  let curObj = null;
  let curEvent = null;
  let curSour = null;
  let inSourBlock = false;

  function flushEvent() {
    if (curEvent && curObj && "events" in curObj) {
      curObj.events.push(curEvent);
    }
    curEvent = null;
    curSour = null;
    inSourBlock = false;
  }

  function flushSour() {
    if (curSour && curObj) {
      const target = curEvent ?? curObj;
      if ("sources" in target) target.sources.push({ ...curSour });
    }
    curSour = null;
    inSourBlock = false;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const level = parseInt(m[1], 10);
    const tag = m[2];
    const val = (m[3] ?? "").trim();

    if (level === 0) {
      flushSour();
      flushEvent();
      if (curType === "INDI" && curId && curObj) individuals.set(curId, curObj);
      else if (curType === "FAM" && curId && curObj) families.set(curId, curObj);
      else if (curType === "SOUR" && curId && curObj) sources.set(curId, curObj);
      curType = null; curId = null; curObj = null;

      if (val === "INDI") {
        curType = "INDI"; curId = tag;
        curObj = { id: tag, raw: "", name: "", sex: "", famc: null, fams: [], events: [], notes: [], sources: [] };
      } else if (val === "FAM") {
        curType = "FAM"; curId = tag;
        curObj = { id: tag, husb: null, wife: null, chil: [], marr: null, div: null };
      } else if (val === "SOUR") {
        curType = "SOUR"; curId = tag;
        curObj = { id: tag, title: "", auth: "", publ: "", note: "" };
      }
      continue;
    }

    if (!curObj) continue;

    if (curType === "INDI") {
      if (level === 1) {
        flushSour();
        flushEvent();
        if (tag === "NAME") { curObj.name = val.replace(/\//g, "").trim(); }
        else if (tag === "SEX") { curObj.sex = val; }
        else if (tag === "FAMC") { curObj.famc = val; }
        else if (tag === "FAMS") { curObj.fams.push(val); }
        else if (tag === "NOTE") { curObj.notes.push(val); }
        else if (tag === "SOUR") {
          curSour = { src_id: val, page: "", text: "", url: null };
          inSourBlock = true;
        } else if (isEventTag(tag)) {
          curEvent = { tag, date: "", year: null, place: "", note: "", sources: [] };
        }
      } else if (level === 2 && curEvent) {
        if (tag === "DATE") { curEvent.date = val; curEvent.year = extractYear(val); }
        else if (tag === "PLAC") { curEvent.place = val; }
        else if (tag === "NOTE") { curEvent.note = val; }
        else if (tag === "SOUR") {
          flushSour();
          curSour = { src_id: val, page: "", text: "", url: null };
          inSourBlock = true;
        }
      } else if (level === 2 && inSourBlock && !curEvent) {
        if (tag === "PAGE") curSour.page = val;
        else if (tag === "DATA") { /* container */ }
      } else if (level === 3 && inSourBlock) {
        if (tag === "TEXT") { curSour.text = val; }
        if (!curSour.url) {
          const urlMatch = val.match(/https?:\/\/\S+/);
          if (urlMatch) curSour.url = urlMatch[0];
        }
      } else if (level === 2 && inSourBlock) {
        if (tag === "PAGE") curSour.page = val;
        if (!curSour.url) {
          const urlMatch = val.match(/https?:\/\/\S+/);
          if (urlMatch) curSour.url = urlMatch[0];
        }
      }
    } else if (curType === "FAM") {
      if (level === 1) {
        flushSour(); flushEvent();
        if (tag === "HUSB") curObj.husb = val;
        else if (tag === "WIFE") curObj.wife = val;
        else if (tag === "CHIL") curObj.chil.push(val);
        else if (tag === "MARR") {
          curEvent = { tag: "MARR", date: "", year: null, place: "", note: "", sources: [] };
          curObj.marr = curEvent;
        } else if (tag === "DIV") {
          curEvent = { tag: "DIV", date: "", year: null, place: "", note: "", sources: [] };
          curObj.div = curEvent;
        }
      } else if (level === 2 && curEvent) {
        if (tag === "DATE") { curEvent.date = val; curEvent.year = extractYear(val); }
        else if (tag === "PLAC") { curEvent.place = val; }
      }
    } else if (curType === "SOUR") {
      if (level === 1) {
        if (tag === "TITL") curObj.title = val;
        else if (tag === "AUTH") curObj.auth = val;
        else if (tag === "PUBL") curObj.publ = val;
        else if (tag === "NOTE") curObj.note = val;
      }
    }
  }

  flushSour(); flushEvent();
  if (curType === "INDI" && curId && curObj) individuals.set(curId, curObj);
  else if (curType === "FAM" && curId && curObj) families.set(curId, curObj);
  else if (curType === "SOUR" && curId && curObj) sources.set(curId, curObj);

  return { individuals, families, sources };
}
