// ---------- Pipeline ----------
function jitter(lat, lon, level) {
  // Scale jitter to geocode precision so city-level points don't drift into
  // the ocean. City ~1 km, county ~10 km, state ~30 km.
  const r = level === "city" ? 0.02 : level === "county" ? 0.15 : 0.4;
  return [lat + (Math.random() - 0.5) * r, lon + (Math.random() - 0.5) * r];
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
      const [lat, lon] = jitter(g.lat, g.lon, g.level);
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
      coded.push([e.year, lat, lon, exact, tcode, placeIdx(e.place), g.lat, g.lon]);
    }
    if (!coded.length) continue;
    coded.sort((a, b) => a[0] - b[0]);
    let prev = null;
    for (const c of coded) {
      const [y, lat, lon, exact, tcode, pidx, blat, blon] = c;
      if (y < mn) mn = y; if (y > mx) mx = y;
      dwells.push([y, lat, lon]); dwellIndi.push(idx); dwellSrc.push(isSource); dwellExact.push(exact);
      dwellType.push(tcode); dwellPlace.push(pidx);
      if (prev) {
        const [py, plat, plon, pex, , , pblat, pblon] = prev;
        // Use base geocode coords (not jittered) to determine whether a real
        // move occurred. Comparing jittered coords incorrectly created flows
        // between consecutive events at the same location, causing the
        // destination ring to appear at a different jitter than the marker.
        if ((pblat !== blat || pblon !== blon) && y > py) {
          flows.push([py, y, plat, plon, lat, lon]);
          flowIndi.push(idx); flowSrc.push(isSource);
          flowExact.push(exact && pex ? 1 : 0);
        }
      }
      prev = [y, lat, lon, exact, tcode, pidx, blat, blon];
    }
  }
  if (mn > mx) { mn = 1700; mx = 2026; }
  const eventCitiesArr = Array.from(evCities.values()).sort((a, b) => b.count - a.count);
  for (let i = 0; i < eventCitiesArr.length; i++) eventCitiesArr[i]._idx = i;
  return { dwells, flows, dwellIndi, flowIndi, dwellSrc, flowSrc, dwellExact, flowExact, dwellType, dwellPlace, places: placesList, eventCities: eventCitiesArr, min_year: mn, max_year: mx, geocoded, missed };
}

function loadTimelineArrays(t, sideForIdx, opts = {}) {
  const requestedYear = Number.isFinite(Number(opts.year))
    ? Number(opts.year)
    : (opts.preserveYear && Number.isFinite(curYear) ? curYear : null);
  const N = t.dwells.length, F = t.flows.length;
  dwellY = new Int16Array(N); dwellLat = new Float32Array(N); dwellLon = new Float32Array(N);
  dwellSide = new Uint8Array(N); dwellSrc = new Uint8Array(N); dwellIndi = new Int32Array(N);
  dwellBlood = new Uint8Array(N); dwellExact = new Uint8Array(N);
  dwellType = new Uint8Array(N); dwellPlace = new Int32Array(N);
  dwellSx = new Float32Array(N); dwellSy = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const d = t.dwells[i];
    dwellY[i] = d[0]; dwellLat[i] = d[1]; dwellLon[i] = d[2];
    dwellIndi[i] = t.dwellIndi[i]; dwellSrc[i] = t.dwellSrc[i];
    dwellExact[i] = t.dwellExact ? t.dwellExact[i] : 0;
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
  flowFromSx = new Float32Array(F); flowFromSy = new Float32Array(F);
  flowToSx = new Float32Array(F); flowToSy = new Float32Array(F);
  for (let i = 0; i < F; i++) {
    const f = t.flows[i];
    flowFromY[i] = f[0]; flowToY[i] = f[1];
    flowFromLat[i] = f[2]; flowFromLon[i] = f[3];
    flowToLat[i] = f[4]; flowToLon[i] = f[5];
    flowIndi[i] = t.flowIndi[i]; flowSrc[i] = t.flowSrc[i];
    flowExact[i] = t.flowExact ? t.flowExact[i] : 0;
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
  } catch (e) {
    console.warn("[kf] refreshBrowserViews:", e.message || e);
  }
}

async function fetchCatalogTrees() {
  if (_clerkUserTier !== "vip" || !_clerkToken) { _kfCatalogTrees = []; return []; }
  try {
    const r = await fetch("/api/catalog/trees", {
      headers: { "Authorization": "Bearer " + _clerkToken },
    });
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
    _kfCatalogTrees = fetched.length ? fetched : _kfCatalogFallbackTrees();
  } catch (e) {
    console.warn("[kf] fetchCatalogTrees:", e?.message || e);
    if (_clerkUserTier === "vip") stats.textContent = `VIP catalog unavailable: ${e?.message || e}`;
    _kfCatalogTrees = _kfCatalogFallbackTrees();
  }
  return _kfCatalogTrees;
}

