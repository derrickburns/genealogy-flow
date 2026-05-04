// ---------- Pipeline ----------
let _kfJitterPoolCache = new Map();
let _kfJitterCache = new Map();
let _kfJitterWorker = null;
let _kfJitterWorkerSeq = 0;
const _kfJitterWorkerPending = new Map();

function _kfResetJitterIndexes() {
  _kfJitterPoolCache = new Map();
  _kfJitterCache = new Map();
}

function _kfHash32(value) {
  let h = 2166136261;
  const s = String(value || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function _kfJitterRadius(level) {
  // Scale jitter to geocode precision so city-level points don't drift into
  // the ocean. City ~1 km, county ~10 km, state ~30 km, country wider.
  if (level === "city") return 0.02;
  if (level === "county") return 0.15;
  if (level === "admin1") return 0.4;
  return 0.7;
}

function _kfJitterPoolKey(lat, lon, level, g = null) {
  return `${lat.toFixed(5)}|${lon.toFixed(5)}|${level}|${g?.cc || ""}|${g?.st || ""}`;
}

function _kfFallbackJitterPool(lat, lon, level, poolKey) {
  const radius = _kfJitterRadius(level);
  if (!radius) return [[lat, lon]];
  const h = _kfHash32(poolKey);
  const baseAngle = (h / 0xffffffff) * Math.PI * 2;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const pool = [];
  for (let i = 0; i < 24; i++) {
    const ring = 0.35 + 0.65 * (((h >>> ((i % 4) * 4)) & 0xf) / 15);
    const angle = baseAngle + i * golden;
    const candLat = lat + Math.sin(angle) * radius * ring;
    const latScale = Math.max(0.25, Math.cos((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180));
    const candLon = lon + (Math.cos(angle) * radius * ring) / latScale;
    pool.push([candLat, candLon]);
  }
  return pool;
}

function jitter(lat, lon, level, key = "", g = null) {
  const poolKey = _kfJitterPoolKey(lat, lon, level, g);
  const cacheKey = `${poolKey}|${key}`;
  const cached = _kfJitterCache.get(cacheKey);
  if (cached) return cached;
  let pool = _kfJitterPoolCache.get(poolKey);
  if (!pool) {
    pool = _kfFallbackJitterPool(lat, lon, level, poolKey);
    _kfJitterPoolCache.set(poolKey, pool);
  }
  const h = _kfHash32(cacheKey);
  const out = pool[h % pool.length] || [lat, lon];
  _kfJitterCache.set(cacheKey, out);
  return out;
}

function _kfGetJitterWorker() {
  if (_kfJitterWorker) return _kfJitterWorker;
  if (typeof Worker === "undefined") return null;
  try {
    _kfJitterWorker = new Worker("./workers/jitter-worker.js", { type: "module" });
  } catch (e) {
    console.warn("[kf] could not start jitter worker:", e?.message || e);
    _kfJitterWorker = null;
    return null;
  }
  _kfJitterWorker.addEventListener("message", e => {
    const msg = e.data || {};
    const pending = _kfJitterWorkerPending.get(msg.id);
    if (!pending) return;
    _kfJitterWorkerPending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg.pools || []);
    else pending.reject(new Error(msg.error || "jitter worker failed"));
  });
  _kfJitterWorker.addEventListener("error", e => {
    console.warn("[kf] jitter worker error:", e.message || e);
    for (const [id, pending] of _kfJitterWorkerPending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(e.message || "jitter worker error"));
      _kfJitterWorkerPending.delete(id);
    }
    try { _kfJitterWorker.terminate(); } catch (_) {}
    _kfJitterWorker = null;
  });
  return _kfJitterWorker;
}

function _kfComputeJitterPoolsInWorker(items) {
  const worker = _kfGetJitterWorker();
  if (!worker || !items.length) return Promise.resolve([]);
  const id = ++_kfJitterWorkerSeq;
  const countries = (gazetteer?.countries || []).map(c => ({ cc: c.cc, name: c.name }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _kfJitterWorkerPending.delete(id);
      reject(new Error("jitter worker timed out"));
    }, 5000);
    _kfJitterWorkerPending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, items, countries });
  });
}

async function _kfPrecomputeJitterPoolsForTimeline(individuals, geocode) {
  if (!individuals?.length || !geocode) return false;
  const placeCache = new Map();
  const pending = new Map();
  for (const ind of individuals) {
    for (const e of ind.events || []) {
      let g = placeCache.get(e.place);
      if (g === undefined) { g = geocode(e.place); placeCache.set(e.place, g); }
      if (!g) continue;
      const key = _kfJitterPoolKey(g.lat, g.lon, g.level, g);
      if (!_kfJitterPoolCache.has(key)) {
        pending.set(key, {
          key,
          lat: g.lat,
          lon: g.lon,
          level: g.level,
          cc: g.cc || "",
          st: g.st || "",
        });
      }
    }
  }
  const items = [...pending.values()];
  if (!items.length) return true;
  try {
    const pools = await _kfComputeJitterPoolsInWorker(items);
    for (const row of pools || []) {
      if (row?.key && Array.isArray(row.pool) && row.pool.length) {
        _kfJitterPoolCache.set(row.key, row.pool);
      }
    }
    return true;
  } catch (e) {
    console.warn("[kf] land-aware jitter precompute failed; using deterministic fallback:", e?.message || e);
    return false;
  }
}

function hasRecordedParent(id, parentsOf) {
  const p = parentsOf.get(id);
  return !!(p && (p[0] || p[1]));
}

function parentStatus(id, parentsOf) {
  // 0 = both parents recorded, 1 = exactly one missing, 2 = neither recorded
  const p = parentsOf.get(id);
  if (!p) return 2;
  const c = (p[0] ? 1 : 0) + (p[1] ? 1 : 0);
  return c === 2 ? 0 : c === 1 ? 1 : 2;
}

const EVENT_TYPE_CODE = {BIRT:0, DEAT:1, RESI:2, MARR:3, EMIG:4, IMMI:5, CENS:6, BAPM:7, BURI:8, CHR:9};
const EVENT_TYPE_LABEL = ["born", "died", "lived in", "married in", "emigrated from", "immigrated to", "census in", "baptized in", "buried in", "christened in", "event in"];

function buildTimeline(individuals, geocode, parentsOf) {
  const dwells = [], flows = [];
  const dwellIndi = [], flowIndi = [], dwellSrc = [], flowSrc = [];
  const dwellExact = [], flowExact = [];
  const dwellLevel = [], flowFromLevel = [], flowToLevel = [];
  const dwellType = [], dwellPlace = [];
  const placeMap = new Map(); const placesList = [];
  function placeIdx(p) { let i = placeMap.get(p); if (i == null) { i = placesList.length; placesList.push(p); placeMap.set(p, i); } return i; }
  let mn = 9999, mx = 0, geocoded = 0, missed = 0;
  const cache = new Map();
  const evCities = new Map(); // key (lat3,lon3) -> {name, lat, lon, count}
  for (let idx = 0; idx < individuals.length; idx++) {
    const ind = individuals[idx];
    if (!ind.events.length) continue;
    const isSource = parentStatus(ind.id, parentsOf);
    const birthYear = Number.isFinite(ind.birth_year) ? ind.birth_year : null;
    const deathYear = Number.isFinite(ind.death_year) ? ind.death_year : null;
    const coded = [];
    for (const e of ind.events) {
      // Guard against clearly impossible event chronology in source data.
      // A stray late residence/census/imported fact after someone's recorded
      // death can keep them visible decades too long on the map.
      if (birthYear != null && e.year != null && e.year < birthYear - 1) continue;
      if (deathYear != null && e.year != null && e.year > deathYear + 1) continue;
      let g = cache.get(e.place);
      if (g === undefined) { g = geocode(e.place); cache.set(e.place, g); }
      if (!g) { missed++; continue; }
      geocoded++;
      const exact = g.level === "city" ? 1 : 0;
      const levelCode = _kfGeoLevelCode(g.level);
      const [lat, lon] = jitter(g.lat, g.lon, g.level, `${ind.id}|${e.place}`, g);
      if (exact) {
        const key = g.lat.toFixed(2) + "," + g.lon.toFixed(2);
        let ec = evCities.get(key);
        if (!ec) {
          const parts = e.place.split(",").map(s => s.trim()).filter(Boolean);
          const name = (parts.length >= 2 ? parts[0] + ", " + parts[1] : parts[0]) || "?";
          ec = { name, lat: g.lat, lon: g.lon, count: 0, pop: 0 };
          evCities.set(key, ec);
        }
        ec.count++;
      }
      const tcode = EVENT_TYPE_CODE[e.type] ?? 10;
      // Store base (un-jittered) coords at indices 6,7 for flow comparison.
      coded.push([e.year, lat, lon, exact, tcode, placeIdx(e.place), g.lat, g.lon, levelCode]);
    }
    if (!coded.length) continue;
    coded.sort((a, b) => a[0] - b[0]);
    let prev = null;
    for (const c of coded) {
      const [y, lat, lon, exact, tcode, pidx, blat, blon, levelCode] = c;
      if (y < mn) mn = y; if (y > mx) mx = y;
      dwells.push([y, lat, lon]); dwellIndi.push(idx); dwellSrc.push(isSource); dwellExact.push(exact);
      dwellLevel.push(levelCode);
      dwellType.push(tcode); dwellPlace.push(pidx);
      if (prev) {
        const [py, plat, plon, pex, , , pblat, pblon, pLevelCode] = prev;
        // Use base geocode coords (not jittered) to determine whether a real
        // move occurred. Comparing jittered coords incorrectly created flows
        // between consecutive events at the same location, causing the
        // destination ring to appear at a different jitter than the marker.
        if ((pblat !== blat || pblon !== blon) && y > py) {
          flows.push([py, y, plat, plon, lat, lon]);
          flowIndi.push(idx); flowSrc.push(isSource);
          flowExact.push(exact && pex ? 1 : 0);
          flowFromLevel.push(pLevelCode);
          flowToLevel.push(levelCode);
        }
      }
      prev = [y, lat, lon, exact, tcode, pidx, blat, blon, levelCode];
    }
  }
  if (mn > mx) { mn = 1700; mx = 2026; }
  const eventCitiesArr = Array.from(evCities.values()).sort((a, b) => b.count - a.count);
  for (let i = 0; i < eventCitiesArr.length; i++) eventCitiesArr[i]._idx = i;
  return { dwells, flows, dwellIndi, flowIndi, dwellSrc, flowSrc, dwellExact, flowExact, dwellLevel, flowFromLevel, flowToLevel, dwellType, dwellPlace, places: placesList, eventCities: eventCitiesArr, min_year: mn, max_year: mx, geocoded, missed };
}

