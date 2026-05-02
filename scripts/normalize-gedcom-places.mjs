#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

function slug(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const US_STATE_ABBR = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

const US_NAME_TO_ABBR = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA", "colorado": "CO", "connecticut": "CT",
  "delaware": "DE", "district of columbia": "DC", "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID", "illinois": "IL",
  "indiana": "IN", "iowa": "IA", "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
  "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS", "missouri": "MO", "montana": "MT",
  "nebraska": "NE", "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK", "oregon": "OR", "pennsylvania": "PA",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
  "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
  "mo": "MO", "mn": "MN", "nd": "ND", "ca": "CA", "ny": "NY", "il": "IL", "wi": "WI", "tx": "TX",
};

const COUNTRY_ALIASES = {
  "usa": "US", "u s a": "US", "u s": "US", "united states": "US", "united states of america": "US", "us": "US", "america": "US",
  "uk": "GB", "u k": "GB", "england": "GB", "scotland": "GB", "wales": "GB", "great britain": "GB", "britain": "GB", "united kingdom": "GB", "northern ireland": "GB",
  "canada": "CA", "ireland": "IE", "germany": "DE", "deutschland": "DE", "prussia": "DE", "france": "FR", "italy": "IT", "spain": "ES",
  "portugal": "PT", "netherlands": "NL", "holland": "NL", "belgium": "BE", "switzerland": "CH", "austria": "AT", "poland": "PL",
  "russia": "RU", "ukraine": "UA", "sweden": "SE", "norway": "NO", "denmark": "DK", "finland": "FI", "australia": "AU",
  "new zealand": "NZ", "south africa": "ZA", "mexico": "MX", "brazil": "BR", "japan": "JP", "china": "CN", "india": "IN",
};

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const GAZ_PATH = join(ROOT, "gazetteer.json");
const US_ZIP_PATH = join(ROOT, "US.zip");
const CITIES_ZIP_PATH = join(ROOT, "cities500.zip");

const [, , inputPath, outputPathArg] = process.argv;
if (!inputPath) {
  console.error("usage: node scripts/normalize-gedcom-places.mjs <input.ged> [output.ged]");
  process.exit(2);
}

const outputPath = outputPathArg || join(ROOT, "normalized", basename(inputPath).replace(/\.ged(com)?$/i, "") + ".normalized.ged");
const reportPath = outputPath.replace(/\.ged$/i, ".report.json");

const LINE_RE = /^(\d+)\s+(?:(@[^@]+@)\s+)?(\S+)(?:\s+(.*))?$/;
const COUNTY_SUFFIX_RE = /\b(County|Parish|Co\.?|Borough|Census Area)\b/i;
const EARTH_RADIUS_MILES = 3958.7613;

function parseLine(line) {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  return { level: parseInt(m[1], 10), xref: m[2] || null, tag: m[3], value: m[4] || "" };
}

function parseYearBounds(s) {
  if (!s) return [null, null];
  const matches = String(s).match(/\b\d{3,4}\b/g);
  if (!matches || !matches.length) return [null, null];
  const years = matches.map(v => parseInt(v, 10)).filter(y => Number.isFinite(y) && y >= 1000 && y <= 2100);
  if (!years.length) return [null, null];
  return [years[0], years[years.length - 1]];
}

function eventYear(ev) {
  if (!ev) return null;
  if (Number.isFinite(ev.year)) return ev.year;
  if (Number.isFinite(ev.yearEnd)) return ev.yearEnd;
  return null;
}

