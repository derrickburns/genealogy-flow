import { readFileSync, writeFileSync } from "node:fs";
import { argv, exit } from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { slug } from "../geo/slug.js";
import {
  CA_PROV_NAME,
  CA_PROVINCES,
  COUNTRY_ALIASES,
  US_NAME_TO_ABBR,
  US_STATE_ABBR,
} from "../geo/aliases.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const COUNTY_SUFFIX = /\b(County|Parish|Co\.?|Borough|Census Area)\b/i;

type LatLon = [number, number];
// 4-tuple: lat, lon, pop, state-or-empty. State info is needed for country-wide
// lookups so we can score candidates by a prior over (cc, st).
type CityCand = [number, number, number, string];

interface GazetteerData {
  cities_by_state: Map<string, Map<string, CityCand[]>>; // key cc|st
  cities_by_country: Map<string, Map<string, CityCand[]>>;
  counties_us: Map<string, LatLon>; // key st|slug
  state_centroids: Map<string, LatLon>; // key cc|st
  country_centroids: Map<string, { lat: number; lon: number; name: string }>;
  state_names: Map<string, Map<string, string>>; // cc -> slug -> st_code
  countryAliases: Map<string, string>;
  stateCountryCollisions: Set<string>; // tokens that are both country aliases + US state names
}

// ---------- Generic helpers (noise stripping, abbreviations, fuzzy) ----------

// Common parenthetical / prefix noise that obscures real geographic tokens in
// historical records: "Colony of Virginia", "Town of Boston", "(now WV)", etc.
const PARENS = /\s*\([^)]*\)/g;
const NOISE_PREFIX = /\b(Colony|Province|Township|City|Town|Borough)\s+of\s+/gi;
const NOISE_SUFFIX = /\b(Township|Twp\.?)\b/gi;
const NOW_FORMERLY = /\b(now|formerly)\s+[^,]+/gi;