function loadTimelineArrays(t, sideForIdx, opts = {}) {
  const requestedYear = Number.isFinite(Number(opts.year))
    ? Number(opts.year)
    : (opts.preserveYear && Number.isFinite(curYear) ? curYear : null);
  const N = t.dwells.length, F = t.flows.length;
  dwellY = new Int16Array(N); dwellLat = new Float32Array(N); dwellLon = new Float32Array(N);
  dwellSide = new Uint8Array(N); dwellSrc = new Uint8Array(N); dwellIndi = new Int32Array(N);
  dwellBlood = new Uint8Array(N); dwellExact = new Uint8Array(N); dwellLevel = new Uint8Array(N);
  dwellType = new Uint8Array(N); dwellPlace = new Int32Array(N);
  dwellSx = new Float32Array(N); dwellSy = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const d = t.dwells[i];
    dwellY[i] = d[0]; dwellLat[i] = d[1]; dwellLon[i] = d[2];
    dwellIndi[i] = t.dwellIndi[i]; dwellSrc[i] = t.dwellSrc[i];
    dwellExact[i] = t.dwellExact ? t.dwellExact[i] : 0;
    dwellLevel[i] = (t.dwellLevel && t.dwellLevel[i] != null) ? t.dwellLevel[i] : (dwellExact[i] ? GEO_LEVEL_CITY : GEO_LEVEL_ADMIN1);
    dwellType[i] = t.dwellType ? t.dwellType[i] : 10;
    dwellPlace[i] = t.dwellPlace ? t.dwellPlace[i] : -1;
    dwellSide[i] = sideForIdx[t.dwellIndi[i]] ?? 3;
  }
  placesList = t.places || [];
  flowFromY = new Int16Array(F); flowToY = new Int16Array(F);
  flowFromLat = new Float32Array(F); flowFromLon = new Float32Array(F);
  flowToLat = new Float32Array(F); flowToLon = new Float32Array(F);
  flowSide = new Uint8Array(F); flowSrc = new Uint8Array(F); flowIndi = new Int32Array(F);
  flowBlood = new Uint8Array(F); flowExact = new Uint8Array(F);
  flowFromLevel = new Uint8Array(F); flowToLevel = new Uint8Array(F);
  flowFromSx = new Float32Array(F); flowFromSy = new Float32Array(F);
  flowToSx = new Float32Array(F); flowToSy = new Float32Array(F);
  for (let i = 0; i < F; i++) {
    const f = t.flows[i];
    flowFromY[i] = f[0]; flowToY[i] = f[1];
    flowFromLat[i] = f[2]; flowFromLon[i] = f[3];
    flowToLat[i] = f[4]; flowToLon[i] = f[5];
    flowIndi[i] = t.flowIndi[i]; flowSrc[i] = t.flowSrc[i];
    flowExact[i] = t.flowExact ? t.flowExact[i] : 0;
    flowFromLevel[i] = (t.flowFromLevel && t.flowFromLevel[i] != null) ? t.flowFromLevel[i] : (flowExact[i] ? GEO_LEVEL_CITY : GEO_LEVEL_ADMIN1);
    flowToLevel[i] = (t.flowToLevel && t.flowToLevel[i] != null) ? t.flowToLevel[i] : (flowExact[i] ? GEO_LEVEL_CITY : GEO_LEVEL_ADMIN1);
    flowSide[i] = sideForIdx[t.flowIndi[i]] ?? 3;
  }
  dwellOrder = new Int32Array(N); for (let i = 0; i < N; i++) dwellOrder[i] = i; dwellOrder.sort((a, b) => dwellY[a] - dwellY[b]);
  indiDwells = new Map();
  for (let i = 0; i < N; i++) { const idx = dwellIndi[i]; let arr = indiDwells.get(idx); if (!arr) { arr = []; indiDwells.set(idx, arr); } arr.push(i); }
  flowFromOrder = new Int32Array(F); for (let i = 0; i < F; i++) flowFromOrder[i] = i; flowFromOrder.sort((a, b) => flowFromY[a] - flowFromY[b]);
  _kfDwellState = null;
  minYear = t.min_year; maxYear = t.max_year;
  range.min = minYear; range.max = maxYear; range.step = 0.1;
  range.value = requestedYear == null
    ? Math.max(minYear, 1700)
    : Math.max(minYear, Math.min(maxYear, requestedYear));
  const _syl = document.getElementById("startYearLabel");
  if (_syl) _syl.textContent = String(minYear);
  curYear = parseFloat(range.value);
  timelineLoaded = true; projectAll();
  fxCtx.clearRect(0, 0, W, H); playBtn.disabled = false;
  _kfClampLoopMarkersToTimeline();
  renderMigBar();
}

function rebuildSideArrays() {
  if (!lastTimeline || !lastSideById || !lastIndividuals) return;
  for (let i = 0; i < dwellIndi.length; i++) {
    const ind = lastIndividuals[dwellIndi[i]];
    if (!ind) { dwellSide[i] = 2; dwellBlood[i] = 0; continue; }
    dwellSide[i] = lastSideById.get(ind.id) ?? 2;
    dwellBlood[i] = lastBloodSet && lastBloodSet.has(ind.id) ? 1 : 0;
  }
  for (let i = 0; i < flowIndi.length; i++) {
    const ind = lastIndividuals[flowIndi[i]];
    if (!ind) { flowSide[i] = 2; flowBlood[i] = 0; continue; }
    flowSide[i] = lastSideById.get(ind.id) ?? 2;
    flowBlood[i] = lastBloodSet && lastBloodSet.has(ind.id) ? 1 : 0;
  }
  fxCtx.clearRect(0, 0, W, H);
}

async function ensureGazetteer() {
  if (gazetteer) return gazetteer;
  stats.textContent = "loading gazetteer (7 MB)...";
  const r = await fetch("/api/geocodes");
  const j = await r.json();
  gazetteer = j; geocoder = buildGeocoder(j);
  // buildMajorCities removed: the major-cities overlay is no longer drawn.
  return j;
}

function buildMajorCities(gz) {
  // De-dupe by city name + cc + admin1; keep highest-pop entry. Filter to pop >= 50k.
  const byKey = new Map();
  for (const row of gz.cities) {
    const [s, cc, st, lat, lon, pop] = row;
    if (pop < 50000) continue;
    const key = cc + "|" + st + "|" + s;
    const ex = byKey.get(key);
    if (!ex || ex.pop < pop) byKey.set(key, { name: titleCase(s), cc, st, lat, lon, pop });
  }
  let cities = Array.from(byKey.values()).sort((a, b) => b.pop - a.pop);
  // Disambiguate names that occur multiple times: append state/country to all duplicates.
  const nameCount = new Map();
  for (const c of cities) nameCount.set(c.name, (nameCount.get(c.name) || 0) + 1);
  for (const c of cities) {
    if (nameCount.get(c.name) > 1) {
      const suffix = c.cc === "US" ? c.st : c.cc;
      c.name = c.name + ", " + suffix;
    }
  }
  majorCities = cities;
  for (let i = 0; i < majorCities.length; i++) majorCities[i]._idx = i;
}

// Only the event-tied city layer is drawn now; majorCities was retired in
// the simplification pass. Returns an empty list when no GEDCOM is loaded.
function currentCities() { return eventCities && eventCities.length ? eventCities : []; }

let cityCanonicalByName = new Map();
function rebuildCityCanonical() {
  cityCanonicalByName = new Map();
  const list = currentCities();
  if (!list) return;
  for (const c of list) {
    const ex = cityCanonicalByName.get(c.name);
    const w = c.pop != null ? c.pop : c.count || 0;
    if (!ex || (ex.pop != null ? ex.pop : ex.count || 0) < w) {
      cityCanonicalByName.set(c.name, c);
    }
  }
}

let cityTree = null;
function buildCityTree() {
  const list = currentCities();
  if (!list || !list.length) { cityTree = null; return null; }
  for (let i = 0; i < list.length; i++) list[i]._idx = i;
  cityTree = d3.quadtree().x(c => c.lon).y(c => c.lat).addAll(list);
  return cityTree;
}

function precomputeDwellCities() {
  if (!dwellLat) return;
  buildCityTree();
  rebuildCityCanonical();
  dwellCity = new Int32Array(dwellLat.length);
  if (!cityTree) { dwellCity.fill(-1); return; }
  for (let i = 0; i < dwellLat.length; i++) {
    const c = cityTree.find(dwellLon[i], dwellLat[i]);
    dwellCity[i] = c ? c._idx : -1;
  }
}