function distanceMiles(a, b) {
  if (!a || !b) return null;
  const alat = Number(a.lat), alon = Number(a.lon), blat = Number(b.lat), blon = Number(b.lon);
  if (![alat, alon, blat, blon].every(Number.isFinite)) return null;
  const toRad = n => n * Math.PI / 180;
  const dLat = toRad(blat - alat);
  const dLon = toRad(blon - alon);
  const lat1 = toRad(alat);
  const lat2 = toRad(blat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

function maxPlausibleMiles(fromYear, toYear) {
  const y0 = Number.isFinite(fromYear) ? fromYear : toYear;
  const y1 = Number.isFinite(toYear) ? toYear : fromYear;
  if (!Number.isFinite(y0) || !Number.isFinite(y1)) return Infinity;
  const gap = Math.max(0, Math.abs(y1 - y0));
  const era = Math.min(y0, y1);
  const miles = era < 1800 ? 75 + gap * 150
    : era < 1850 ? 150 + gap * 300
    : era < 1900 ? 500 + gap * 700
    : era < 1950 ? 1200 + gap * 1500
    : 3000 + gap * 4000;
  return Math.min(12500, miles);
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

  function canonicalCountyName(name) {
    return String(name || "")
      .replace(/\s+(County|Parish|Borough|Census Area)$/i, "")
      .trim();
  }

  function loadUsAdmin2ByCode() {
    const out = new Map();
    try {
      const zip = new AdmZip(US_ZIP_PATH);
      const entry = zip.getEntry("US.txt");
      if (!entry) return out;
      for (const line of entry.getData().toString("utf8").split(/\r?\n/)) {
        if (!line) continue;
        const p = line.split("\t");
        if (p.length < 15 || p[6] !== "A" || p[7] !== "ADM2") continue;
        const st = p[10];
        const countyCode = p[11];
        const county = canonicalCountyName(p[2] || p[1]);
        if (st && countyCode && county) out.set(`${st}|${countyCode}`, county);
      }
    } catch {
      // The normalizer still works with the compact gazetteer; it just cannot
      // fill county for city-only US places without the raw GeoNames files.
    }
    return out;
  }

  const usAdmin2ByCode = loadUsAdmin2ByCode();
  const cityByStateSlug = new Map(), cityByCountrySlug = new Map();
  function addCity(slugName, cc, st, lat, lon, pop, county = null) {
    const k1 = cc + "|" + st;
    let m = cityByStateSlug.get(k1); if (!m) { m = new Map(); cityByStateSlug.set(k1, m); }
    const ex = m.get(slugName);
    if (!ex || ex.pop < pop || (county && !ex.county)) m.set(slugName, { name: slugName, lat, lon, pop, county });
    let m2 = cityByCountrySlug.get(cc); if (!m2) { m2 = new Map(); cityByCountrySlug.set(cc, m2); }
    const ex2 = m2.get(slugName);
    if (!ex2 || ex2.pop < pop || (county && !ex2.county)) m2.set(slugName, { name: slugName, lat, lon, pop, st, county });
  }

  for (const row of gz.cities) {
    const [s, cc, st, lat, lon, pop] = row;
    addCity(s, cc, st, lat, lon, pop);
  }

  try {
    const zip = new AdmZip(CITIES_ZIP_PATH);
    const entry = zip.getEntry("cities500.txt");
    if (entry) {
      for (const line of entry.getData().toString("utf8").split(/\r?\n/)) {
        if (!line) continue;
        const p = line.split("\t");
        if (p.length < 15 || p[6] !== "P" || p[8] !== "US") continue;
        const lat = Number.parseFloat(p[4]);
        const lon = Number.parseFloat(p[5]);
        const pop = Number.parseInt(p[14], 10);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(pop)) continue;
        const st = p[10];
        const county = usAdmin2ByCode.get(`${st}|${p[11]}`) || null;
        addCity(slug(p[2] || p[1]), "US", st, lat, lon, Math.max(pop, 1), county);
      }
    }
  } catch {
    // See loadUsAdmin2ByCode comment.
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
    const tryUS = tok => {
      const up = tok.toUpperCase().replace(/\.+$/, "");
      if (US_STATE_ABBR[up]) return up;
      const sl = slug(tok);
      if (US_NAME_TO_ABBR[sl]) return US_NAME_TO_ABBR[sl];
      const codes = adminBySlug.get("US");
      if (codes && codes.has(sl)) return codes.get(sl);
      return null;
    };
    if (cc === "US") {
      for (let i = parts.length - 1; i >= 0; i--) {
        const hit = tryUS(parts[i].trim());
        if (hit) return [hit, i];
      }
      return [null, null];
    }
    if (cc) {
      const codes = adminBySlug.get(cc); if (!codes) return [null, null];
      for (let i = parts.length - 1; i >= 0; i--) {
        const sl = slug(parts[i]);
        if (codes.has(sl)) return [codes.get(sl), i];
      }
    }
    return [null, null];
  }

  function findCounty(parts, st) {
    const m = countiesByState.get(st); if (!m) return null;
    for (const tok of parts) {
      const s = slug(tok);
      const sClean = s.replace(/ county$/, "").replace(/ parish$/, "").trim();
      const hit = m.get(s) || m.get(sClean);
      if (hit) return hit;
    }
    return null;
  }

  function geocode(place) {
    const parts = String(place).split(",").map(s => s.trim()).filter(Boolean);
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
          if (hit) return { level: "city", cc, st, county: hit.county || null, city: parts[i].trim(), lat: hit.lat, lon: hit.lon };
        }
        return { level: "county", cc, st, city: null, lat: cty.lat, lon: cty.lon };
      }
    }

    if (st) {
      const upper = stIdx == null ? parts.length : stIdx;
      const map = cityByStateSlug.get(cc + "|" + st);
      if (map) for (let i = 0; i < upper; i++) {
        if (COUNTY_SUFFIX_RE.test(parts[i])) continue;
        const key = slug(parts[i]);
        const hit = map.get(key);
        if (hit) return { level: "city", cc, st, county: hit.county || null, city: parts[i].trim(), lat: hit.lat, lon: hit.lon };
      }
      if (cc === "US") {
        const cty = findCounty(parts, st);
        if (cty) return { level: "county", cc, st, city: null, lat: cty.lat, lon: cty.lon };
      }
      const ad = adminByCC.get(cc)?.get(st);
      if (ad) return { level: "admin1", cc, st, city: null, lat: ad.lat, lon: ad.lon };
    }

    if (cc) {
      const map = cityByCountrySlug.get(cc);
      if (map) for (const tok of parts) {
        const hit = map.get(slug(tok));
        if (hit) return { level: "city", cc, st: hit.st || null, county: hit.county || null, city: tok.trim(), lat: hit.lat, lon: hit.lon };
      }
      const c = countryByCC.get(cc);
      if (c) return { level: "country", cc, st: null, city: null, lat: c.lat, lon: c.lon };
    }
    return null;
  }

  return { geocode, countryByCC, adminByCC };
}

