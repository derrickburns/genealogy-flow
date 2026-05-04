import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import * as topojson from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";

let world = null;
let usStates = null;
let landEntries = null;
let landGrid = null;
let stateByAbbr = null;
let countryFeatures = null;

const US_STATE_ABBR = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",
  CT:"Connecticut",DE:"Delaware",DC:"District of Columbia",FL:"Florida",GA:"Georgia",
  HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",
  LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",
  MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",
  NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",
  OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",
  SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",
  VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",
};

function slug(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`status ${r.status}`);
  return r.json();
}

async function ensureTopology() {
  if (world) return;
  [world, usStates] = await Promise.all([
    fetchJson("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json"),
    fetchJson("https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json").catch(() => null),
  ]);
}

function featureBounds(feature) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  function visit(coords) {
    if (!coords) return;
    if (typeof coords[0] === "number") {
      const lon = coords[0], lat = coords[1];
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    } else {
      for (const c of coords) visit(c);
    }
  }
  visit(feature?.geometry?.coordinates);
  return Number.isFinite(minLon) ? [minLon, minLat, maxLon, maxLat] : null;
}

function boundsContains(bounds, lon, lat) {
  return !bounds || (lon >= bounds[0] && lon <= bounds[2] && lat >= bounds[1] && lat <= bounds[3]);
}

function featureContains(entry, lat, lon) {
  return !!entry && boundsContains(entry.bounds, lon, lat) && d3.geoContains(entry.feature, [lon, lat]);
}

function featureEntries(feature) {
  const entries = [];
  function addGeometry(geometry, properties = null) {
    if (!geometry) return;
    if (geometry.type === "GeometryCollection") {
      for (const g of geometry.geometries || []) addGeometry(g, properties);
      return;
    }
    if (geometry.type === "MultiPolygon") {
      for (const coordinates of geometry.coordinates || []) {
        addGeometry({ type: "Polygon", coordinates }, properties);
      }
      return;
    }
    if (geometry.type !== "Polygon") return;
    const f = { type: "Feature", properties, geometry };
    const bounds = featureBounds(f);
    if (bounds) entries.push({ feature: f, bounds });
  }
  if (feature?.type === "FeatureCollection") {
    for (const f of feature.features || []) entries.push(...featureEntries(f));
  } else if (feature?.type === "Feature") {
    addGeometry(feature.geometry, feature.properties || null);
  } else {
    addGeometry(feature);
  }
  return entries;
}

function landGridKey(lon, lat) {
  const size = 5;
  const x = Math.max(0, Math.min(71, Math.floor((lon + 180) / size)));
  const y = Math.max(0, Math.min(35, Math.floor((lat + 90) / size)));
  return `${x}|${y}`;
}

function buildLandGrid(entries) {
  const grid = new Map();
  const size = 5;
  for (const entry of entries) {
    const b = entry.bounds;
    const minX = Math.max(0, Math.min(71, Math.floor((b[0] + 180) / size)));
    const maxX = Math.max(0, Math.min(71, Math.floor((b[2] + 180) / size)));
    const minY = Math.max(0, Math.min(35, Math.floor((b[1] + 90) / size)));
    const maxY = Math.max(0, Math.min(35, Math.floor((b[3] + 90) / size)));
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const key = `${x}|${y}`;
        let list = grid.get(key);
        if (!list) { list = []; grid.set(key, list); }
        list.push(entry);
      }
    }
  }
  return grid;
}

function ensureLandIndex() {
  if (landEntries) return;
  landEntries = [];
  landGrid = new Map();
  if (!world?.objects?.land) return;
  landEntries = featureEntries(topojson.feature(world, world.objects.land));
  landGrid = buildLandGrid(landEntries);
}