function titleCase(s) {
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

const ROOT_MAX_DEPTH = 6;
const ROOT_TOP_N = 10;

function ancestorScore(rootId, parentsOf, indiById, maxDepth) {
  const root = indiById.get(rootId);
  if (!root) return { score: 0, found: 0 };
  const queue = [[rootId, 0]];
  const visited = new Set([rootId]);
  let total = 0;
  let found = 0;
  while (queue.length) {
    const [id, gen] = queue.shift();
    if (gen > maxDepth) continue;
    const ind = indiById.get(id);
    if (!ind) continue;
    if (gen > 0) found++;
    const richness = (ind.events?.length ?? 0);
    total += richness / (1 << gen);
    const pars = parentsOf.get(id);
    if (!pars) continue;
    for (const pid of pars) {
      if (pid && !visited.has(pid)) {
        visited.add(pid);
        queue.push([pid, gen + 1]);
      }
    }
  }
  return { score: total, found };
}

function rankRootCandidates(individuals, isParent, parentsOf, indiById) {
  let expected = 0;
  for (let d = 1; d <= ROOT_MAX_DEPTH; d++) expected += 1 << d;
  const scored = [];
  for (const ind of individuals) {
    if (ind.death_year != null) continue;
    const { score, found } = ancestorScore(ind.id, parentsOf, indiById, ROOT_MAX_DEPTH);
    if (score <= 0 || found < 2) continue;
    const pci = expected > 0 ? found / expected : 0;
    scored.push({ ind, score, count: found, pci });
  }
  scored.sort((a, b) =>
    b.score - a.score
    || (b.ind.birth_year ?? -1) - (a.ind.birth_year ?? -1),
  );
  return scored.slice(0, ROOT_TOP_N).map(({ ind, score, count, pci }) => ({
    ind, count, score, pci,
    label: `PCI ${(pci * 100).toFixed(0)}%`,
  }));
}

function gedcomNameFromFile(file) {
  return file.name.replace(/\.(ged|gedcom)$/i, "").trim() || "untitled";
}

async function loadGedcomToProxy(file, gedcomText, mode) {
  const proxy = await detectChatProxy();
  if (!proxy) return { ok: false, reason: "no proxy" };
  const name = gedcomNameFromFile(file);
  try {
    let r = await fetch(proxy + "/load-gedcom?mode=" + encodeURIComponent(mode || "add"), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "kf-filename": encodeURIComponent(name) },
      body: gedcomText,
    });
    // 409 on duplicate name (mode=add). Auto-promote to replace so the user
    // doesn't have to re-load with a flag — they re-picked the file deliberately.
    if (r.status === 409 && (mode || "add") === "add") {
      r = await fetch(proxy + "/load-gedcom?mode=replace", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "kf-filename": encodeURIComponent(name) },
        body: gedcomText,
      });
    }
    const j = await r.json();
    if (!j.ok) console.warn("[kf] proxy load-gedcom failed:", j.error);
    return j;
  } catch (e) {
    console.warn("[kf] proxy load-gedcom error:", e.message || e);
    return { ok: false, reason: e.message || String(e) };
  }
}

async function fetchPersonSources() {
  // Build a map from browser-index → Map<sourceId, sourceName> covering
  // every GEDCOM the person appears in. For a person with no cluster
  // entry, the map degenerates to {activeSource}. Used by the "by gedcom
  // tree" cluster mode to break each cluster down by tree-of-origin while
  // counting cross-tree-linked persons in every tree they appear in.
  if (!lastIndividuals || !_kfActiveTreeName) { _kfPersonSources = null; return; }
  const proxy = await detectChatProxy();
  if (!proxy) { _kfPersonSources = null; return; }
  try {
    const sourcesResp = await fetch(proxy + "/sources").then(r => r.json());
    const sources = (sourcesResp && sourcesResp.ok ? sourcesResp.sources : []) || [];
    const sourceById = new Map(sources.map(s => [s.id, s.name]));
    const activeSrc = sources.find(s => s.name === _kfActiveTreeName);
    const activeId = activeSrc ? activeSrc.id : null;
    const activeMap = activeSrc ? new Map([[activeSrc.id, activeSrc.name]]) : new Map();
    const sqlResp = await fetch(proxy + "/sql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "SELECT cluster_id, source_id, indi_id FROM person_clusters",
        limit: 1000,
      }),
    }).then(r => r.json());
    const out = new Map();
    if (sqlResp && sqlResp.ok && sqlResp.rows && activeId != null) {
      const clusterToMembers = new Map();
      for (const row of sqlResp.rows) {
        let arr = clusterToMembers.get(row.cluster_id);
        if (!arr) { arr = []; clusterToMembers.set(row.cluster_id, arr); }
        arr.push({ src: row.source_id, indi: row.indi_id });
      }
      const activeIndiToSources = new Map();
      for (const members of clusterToMembers.values()) {
        const activeMember = members.find(m => m.src === activeId);
        if (!activeMember) continue;
        const set = new Set();
        for (const m of members) set.add(m.src);
        activeIndiToSources.set(activeMember.indi, set);
      }
      for (let idx = 0; idx < lastIndividuals.length; idx++) {
        const ind = lastIndividuals[idx];
        if (!ind) continue;
        const set = activeIndiToSources.get(ind.id);
        if (set) {
          const m = new Map();
          for (const sid of set) m.set(sid, sourceById.get(sid) || String(sid));
          out.set(idx, m);
        } else {
          out.set(idx, activeMap);
        }
      }
    } else {
      for (let idx = 0; idx < lastIndividuals.length; idx++) {
        out.set(idx, activeMap);
      }
    }
    _kfPersonSources = out;
  } catch (_) { _kfPersonSources = null; }
}