function _kfSourceNameFromFileName(name) {
  return String(name || "").replace(/\.(ged|gedcom)$/i, "").trim() || "untitled";
}

async function loadCatalogTree(key, opts = {}) {
  if (!key || !_clerkToken) return false;
  const r = await fetch("/api/catalog/tree?key=" + encodeURIComponent(key), {
    headers: { "Authorization": "Bearer " + _clerkToken },
  });
  if (!r.ok) {
    let detail = String(r.status);
    try {
      const err = await r.json();
      if (err?.error) detail += ` ${err.error}`;
    } catch (_) {}
    stats.textContent = `could not load VIP tree ${key}: ${detail}`;
    return false;
  }
  const raw = await r.text();
  let text = raw;
  let name = r.headers.get("X-Catalog-Name") || key;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.text === "string") {
      text = parsed.text;
      name = typeof parsed?.name === "string" ? parsed.name : name;
    }
  } catch (_) {}
  if (!text) return false;
  const sourceName = _kfSourceNameFromFileName(name);
  if (_kfTreeCache.has(sourceName) || _kfLoadedSources.has(sourceName)) return true;
  const file = new File([text], name, { type: "text/plain" });
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
  if (_clerkUserTier !== "vip" || !_clerkToken) return;
  const userKey = _kfStartupLoadUserKey || _clerkToken;
  if (_kfVipCatalogAutoLoadUserKey === userKey) return;
  _kfVipCatalogAutoLoadUserKey = userKey;
  try {
    const trees = (_kfCatalogTrees.length ? _kfCatalogTrees : await fetchCatalogTrees())
      .filter(t => t && t.available !== false);
    const pending = trees.filter(t => {
      const sourceName = _kfSourceNameFromFileName(t.name || t.key);
      return !_kfTreeCache.has(sourceName) && !_kfLoadedSources.has(sourceName);
    });
    if (!pending.length) {
      refreshSources();
      _kfRefreshStatsSummary();
      return;
    }
    stats.textContent = `loading ${pending.length} VIP tree${pending.length === 1 ? "" : "s"}...`;
    let loaded = 0;
    let failed = 0;
    for (const tree of pending) {
      stats.textContent = `loading VIP tree ${tree.name || tree.key}...`;
      try {
        if (await loadCatalogTree(tree.key, { suppressAutosave: true })) loaded++;
        else failed++;
      } catch (e) {
        failed++;
        console.warn("[kf] loadCatalogTree:", tree.key, e?.message || e);
      }
    }
    refreshSources();
    _kfRefreshStatsSummary(failed ? { suffix: `${failed} VIP failed` } : {});
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
  stats.textContent = parts.join("  |  ");
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

function renderSources(list) {
  const wrap = document.getElementById("sourcesPanel");
  const inner = document.getElementById("sourcesList");
  if (!wrap || !inner) return;
  const filtered = (list || []).filter(s => (s.n_individuals || 0) > 0);
  _kfLoadedTreeCount = filtered.length;
  if (filtered.length === 0 && _kfCatalogTrees.length === 0) {
    wrap.classList.add("hidden");
    inner.innerHTML = "";
    if (typeof _kfRefreshQuickChips === "function") _kfRefreshQuickChips();
    return;
  }
  wrap.classList.remove("hidden");
  const parts = [`<span class="label">trees</span>`, `<button type="button" class="srcAction" data-select="all">all</button>`];
  for (const s of filtered) {
    const n = (s.n_individuals || 0).toLocaleString();
    parts.push(
      `<span class="src${s.active ? " on" : ""}" data-id="${s.id}" title="${escChat(s.loaded_at || "")}">` +
      `<input class="sel" type="checkbox" data-sel="${s.id}" ${s.selected ? "checked" : ""} title="Include this tree in queries, maps, clusters, and animations">` +
      `<span class="name" data-activate="${escChat(s.name)}" title="Use this tree as the home/detail tree">${escChat(s.name)}</span>` +
      `<span class="meta">${n}</span>` +
      `<span class="x" data-del="${s.id}" data-name="${escChat(s.name)}" title="Remove this tree">x</span>` +
      `</span>`,
    );
  }
  const catalogActions = [];
  for (const t of _kfCatalogTrees) {
    const sourceName = _kfSourceNameFromFileName(t.name || t.key);
    const loaded = _kfTreeCache.has(sourceName) || _kfLoadedSources.has(sourceName);
    if (t.available === false || loaded) continue;
    catalogActions.push(t);
  }
  if (catalogActions.length) {
    parts.push(`<span class="label" style="margin-left:8px">vip library</span>`);
    for (const t of catalogActions) {
      parts.push(`<button type="button" class="srcAction" data-catalog="${escChat(t.key)}" title="Load this server tree">${escChat(t.name)}</button>`);
    }
  }
  inner.innerHTML = parts.join("");
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
  inner.querySelectorAll(".name[data-activate]").forEach(el => {
    el.addEventListener("click", () => {
      const name = el.getAttribute("data-activate") || "";
      if (name) kfApi.setActiveTree(name);
    });
  });
  inner.querySelectorAll(".x[data-del]").forEach(el => {
    el.addEventListener("click", async () => {
      const id = Number(el.getAttribute("data-del"));
      const name = el.getAttribute("data-name") || "";
      const ok = await deleteSource(id);
      if (!ok) return;
      _kfTreeCache.delete(name);
      if (name === _kfActiveTreeName) {
        const remaining = [..._kfTreeCache.keys()];
        if (remaining.length > 0) {
          const nextName = remaining[0];
          const text = _kfTreeCache.get(nextName);
          const fake = new File([text], nextName + ".ged", { type: "text/plain" });
          _kfSkipNextProxyLoad = true;
          _kfSkipNextSeed = true;
          processFile(fake).catch(e => console.warn("[kf] post-delete switch:", e?.message || e));
        } else {
          lastIndividuals = null;
          _kfActiveTreeName = null;
          _kfSurnamesTop = null;
          _kfSurnameFilter = null;
          _kfRenderSurnameChips();
        }
      }
      refreshSources();
    });
  });
  inner.querySelectorAll(".srcAction[data-select='all']").forEach(el => {
    el.addEventListener("click", () => {
      _kfSelectedSourceIds = new Set(filtered.map(s => s.id));
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
  if (typeof _kfRefreshQuickChips === "function") _kfRefreshQuickChips();
}

async function refreshSources() {
  if (_clerkUserTier === "vip") await fetchCatalogTrees();
  renderSources(_kfGetLoadedSourcesList());
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
  const text = await file.text();
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
  const { individuals, families } = text.trimStart().startsWith("{")
    ? parseGedcomFromJson(JSON.parse(text))
    : parseGedcom(text);
  const { indiById, indiIdxById, parentsOf, isParent, childrenOf } = computeRelations(individuals, families);
  lastIndividuals = individuals; lastIndiById = indiById; lastIndiIdxById = indiIdxById;
  lastParentsOf = parentsOf; lastIsParent = isParent; lastChildrenOf = childrenOf;
  lastFamilies = families;
  prewarmKinCache();
  stats.textContent = `geocoding ${individuals.length.toLocaleString()} people...`;
  await new Promise(r => requestAnimationFrame(r));
  const tl = buildTimeline(individuals, geocoder, parentsOf);
  lastTimeline = tl;
  // A newly parsed tree needs fresh typed arrays. Otherwise loading a smaller
  // VIP tree after a larger one reuses stale person indices from the old tree.
  timelineLoaded = false;
  eventCities = tl.eventCities || [];
  lastFileName = file.name.replace(/\.(ged|gedcom)$/i, "") || "genealogy";
  // Cache the raw GEDCOM text so kfApi.setActiveTree(name) can re-activate
  // a previously-loaded tree without forcing the user to drop the file again.
  _kfActiveTreeName = lastFileName;
  _kfTreeCache.set(lastFileName, text);
  let browserSourceId = _kfSourceIdByName.get(lastFileName);
  if (!browserSourceId) {
    browserSourceId = _kfNextBrowserSourceId++;
    _kfSourceIdByName.set(lastFileName, browserSourceId);
  }
  const eventCount = individuals.reduce((sum, ind) => sum + ((ind.events && ind.events.length) || 0), 0);
  const loadedSourceSnapshot = {
    source_id: browserSourceId,
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

  const candidates = rankRootCandidates(individuals, isParent, parentsOf, indiById);
  populateRootSelect(candidates);
  const rootId = candidates[0]?.ind.id ?? individuals[0]?.id ?? null;
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
  $("quickChips").classList.remove("hidden");
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
      updatePanel(true);
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
  if (_clerkToken && _clerkUserTier === "vip" && !_kfSkipNextSeed && _kfSkipNextSeedCount <= 0) {
    seedCloudDb(loadedSourceSnapshot); // VIP autosaves this tree into the server-side set
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