const gz = JSON.parse(readFileSync(GAZ_PATH, "utf8"));
const { geocode, countryByCC, adminByCC } = buildGeocoder(gz);

const raw = readFileSync(inputPath, "utf8");
const lines = raw.split(/\r?\n/);

const sourceMeta = new Map();
const persons = new Map();
const placeEvents = [];

let curRec = null;
let person = null;
let curEvent = null;
let curDate = "";
let curPlaceLine = -1;
let curPlace = "";
let curSources = [];
let sourceRecord = null;

function flushEvent() {
  if (person && curEvent && curPlaceLine >= 0 && curPlace) {
    const [y0, y1] = parseYearBounds(curDate);
    placeEvents.push({
      personId: person.id,
      personName: person.name || person.id,
      eventType: curEvent,
      year: y0,
      yearEnd: y1 ?? y0,
      place: curPlace,
      placeLine: curPlaceLine,
      sourceIds: curSources.slice(),
    });
  }
  curEvent = null;
  curDate = "";
  curPlaceLine = -1;
  curPlace = "";
  curSources = [];
}

function flushRecord() {
  flushEvent();
  curRec = null;
  person = null;
  sourceRecord = null;
}

for (let i = 0; i < lines.length; i++) {
  const p = parseLine(lines[i]);
  if (!p) continue;
  if (p.level === 0) {
    flushRecord();
    if (p.tag === "INDI" && p.xref) {
      person = { id: p.xref, name: "" };
      persons.set(p.xref, person);
      curRec = "INDI";
    } else if (p.tag === "SOUR" && p.xref) {
      sourceRecord = { id: p.xref, title: "", publ: "" };
      sourceMeta.set(p.xref, sourceRecord);
      curRec = "SOUR";
    }
    continue;
  }

  if (curRec === "INDI" && person) {
    if (p.level === 1) {
      if (p.tag === "NAME" && !person.name) person.name = p.value.replace(/\//g, "").trim();
      flushEvent();
      if (p.tag === "BIRT" || p.tag === "DEAT" || p.tag === "RESI" || p.tag === "MARR" || p.tag === "EMIG" || p.tag === "IMMI" || p.tag === "CENS" || p.tag === "BAPM" || p.tag === "BURI" || p.tag === "CHR") {
        curEvent = p.tag;
      }
    } else if (curEvent && p.level === 2) {
      if (p.tag === "DATE") curDate = p.value;
      else if (p.tag === "PLAC") { curPlace = p.value; curPlaceLine = i; }
      else if (p.tag === "SOUR") curSources.push(p.value.trim());
    }
  } else if (curRec === "SOUR" && sourceRecord) {
    if (p.level === 1 && p.tag === "TITL" && !sourceRecord.title) sourceRecord.title = p.value.trim();
    else if (p.level === 1 && p.tag === "PUBL" && !sourceRecord.publ) sourceRecord.publ = p.value.trim();
    else if (p.level === 2 && p.tag === "PLAC" && !sourceRecord.publPlace) sourceRecord.publPlace = p.value.trim();
  }
}
flushRecord();

function canonicalCountry(cc) {
  if (cc === "US") return "USA";
  const c = countryByCC.get(cc);
  return c ? c.name : cc;
}

function canonicalAdmin(cc, st) {
  if (!st) return null;
  if (cc === "US" && US_STATE_ABBR[st]) return US_STATE_ABBR[st];
  return adminByCC.get(cc)?.get(st)?.name || st;
}

function placeKeyFromGeo(place, g) {
  const parts = String(place).split(",").map(s => s.trim()).filter(Boolean);
  const head = parts[0] ? slug(parts[0]) : "";
  return `${head}|${g.st || ""}|${g.cc}`;
}

const placeKeyCounts = new Map();
const personContext = new Map();
const eventsByPerson = new Map();

for (const ev of placeEvents) {
  const g = geocode(ev.place);
  ev.geo = g;
  if (!eventsByPerson.has(ev.personId)) eventsByPerson.set(ev.personId, []);
  eventsByPerson.get(ev.personId).push(ev);
  if (g) {
    const key = placeKeyFromGeo(ev.place, g);
    if (!placeKeyCounts.has(key)) placeKeyCounts.set(key, new Map());
    const m = placeKeyCounts.get(key);
    m.set(ev.place, (m.get(ev.place) || 0) + 1);

    if (!personContext.has(ev.personId)) personContext.set(ev.personId, { regions: new Map(), fullPlaces: new Map() });
    const pc = personContext.get(ev.personId);
    const rkey = `${g.cc}|${g.st || ""}`;
    pc.regions.set(rkey, (pc.regions.get(rkey) || 0) + 1);
    pc.fullPlaces.set(ev.place, (pc.fullPlaces.get(ev.place) || 0) + 1);
  }
}

for (const events of eventsByPerson.values()) {
  events.sort((a, b) => (eventYear(a) ?? Number.POSITIVE_INFINITY) - (eventYear(b) ?? Number.POSITIVE_INFINITY));
}

function topKey(map) {
  let best = null, bestN = -1;
  for (const [k, n] of map.entries()) {
    if (n > bestN) { bestN = n; best = k; }
  }
  return best;
}

function inferFromPersonContext(ev) {
  const pc = personContext.get(ev.personId);
  if (!pc) return null;
  const region = topKey(pc.regions);
  if (!region) return null;
  const [cc, st] = region.split("|");
  const place = ev.place.trim();
  if (!place || place.includes(",")) return null;
  if (/^\d/.test(place)) return null; // address-only is too speculative
  const trial = st ? `${place}, ${canonicalAdmin(cc, st)}, ${canonicalCountry(cc)}` : `${place}, ${canonicalCountry(cc)}`;
  const g = geocode(trial);
  return g ? trial : null;
}

function isAddressOnlyPlace(place) {
  const s = String(place || "").trim();
  return /^\d+\s+\S+/.test(s) && !s.includes(",");
}

function normalizeGeocodedPlace(ev) {
  const place = ev.place.trim();
  const g = ev.geo;
  if (!g) return place;

  const key = placeKeyFromGeo(place, g);
  const variants = placeKeyCounts.get(key);
  const bestVariant = variants ? topKey(variants) : null;

  const parts = place.split(",").map(s => s.trim()).filter(Boolean);
  const head = parts[0] || place;
  if (g.level === "country") return canonicalCountry(g.cc);
  const admin = canonicalAdmin(g.cc, g.st);
  const country = canonicalCountry(g.cc);
  if (g.level === "city" && g.cc === "US" && g.county && admin) return `${head}, ${g.county}, ${admin}, ${country}`;
  if (bestVariant && bestVariant.split(",").length > place.split(",").length) return bestVariant;
  if (g.level === "admin1") return admin ? `${admin}, ${country}` : place;
  if (admin) {
    // Keep county if the place already includes one; otherwise standardize to
    // City/Township, State, Country and let the global variant map add county
    // when strong corpus evidence exists.
    if (parts.length >= 4) return `${head}, ${parts[1]}, ${admin}, ${country}`;
    return `${head}, ${admin}, ${country}`;
  }
  return place;
}

function localAddressLocalityCandidate(ev) {
  if (!ev.geo || isAddressOnlyPlace(ev.place)) return null;
  if (ev.geo.level === "country") return null;
  const normalizedPlace = normalizeGeocodedPlace(ev);
  if (!normalizedPlace || normalizedPlace === "USA") return null;
  return {
    place: normalizedPlace,
    level: ev.geo.level,
    lat: ev.geo.lat,
    lon: ev.geo.lon,
    evidence: {
      eventType: ev.eventType,
      year: eventYear(ev),
      place: ev.place,
      normalizedPlace,
    },
  };
}

function nearestKnownEventsForYear(events, targetYear, skipEv) {
  if (!Number.isFinite(targetYear)) return { before: null, after: null };
  let before = null;
  let after = null;
  for (const ev of events) {
    if (ev === skipEv || !ev.geo || isAddressOnlyPlace(ev.place)) continue;
    const y = eventYear(ev);
    if (!Number.isFinite(y)) continue;
    if (y <= targetYear && (!before || y > eventYear(before))) before = ev;
    if (y >= targetYear && (!after || y < eventYear(after))) after = ev;
  }
  return { before, after };
}

function travelLeg(fromEv, toYear, toGeo) {
  if (!fromEv || !toGeo || !Number.isFinite(toYear)) return null;
  const fromYear = eventYear(fromEv);
  if (!Number.isFinite(fromYear)) return null;
  const miles = distanceMiles(fromEv.geo, toGeo);
  if (!Number.isFinite(miles)) return null;
  const maxMiles = maxPlausibleMiles(fromYear, toYear);
  return {
    fromEventType: fromEv.eventType,
    fromYear,
    fromPlace: normalizeGeocodedPlace(fromEv),
    miles: Math.round(miles),
    maxPlausibleMiles: Math.round(maxMiles),
    plausible: miles <= maxMiles,
  };
}

function scoreAddressCandidate(candidate, targetYear) {
  const levelScore = { city: 4, county: 3, admin1: 1, country: 0 }[candidate.level] ?? 0;
  let score = levelScore;
  for (const ev of candidate.evidenceEvents) {
    const y = ev.year;
    if (!Number.isFinite(targetYear) || !Number.isFinite(y)) continue;
    const gap = Math.abs(targetYear - y);
    if (gap <= 1) score += 6;
    else if (gap <= 5) score += 4;
    else if (gap <= 10) score += 3;
    else if (gap <= 25) score += 1;
  }
  score += Math.min(3, candidate.evidenceEvents.length);
  if (candidate.travel.some(leg => leg && !leg.plausible)) score -= 10;
  return score;
}

const addressOnlyReviews = [];

function resolveAddressOnlyPlace(ev) {
  const place = ev.place.trim();
  const targetYear = eventYear(ev);
  const personEvents = eventsByPerson.get(ev.personId) || [];
  const candidatesByPlace = new Map();

  for (const other of personEvents) {
    if (other === ev) continue;
    const cand = localAddressLocalityCandidate(other);
    if (!cand) continue;
    let existing = candidatesByPlace.get(cand.place);
    if (!existing) {
      existing = {
        place: cand.place,
        level: cand.level,
        lat: cand.lat,
        lon: cand.lon,
        evidenceEvents: [],
        travel: [],
        score: 0,
      };
      candidatesByPlace.set(cand.place, existing);
    }
    existing.evidenceEvents.push(cand.evidence);
  }

  const { before, after } = nearestKnownEventsForYear(personEvents, targetYear, ev);
  const candidates = [...candidatesByPlace.values()].map(candidate => {
    const geo = { lat: candidate.lat, lon: candidate.lon };
    candidate.travel = [
      travelLeg(before, targetYear, geo),
      travelLeg({ ...candidate, eventType: ev.eventType, geo, place: candidate.place, year: targetYear, yearEnd: targetYear }, eventYear(after), after?.geo),
    ].filter(Boolean);
    candidate.score = scoreAddressCandidate(candidate, targetYear);
    candidate.evidenceEvents.sort((a, b) => (Math.abs((targetYear ?? 0) - (a.year ?? 0))) - (Math.abs((targetYear ?? 0) - (b.year ?? 0))));
    return candidate;
  }).sort((a, b) => b.score - a.score);

  const specificCandidates = candidates.filter(c => c.level === "city" || c.level === "county");
  const best = specificCandidates[0] || null;
  const second = specificCandidates[1] || null;
  const hasImplausibleTravel = best?.travel.some(leg => !leg.plausible) || false;
  const accepted = Boolean(best && best.score >= 12 && (!second || best.score - second.score >= 4) && !hasImplausibleTravel);
  const selected = accepted ? `${place}, ${best.place}` : null;
  const decision = accepted
    ? "accepted_local"
    : candidates.length === 0
      ? "needs_online_geocoder_no_local_candidates"
      : hasImplausibleTravel
        ? "needs_online_geocoder_implausible_travel"
        : "needs_online_geocoder_ambiguous_local_candidates";

  addressOnlyReviews.push({
    person: ev.personName,
    personId: ev.personId,
    eventType: ev.eventType,
    year: targetYear,
    place,
    decision,
    selected,
    candidates: candidates.slice(0, 8).map(c => ({
      place: c.place,
      level: c.level,
      score: c.score,
      evidenceEvents: c.evidenceEvents.slice(0, 5),
      travel: c.travel,
    })),
  });
  return selected || place;
}

function normalizePlace(ev) {
  const place = ev.place.trim();
  if (!place) return place;
  if (isAddressOnlyPlace(place)) return resolveAddressOnlyPlace(ev);
  const g = ev.geo;
  if (!g) {
    const inferred = inferFromPersonContext(ev);
    return inferred || place;
  }
  return normalizeGeocodedPlace(ev);
}

const changes = [];
for (const ev of placeEvents) {
  const norm = normalizePlace(ev);
  if (norm && norm !== ev.place) {
    const line = lines[ev.placeLine];
    const prefix = line.slice(0, line.indexOf("PLAC") + 5);
    lines[ev.placeLine] = prefix + norm;
    changes.push({
      person: ev.personName,
      eventType: ev.eventType,
      year: ev.year,
      from: ev.place,
      to: norm,
    });
  }
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, lines.join("\n"));
writeFileSync(reportPath, JSON.stringify({ inputPath, outputPath, changes, addressOnlyReviews }, null, 2));

console.log(JSON.stringify({
  inputPath,
  outputPath,
  reportPath,
  changed: changes.length,
  addressOnlyReviewed: addressOnlyReviews.length,
  addressOnlyAccepted: addressOnlyReviews.filter(r => r.decision === "accepted_local").length,
  addressOnlyNeedsOnline: addressOnlyReviews.filter(r => r.decision.startsWith("needs_online_geocoder")).length,
  sample: changes.slice(0, 20),
}, null, 2));