function _kfGetLoadedSourcesList() {
  return [..._kfLoadedSources.values()]
    .map(s => ({
      id: s.source_id,
      name: s.name,
      common_name: s.common_name || s.name,
      source_kind: s.source_kind || null,
      catalog_key: s.catalog_key || null,
      tree_uuid: s.tree_uuid || null,
      content_hash: s.content_hash || null,
      content_changed_at: s.content_changed_at || null,
      owner_email: s.owner_email || null,
      owner_uuid: s.owner_uuid || null,
      relation: s.relation || null,
      top_pci_id: s.top_pci_id || null,
      top_pci_name: s.top_pci_name || null,
      top_pci_score: s.top_pci_score ?? null,
      loaded_at: s.loaded_at,
      n_individuals: s.n_individuals,
      active: s.name === _kfActiveTreeName,
      selected: _kfSelectedSourceIds.has(s.source_id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function _kfEnsureSelectedSources() {
  const validIds = new Set([..._kfLoadedSources.values()].map(s => s.source_id));
  _kfSelectedSourceIds = new Set([..._kfSelectedSourceIds].filter(id => validIds.has(id)));
  if (_kfSelectedSourceIds.size === 0) {
    for (const id of validIds) _kfSelectedSourceIds.add(id);
  }
}

function _kfSelectedIdsSqlList() {
  const ids = [..._kfSelectedSourceIds].filter(Number.isFinite);
  return ids.length ? ids.join(",") : "NULL";
}

function _kfRefreshBrowserViews() {
  if (!_kfBrowserDb) return;
  const idsSql = _kfSelectedIdsSqlList();
  const hasSelection = _kfSelectedSourceIds.size > 0;
  const where = hasSelection ? `source_id IN (${idsSql})` : "0";
  try {
    _kfBrowserDb.run(`DROP VIEW IF EXISTS sources`);
    _kfBrowserDb.run(`DROP VIEW IF EXISTS individuals`);
    _kfBrowserDb.run(`DROP VIEW IF EXISTS events`);
    _kfBrowserDb.run(`DROP VIEW IF EXISTS families`);
    _kfBrowserDb.run(`DROP VIEW IF EXISTS family_children`);
    _kfBrowserDb.run(`CREATE VIEW sources AS SELECT * FROM base_sources WHERE id IN (${idsSql})`);
    _kfBrowserDb.run(`CREATE VIEW individuals AS SELECT * FROM base_individuals WHERE ${where}`);
    _kfBrowserDb.run(`CREATE VIEW events AS SELECT * FROM base_events WHERE ${where}`);
    _kfBrowserDb.run(`CREATE VIEW families AS SELECT * FROM base_families WHERE ${where}`);
    _kfBrowserDb.run(`CREATE VIEW family_children AS SELECT * FROM base_family_children WHERE ${where}`);
    if (typeof _kfScheduleAiCacheIndexRefresh === "function") _kfScheduleAiCacheIndexRefresh();
  } catch (e) {
    console.warn("[kf] refreshBrowserViews:", e.message || e);
  }
}

async function fetchCatalogTrees() {
  try {
    const r = await fetch("/api/catalog/trees", { headers: _kfAuthHeaders() });
    const j = await r.json();
    if (!r.ok) {
      const details = [j?.error ? `${r.status} ${j.error}` : `catalog ${r.status}`];
      if (j?.user?.type) details.push(`server saw ${j.user.type}${j.user.email ? ` ${j.user.email}` : ""}`);
      if (j?.auth?.status && j.auth.status !== "signed-in") {
        details.push(`auth ${j.auth.status}${j.auth.reason ? `: ${j.auth.reason}` : ""}`);
      }
      if (j?.auth?.message && j.auth.status !== "signed-in") details.push(j.auth.message);
      throw new Error(details.join("; "));
    }
    const fetched = j && Array.isArray(j.trees) ? j.trees : [];
    _kfCatalogTrees = fetched.length
      ? _kfVisibleCatalogTreesForViewer(fetched)
      : _kfCatalogFallbackTrees();
  } catch (e) {
    console.warn("[kf] fetchCatalogTrees:", e?.message || e);
    if (_clerkUserTier === "vip") stats.textContent = `Tree catalog unavailable: ${e?.message || e}`;
    _kfCatalogTrees = _kfCatalogFallbackTrees();
  }
  return _kfCatalogTrees;
}

async function fetchCloudTrees() {
  if (!_clerkToken || _clerkUserTier === "anon") { _kfCloudTrees = []; return []; }
  try {
    const r = await fetch("/api/gedcom/sources", { headers: _kfAuthHeaders() });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error || `cloud sources ${r.status}`);
    _kfCloudTrees = (Array.isArray(j?.trees) ? j.trees : [])
      .filter(t => _kfCanonicalTreeName(t?.name) !== "demo");
  } catch (e) {
    console.warn("[kf] fetchCloudTrees:", e?.message || e);
    _kfCloudTrees = [];
  }
  return _kfCloudTrees;
}

async function refreshSharePanel() {
  const panel = document.getElementById("sharingPanel");
  const list = document.getElementById("sharingList");
  if (panel) panel.hidden = true;
  if (list) list.innerHTML = "";
  if (!_clerkToken || _clerkUserTier === "anon") {
    _kfShareState = { trees: [] };
    return;
  }
  try {
    const r = await fetch("/api/gedcom/share", { headers: _kfAuthHeaders() });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error || `share ${r.status}`);
    _kfShareState = { trees: Array.isArray(j?.trees) ? j.trees : [] };
  } catch (e) {
    _kfShareState = { trees: [], error: e?.message || String(e) };
  }
  renderSharePanel();
}

function renderSharePanel() {
  const panel = document.getElementById("sharingPanel");
  const list = document.getElementById("sharingList");
  if (panel) panel.hidden = true;
  if (list) list.innerHTML = "";
  if (document.getElementById("sourcesList")) renderSources(_kfGetLoadedSourcesList());
}

function renderLoadedTreeNamePanel(list = _kfGetLoadedSourcesList()) {
  const panel = document.getElementById("loadedTreeNamePanel");
  if (!panel) return;
  panel.hidden = true;
  panel.innerHTML = "";
}

function _kfFormatTreeTimestamp(ts) {
  return ts ? new Date(ts * 1000).toLocaleDateString() : "";
}

function _kfTreeInventoryItem(row) {
  return row.loaded || row.share || row.remote || {};
}

function _kfMergeInventoryRow(rows, kind, rawItem) {
  if (!rawItem) return;
  const item = kind === "share" && rawItem.kind !== "catalog"
    ? { ...rawItem, tree_uuid: rawItem.tree_uuid || rawItem.key || null }
    : rawItem;
  const existing = rows.find(row => {
    const a = _kfTreeInventoryItem(row);
    return _kfSameTreeForUi(a, item) ||
      (a?.key && item?.key && a.kind === item.kind && String(a.key) === String(item.key)) ||
      (a?.id && item?.id && String(a.id) === String(item.id));
  });
  if (existing) existing[kind] = item;
  else rows.push({ loaded: null, remote: null, share: null, [kind]: item });
}

function _kfBuildTreeInventory(loaded, remoteTrees) {
  const rows = [];
  for (const src of loaded || []) _kfMergeInventoryRow(rows, "loaded", src);
  for (const tree of remoteTrees || []) {
    if (tree?.available === false) continue;
    _kfMergeInventoryRow(rows, "remote", tree);
  }
  for (const tree of _kfShareState?.trees || []) _kfMergeInventoryRow(rows, "share", tree);
  rows.sort((a, b) => {
    const av = a.loaded ? 0 : 1;
    const bv = b.loaded ? 0 : 1;
    if (av !== bv) return av - bv;
    return _kfFamiliarTreeName(_kfTreeInventoryItem(a)).localeCompare(_kfFamiliarTreeName(_kfTreeInventoryItem(b)));
  });
  return rows;
}

function _kfInventoryShareKey(row) {
  const share = row.share;
  if (!share) return null;
  return { kind: share.kind, key: share.key };
}

async function _kfUpdateTreeShare(kind, key, email, action, extra = {}) {
  if (!_clerkToken) return;
  const r = await fetch("/api/gedcom/share", {
    method: "POST",
    headers: _kfJsonHeaders(),
    body: JSON.stringify({ kind, key, email, action, ...extra }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    stats.textContent = `sharing failed: ${j?.error || r.status}`;
    return;
  }
  _kfShareState = { trees: Array.isArray(j?.trees) ? j.trees : [] };
  renderSharePanel();
  refreshSources();
}

function _kfSourceNameFromFileName(name) {
  return String(name || "")
    .trim()
    .replace(/\.(ged|gedcom|json)(?=\s*(?:$|\(|\u00b7))/ig, "")
    .replace(/(\.(ged|gedcom|json))+$/i, "")
    .trim() || "untitled";
}

function _kfLoadedSourceByTreeUuid(treeUuid) {
  if (!treeUuid) return null;
  return [..._kfLoadedSources.values()].find(s => s.tree_uuid === treeUuid) || null;
}

function _kfUniqueSourceName(baseName, meta = {}) {
  const base = _kfSourceNameFromFileName(baseName);
  const equivalent = [..._kfLoadedSources.values()]
    .find(src => _kfSameTreeForUi(src, { ...meta, name: base, common_name: meta.common_name || base }));
  if (equivalent) return equivalent.name;
  const existing = _kfLoadedSources.get(base);
  if (!existing || (meta.tree_uuid && existing.tree_uuid === meta.tree_uuid)) return base;
  const owner = meta.owner_email ? ` (${meta.owner_email})` : " (shared)";
  let candidate = base + owner;
  let n = 2;
  while (_kfLoadedSources.has(candidate)) {
    const src = _kfLoadedSources.get(candidate);
    if (meta.tree_uuid && src?.tree_uuid === meta.tree_uuid) return candidate;
    candidate = `${base}${owner} ${n}`;
    n++;
  }
  return candidate;
}

function _kfFamiliarTreeName(item) {
  return _kfSourceNameFromFileName(item?.common_name || item?.tree_name || item?.name || item?.key || "");
}

function _kfTreeLabel(item, counts) {
  const base = _kfFamiliarTreeName(item);
  const owner = item?.owner_email || "";
  return counts?.get(base.toLowerCase()) > 1 && owner ? `${base} · ${owner}` : base;
}

function _kfCanonicalTreePayload(individuals, families) {
  const people = (individuals || []).map(ind => ({
    id: ind.id || "",
    name: ind.name || "",
    sex: ind.sex || "",
    birth_year: ind.birth_year ?? null,
    death_year: ind.death_year ?? null,
    famc: ind.famc || "",
    events: (ind.events || []).map(e => ({
      type: e.type || e.tag || "",
      year: e.year ?? null,
      place: e.place || "",
    })).sort((a, b) =>
      String(a.type).localeCompare(String(b.type)) ||
      Number(a.year ?? -999999) - Number(b.year ?? -999999) ||
      String(a.place).localeCompare(String(b.place))
    ),
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const fams = Array.from((families instanceof Map ? families.values() : families) || []).map(f => ({
    id: f.id || "",
    husb: f.husb || "",
    wife: f.wife || "",
    chil: (f.chil || []).slice().sort(),
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return JSON.stringify({ individuals: people, families: fams });
}

async function _kfHashText(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function _kfTreeContentHash(individuals, families) {
  return _kfHashText(_kfCanonicalTreePayload(individuals, families));
}

function _kfCanonicalTreeName(name) {
  return _kfSourceNameFromFileName(name)
    .replace(/\s+\((shared|owned|public|vip|[^)@\s]+@[^)]+)\)(?:\s+\d+)?$/i, "")
    .trim()
    .toLowerCase();
}

function _kfKnownServerTreeName(name) {
  return new Set(["archer", "demo", "golden-rosenberg", "gregory-henry"])
    .has(_kfCanonicalTreeName(name));
}

function _kfSameTreeForUi(a, b) {
  const ah = String(a?.content_hash || "").trim();
  const bh = String(b?.content_hash || "").trim();
  if (ah && bh && ah === bh) return true;
  const au = String(a?.tree_uuid || "").trim();
  const bu = String(b?.tree_uuid || "").trim();
  if (au && bu && au === bu) return true;
  const an = _kfCanonicalTreeName(_kfFamiliarTreeName(a));
  const bn = _kfCanonicalTreeName(_kfFamiliarTreeName(b));
  if (!an || an !== bn) return false;
  if (_kfKnownServerTreeName(an)) return true;
  const ao = String(a?.owner_email || "").trim().toLowerCase();
  const bo = String(b?.owner_email || "").trim().toLowerCase();
  return !!ao && ao === bo;
}

function _kfIsCatalogDuplicateTree(item) {
  if (item?.kind === "catalog") return false;
  const name = _kfCanonicalTreeName(item?.common_name || item?.tree_name || item?.name || item?.key || "");
  return !!name && _kfKnownServerTreeName(name) &&
    (_kfCatalogTrees || []).some(t => t?.kind === "catalog" && _kfCanonicalTreeName(t.name || t.key) === name);
}

function _kfIsTreeLoadedLike(item) {
  const hash = item?.content_hash;
  if (hash && [..._kfLoadedSources.values()].some(src => src.content_hash === hash)) return true;
  const uuid = item?.tree_uuid;
  if (uuid && _kfLoadedSourceByTreeUuid(uuid)) return true;
  const sourceName = _kfSourceNameFromFileName(item?.name || item?.key || "");
  if (!uuid && (_kfTreeCache.has(sourceName) || _kfLoadedSources.has(sourceName))) return true;
  return [..._kfLoadedSources.values()].some(src => _kfSameTreeForUi(src, item));
}

function _kfRemoteTreePriority(t) {
  let score = 0;
  if (t?.kind === "catalog") score -= 1000;
  if (t?.relation === "owned") score -= 100;
  if (t?.relation === "shared") score -= 50;
  if (t?.is_default) score -= 10;
  return score;
}

function _kfDedupeRemoteTrees(trees) {
  const out = [];
  for (const tree of trees || []) {
    if (!tree || _kfIsCatalogDuplicateTree(tree)) continue;
    const idx = out.findIndex(existing => _kfSameTreeForUi(existing, tree));
    if (idx === -1) out.push(tree);
    else if (_kfRemoteTreePriority(tree) < _kfRemoteTreePriority(out[idx])) out[idx] = tree;
  }
  return out;
}

function _kfPreferredLoadedSource(a, b) {
  if (!!a.tree_uuid !== !!b.tree_uuid) return a.tree_uuid ? a : b;
  if (!!a.owner_email !== !!b.owner_email) return a.owner_email ? a : b;
  if (_kfActiveTreeName === a.name) return a;
  if (_kfActiveTreeName === b.name) return b;
  if (_kfSelectedSourceIds.has(a.source_id) !== _kfSelectedSourceIds.has(b.source_id)) {
    return _kfSelectedSourceIds.has(a.source_id) ? a : b;
  }
  return String(a.name || "").length <= String(b.name || "").length ? a : b;
}

function _kfPruneDuplicateLoadedSources() {
  const sources = [..._kfLoadedSources.values()];
  let changed = false;
  for (let i = 0; i < sources.length; i++) {
    const a = sources[i];
    if (!_kfLoadedSources.has(a.name)) continue;
    for (let j = i + 1; j < sources.length; j++) {
      const b = sources[j];
      if (!_kfLoadedSources.has(b.name) || !_kfSameTreeForUi(a, b)) continue;
      const keep = _kfPreferredLoadedSource(a, b);
      const drop = keep === a ? b : a;
      if (_kfSelectedSourceIds.has(drop.source_id)) _kfSelectedSourceIds.add(keep.source_id);
      _kfSelectedSourceIds.delete(drop.source_id);
      if (_kfActiveTreeName === drop.name) _kfActiveTreeName = keep.name;
      _kfLoadedSources.delete(drop.name);
      _kfTreeCache.delete(drop.name);
      changed = true;
    }
  }
  if (changed) {
    _kfEnsureSelectedSources();
    buildBrowserDb();
    if (timelineLoaded) _kfRebuildSelectedVisualization({ preserveYear: true });
  }
  return changed;
}

async function loadCatalogTree(key, opts = {}) {
  if (!key) return false;
  const catalogMeta = (_kfCatalogTrees || []).find(t => t && t.key === key) || null;
  if (catalogMeta && _kfIsTreeLoadedLike(catalogMeta)) return true;
  let r;
  if (key === "demo") {
    r = await fetch(DEMO_GED_URL);
  } else {
    r = await fetch("/api/catalog/tree?key=" + encodeURIComponent(key), {
      headers: _kfAuthHeaders(),
    });
  }
  if (!r.ok) {
    let detail = String(r.status);
    try {
      const err = await r.json();
      if (err?.error) detail += ` ${err.error}`;
    } catch (_) {}
    stats.textContent = `could not load tree ${key}: ${detail}`;
    return false;
  }
  const raw = await r.text();
  let text = raw;
  let name = key === "demo" ? "DEMO.json" : (r.headers.get("X-Catalog-Name") || key);
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.text === "string") {
      text = parsed.text;
      name = typeof parsed?.name === "string" ? parsed.name : name;
    }
  } catch (_) {}
  if (!text) return false;
  const sourceName = _kfSourceNameFromFileName(name);
  if (catalogMeta && _kfIsTreeLoadedLike(catalogMeta)) return true;
  if (!catalogMeta?.tree_uuid && (_kfTreeCache.has(sourceName) || _kfLoadedSources.has(sourceName))) return true;
  const file = new File([text], name, { type: "text/plain" });
  file._kfTreeMeta = {
    source_kind: "catalog",
    catalog_key: key,
    tree_uuid: catalogMeta?.tree_uuid || null,
    owner_email: catalogMeta?.owner_email || null,
    relation: catalogMeta?.relation || null,
    common_name: sourceName,
  };
  if (opts.suppressAutosave) _kfSkipNextSeed = true;
  try {
    await processFile(file);
  } catch (e) {
    if (opts.suppressAutosave) _kfSkipNextSeed = false;
    throw e;
  }
  return true;
}

async function autoLoadPublicDemoTree() {
  if (!DEMO_GED_URL) return false;
  const sourceName = _kfSourceNameFromFileName("DEMO.json");
  const existing = _kfLoadedSources.get(sourceName);
  if (existing) {
    _kfSelectedSourceIds.add(existing.source_id);
    _kfActiveTreeName = existing.name;
    _kfRebuildSelectedVisualization({
      preserveYear: true,
      preferredSourceName: existing.name,
      preferActiveRoot: true,
      selectRoot: true,
      centerRoot: !timelineLoaded,
    });
    refreshSources();
    return true;
  }
  if (_kfPublicDemoLoadPromise) return _kfPublicDemoLoadPromise;
  _kfPublicDemoLoadPromise = (async () => {
    stats.textContent = "loading demo tree...";
    const resp = await fetch(DEMO_GED_URL);
    if (!resp.ok) throw new Error(resp.status + " " + resp.statusText);
    const text = await resp.text();
    const demoFile = new File([text], "DEMO.json", { type: "application/json" });
    const demoMeta = (_kfCatalogTrees || []).find(t => t?.key === "demo") || VIP_CATALOG_TREES[0] || null;
    demoFile._kfTreeMeta = {
      source_kind: "catalog",
      catalog_key: "demo",
      tree_uuid: demoMeta?.tree_uuid || null,
      owner_email: demoMeta?.owner_email || null,
      relation: demoMeta?.relation || "public",
      common_name: "DEMO",
    };
    _kfSkipNextSeed = true;
    await processFile(demoFile);
    const loaded = _kfLoadedSources.get(sourceName);
    if (loaded) {
      _kfSelectedSourceIds.add(loaded.source_id);
      _kfActiveTreeName = loaded.name;
      _kfRebuildSelectedVisualization({
        preserveYear: true,
        preferredSourceName: loaded.name,
        preferActiveRoot: true,
        selectRoot: true,
        centerRoot: true,
      });
    }
    return true;
  })().catch(e => {
    _kfSkipNextSeed = false;
    stats.textContent = "demo load failed: " + (e?.message || e);
    return false;
  }).finally(() => {
    _kfPublicDemoLoadPromise = null;
  });
  return _kfPublicDemoLoadPromise;
}

async function loadCloudTree(sourceKey, opts = {}) {
  if (!sourceKey || !_clerkToken) return false;
  const remoteMeta = (_kfCloudTrees || []).find(t => String(t.tree_uuid || t.key || t.source_id) === String(sourceKey)) || null;
  if (remoteMeta && _kfIsTreeLoadedLike(remoteMeta)) return true;
  const param = remoteMeta?.tree_uuid || !/^\d+$/.test(String(sourceKey))
    ? "tree_uuid=" + encodeURIComponent(String(remoteMeta?.tree_uuid || sourceKey))
    : "source_id=" + encodeURIComponent(String(sourceKey));
  const r = await fetch("/api/gedcom?" + param, {
    headers: _kfAuthHeaders(),
  });
  if (!r.ok) {
    let detail = String(r.status);
    try {
      const err = await r.json();
      if (err?.error) detail += ` ${err.error}`;
    } catch (_) {}
    stats.textContent = `could not load saved tree: ${detail}`;
    return false;
  }
  const payload = await r.json();
  const tree = Array.isArray(payload?.trees) ? payload.trees[0] : null;
  if (!tree) return false;
  if (_kfIsTreeLoadedLike(tree)) return true;
  const sourceName = _kfSourceNameFromFileName(tree.name || "saved");
  if (!tree.tree_uuid && (_kfTreeCache.has(sourceName) || _kfLoadedSources.has(sourceName))) return true;
  const file = new File([JSON.stringify(tree.data || {})], (tree.name || "saved") + ".ged", { type: "application/json" });
  file._kfTreeMeta = {
    tree_uuid: tree.tree_uuid || remoteMeta?.tree_uuid || null,
    content_hash: tree.content_hash || remoteMeta?.content_hash || null,
    content_changed_at: tree.content_changed_at || remoteMeta?.content_changed_at || null,
    owner_uuid: tree.owner_uuid || remoteMeta?.owner_uuid || null,
    owner_email: tree.owner_email || remoteMeta?.owner_email || null,
    relation: tree.relation || remoteMeta?.relation || null,
    top_pci_id: tree.top_pci_id || remoteMeta?.top_pci_id || null,
    top_pci_name: tree.top_pci_name || remoteMeta?.top_pci_name || null,
    top_pci_score: tree.top_pci_score ?? remoteMeta?.top_pci_score ?? null,
    common_name: sourceName,
  };
  if (opts.suppressAutosave) _kfSkipNextSeed = true;
  try {
    await processFile(file);
  } catch (e) {
    if (opts.suppressAutosave) _kfSkipNextSeed = false;
    throw e;
  }
  return true;
}

async function autoLoadVipCatalogTrees() {
  if (!_clerkToken) return;
  const userKey = _kfStartupLoadUserKey || _clerkToken;
  if (_kfVipCatalogAutoLoadUserKey === userKey) return;
  _kfVipCatalogAutoLoadUserKey = userKey;
  try {
    const trees = (_kfCatalogTrees.length ? _kfCatalogTrees : await fetchCatalogTrees())
      .filter(t => t && t.available !== false && t.key !== "demo");
    const pending = trees.filter(t => {
      return !_kfIsTreeLoadedLike(t);
    });
    if (!pending.length) {
      refreshSources();
      _kfRefreshStatsSummary();
      return;
    }
    stats.textContent = `loading ${pending.length} shared tree${pending.length === 1 ? "" : "s"}...`;
    let loaded = 0;
    let failed = 0;
    for (const tree of pending) {
      stats.textContent = `loading shared tree ${tree.name || tree.key}...`;
      try {
        if (await loadCatalogTree(tree.key, { suppressAutosave: true })) loaded++;
        else failed++;
      } catch (e) {
        failed++;
        console.warn("[kf] loadCatalogTree:", tree.key, e?.message || e);
      }
    }
    refreshSources();
    _kfRefreshStatsSummary(failed ? { suffix: `${failed} shared failed` } : {});
  } catch (e) {
    _kfVipCatalogAutoLoadUserKey = "";
    console.warn("[kf] autoLoadVipCatalogTrees:", e?.message || e);
  }
}

function _kfRefreshStatsSummary(opts = {}) {
  if (!timelineLoaded || !lastIndividuals) return;
  const selectedCount = typeof _kfSelectedVizSourceList === "function" ? _kfSelectedVizSourceList().length : 0;
  const loadedCount = _kfLoadedSources?.size || selectedCount || 0;
  const visibleTreeCount = selectedCount || loadedCount || 1;
  const scope = loadedCount > visibleTreeCount
    ? `${visibleTreeCount} of ${loadedCount} trees selected`
    : `${visibleTreeCount} tree${visibleTreeCount === 1 ? "" : "s"}`;
  const parts = [
    scope,
    `${lastIndividuals.length.toLocaleString()} people`,
    `${dwellY.length.toLocaleString()} events`,
    `${flowFromY.length.toLocaleString()} migrations`,
    `${minYear}-${maxYear}`,
  ];
  if (opts.suffix) parts.push(opts.suffix);
  const summary = parts.join("  |  ");
  stats.textContent = summary;
  const treeStats = document.getElementById("treeStats");
  if (treeStats) treeStats.textContent = summary;
}

async function deleteSource(id) {
  const src = [..._kfLoadedSources.values()].find(s => s.source_id === id);
  if (!src) return false;
  _kfLoadedSources.delete(src.name);
  _kfTreeCache.delete(src.name);
  _kfSelectedSourceIds.delete(id);
  if (_kfActiveTreeName === src.name) {
    const remaining = [..._kfLoadedSources.values()];
    _kfActiveTreeName = remaining[0]?.name || null;
  }
  _kfEnsureSelectedSources();
  buildBrowserDb();
  _kfRebuildSelectedVisualization({ preserveYear: true });
  return true;
}

function _kfRemoveRestrictedVipSources() {
  if (_clerkUserTier !== "vip") return false;
  const archerAllowed = _kfCatalogTrees.some(t => t && t.key === "archer");
  const restricted = [..._kfLoadedSources.values()]
    .filter(s => (_kfIsRestrictedUnsharedSourceName(s.common_name) || _kfIsRestrictedUnsharedSourceName(s.name)) && !archerAllowed);
  if (!restricted.length) return false;
  for (const src of restricted) {
    _kfLoadedSources.delete(src.name);
    _kfTreeCache.delete(src.name);
    _kfSelectedSourceIds.delete(src.source_id);
    if (_kfActiveTreeName === src.name) _kfActiveTreeName = null;
  }
  if (!_kfActiveTreeName) {
    const remaining = [..._kfLoadedSources.values()];
    _kfActiveTreeName = remaining[0]?.name || null;
  }
  _kfCatalogTrees = _kfCatalogTrees.filter(t => !t || t.key !== "archer");
  _kfEnsureSelectedSources();
  buildBrowserDb();
  if (timelineLoaded) _kfRebuildSelectedVisualization({ preserveYear: true });
  return true;
}

function _kfRemovePublicDemoSourcesForSignedIn() {
  if (_clerkUserTier === "anon") return false;
  const demoSources = [..._kfLoadedSources.values()]
    .filter(s => _kfIsPublicDemoSourceName(s.common_name) || _kfIsPublicDemoSourceName(s.name));
  if (!demoSources.length) return false;
  for (const src of demoSources) {
    _kfLoadedSources.delete(src.name);
    _kfTreeCache.delete(src.name);
    _kfSelectedSourceIds.delete(src.source_id);
    if (_kfActiveTreeName === src.name) _kfActiveTreeName = null;
  }
  if (!_kfActiveTreeName) {
    const remaining = [..._kfLoadedSources.values()];
    _kfActiveTreeName = remaining[0]?.name || null;
  }
  _kfEnsureSelectedSources();
  buildBrowserDb();
  if (timelineLoaded) _kfRebuildSelectedVisualization({ preserveYear: true });
  return true;
}

function renderSources(list) {
  const wrap = document.getElementById("sourcesPanel");
  const inner = document.getElementById("sourcesList");
  if (!wrap || !inner) return;
  if (_kfPruneDuplicateLoadedSources()) list = _kfGetLoadedSourcesList();
  const filtered = (list || []).filter(s => (s.n_individuals || 0) > 0);
  _kfLoadedTreeCount = filtered.length;
  const remoteTrees = _kfDedupeRemoteTrees([...(_kfCatalogTrees || []), ...(_kfCloudTrees || [])]);
  const inventory = _kfBuildTreeInventory(filtered, remoteTrees);
  if (inventory.length === 0) {
    wrap.classList.add("hidden");
    inner.innerHTML = "";
    const treeStats = document.getElementById("treeStats");
    if (treeStats) treeStats.textContent = "Loading DEMO tree...";
    if (typeof _kfRefreshQuickChips === "function") _kfRefreshQuickChips();
    return;
  }
  wrap.classList.remove("hidden");
  const nameCounts = new Map();
  for (const row of inventory) {
    const key = _kfFamiliarTreeName(_kfTreeInventoryItem(row)).toLowerCase();
    if (key) nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }
  const treeRow = row => {
    const loaded = row.loaded;
    const remote = row.remote;
    const share = row.share;
    const item = _kfTreeInventoryItem(row);
    const label = _kfTreeLabel(item, nameCounts);
    const n = loaded?.n_individuals ? `${loaded.n_individuals.toLocaleString()} people` : "";
    const badges = [];
    if (loaded) badges.push(loaded.selected ? "Visualized" : "Loaded");
    else badges.push("Available");
    if (share || remote?.relation === "owned") badges.push("Saved");
    if (item?.relation === "public" || item?.public) badges.push("Public");
    if (share?.shares?.length) badges.push(`Shared with ${share.shares.length}`);
    else if (remote?.relation === "shared") badges.push("Shared with you");
    const meta = [
      n,
      item.owner_email ? `Owner: ${item.owner_email}` : "",
      item.content_changed_at ? `Changed: ${_kfFormatTreeTimestamp(item.content_changed_at)}` : "",
      item.top_pci_name ? `Top PCI: ${item.top_pci_name}${item.top_pci_score != null ? ` (${Math.round(item.top_pci_score * 100)}%)` : ""}` : "",
    ].filter(Boolean).join(" | ");
    const checkbox = loaded
      ? `<input class="sel" type="checkbox" data-sel="${loaded.id}" ${loaded.selected ? "checked" : ""} title="Include this tree in queries, maps, clusters, and animations">`
      : `<span class="treeRowSpacer" aria-hidden="true"></span>`;
    const nameControl = loaded
      ? `<form class="treeLocalRename treeInlineForm" data-source-id="${escChat(loaded.id)}">` +
        `<input type="text" value="${escChat(_kfFamiliarTreeName(loaded))}" aria-label="Tree name" placeholder="Tree name required">` +
        `<button type="submit">${escChat(_clerkToken && _clerkUserTier !== "anon" ? "Save" : "Rename")}</button>` +
        `</form>`
      : `<span class="sourceText"><span class="name">${escChat(label)}</span><span class="sourceMeta">${escChat(meta || badges.join(" | "))}</span></span>`;
    let loadAction = "";
    if (!loaded && remote) {
      const relation = remote.relation ? ` (${remote.relation})` : "";
      const title = `Load ${remote.name || remote.key}${remote.owner_email ? `. Owner: ${remote.owner_email}.` : ""}`;
      loadAction = remote.kind === "cloud"
        ? `<button type="button" class="srcAction" data-cloud="${escChat(remote.tree_uuid || remote.key || remote.source_id)}" title="${escChat(title)}">Load${escChat(relation)}</button>`
        : `<button type="button" class="srcAction" data-catalog="${escChat(remote.key)}" title="${escChat(title)}">Load${escChat(relation)}</button>`;
    }
    const shareKey = _kfInventoryShareKey(row);
    const shareRows = share?.shares?.length
      ? `<div class="shareEmails">${share.shares.map(s => `<span class="shareEmail">${escChat(s.email)} <button type="button" data-share-remove="${escChat(share.kind)}:${escChat(share.key)}:${escChat(s.email)}" title="Remove share">×</button></span>`).join("")}</div>`
      : shareKey ? `<div class="shareEmails"><span class="shareNone">Not shared yet</span></div>` : "";
    const shareControls = shareKey
      ? `<form class="shareAdd" data-share-kind="${escChat(shareKey.kind)}" data-share-key="${escChat(shareKey.key)}">` +
        `<input type="email" placeholder="friend@example.com" aria-label="Email address to share with">` +
        `<button type="submit">Share</button>` +
        `</form>` : "";
    return `<div class="treeInventoryRow${loaded?.selected ? " on" : ""}${loaded && !loaded.selected ? " excluded" : ""}" data-tree-row="${escChat(label)}">` +
      `<div class="treeRowMain">${checkbox}${nameControl}${loadAction}</div>` +
      `<div class="treeBadges">${badges.map(b => `<span>${escChat(b)}</span>`).join("")}</div>` +
      (loaded && meta ? `<div class="treeMeta">${escChat(meta)}</div>` : "") +
      `${shareRows}${shareControls}` +
      `</div>`;
  };
  inner.innerHTML = inventory.map(treeRow).join("");
  inner.querySelectorAll(".sel[data-sel]").forEach(el => {
    el.addEventListener("change", () => {
      const id = Number(el.getAttribute("data-sel"));
      if (!id) return;
      if (el.checked) _kfSelectedSourceIds.add(id);
      else _kfSelectedSourceIds.delete(id);
      _kfEnsureSelectedSources();
      _kfRefreshBrowserViews();
      _kfRebuildSelectedVisualization({ preserveYear: true });
      if (typeof _kfRefreshViewChrome === "function") _kfRefreshViewChrome(true);
      renderSources(_kfGetLoadedSourcesList());
    });
  });
  inner.querySelectorAll(".srcAction[data-catalog]").forEach(el => {
    el.addEventListener("click", async () => {
      const key = el.getAttribute("data-catalog") || "";
      if (!key) return;
      el.setAttribute("disabled", "disabled");
      try { await loadCatalogTree(key, { suppressAutosave: true }); }
      finally { el.removeAttribute("disabled"); refreshSources(); }
    });
  });
  inner.querySelectorAll(".srcAction[data-cloud]").forEach(el => {
    el.addEventListener("click", async () => {
      const sourceId = el.getAttribute("data-cloud") || "";
      if (!sourceId) return;
      el.setAttribute("disabled", "disabled");
      try { await loadCloudTree(sourceId, { suppressAutosave: true }); }
      finally { el.removeAttribute("disabled"); refreshSources(); }
    });
  });
  inner.querySelectorAll(".treeLocalRename").forEach(form => {
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const sourceId = Number(form.dataset.sourceId || "");
      const src = [..._kfLoadedSources.values()].find(s => s.source_id === sourceId);
      const input = form.querySelector("input");
      const name = _kfSourceNameFromFileName(input?.value || "");
      if (!src || !name) { stats.textContent = "tree name is required"; return; }
      src.common_name = name;
      if (_clerkToken && _clerkUserTier !== "anon") {
        await _kfSaveLoadedTreesToCloud([src]);
        await refreshSharePanel();
      }
      refreshSources();
    });
  });
  inner.querySelectorAll(".shareAdd").forEach(form => {
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const input = form.querySelector("input");
      const email = input?.value?.trim() || "";
      if (!email) return;
      await _kfUpdateTreeShare(form.dataset.shareKind, form.dataset.shareKey, email, "add");
      input.value = "";
    });
  });
  inner.querySelectorAll("[data-share-remove]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const [kind, key, ...emailParts] = String(btn.dataset.shareRemove || "").split(":");
      const email = emailParts.join(":");
      await _kfUpdateTreeShare(kind, key, email, "remove");
    });
  });
  if (typeof _kfRefreshQuickChips === "function") _kfRefreshQuickChips();
}

async function refreshSources() {
  await Promise.all([fetchCatalogTrees(), fetchCloudTrees()]);
  _kfRemoveRestrictedVipSources();
  renderSources(_kfGetLoadedSourcesList());
  refreshSharePanel();
  if (typeof _kfRefreshViewChrome === "function") _kfRefreshViewChrome(true);
  refreshReviewBadge();
}

// ---------- v2.5 Review UI ----------

const _kfReviewState = {
  queue: [],          // pending unlabeled pairs
  index: 0,           // pointer into queue
  totalUnlabeled: 0,  // count for progress label
  loading: false,
};
const REVIEW_BATCH = 25;

async function fetchReviewQueue(stratum) {
  const proxy = await detectChatProxy();
  if (!proxy) return null;
  let url = proxy + "/links?origin=unlabeled&include=family&limit=" + REVIEW_BATCH;
  if (stratum && stratum !== "all") {
    const [lo, hi] = stratum.split("-").map(Number);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      url += "&min_score=" + lo + "&max_score=" + hi;
    }
  }
  try {
    const r = await fetch(url);
    const j = await r.json();
    return j.ok ? j.links : null;
  } catch (_) { return null; }
}

async function refreshReviewBadge() {
  const proxy = await detectChatProxy();
  const btn = document.getElementById("chatReview");
  if (!btn) return;
  if (!proxy) { btn.hidden = true; return; }
  try {
    const r = await fetch(proxy + "/links?origin=unlabeled&limit=1");
    const j = await r.json();
    if (!j.ok) { btn.hidden = true; return; }
    // Cheap probe: if any unlabeled, ask for total via SQL.
    const r2 = await fetch(proxy + "/sql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "SELECT COUNT(*) AS n FROM person_links WHERE origin LIKE 'auto:%'" }),
    });
    const j2 = await r2.json();
    const n = j2.ok && j2.rows && j2.rows[0] ? j2.rows[0].n : 0;
    btn.hidden = n === 0;
    btn.textContent = "review " + n;
    _kfReviewState.totalUnlabeled = n;
  } catch (_) { btn.hidden = true; }
}

