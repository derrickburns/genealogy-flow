#!/usr/bin/env -S npx tsx
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
type CityCand = [number, number, number]; // lat, lon, pop

interface GazetteerData {
  cities_by_state: Map<string, Map<string, CityCand[]>>; // key cc|st
  cities_by_country: Map<string, Map<string, CityCand[]>>;
  counties_us: Map<string, LatLon>; // key st|slug
  state_centroids: Map<string, LatLon>; // key cc|st
  country_centroids: Map<string, { lat: number; lon: number; name: string }>;
  state_names: Map<string, Map<string, string>>; // cc -> slug -> st_code
  countryAliases: Map<string, string>;
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
    getOrInit(cm, key, () => []).push([lat, lon, pop]);
    const ccm = getOrInit(cities_by_country, cc, () => new Map<string, CityCand[]>());
    getOrInit(ccm, key, () => []).push([lat, lon, pop]);
    if (alt) {
      for (const a of alt.split(",")) {
        const ak = slug(a);
        if (ak && ak !== key) {
          getOrInit(cm, ak, () => []).push([lat, lon, Math.floor(pop / 2)]);
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

  return {
    cities_by_state, cities_by_country, counties_us,
    state_centroids, country_centroids, state_names,
    countryAliases: aliases,
  };
}

function detectCountry(parts: string[], aliases: Map<string, string>): string | null {
  if (parts.length === 0) return null;
  const last = slug(parts[parts.length - 1]!);
  if (aliases.has(last)) return aliases.get(last)!;
  if (parts.length >= 2) {
    const last2 = slug(parts[parts.length - 1] + " " + parts[parts.length - 2]);
    if (aliases.has(last2)) return aliases.get(last2)!;
  }
  return null;
}

interface DetectStateResult { st: string | null; idx: number | null; }

function detectState(parts: string[], cc: string, stateNames: Map<string, Map<string, string>>): DetectStateResult {
  if (parts.length === 0) return { st: null, idx: null };
  if (cc === "US") {
    for (let idx = parts.length - 1; idx >= 0; idx--) {
      const tok = parts[idx]!.trim();
      const tokUp = tok.toUpperCase().replace(/\.+$/, "");
      if (US_STATE_ABBR[tokUp]) return { st: tokUp, idx };
      const slugged = slug(tok);
      if (US_NAME_TO_ABBR[slugged]) return { st: US_NAME_TO_ABBR[slugged]!, idx };
      const usMap = stateNames.get("US");
      if (usMap && usMap.has(slugged)) return { st: usMap.get(slugged)!, idx };
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
    }
    return { st: null, idx: null };
  }
  const cm = stateNames.get(cc);
  if (cm) {
    for (let idx = parts.length - 1; idx >= 0; idx--) {
      const slugged = slug(parts[idx]!);
      if (cm.has(slugged)) return { st: cm.get(slugged)!, idx };
    }
  }
  return { st: null, idx: null };
}

function bestCity(cands: CityCand[]): LatLon {
  let best = cands[0]!;
  for (const c of cands) if (c[2] > best[2]) best = c;
  return [best[0], best[1]];
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
}

function geocodeOne(place: string, gz: GazetteerData): GeocodeResult | null {
  const parts = place.split(",").map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const cc = detectCountry(parts, gz.countryAliases) ?? "US";
  const { st, idx: stIdx } = detectState(parts, cc, gz.state_names);
  const hasCountyToken = parts.some(p => COUNTY_SUFFIX.test(p));

  if (cc === "US" && st && hasCountyToken) {
    const cty = findCounty(parts, st, gz.counties_us);
    if (cty) {
      const upper = stIdx ?? parts.length;
      for (let i = 0; i < upper; i++) {
        const tok = parts[i]!;
        if (COUNTY_SUFFIX.test(tok)) continue;
        const s = slug(tok);
        const cands = gz.cities_by_state.get(`${cc}|${st}`)?.get(s);
        if (cands && cands.length > 0) {
          const [lat, lon] = bestCity(cands);
          return { lat, lon, level: "city", cc, st };
        }
      }
      return { lat: cty[0], lon: cty[1], level: "county", cc, st };
    }
  }

  if (st) {
    const upper = stIdx ?? parts.length;
    const candLookup = gz.cities_by_state.get(`${cc}|${st}`);
    if (candLookup) {
      for (let i = 0; i < upper; i++) {
        const tok = parts[i]!;
        if (COUNTY_SUFFIX.test(tok)) continue;
        const s = slug(tok);
        const cands = candLookup.get(s);
        if (cands && cands.length > 0) {
          const [lat, lon] = bestCity(cands);
          return { lat, lon, level: "city", cc, st };
        }
      }
    }
    if (cc === "US") {
      const cty = findCounty(parts, st, gz.counties_us);
      if (cty) return { lat: cty[0], lon: cty[1], level: "county", cc, st };
    }
    const sc = gz.state_centroids.get(`${cc}|${st}`);
    if (sc) return { lat: sc[0], lon: sc[1], level: "admin1", cc, st };
  }

  const candLookup = gz.cities_by_country.get(cc);
  if (candLookup) {
    for (const tok of parts) {
      const s = slug(tok);
      const cands = candLookup.get(s);
      if (cands && cands.length > 0) {
        const [lat, lon] = bestCity(cands);
        return { lat, lon, level: "city", cc, st: null };
      }
    }
  }
  const cc_centroid = gz.country_centroids.get(cc);
  if (cc_centroid) {
    return { lat: cc_centroid.lat, lon: cc_centroid.lon, level: "country", cc, st: null };
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

  const results: Record<string, GeocodeResult> = {};
  const misses: string[] = [];
  const counts = { city: 0, county: 0, admin1: 0, country: 0, miss: 0 };
  for (const place of places) {
    const r = geocodeOne(place, gz);
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
  return 0;
}

exit(main());