function ensureStateIndex() {
  if (stateByAbbr) return;
  stateByAbbr = new Map();
  if (!usStates?.objects?.states) return;
  const nameToAbbr = new Map();
  for (const [abbr, name] of Object.entries(US_STATE_ABBR)) nameToAbbr.set(slug(name), abbr);
  const fc = topojson.feature(usStates, usStates.objects.states);
  for (const f of fc.features || []) {
    const abbr = nameToAbbr.get(slug(f.properties?.name || ""));
    if (abbr) stateByAbbr.set(abbr, { feature: f, bounds: featureBounds(f) });
  }
}

function ensureCountryFeatures() {
  if (countryFeatures) return countryFeatures;
  countryFeatures = [];
  if (!world?.objects?.countries) return countryFeatures;
  const fc = topojson.feature(world, world.objects.countries);
  countryFeatures = (fc.features || []).map(feature => ({
    feature,
    bounds: featureBounds(feature),
    name: slug(feature.properties?.name || ""),
  }));
  return countryFeatures;
}

function countryIndex(countries = []) {
  const byName = new Map();
  for (const entry of ensureCountryFeatures()) if (entry.name) byName.set(entry.name, entry);
  const aliases = {
    US: ["united states", "united states of america", "usa"],
    GB: ["united kingdom", "great britain", "england", "scotland", "wales"],
    RU: ["russia", "russian federation"],
    KR: ["south korea", "republic of korea"],
    KP: ["north korea"],
    CD: ["democratic republic of the congo"],
    CG: ["republic of the congo"],
    CZ: ["czech republic", "czechia"],
  };
  const byCode = new Map();
  for (const c of countries || []) {
    const names = [slug(c.name), ...((aliases[c.cc] || []).map(slug))].filter(Boolean);
    const hit = names.map(n => byName.get(n)).find(Boolean);
    if (hit) byCode.set(c.cc, hit);
  }
  return byCode;
}

function hash32(value) {
  let h = 2166136261;
  const s = String(value || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function jitterRadius(level) {
  if (level === "city") return 0.02;
  if (level === "county") return 0.15;
  if (level === "admin1") return 0.4;
  return 0.7;
}

function candidateAllowed(lat, lon, item, countriesByCode) {
  ensureLandIndex();
  if (landEntries.length) {
    const land = landGrid.get(landGridKey(lon, lat)) || [];
    if (!land.some(entry => featureContains(entry, lat, lon))) return false;
  }
  if (item.cc === "US" && item.st) {
    ensureStateIndex();
    const state = stateByAbbr.get(item.st);
    if (state && !featureContains(state, lat, lon)) return false;
  }
  const country = item.cc ? countriesByCode.get(item.cc) : null;
  if (country && !featureContains(country, lat, lon)) return false;
  return true;
}

function candidatePool(item, countriesByCode) {
  const lat = Number(item.lat);
  const lon = Number(item.lon);
  const radius = jitterRadius(item.level);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !radius) return [[lat, lon]];
  const h = hash32(item.key);
  const baseAngle = (h / 0xffffffff) * Math.PI * 2;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const pool = [];
  for (let i = 0; i < 24; i++) {
    const ring = 0.35 + 0.65 * (((h >>> ((i % 4) * 4)) & 0xf) / 15);
    const angle = baseAngle + i * golden;
    const candLat = lat + Math.sin(angle) * radius * ring;
    const latScale = Math.max(0.25, Math.cos((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180));
    const candLon = lon + (Math.cos(angle) * radius * ring) / latScale;
    if (candidateAllowed(candLat, candLon, item, countriesByCode)) {
      pool.push([Number(candLat.toFixed(6)), Number(candLon.toFixed(6))]);
    }
  }
  if (!pool.length) pool.push([lat, lon]);
  return pool;
}

self.addEventListener("message", async e => {
  const { id, items = [], countries = [] } = e.data || {};
  try {
    await ensureTopology();
    const countriesByCode = countryIndex(countries);
    const pools = items.map(item => ({ key: item.key, pool: candidatePool(item, countriesByCode) }));
    self.postMessage({ id, ok: true, pools });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
});