function renderReviewPair(link) {
  const body = document.getElementById("reviewBody");
  if (!link) {
    body.innerHTML = `<div style="grid-column:1/-1; padding:30px; text-align:center; color:#9aa6bc;">No more pairs in this stratum.<br><span style="font-size:11px;">Switch the dropdown below to keep labeling.</span></div>`;
    return;
  }
  const ev = (link.evidence && typeof link.evidence === "object") ? link.evidence : {};
  function lifespan(by, dy) { return (by ?? "?") + "–" + (dy ?? "?"); }
  function liteRow(person) {
    if (!person) return `<li class="kf-empty">—</li>`;
    return `<li><span class="kn">${escChat(person.name || "?")}</span> <span class="ky">(${lifespan(person.birth_year, person.death_year)})</span></li>`;
  }
  function anomalyBadges(list) {
    if (!list || !list.length) return "";
    return `<div class="kf-anom">${list.map(a => `<span class="kf-anom-${a.severity}" title="${escChat(JSON.stringify(a.detail || {}))}">${escChat(a.kind.replace(/_/g, " "))}</span>`).join("")}</div>`;
  }
  function col(side) {
    const idA = side === "a";
    const name = idA ? link.name_a : link.name_b;
    const by   = idA ? link.birth_a : link.birth_b;
    const dy   = idA ? link.death_a : link.death_b;
    const sex  = idA ? link.sex_a : link.sex_b;
    const src  = idA ? link.source_a_name : link.source_b_name;
    const par  = idA ? link.parents_a : link.parents_b;
    const ch   = idA ? link.children_a : link.children_b;
    const an   = idA ? link.anomalies_a : link.anomalies_b;
    const fa = par && par.father, mo = par && par.mother;
    const childrenHtml = (ch && ch.length)
      ? `<ul class="kfList">${ch.map(c => liteRow(c)).join("")}</ul>`
      : `<div class="kf-empty">no children recorded</div>`;
    return `<div class="col">
      <h4>${escChat(src)}</h4>
      <div class="nm">${escChat(name || "?")}</div>
      <div class="yrs">${lifespan(by, dy)}${sex ? "  ·  " + sex : ""}</div>
      ${anomalyBadges(an)}
      <div class="kfBlock"><h5>parents</h5><ul class="kfList">${liteRow(fa)}${liteRow(mo)}</ul></div>
      <div class="kfBlock"><h5>children (${ch ? ch.length : 0})</h5>${childrenHtml}</div>
    </div>`;
  }
  const fmtEv = (k, v) => `<span class="ev">${k}<b>${v != null ? Number(v).toFixed(2) : "—"}</b></span>`;
  body.innerHTML =
    col("a") + col("b") +
    `<div id="reviewScore">
      <span class="total">${(link.score || 0).toFixed(3)}</span>
      ${fmtEv("name", ((ev.given || 0) + (ev.surname || 0)) / 2)}
      ${fmtEv("birth", ev.birth)}
      ${fmtEv("parents", ev.parents)}
      ${fmtEv("geo", ev.geo)}
      <span style="margin-left:auto; color:#9aa6bc; font-size:10px;">link #${link.link_id}</span>
    </div>`;
  document.getElementById("reviewProgress").textContent =
    `${_kfReviewState.index + 1} / ${_kfReviewState.queue.length} (queue) · ${_kfReviewState.totalUnlabeled} total`;
}