function stripNoise(place: string): string {
  let s = place;
  s = s.replace(PARENS, "");
  s = s.replace(NOW_FORMERLY, "");
  s = s.replace(NOISE_PREFIX, "");
  s = s.replace(NOISE_SUFFIX, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// Expand common abbreviations before slugging so "St. Mary's" matches "Saint
// Marys" entries from GeoNames. Single-letter directional abbrevs ("N. Carolina")
// expand to "North Carolina" so multi-word state lookup catches them.
function expandAbbr(place: string): string {
  return place
    .replace(/\bSt\./gi, "Saint")
    .replace(/\bSte\./gi, "Sainte")
    .replace(/\bFt\./gi, "Fort")
    .replace(/\bMt\./gi, "Mount")
    .replace(/\bMtn\.?\b/gi, "Mountain")
    .replace(/\bN\.\s*([A-Z])/g, "North $1")
    .replace(/\bS\.\s*([A-Z])/g, "South $1")
    .replace(/\bE\.\s*([A-Z])/g, "East $1")
    .replace(/\bW\.\s*([A-Z])/g, "West $1");
}

// Apostrophes split slugs into useless single-letter words ("st mary s").
// Pre-strip them so slug() yields "saint marys" cleanly.
function dropApostrophes(s: string): string {
  return s.replace(/[’']/g, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  if (Math.abs(m - n) > 2) return 99; // we only care about d<=2
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : Math.min(prev, dp[j - 1]!, dp[j]!) + 1;
      prev = tmp;
    }
  }
  return dp[n]!;
}

function fuzzyState(slugStr: string, codeBySlug: Map<string, string>): string | null {
  if (slugStr.length < 6) return null;
  let best: string | null = null;
  let bestDist = 3;
  for (const [name, code] of codeBySlug) {
    if (Math.abs(name.length - slugStr.length) > 2) continue;
    const d = levenshtein(slugStr, name);
    if (d < bestDist) { bestDist = d; best = code; if (d === 1) break; }
  }
  return best;
}

// Build a slug -> state-code map for fuzzy detection (canonical names + aliases).
function buildUSStateSlugs(stateNames: Map<string, Map<string, string>>): Map<string, string> {
  const out = new Map<string, string>();
  const usMap = stateNames.get("US");
  if (usMap) for (const [k, v] of usMap) out.set(k, v);
  for (const [k, v] of Object.entries(US_NAME_TO_ABBR)) out.set(k, v);
  return out;
}

function readGeonamesText(zipPath: string, innerName: string): string {
  const zip = new AdmZip(zipPath);
  const entry = zip.getEntry(innerName);
  if (!entry) throw new Error(`${innerName} not found in ${zipPath}`);
  return entry.getData().toString("utf8");
}

function getOrInit<K, V>(m: Map<K, V>, k: K, mk: () => V): V {
  let v = m.get(k);
  if (v === undefined) { v = mk(); m.set(k, v); }
  return v;
}

function loadGeonames(): GazetteerData {
  const aliases = new Map<string, string>(Object.entries(COUNTRY_ALIASES));
  const cities_by_state = new Map<string, Map<string, CityCand[]>>();
  const cities_by_country = new Map<string, Map<string, CityCand[]>>();
  const counties_us = new Map<string, LatLon>();
  const state_names = new Map<string, Map<string, string>>();
  const countryNames = new Map<string, string>();

  for (const line of readFileSync(join(ROOT, "countryInfo.txt"), "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 9) continue;
    const iso = parts[0]!;
    const name = parts[4]!;
    countryNames.set(iso, name);
    const lower = name.toLowerCase();
    if (!aliases.has(lower)) aliases.set(lower, iso);
  }

  for (const line of readFileSync(join(ROOT, "admin1.txt"), "utf8").split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const code = parts[0]!;
    const name = parts[1]!;
    const asciiName = parts[2]!;
    const dot = code.indexOf(".");
    if (dot < 0) continue;
    const cc = code.slice(0, dot);
    const st = code.slice(dot + 1);
    const cm = getOrInit(state_names, cc, () => new Map<string, string>());
    cm.set(slug(name), st);
    cm.set(slug(asciiName), st);
  }

  const citiesText = readGeonamesText(join(ROOT, "cities500.zip"), "cities500.txt");
  for (const line of citiesText.split(/\r?\n/)) {
    if (!line) continue;
    const p = line.split("\t");
    if (p.length < 15) continue;
    if (p[6] !== "P") continue;
    const lat = Number.parseFloat(p[4]!);
    const lon = Number.parseFloat(p[5]!);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const cc = p[8]!;
    const st = p[10]!;
    const popN = Number.parseInt(p[14]!, 10);
    const pop = Number.isFinite(popN) ? popN : 0;
    const name = p[1]!;
    const asciiName = p[2]!;
    const alt = p[3]!;
    const key = slug(asciiName || name);
    const sk = `${cc}|${st}`;
    const cm = getOrInit(cities_by_state, sk, () => new Map<string, CityCand[]>());
    getOrInit(cm, key, () => []).push([lat, lon, pop, st]);
    const ccm = getOrInit(cities_by_country, cc, () => new Map<string, CityCand[]>());
    getOrInit(ccm, key, () => []).push([lat, lon, pop, st]);
    if (alt) {
      for (const a of alt.split(",")) {
        const ak = slug(a);
        if (ak && ak !== key) {
          getOrInit(cm, ak, () => []).push([lat, lon, Math.floor(pop / 2), st]);
        }
      }
    }
  }

  const usText = readGeonamesText(join(ROOT, "US.zip"), "US.txt");
  for (const line of usText.split(/\r?\n/)) {
    if (!line) continue;
    const p = line.split("\t");
    if (p.length < 15) continue;
    if (p[6] !== "A" || p[7] !== "ADM2") continue;
    const asciiName = p[2]!;
    const lat = Number.parseFloat(p[4]!);
    const lon = Number.parseFloat(p[5]!);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const st = p[10]!;
    const stripped = slug(asciiName).replace(" county", "").replace(" parish", "").trim();
    counties_us.set(`${st}|${stripped}`, [lat, lon]);
    counties_us.set(`${st}|${slug(asciiName).trim()}`, [lat, lon]);
  }

  const state_centroids = new Map<string, LatLon>();
  for (const [sk, cm] of cities_by_state) {
    let lats = 0, lons = 0, w = 0;
    for (const cands of cm.values()) {
      for (const c of cands) {
        const ww = Math.max(c[2], 1);
        lats += c[0] * ww; lons += c[1] * ww; w += ww;
      }
    }
    if (w > 0) state_centroids.set(sk, [lats / w, lons / w]);
  }

  const country_centroids = new Map<string, { lat: number; lon: number; name: string }>();
  for (const [cc, cm] of cities_by_country) {
    let lats = 0, lons = 0, w = 0;
    for (const cands of cm.values()) {
      for (const c of cands) {
        const ww = Math.max(c[2], 1);
        lats += c[0] * ww; lons += c[1] * ww; w += ww;
      }
    }
    if (w > 0) {
      country_centroids.set(cc, {
        lat: lats / w,
        lon: lons / w,
        name: countryNames.get(cc) ?? cc,
      });
    }
  }

  const stateCountryCollisions = buildStateCountryCollisions(aliases, state_names);
  return {
    cities_by_state, cities_by_country, counties_us,
    state_centroids, country_centroids, state_names,
    countryAliases: aliases,
    stateCountryCollisions,
  };
}

// Tokens that are simultaneously a country alias and a US state name (the only
// known case is "georgia" - country and state share the same name). Auto-detected
// at gazetteer-load time by intersecting US state slugs with country aliases.
function buildStateCountryCollisions(
  aliases: Map<string, string>,
  stateNames: Map<string, Map<string, string>>,
): Set<string> {
  const out = new Set<string>();
  const usMap = stateNames.get("US");
  if (!usMap) return out;
  for (const k of usMap.keys()) {
    if (aliases.has(k) && aliases.get(k) !== "US") out.add(k);
  }
  // Hand-crafted alias map from aliases.ts
  for (const k of Object.keys(US_NAME_TO_ABBR)) {
    if (aliases.has(k) && aliases.get(k) !== "US") out.add(k);
  }
  return out;
}

function detectCountry(
  parts: string[],
  aliases: Map<string, string>,
  collisions: Set<string>,
): string | null {
  if (parts.length === 0) return null;
  const last = slug(parts[parts.length - 1]!);
  if (aliases.has(last)) {
    // Defer to default cc=US when this token is also a US state name.
    if (collisions.has(last)) return null;
    return aliases.get(last)!;
  }
  if (parts.length >= 2) {
    const last2 = slug(parts[parts.length - 1] + " " + parts[parts.length - 2]);
    if (aliases.has(last2)) return aliases.get(last2)!;
  }
  return null;
}

// County-marker tokens come from COUNTY_SUFFIX itself - same semantic source
// just in word-set form so we can skip them in state detection (CO=Colorado vs
// "Co." for county is the prototype collision).
const COUNTY_MARKER_WORDS = new Set(["co", "county", "parish", "borough", "twp", "township", "census", "area"]);

interface DetectStateResult { st: string | null; idx: number | null; }

function detectState(
  parts: string[],
  cc: string,
  stateNames: Map<string, Map<string, string>>,
  usFuzzySlugs?: Map<string, string>,
): DetectStateResult {
  if (parts.length === 0) return { st: null, idx: null };
  // Search a single comma-token for a state, walking the whole token first then
  // each whitespace/paren-separated word. Catches "VA USA", "Virginia (now West
  // Virginia)", "Tenn.", and similar runs where a state isn't on its own.
  const tryUS = (tok: string): string | null => {
    const upWhole = tok.toUpperCase().replace(/\.+$/, "");
    if (US_STATE_ABBR[upWhole]) return upWhole;
    const slWhole = slug(tok);
    if (US_NAME_TO_ABBR[slWhole]) return US_NAME_TO_ABBR[slWhole]!;
    const usMap = stateNames.get("US");
    if (usMap && usMap.has(slWhole)) return usMap.get(slWhole)!;
    const words = tok.split(/[\s().]+/).filter(Boolean);
    if (words.length > 1) {
      for (const w of words) {
        const wLow = w.toLowerCase().replace(/\.+$/, "");
        if (COUNTY_MARKER_WORDS.has(wLow)) continue;
        const wUp = w.toUpperCase().replace(/\.+$/, "");
        if (US_STATE_ABBR[wUp]) return wUp;
        const wSl = slug(w);
        if (US_NAME_TO_ABBR[wSl]) return US_NAME_TO_ABBR[wSl]!;
        if (usMap && usMap.has(wSl)) return usMap.get(wSl)!;
      }
      for (let span = 2; span <= Math.min(words.length, 4); span++) {
        for (let s = 0; s + span <= words.length; s++) {
          const phrase = words.slice(s, s + span).join(" ");
          const pSl = slug(phrase);
          if (US_NAME_TO_ABBR[pSl]) return US_NAME_TO_ABBR[pSl]!;
          if (usMap && usMap.has(pSl)) return usMap.get(pSl)!;
        }
      }
    }
    return null;
  };
  if (cc === "US") {
    for (let idx = parts.length - 1; idx >= 0; idx--) {
      const hit = tryUS(parts[idx]!.trim());
      if (hit) return { st: hit, idx };
    }
    // Fuzzy fallback: catch typos like "Virgina" / "Tennesse" via Levenshtein
    // <=2 against canonical state names + aliases. Only fires when no direct
    // match was found anywhere in the parts list.
    if (usFuzzySlugs) {
      for (let idx = parts.length - 1; idx >= 0; idx--) {
        const tok = parts[idx]!.trim();
        const hit = fuzzyState(slug(tok), usFuzzySlugs);
        if (hit) return { st: hit, idx };
        const words = tok.split(/[\s().]+/).filter(Boolean);
        if (words.length > 1) {
          for (const w of words) {
            const wHit = fuzzyState(slug(w), usFuzzySlugs);
            if (wHit) return { st: wHit, idx };
          }
        }
      }
    }
    return { st: null, idx: null };
  }
  if (cc === "CA") {
    for (let idx = parts.length - 1; idx >= 0; idx--) {
      const tok = parts[idx]!.trim();
      const tokUp = tok.toUpperCase().replace(/\.+$/, "");
      if (CA_PROVINCES[tokUp]) return { st: tokUp, idx };
      const slugged = slug(tok);
      if (CA_PROV_NAME[slugged]) return { st: CA_PROV_NAME[slugged]!, idx };
      const words = tok.split(/[\s().]+/).filter(Boolean);
      if (words.length > 1) {
        for (const w of words) {
          const wUp = w.toUpperCase().replace(/\.+$/, "");
          if (CA_PROVINCES[wUp]) return { st: wUp, idx };
          const wSl = slug(w);
          if (CA_PROV_NAME[wSl]) return { st: CA_PROV_NAME[wSl]!, idx };
        }
      }
    }
    return { st: null, idx: null };
  }
  const cm = stateNames.get(cc);
  if (cm) {
    for (let idx = parts.length - 1; idx >= 0; idx--) {
      const tok = parts[idx]!;
      const slugged = slug(tok);
      if (cm.has(slugged)) return { st: cm.get(slugged)!, idx };
      const words = tok.split(/[\s().]+/).filter(Boolean);
      if (words.length > 1) {
        for (const w of words) {
          const wSl = slug(w);
          if (cm.has(wSl)) return { st: cm.get(wSl)!, idx };
        }
      }
    }
  }
  return { st: null, idx: null };
}

function bestCity(cands: CityCand[]): LatLon {
  let best = cands[0]!;
  for (const c of cands) if (c[2] > best[2]) best = c;
  return [best[0], best[1]];
}

// Score a candidate by population + position-in-place + (cc, st) prior.
// Higher score wins. Used in country-wide lookups where the same city slug
// resolves to many cities globally (e.g. "Concord", "Springfield", "Berlin").
function scoreCand(
  c: CityCand,
  cc: string,
  posWeight: number,
  prior: Map<string, number>,
): number {
  const popScore = Math.log(Math.max(c[2], 1));
  const stKey = c[3] ? `${cc}|${c[3]}` : cc;
  const priorMass = prior.get(stKey) ?? 0;
  // Add 1 inside log so a totally unseen state doesn't get -Infinity; tree-prior
  // is a soft bias, not a veto.
  const priorScore = Math.log(1 + priorMass);
  return popScore + 3.0 * priorScore + 4.0 * posWeight;
}

function findCounty(parts: string[], st: string, counties: Map<string, LatLon>): LatLon | null {
  for (const tok of parts) {
    const s = slug(tok);
    const sClean = s.replace(" county", "").replace(" parish", "").trim();
    for (const k of [s, sClean]) {
      const v = counties.get(`${st}|${k}`);
      if (v) return v;
    }
  }
  return null;
}

interface GeocodeResult {
  lat: number;
  lon: number;
  level: "city" | "county" | "admin1" | "country";
  cc: string;
  st: string | null;
  confidence: "high" | "medium" | "low";
}

interface GeocodeContext {
  prior: Map<string, number>; // (cc|st) -> count of confident hits in tree
  usFuzzySlugs: Map<string, string>;
}

function geocodeOne(place: string, gz: GazetteerData, ctx: GeocodeContext): GeocodeResult | null {
  // Pre-process: kill parens noise, expand abbreviations, drop apostrophes
  // before slug() collapses them into junk tokens.
  const cleaned = dropApostrophes(expandAbbr(stripNoise(place)));
  const parts = cleaned.split(",").map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const cc = detectCountry(parts, gz.countryAliases, gz.stateCountryCollisions) ?? "US";
  const { st, idx: stIdx } = detectState(parts, cc, gz.state_names, cc === "US" ? ctx.usFuzzySlugs : undefined);
  const hasCountyToken = parts.some(p => COUNTY_SUFFIX.test(p));

  // Helper: extract city tokens (positions 0..stIdx, skipping county tokens).
  // Returns [token, position] so we can apply position weight in scoring.
  const cityTokens = (): { tok: string; pos: number }[] => {
    const out: { tok: string; pos: number }[] = [];
    const upper = stIdx ?? parts.length;
    for (let i = 0; i < upper; i++) {
      const tok = parts[i]!;
      if (COUNTY_SUFFIX.test(tok)) continue;
      // Token-level word splitting: "Mill Creek Township" -> ["Mill", "Mill Creek", "Creek"].
      const words = tok.split(/[\s().]+/).filter(Boolean);
      out.push({ tok, pos: i });
      if (words.length > 1) {
        for (let span = 1; span <= Math.min(words.length, 3); span++) {
          for (let s = 0; s + span <= words.length; s++) {
            const phrase = words.slice(s, s + span).join(" ");
            if (phrase !== tok) out.push({ tok: phrase, pos: i });
          }
        }
      }
    }
    return out;
  };

  // State-scoped city lookup (fast path when state is known).
  const lookupCityInState = (stCode: string): GeocodeResult | null => {
    const candLookup = gz.cities_by_state.get(`${cc}|${stCode}`);
    if (!candLookup) return null;
    for (const { tok } of cityTokens()) {
      const s = slug(tok);
      const cands = candLookup.get(s);
      if (cands && cands.length > 0) {
        const [lat, lon] = bestCity(cands);
        return { lat, lon, level: "city", cc, st: stCode, confidence: "high" };
      }
    }
    return null;
  };

  // 1. State + county both present: prefer city in state, else county centroid.
  if (cc === "US" && st && hasCountyToken) {
    const cty = findCounty(parts, st, gz.counties_us);
    if (cty) {
      const cityHit = lookupCityInState(st);
      if (cityHit) return cityHit;
      return { lat: cty[0], lon: cty[1], level: "county", cc, st, confidence: "high" };
    }
  }

  // 2. State known: city -> county -> admin1 fallback.
  if (st) {
    const cityHit = lookupCityInState(st);
    if (cityHit) return cityHit;
    if (cc === "US") {
      const cty = findCounty(parts, st, gz.counties_us);
      if (cty) return { lat: cty[0], lon: cty[1], level: "county", cc, st, confidence: "high" };
    }
    const sc = gz.state_centroids.get(`${cc}|${st}`);
    if (sc) return { lat: sc[0], lon: sc[1], level: "admin1", cc, st, confidence: "medium" };
  }

  // 3. US + county hint but no state: enumerate states owning that county and
  // pick by tree-prior + city-match. Tie-break is *no longer* alphabetical.
  if (cc === "US" && hasCountyToken && !st) {
    const countySlugs: string[] = [];
    for (const tok of parts) {
      if (!COUNTY_SUFFIX.test(tok)) continue;
      const s = slug(tok);
      const stripped = s.replace(" county", "").replace(" parish", "").trim();
      if (s) countySlugs.push(s);
      if (stripped && stripped !== s) countySlugs.push(stripped);
    }
    const matchingStates = new Set<string>();
    for (const key of gz.counties_us.keys()) {
      const sep = key.indexOf("|");
      if (sep < 0) continue;
      const stCode = key.slice(0, sep);
      const ctySlug = key.slice(sep + 1);
      if (countySlugs.includes(ctySlug)) matchingStates.add(stCode);
    }
    if (matchingStates.size > 0) {
      // First: any state where the city token actually matches a city.
      let bestCityHit: { result: GeocodeResult; score: number } | null = null;
      for (const stCode of matchingStates) {
        const cl = gz.cities_by_state.get(`US|${stCode}`);
        if (!cl) continue;
        for (const { tok, pos } of cityTokens()) {
          const s = slug(tok);
          const cands = cl.get(s);
          if (!cands || cands.length === 0) continue;
          const posWeight = 1 - pos / Math.max(parts.length, 1);
          for (const c of cands) {
            const sc = scoreCand(c, cc, posWeight, ctx.prior);
            if (!bestCityHit || sc > bestCityHit.score) {
              bestCityHit = {
                result: { lat: c[0], lon: c[1], level: "city", cc, st: stCode, confidence: "medium" },
                score: sc,
              };
            }
          }
        }
      }
      if (bestCityHit) return bestCityHit.result;
      // No city match: pick the prior-favored state and return its county centroid.
      let bestSt: string | null = null;
      let bestScore = -Infinity;
      for (const stCode of matchingStates) {
        const priorScore = ctx.prior.get(`US|${stCode}`) ?? 0;
        if (priorScore > bestScore) { bestScore = priorScore; bestSt = stCode; }
      }
      if (bestSt === null) bestSt = [...matchingStates][0]!;
      const cty = findCounty(parts, bestSt, gz.counties_us);
      if (cty) {
        return { lat: cty[0], lon: cty[1], level: "county", cc, st: bestSt, confidence: "low" };
      }
    }
  }

  // 4. Country-wide city lookup: score every candidate by pop + position + prior
  // and pick the max. Replaces the old "first match wins" walk that was easily
  // tricked by alphabetical/positional ordering.
  const candLookup = gz.cities_by_country.get(cc);
  if (candLookup) {
    let best: { c: CityCand; score: number } | null = null;
    for (const { tok, pos } of cityTokens()) {
      const s = slug(tok);
      const cands = candLookup.get(s);
      if (!cands || cands.length === 0) continue;
      const posWeight = 1 - pos / Math.max(parts.length, 1);
      for (const c of cands) {
        const sc = scoreCand(c, cc, posWeight, ctx.prior);
        if (!best || sc > best.score) best = { c, score: sc };
      }
    }
    if (best) {
      const c = best.c;
      // Confidence: high if the resolved state matches a known prior weight,
      // medium otherwise. We don't know if the user "meant" this state, but a
      // populated prior at least says it's plausible in their tree.
      const priorMass = c[3] ? (ctx.prior.get(`${cc}|${c[3]}`) ?? 0) : 0;
      const conf: "high" | "medium" | "low" = priorMass > 5 ? "medium" : "low";
      return { lat: c[0], lon: c[1], level: "city", cc, st: c[3] || null, confidence: conf };
    }
  }
  const cc_centroid = gz.country_centroids.get(cc);
  if (cc_centroid) {
    return { lat: cc_centroid.lat, lon: cc_centroid.lon, level: "country", cc, st: null, confidence: "low" };
  }
  return null;
}

interface IndividualsFile {
  individuals: { events: { place: string }[] }[];
}

function main(): number {
  const src = argv[2];
  const out = argv[3];
  if (!src || !out) {
    console.error("usage: geocode <individuals.json> <places.json>");
    return 2;
  }
  console.log("Loading GeoNames...");
  const gz = loadGeonames();
  let cityEntries = 0;
  for (const m of gz.cities_by_state.values()) cityEntries += m.size;
  console.log(`  ${cityEntries} city entries`);
  console.log(`  ${gz.counties_us.size} US county entries`);
  console.log(`  ${gz.state_centroids.size} state centroids`);

  const data = JSON.parse(readFileSync(src, "utf8")) as IndividualsFile;
  const places = new Set<string>();
  for (const p of data.individuals) for (const e of p.events) places.add(e.place);
  console.log(`Geocoding ${places.size} unique places...`);

  const usFuzzySlugs = buildUSStateSlugs(gz.state_names);

  // ---- Pass 1: build the (cc, st) prior from confidently-resolved places.
  // The prior is a soft bias for ambiguous lookups in pass 2; only "high"-
  // confidence hits feed it so we don't reinforce our own mistakes.
  const passOnePrior = new Map<string, number>();
  const ctxPass1: GeocodeContext = { prior: passOnePrior, usFuzzySlugs };
  const pass1: Record<string, GeocodeResult> = {};
  for (const place of places) {
    const r = geocodeOne(place, gz, ctxPass1);
    if (!r) continue;
    pass1[place] = r;
    if (r.confidence === "high" && r.st) {
      const k = `${r.cc}|${r.st}`;
      passOnePrior.set(k, (passOnePrior.get(k) ?? 0) + 1);
    }
  }
  const topPriorPairs = [...passOnePrior.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`Pass 1 prior top: ${topPriorPairs.map(([k, n]) => `${k}=${n}`).join(", ")}`);

  // ---- Pass 2: re-geocode using the prior. Confident pass-1 results stay; the
  // prior only changes ambiguous county/country-wide hits.
  const ctxPass2: GeocodeContext = { prior: passOnePrior, usFuzzySlugs };
  const results: Record<string, GeocodeResult> = {};
  const misses: string[] = [];
  const counts = { city: 0, county: 0, admin1: 0, country: 0, miss: 0 };
  for (const place of places) {
    const r = geocodeOne(place, gz, ctxPass2);
    if (r === null) {
      counts.miss += 1;
      misses.push(place);
    } else {
      counts[r.level] += 1;
      results[place] = r;
    }
  }

  writeFileSync(out, JSON.stringify(results));
  console.log(`Wrote ${Object.keys(results).length} place mappings to ${out}`);
  console.log(`Resolution counts: ${JSON.stringify(counts)}`);
  const missRate = ((counts.miss / places.size) * 100).toFixed(1);
  console.log(`Miss rate: ${counts.miss}/${places.size} = ${missRate}%`);
  writeFileSync(join(ROOT, "misses.txt"), misses.sort().slice(0, 500).join("\n"));

  // Persist the prior so the runtime geocoder (browser) can use the same bias.
  const priorJson = Object.fromEntries(passOnePrior);
  writeFileSync(join(ROOT, "geo-prior.json"), JSON.stringify(priorJson));
  console.log(`Wrote ${Object.keys(priorJson).length} prior entries to geo-prior.json`);
  return 0;
}

exit(main());