async function reviewLoadStratum(stratum) {
  const queue = await fetchReviewQueue(stratum);
  _kfReviewState.queue = queue || [];
  _kfReviewState.index = 0;
  renderReviewPair(_kfReviewState.queue[0]);
}

async function reviewSubmit(action) {
  const cur = _kfReviewState.queue[_kfReviewState.index];
  if (!cur) return;
  if (action !== "skip") {
    const proxy = await detectChatProxy();
    if (!proxy) return;
    const reasonInput = document.getElementById("reviewReason");
    const confSel = document.getElementById("reviewConfidence");
    const body = {};
    if (reasonInput.value.trim()) body.reason = reasonInput.value.trim();
    if (confSel.value) body.confidence = Number(confSel.value);
    try {
      await fetch(`${proxy}/links/${cur.link_id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      _kfReviewState.totalUnlabeled = Math.max(0, _kfReviewState.totalUnlabeled - 1);
    } catch (_) { /* keep going */ }
    reasonInput.value = "";
    confSel.value = "";
  }
  _kfReviewState.index++;
  if (_kfReviewState.index >= _kfReviewState.queue.length) {
    // Auto-load next batch in the same stratum.
    const stratum = document.getElementById("reviewStratum").value;
    await reviewLoadStratum(stratum);
  } else {
    renderReviewPair(_kfReviewState.queue[_kfReviewState.index]);
  }
  refreshReviewBadge();
}

const reviewModalEl = document.getElementById("reviewModal");
const chatReviewBtn = document.getElementById("chatReview");
chatReviewBtn.addEventListener("click", async () => {
  reviewModalEl.classList.remove("hidden");
  const stratum = document.getElementById("reviewStratum").value;
  await reviewLoadStratum(stratum);
});
document.getElementById("reviewClose").addEventListener("click", () => {
  reviewModalEl.classList.add("hidden");
});
reviewModalEl.addEventListener("click", e => {
  if (e.target === reviewModalEl) reviewModalEl.classList.add("hidden");
});
document.getElementById("reviewStratum").addEventListener("change", async e => {
  await reviewLoadStratum(e.target.value);
});
for (const b of document.querySelectorAll("#reviewActions .reviewBtn")) {
  b.addEventListener("click", () => reviewSubmit(b.dataset.action));
}
document.addEventListener("keydown", e => {
  if (reviewModalEl.classList.contains("hidden")) return;
  // Ignore typing in the reason input.
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT")) return;
  if (e.key === "Escape") { reviewModalEl.classList.add("hidden"); return; }
  if (e.key === "1" || e.key.toLowerCase() === "y") { reviewSubmit("confirm"); e.preventDefault(); }
  else if (e.key === "2" || e.key.toLowerCase() === "n") { reviewSubmit("reject"); e.preventDefault(); }
  else if (e.key === "3" || e.key.toLowerCase() === "a") { reviewSubmit("ambiguous"); e.preventDefault(); }
  else if (e.key === " ") { reviewSubmit("skip"); e.preventDefault(); }
});

async function processFile(file) {
  welcome.classList.add("hidden");
  localStorage.setItem("kf_returning", "1");
  stats.textContent = `reading ${file.name}...`;
  let text = await file.text();
  const sourceMeta = file._kfTreeMeta || {};
  const incomingSourceName = _kfSourceNameFromFileName(sourceMeta.common_name || file.name);
  const archerAllowed = _kfCatalogTrees.some(t => t && t.key === "archer");
  if (_clerkUserTier === "vip" &&
      _kfIsRestrictedUnsharedSourceName(incomingSourceName) &&
      !archerAllowed) {
    stats.textContent = `${incomingSourceName} is not shared with this account`;
    refreshSources();
    return;
  }
  let parsedJson = null;
  const isPublicDemoFile = DEMO_GED_URL && /^demo\.json$/i.test(file.name || "");
  if (text.trimStart().startsWith("{")) {
    parsedJson = JSON.parse(text);
    if (isPublicDemoFile) {
      parsedJson = _kfSanitizePublicDemoJson(parsedJson);
      text = JSON.stringify(parsedJson);
    }
  }
  window._lastLoadedGedcomRaw = text; // captured for cloud save
  // Multi-source: append this tree to the proxy DB. Prior chat is preserved
  // (it's still factually about the trees that remain loaded). The proxy
  // resets the claude proc on add/replace so a new query sees the new schema.
  // Run in parallel with browser-side parsing. Attach the handler IMMEDIATELY
  // so it survives any later exception in this function (small trees can
  // crash rankRootCandidates / applyRoot but the upload still succeeded).
  // setActiveTree re-runs processFile to swap browser state but the proxy
  // already has the data — _kfSkipNextProxyLoad lets it skip the upload.
  if (_kfSkipNextProxyLoad) {
    _kfSkipNextProxyLoad = false;
  } else if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    loadGedcomToProxy(file, text, DEMO_GED_URL ? "replace" : "add").then(r => {
      if (r && r.ok) {
        const cur = stats.textContent || "";
        const mode = r.mode === "replace" ? "replaced" : "added";
        stats.textContent = cur + (cur ? "  ·  " : "") + `chat tree ${mode} (${(r.build_ms/1000).toFixed(1)}s)`;
        refreshSources();
        fetchPersonSources();   // for the "by gedcom tree" cluster mode
      } else if (r && r.reason && r.reason !== "no proxy") {
        console.warn("[kf] load-gedcom:", r.reason);
      }
    }).catch(e => console.warn("[kf] load-gedcom error:", e?.message || e));
  }
  await ensureGazetteer();
  stats.textContent = "parsing GEDCOM...";
  await new Promise(r => requestAnimationFrame(r));
  const { individuals, families } = parsedJson
    ? parseGedcomFromJson(parsedJson)
    : parseGedcom(text);
  const { indiById, indiIdxById, parentsOf, isParent, childrenOf } = computeRelations(individuals, families);
  lastIndividuals = individuals; lastIndiById = indiById; lastIndiIdxById = indiIdxById;
  lastParentsOf = parentsOf; lastIsParent = isParent; lastChildrenOf = childrenOf;
  lastFamilies = families;
  prewarmKinCache();
  stats.textContent = `placing ${individuals.length.toLocaleString()} people...`;
  await new Promise(r => requestAnimationFrame(r));
  await _kfPrecomputeJitterPoolsForTimeline(individuals, geocoder);
  const tl = buildTimeline(individuals, geocoder, parentsOf);
  lastTimeline = tl;
  // A newly parsed tree needs fresh typed arrays. Otherwise loading a smaller
  // Another tree after a larger one reuses stale person indices from the old tree.
  timelineLoaded = false;
  eventCities = tl.eventCities || [];
  const sourceNameBase = sourceMeta.common_name || file.name.replace(/\.(ged|gedcom|json)$/i, "") || "genealogy";
  lastFileName = _kfUniqueSourceName(sourceNameBase, sourceMeta);
  // Desktop can retain raw text for reprocessing. Mobile keeps only the
  // parsed source snapshot to avoid doubling memory for large trees.
  _kfActiveTreeName = lastFileName;
  if (typeof _kfIsMobileLayout === "function" && _kfIsMobileLayout()) {
    _kfTreeCache.delete(lastFileName);
  } else {
    _kfTreeCache.set(lastFileName, text);
  }
  let browserSourceId = _kfSourceIdByName.get(lastFileName);
  if (!browserSourceId) {
    browserSourceId = _kfNextBrowserSourceId++;
    _kfSourceIdByName.set(lastFileName, browserSourceId);
  }
  const eventCount = individuals.reduce((sum, ind) => sum + ((ind.events && ind.events.length) || 0), 0);
  const candidates = rankRootCandidates(individuals, isParent, parentsOf, indiById);
  const rootId = candidates[0]?.ind.id ?? individuals[0]?.id ?? null;
  const topPci = candidates[0] || null;
  const contentHash = sourceMeta.content_hash || await _kfTreeContentHash(individuals, families);
  const loadedSourceSnapshot = {
    source_id: browserSourceId,
    source_kind: sourceMeta.source_kind || null,
    catalog_key: sourceMeta.catalog_key || null,
    tree_uuid: sourceMeta.tree_uuid || null,
    content_hash: contentHash,
    content_changed_at: sourceMeta.content_changed_at || null,
    owner_uuid: sourceMeta.owner_uuid || null,
    owner_email: sourceMeta.owner_email || null,
    relation: sourceMeta.relation || null,
    top_pci_id: topPci?.ind?.id || null,
    top_pci_name: topPci?.ind?.name || null,
    top_pci_score: topPci?.pci ?? null,
    common_name: sourceMeta.common_name || _kfSourceNameFromFileName(sourceNameBase),
    name: lastFileName,
    loaded_at: new Date().toISOString(),
    n_individuals: individuals.length,
    n_events: eventCount,
    n_families: families.size,
    individuals,
    families,
  };
  _kfLoadedSources.set(lastFileName, loadedSourceSnapshot);
  _kfSelectedSourceIds.add(browserSourceId);
  _kfTreeColorIdx = _kfTreeColorFromName(lastFileName);

  populateRootSelect(candidates);
  if (rootId) _kfPreferredRootBySourceName.set(lastFileName, rootId);
  // Highest-PCI person is the *initial* home person and remains discoverable
  // as the "top PCI" suggestion. Picking someone else from search reassigns
  // _kfHomePersonId to that pick; _kfTopPciId never changes for this load.
  _kfTopPciId = rootId;
  _kfTopPCI = candidates[0]?.pci ?? null;
  _kfHomePersonId = rootId;
  _kfHomePCI = _kfTopPCI;
  _kfRefreshHomeBtn();
  applyRoot(rootId);

  rootwrap.style.display = "";
  $("clusterSection").classList.remove("hidden");
  $("quickChips")?.classList.remove("hidden");
  $("mapLegend").classList.remove("hidden");
  updateMapLegend();
  _kfBuildSurnameTopN(12);
  _kfRenderSurnameChips();
  _kfRefreshQuickChips();
  _kfRenderYearHistogram();
  // Jump the slider to today (clamped to the data range), center the
  // map on the root person's most recent recorded location, and
  // auto-select that dwell so the panel opens to the root's card.
  const today = new Date().getFullYear();
  curYear = Math.min(maxYear, Math.max(minYear, today));
  range.value = curYear;
  const rootIdx = lastIndiIdxById?.get(rootId);
  if (rootIdx !== undefined) {
    const dwells = indiDwells.get(rootIdx);
    if (dwells && dwells.length) {
      let latest = dwells[0];
      for (const di of dwells) if (dwellY[di] > dwellY[latest]) latest = di;
      centerOnGeo(dwellLon[latest], dwellLat[latest]);
      highlightedDwell = latest;
      highlightInferredYear = -1;
      highlightInferredSrcYear = -1;
      if (typeof _kfShowPersonCard === "function") _kfShowPersonCard(latest);
    }
  }
  // Start playback from 1900 so the user immediately sees migration in motion.
  const START_YEAR = 1900;
  if (minYear <= START_YEAR && maxYear >= START_YEAR) {
    curYear = START_YEAR;
    range.value = START_YEAR;
  }
  _kfRebuildSelectedVisualization({
    preserveYear: true,
    preferredSourceName: lastFileName,
    preferredRawRootId: rootId,
    preferActiveRoot: true,
    selectRoot: true,
    centerRoot: true,
  });
  requestAnimationFrame(() => { if (!playing) playBtn.click(); });
  buildBrowserDb(); // build in-memory SQLite for kfApi.sql() — all users
  refreshSources();
  if (_clerkToken && !_kfSkipNextSeed && _kfSkipNextSeedCount <= 0) {
    _kfMaybePersistLoadedTreeByHash(loadedSourceSnapshot, sourceMeta)
      .catch(e => console.warn("[kf] persist loaded tree:", e?.message || e));
  }
  _kfSkipNextSeed = false;
  if (_kfSkipNextSeedCount > 0) _kfSkipNextSeedCount--;
}

function populateRootSelect(candidates) {
  const sel = $("rootSel");
  sel.innerHTML = "";
  for (const c of candidates) {
    const { ind, count, label } = c;
    const opt = document.createElement("option");
    opt.value = ind.id;
    const yrs = (ind.birth_year ?? "?") + "-" + (ind.death_year ?? "?");
    const tag = label ? `${label}  ` : "";
    const tree = ind.source_name ? `  [${ind.source_name}]` : "";
    opt.textContent = `${tag}${ind.name}${tree}  (${yrs})  - ${count} ancestors`;
    sel.appendChild(opt);
  }
}

function applyRoot(rootId, opts = {}) {
  if (!rootId) return;
  lastRootId = rootId;
  lastSideById = classifySides(rootId, lastParentsOf, lastChildrenOf, lastIndividuals);
  lastAncestorSet = directAncestorSet(rootId, lastParentsOf);
  lastBloodSet = bloodRelatives(rootId, lastParentsOf, lastChildrenOf);
  recomputeRelationships();
  if (timelineLoaded) {
    rebuildSideArrays();
  } else {
    const sideForIdx = new Int8Array(lastIndividuals.length);
    for (let i = 0; i < lastIndividuals.length; i++) sideForIdx[i] = lastSideById.get(lastIndividuals[i].id) ?? 2;
    loadTimelineArrays(lastTimeline, sideForIdx, opts);
    rebuildSideArrays();
    precomputeDwellCities();
  }
  // Build the deck.gl binary buffers (dwells + flows) and push to overlay.
  buildDeckDwellData();
  buildDeckFlowData();
  updateDeckDwellLayer();
  const rootInd = lastIndiById.get(rootId);
  const sel = $("rootSel");
  for (const opt of sel.options) opt.selected = (opt.value === rootId);
  _kfRefreshStatsSummary();
  updateSliderMarkers();
  _kfRefreshHomeBtn();
}

// Home person = the user's chosen reference person. Defaults to the
// highest-PCI individual at load time. Picking from the search bar updates
// _kfHomePersonId so the home button always reflects the current pick.
// _kfTopPciId is the immutable "highest PCI" individual for this tree —
// it stays findable in the search dropdown so the user can always restore
// home back to them.
let _kfHomePersonId = null;
let _kfHomePCI = null;
let _kfTopPciId = null;
let _kfTopPCI = null;
