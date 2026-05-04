const _KF_LOOKUP_STOPWORDS = new Set([
  "about", "again", "alive", "alaska", "all", "also", "and", "are", "ask", "at",
  "back", "been", "case", "can", "cannot", "claude", "current", "data", "database",
  "did", "does", "family", "for", "from", "get", "have", "how", "in", "into",
  "living", "map", "not", "now", "of", "on", "people", "person", "place", "query",
  "same", "see", "show", "that", "the", "their", "them", "there", "these", "they",
  "this", "time", "tree", "was", "were", "what", "when", "where", "who", "with",
]);

function _kfSelectedSourceSnapshots() {
  const selected = _kfSelectedSourceIds && _kfSelectedSourceIds.size ? _kfSelectedSourceIds : null;
  return [..._kfLoadedSources.values()].filter(src => !selected || selected.has(src.source_id));
}

function _kfVizIndiId(src, rawId) {
  return `s${src.source_id}:I:${String(rawId || "")}`;
}

function _kfVizFamId(src, rawId) {
  return `s${src.source_id}:F:${String(rawId || "")}`;
}

function _kfCloneEventForViz(ev) {
  return {
    type: ev.type,
    date: ev.date || "",
    year: ev.year ?? null,
    year_end: ev.year_end ?? ev.year ?? null,
    place: ev.place || "",
  };
}

function _kfSelectedVizSourceList() {
  return (_kfVizSources && _kfVizSources.length ? _kfVizSources : _kfSelectedSourceSnapshots())
    .filter(src => src && (src.n_individuals || src.individuals?.length || 0) > 0);
}

function _kfSourceNameForIndiIdx(idx) {
  return _kfVizSourceNameByIndi?.[idx] || _kfActiveTreeName || lastFileName || "current tree";
}

function _kfSourceIdForIndiIdx(idx) {
  const id = _kfVizSourceIdByIndi?.[idx];
  if (Number.isFinite(id)) return id;
  const name = _kfSourceNameForIndiIdx(idx);
  return _kfSourceIdByName.get(name) || 1;
}

function _kfBuildSelectedVizDataset(sources) {
  const individuals = [];
  const families = new Map();
  const sourceNameByIndi = [];
  const sourceIdByIndi = [];
  const rawIdByIndi = [];
  for (const src of sources) {
    for (const ind of (src.individuals || [])) {
      const clone = {
        ...ind,
        id: _kfVizIndiId(src, ind.id),
        raw_id: ind.id,
        source_id: src.source_id,
        source_name: src.name,
        famc: ind.famc ? _kfVizFamId(src, ind.famc) : null,
        events: (ind.events || []).map(_kfCloneEventForViz),
      };
      individuals.push(clone);
      sourceNameByIndi.push(src.name);
      sourceIdByIndi.push(src.source_id);
      rawIdByIndi.push(ind.id);
    }
    for (const [, fam] of (src.families || new Map())) {
      families.set(_kfVizFamId(src, fam.id), {
        id: _kfVizFamId(src, fam.id),
        husb: fam.husb ? _kfVizIndiId(src, fam.husb) : null,
        wife: fam.wife ? _kfVizIndiId(src, fam.wife) : null,
        chil: (fam.chil || []).map(id => _kfVizIndiId(src, id)),
      });
    }
  }
  return { individuals, families, sourceNameByIndi, sourceIdByIndi, rawIdByIndi };
}

function _kfRootForSourceInViz(sourceName, sources, indiById, rawRootId = null) {
  const src = sources.find(s => s.name === sourceName) || null;
  if (!src) return null;
  const raw = rawRootId || _kfPreferredRootBySourceName.get(src.name);
  if (raw) {
    const id = _kfVizIndiId(src, raw);
    if (indiById.has(id)) return id;
  }
  for (const ind of (src.individuals || [])) {
    const id = _kfVizIndiId(src, ind.id);
    if (indiById.has(id)) return id;
  }
  return null;
}

function _kfChooseVizRoot(sources, indiById, candidates, opts = {}) {
  const preferredSourceName = opts.preferredSourceName || _kfActiveTreeName || sources[0]?.name || "";
  if (opts.preferActiveRoot) {
    const preferred = _kfRootForSourceInViz(preferredSourceName, sources, indiById, opts.preferredRawRootId);
    if (preferred) return preferred;
  }
  if (_kfHomePersonId && indiById.has(_kfHomePersonId)) return _kfHomePersonId;
  if (lastRootId && indiById.has(lastRootId)) return lastRootId;
  const preferred = _kfRootForSourceInViz(preferredSourceName, sources, indiById, opts.preferredRawRootId);
  if (preferred) return preferred;
  return candidates[0]?.ind.id || sources[0]?.individuals?.[0] && _kfVizIndiId(sources[0], sources[0].individuals[0].id) || null;
}

function _kfRefreshHomePci(rootId) {
  if (!rootId || !lastParentsOf || !lastIndiById) { _kfHomePCI = null; return; }
  if (rootId === _kfTopPciId) { _kfHomePCI = _kfTopPCI; return; }
  let expected = 0;
  for (let d = 1; d <= ROOT_MAX_DEPTH; d++) expected += 1 << d;
  const { found } = ancestorScore(rootId, lastParentsOf, lastIndiById, ROOT_MAX_DEPTH);
  _kfHomePCI = expected > 0 ? found / expected : null;
}

function _kfLatestVisibleDwellForId(indId) {
  const idx = lastIndiIdxById?.get(indId);
  if (idx == null) return -1;
  return _kfLatestValidDwellForIndi(idx, Math.floor(curYear));
}

function _kfRebuildSelectedVisualization(opts = {}) {
  if (!geocoder) return false;
  if (!_kfLoadedSources.size) {
    lastIndividuals = lastFamilies = lastIndiById = lastIndiIdxById = null;
    lastParentsOf = lastIsParent = lastChildrenOf = null;
    timelineLoaded = false;
    _kfDwellCount = 0;
    _kfVizSources = [];
    _kfVizSourceNameByIndi = [];
    _kfVizSourceIdByIndi = [];
    _kfVizRawIdByIndi = [];
    fxCtx.clearRect(0, 0, W, H);
    if (_kfDeckOverlay) updateDeckDwellLayer();
    return false;
  }
  _kfEnsureSelectedSources();
  const sources = _kfSelectedSourceSnapshots().filter(src => src && (src.individuals || []).length);
  if (!sources.length) {
    lastIndividuals = lastFamilies = lastIndiById = lastIndiIdxById = null;
    lastParentsOf = lastIsParent = lastChildrenOf = null;
    timelineLoaded = false;
    _kfDwellCount = 0;
    _kfVizSources = [];
    _kfVizSourceNameByIndi = [];
    _kfVizSourceIdByIndi = [];
    _kfVizRawIdByIndi = [];
    fxCtx.clearRect(0, 0, W, H);
    if (_kfDeckOverlay) updateDeckDwellLayer();
    return false;
  }
  if (!_kfActiveTreeName || !sources.some(src => src.name === _kfActiveTreeName)) {
    _kfActiveTreeName = sources[0].name;
  }
  const previousYear = Number.isFinite(curYear) ? curYear : null;
  const previousHighlightId = highlightedDwell >= 0 && lastIndividuals && dwellIndi
    ? lastIndividuals[dwellIndi[highlightedDwell]]?.id
    : null;
  const data = _kfBuildSelectedVizDataset(sources);
  if (!data.individuals.length) return false;
  const { indiById, indiIdxById, parentsOf, isParent, childrenOf } = computeRelations(data.individuals, data.families);

  lastIndividuals = data.individuals;
  lastFamilies = data.families;
  lastIndiById = indiById;
  lastIndiIdxById = indiIdxById;
  lastParentsOf = parentsOf;
  lastIsParent = isParent;
  lastChildrenOf = childrenOf;
  _kfVizSources = sources.slice();
  _kfVizSourceNameByIndi = data.sourceNameByIndi;
  _kfVizSourceIdByIndi = data.sourceIdByIndi;
  _kfVizRawIdByIndi = data.rawIdByIndi;
  _kfVizIsComposite = sources.length > 1;
  _kfPersonSources = null;
  lastFileName = sources.length === 1 ? sources[0].name : `${sources.length} selected trees`;
  _kfTreeColorIdx = _kfTreeColorFromName(_kfActiveTreeName || sources[0].name);
  prewarmKinCache();

  const candidates = rankRootCandidates(data.individuals, isParent, parentsOf, indiById);
  populateRootSelect(candidates);
  const rootId = _kfChooseVizRoot(sources, indiById, candidates, opts);
  if (!rootId) return false;
  _kfTopPciId = candidates[0]?.ind.id ?? rootId;
  _kfTopPCI = candidates[0]?.pci ?? null;
  _kfHomePersonId = rootId;
  _kfRefreshHomePci(rootId);
  _kfRefreshHomeBtn();

  stats.textContent = `geocoding ${data.individuals.length.toLocaleString()} people from ${sources.length} tree${sources.length === 1 ? "" : "s"}...`;
  lastTimeline = buildTimeline(data.individuals, geocoder, parentsOf);
  eventCities = lastTimeline.eventCities || [];
  timelineLoaded = false;
  applyRoot(rootId, { preserveYear: true, year: previousYear });

  const nextHighlightId = previousHighlightId && lastIndiById.has(previousHighlightId)
    ? previousHighlightId
    : (opts.selectRoot ? rootId : null);
  highlightedDwell = nextHighlightId ? _kfLatestVisibleDwellForId(nextHighlightId) : -1;
  highlightInferredYear = -1;
  highlightInferredSrcYear = -1;
  if (highlightedDwell >= 0 && opts.centerRoot) centerOnGeo(dwellLon[highlightedDwell], dwellLat[highlightedDwell]);
  if (highlightedDwell >= 0 && opts.selectRoot && typeof _kfShowPersonCard === "function") _kfShowPersonCard(highlightedDwell);

  _kfBuildSurnameTopN(12);
  _kfRenderSurnameChips();
  _kfRefreshQuickChips();
  _kfRenderYearHistogram();
  updateMapLegend();
  _kfClusterCacheKey = "";
  fxCtx.clearRect(0, 0, W, H);
  if (_kfDeckOverlay) updateDeckDwellLayer();
  return true;
}

function _kfSingularizeSurnameToken(token) {
  let s = String(token || "").toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, "");
  if (!s) return "";
  if (s.endsWith("ies") && s.length > 4) return s.slice(0, -3) + "y";
  if (s.endsWith("s") && !s.endsWith("ss") && s.length > 3) return s.slice(0, -1);
  return s;
}

function _kfSelectedSurnameSet() {
  const out = new Set();
  for (const src of _kfSelectedSourceSnapshots()) {
    for (const ind of (src.individuals || [])) {
      const surname = _kfSurnameOf(ind.name);
      if (surname) out.add(surname.toLowerCase());
    }
  }
  return out;
}

function _kfSurnameCandidatesFromQuestion(text) {
  const known = _kfSelectedSurnameSet();
  if (!known.size) return [];
  const out = [];
  const seen = new Set();
  const words = String(text || "").toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
  for (const word of words) {
    const base = _kfSingularizeSurnameToken(word);
    if (!base || _KF_LOOKUP_STOPWORDS.has(base) || !known.has(base) || seen.has(base)) continue;
    seen.add(base);
    out.push(base);
    if (out.length >= 3) break;
  }
  return out;
}

function _kfKnownPlaceTokens() {
  const out = new Set();
  for (const src of _kfSelectedSourceSnapshots()) {
    for (const ind of (src.individuals || [])) {
      for (const ev of (ind.events || [])) {
        const words = String(ev.place || "").toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
        for (const word of words) {
          if (!_KF_LOOKUP_STOPWORDS.has(word)) out.add(word);
        }
      }
    }
  }
  return out;
}

function _kfPlaceTermsFromText(text, surnames = []) {
  const known = _kfKnownPlaceTokens();
  if (!known.size) return [];
  const surnameSet = new Set(surnames.map(s => String(s).toLowerCase()));
  const out = [];
  const seen = new Set();
  const words = String(text || "").toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
  for (const word of words) {
    const baseSurname = _kfSingularizeSurnameToken(word);
    if (_KF_LOOKUP_STOPWORDS.has(word) || surnameSet.has(baseSurname)) continue;
    if (!known.has(word) || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= 5) break;
  }
  return out;
}

function _kfNormalizePlaceTerms(place) {
  if (Array.isArray(place)) {
    return place.flatMap(p => _kfNormalizePlaceTerms(p));
  }
  return String(place || "")
    .toLowerCase()
    .match(/[a-z][a-z'-]{2,}/g)?.filter(w => !_KF_LOOKUP_STOPWORDS.has(w)) || [];
}

function _kfPlaceMatchesTerms(place, terms) {
  if (!terms || !terms.length) return true;
  const hay = String(place || "").toLowerCase();
  return terms.some(term => hay.includes(term));
}

function _kfPlacedEvents(ind) {
  return (ind?.events || [])
    .filter(ev => ev && ev.place && Number.isFinite(parseInt(ev.year, 10)))
    .map(ev => ({ event: _kfEventPlainLabel(ev.type, { noun: true }), year: parseInt(ev.year, 10), place: String(ev.place || "") }))
    .sort((a, b) => a.year - b.year || a.event.localeCompare(b.event));
}

function _kfLatestPlacedEvent(ind, throughYear) {
  let latest = null;
  for (const ev of _kfPlacedEvents(ind)) {
    if (ev.year > throughYear) continue;
    if (!latest || ev.year >= latest.year) latest = ev;
  }
  return latest;
}

function _kfDwellIntervalsForPerson(ind, throughYear) {
  const events = _kfPlacedEvents(ind);
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const next = events[i + 1];
    let end = next ? next.year - 1 : throughYear;
    if (ind?.death_year != null) end = Math.min(end, ind.death_year);
    if (end < ev.year) end = ev.year;
    out.push({ start: ev.year, end, event: ev.event, place: ev.place });
  }
  return out;
}

function _kfPersonLivingStatusNow(ind, year = new Date().getFullYear()) {
  if (ind?.death_year != null) return "deceased";
  return _kfPersonMayBeAliveAtYear(ind, year) ? "living_or_presumed_living" : "presumed_deceased";
}

function _kfFindPeopleRows(criteria = {}) {
  const year = Number.isFinite(Number(criteria.year)) ? Number(criteria.year) : new Date().getFullYear();
  const limit = Math.max(1, Math.min(100, parseInt(criteria.limit, 10) || 40));
  const surname = criteria.surname ? _kfSingularizeSurnameToken(criteria.surname) : "";
  const nameNeedle = criteria.name ? String(criteria.name).toLowerCase().trim() : "";
  const livingOnly = criteria.living === true || String(criteria.status || "").toLowerCase() === "living";
  const placeTerms = Array.isArray(criteria.placeTerms)
    ? criteria.placeTerms.flatMap(p => _kfNormalizePlaceTerms(p))
    : _kfNormalizePlaceTerms(criteria.placeTerms || criteria.place);
  const mustHavePlace = !!criteria.mustHavePlace;
  const rows = [];
  let total = 0;

  for (const src of _kfSelectedSourceSnapshots()) {
    for (const ind of (src.individuals || [])) {
      const personSurname = _kfSurnameOf(ind.name || "");
      if (surname && String(personSurname || "").toLowerCase() !== surname) continue;
      if (nameNeedle && !String(ind.name || "").toLowerCase().includes(nameNeedle)) continue;
      const status = _kfPersonLivingStatusNow(ind, year);
      if (livingOnly && status !== "living_or_presumed_living") continue;
      const latest = _kfLatestPlacedEvent(ind, year);
      const intervals = _kfDwellIntervalsForPerson(ind, year);
      const matchingIntervals = placeTerms.length
        ? intervals.filter(iv => _kfPlaceMatchesTerms(iv.place, placeTerms))
        : [];
      if (mustHavePlace && placeTerms.length && matchingIntervals.length === 0) continue;
      total++;
      if (rows.length >= limit) continue;
      rows.push({
        tree: src.name,
        id: ind.id,
        name: ind.name || "?",
        sex: ind.sex || null,
        birth: ind.birth_year ?? null,
        birth_place: ind.birth_place || null,
        death: ind.death_year ?? null,
        status,
        latest_place: latest?.place || ind.birth_place || null,
        latest_year: latest?.year ?? null,
        place_intervals: matchingIntervals.slice(0, 8),
        placed_events: _kfPlacedEvents(ind).slice(-12),
      });
    }
  }
  rows.sort((a, b) => (a.birth ?? 9999) - (b.birth ?? 9999) || a.name.localeCompare(b.name));
  return {
    ok: true,
    criteria: { surname: surname || null, name: nameNeedle || null, living: livingOnly, year, placeTerms, mustHavePlace },
    total,
    truncated: total > rows.length,
    rows,
  };
}

function _kfFormatInterval(iv) {
  if (!iv) return "";
  const range = iv.start === iv.end ? String(iv.start) : `${iv.start}-${iv.end}`;
  return `${range} ${iv.place}`;
}

function buildQuestionDataContext(userMsg) {
  if (!_kfLoadedSources.size) return "";
  const lower = String(userMsg || "").toLowerCase();
  const surnames = _kfSurnameCandidatesFromQuestion(userMsg);
  if (!surnames.length) return "";
  const shouldLookup = /\b(living|alive|all|everyone|where|when|same|together|database|db|people|surname|family|families)\b/.test(lower)
    || surnames.some(s => lower.includes(`${s}s`));
  if (!shouldLookup) return "";

  const placeTerms = _kfPlaceTermsFromText(userMsg, surnames);
  const living = /\b(living|alive)\b/.test(lower);
  const blocks = [];
  for (const surname of surnames.slice(0, 2)) {
    const result = _kfFindPeopleRows({ surname, living, placeTerms, limit: 24 });
    const label = surname.charAt(0).toUpperCase() + surname.slice(1);
    const lines = [
      `Database lookup for surname ${label} (scoped to checked trees): ${result.total} ${living ? "living/presumed-living " : ""}match${result.total === 1 ? "" : "es"}${result.truncated ? "; showing first 24" : ""}.`,
    ];
    if (placeTerms.length) lines.push(`Place terms recognized from question: ${placeTerms.join(", ")}.`);
    for (const row of result.rows) {
      const life = [row.birth ? `b. ${row.birth}` : "", row.death ? `d. ${row.death}` : row.status].filter(Boolean).join(", ");
      const latest = row.latest_place
        ? (row.latest_year != null ? `latest known ${row.latest_place} in ${row.latest_year}` : `birth location recorded as ${row.latest_place}`)
        : "no placed events";
      const intervals = placeTerms.length
        ? (row.place_intervals.length ? `matching intervals: ${row.place_intervals.map(_kfFormatInterval).join("; ")}` : `matching intervals: none`)
        : "";
      lines.push(`- ${row.name} (${life}; ${row.tree}): ${latest}${intervals ? `; ${intervals}` : ""}.`);
    }
    blocks.push(lines.join("\n"));
  }
  return `Database context precomputed for this question:\n${blocks.join("\n\n")}`;
}

const _KF_HISTORICAL_TITLE_RE = /\b(Sir|Dame|Lady|Lord|King|Queen|Prince|Princess|Duke|Duchess|Earl|Count|Countess|Baron|Baroness|Rev\.?|Dr\.?|Capt\.?|Captain|Col\.?|Colonel|Maj\.?|Major|Gen\.?|General)\b/i;

function _kfCountryLabelFromPlace(place) {
  const raw = String(place || "").trim();
  if (!raw) return "";
  if (geocoder) {
    const g = geocoder(raw);
    if (g) {
      const normalized = typeof geocoder.normalizePlace === "function" ? geocoder.normalizePlace(raw) : raw;
      const parts = String(normalized || raw).split(",").map(s => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
      if (g.cc === "US") return "USA";
      return g.cc || "";
    }
  }
  const parts = raw.split(",").map(s => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function _kfTopCountsFromMap(map, limit = 8) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function _kfAddCount(map, key, n = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + n);
}

function _kfLifeForTool(ind) {
  return { name: ind.name || "?", birth: ind.birth_year ?? null, death: ind.death_year ?? null };
}

function _kfImmigrationRouteLabel(fromCountry, toCountry) {
  return `${fromCountry || "unknown"} -> ${toCountry || "unknown"}`;
}

function _kfGeoForPlaceCached(cache, place) {
  const raw = String(place || "").trim();
  if (!raw || !geocoder) return null;
  if (cache.has(raw)) return cache.get(raw);
  const g = geocoder(raw);
  cache.set(raw, g || null);
  return g || null;
}

function _kfRefreshMapActionOverlays() {
  fxCtx.clearRect(0, 0, W, H);
  if (_kfDeckOverlay) updateDeckDwellLayer();
}

function _kfRoutePointFromInput(point) {
  if (typeof point === "string") {
    const ind = _kfFindIndi(point);
    if (ind) {
      const p = _kfLatestDwellLatLon(ind);
      if (p) return { lat: p.lat, lon: p.lon, label: ind.name };
    }
    if (!geocoder) return { error: "geocoder not ready" };
    const g = geocoder(point);
    if (!g) return { error: "no place matched: " + point };
    return { lat: g.lat, lon: g.lon, label: point };
  }
  if (point && typeof point === "object") {
    if (typeof point.place === "string") return _kfRoutePointFromInput(point.place);
    if (typeof point.person === "string") return _kfRoutePointFromInput(point.person);
    const lat = Number(point.lat);
    const lon = Number(point.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { lat, lon, label: point.label || "" };
    }
  }
  return { error: "route point must be a place, person, or {lat, lon}" };
}

function _kfNormalizedPlaceForTool(place) {
  const raw = String(place || "").trim();
  if (!raw) return "";
  if (geocoder && typeof geocoder.normalizePlace === "function") return geocoder.normalizePlace(raw) || raw;
  return raw;
}

function _kfRegionLabelFromGeo(place, geo) {
  const normalized = _kfNormalizedPlaceForTool(place);
  const parts = normalized.split(",").map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) return `${parts[parts.length - 2]}, ${parts[parts.length - 1]}`;
  if (parts.length === 1) return parts[0];
  if (geo?.st && geo?.cc) return `${geo.st}, ${geo.cc}`;
  return String(place || "").trim();
}

function _kfPersonKey(src, ind) {
  return `${src.source_id}:${ind.id}`;
}

function _kfSelectedGenealogyFacts(opts = {}) {
  const geoCache = new Map();
  const sources = _kfSelectedSourceSnapshots();
  const persons = [];
  const facts = [];
  const factsByPerson = new Map();
  const families = [];
  for (const src of sources) {
    for (const ind of (src.individuals || [])) {
      const key = _kfPersonKey(src, ind);
      const person = {
        key,
        tree: src.name,
        id: ind.id,
        name: ind.name || "?",
        surname: _kfSurnameOf(ind.name || "") || "(unknown)",
        birth: ind.birth_year ?? null,
        birthPlace: ind.birth_place || null,
        death: ind.death_year ?? null,
      };
      persons.push(person);
      const rows = [];
      for (const ev of (ind.events || [])) {
        const year = Number(ev?.year);
        const place = String(ev?.place || "").trim();
        if (!Number.isFinite(year) || !place) continue;
        const geo = _kfGeoForPlaceCached(geoCache, place);
        const fact = {
          ...person,
          type: String(ev.type || "").toUpperCase(),
          event: _kfEventPlainLabel(ev.type, { noun: true }),
          year,
          place,
          normalizedPlace: _kfNormalizedPlaceForTool(place),
          region: _kfRegionLabelFromGeo(place, geo),
          country: geo ? _kfCountryLabelFromPlace(place) : _kfCountryLabelFromPlace(place),
          lat: geo?.lat ?? null,
          lon: geo?.lon ?? null,
          geoLevel: geo?.level || null,
          geoState: geo?.st || null,
        };
        rows.push(fact);
        facts.push(fact);
      }
      rows.sort((a, b) => a.year - b.year || a.event.localeCompare(b.event));
      factsByPerson.set(key, rows);
    }
    for (const [, fam] of (src.families || new Map())) {
      families.push({
        tree: src.name,
        id: fam.id,
        husbKey: fam.husb ? `${src.source_id}:${fam.husb}` : null,
        wifeKey: fam.wife ? `${src.source_id}:${fam.wife}` : null,
        childKeys: (fam.chil || []).map(id => `${src.source_id}:${id}`),
      });
    }
  }
  return { sources: sources.map(s => s.name), persons, facts, factsByPerson, families, limit: parseInt(opts.limit, 10) || 12 };
}

function _kfMoveRowsFromFacts(data, opts = {}) {
  const minMiles = Number.isFinite(Number(opts.minMiles)) ? Number(opts.minMiles) : 25;
  const moves = [];
  for (const [personKey, rows] of data.factsByPerson.entries()) {
    let prev = null;
    for (const row of rows) {
      if (row.lat == null || row.lon == null) continue;
      if (prev) {
        const miles = _kfHaversineMiles(prev.lat, prev.lon, row.lat, row.lon);
        if (miles >= minMiles && row.year >= prev.year) {
          moves.push({
            personKey,
            tree: row.tree,
            person: row.name,
            surname: row.surname,
            birth: row.birth,
            death: row.death,
            fromYear: prev.year,
            toYear: row.year,
            yearsElapsed: row.year - prev.year,
            from: prev.normalizedPlace || prev.place,
            to: row.normalizedPlace || row.place,
            fromRegion: prev.region,
            toRegion: row.region,
            fromCountry: prev.country,
            toCountry: row.country,
            miles: Math.round(miles * 10) / 10,
          });
        }
      }
      prev = row;
    }
  }
  return moves;
}

function _kfExamplePerson(row) {
  return {
    person: row.person || row.name,
    birth: row.birth ?? null,
    death: row.death ?? null,
    tree: row.tree,
  };
}

function _kfUniqueExamples(rows, limit = 6) {
  const out = [], seen = new Set();
  for (const row of rows) {
    const key = `${row.tree}:${row.person || row.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(_kfExamplePerson(row));
    if (out.length >= limit) break;
  }
  return out;
}

function _kfCollectImmigrationWaves(opts = {}) {
  const limit = Math.max(5, Math.min(30, parseInt(opts?.limit, 10) || 18));
  const signals = [];
  const seenSignals = new Set();
  const titleMarked = [];
  const selectedSources = _kfSelectedSourceSnapshots();
  const countryCache = new Map();
  const countryFor = (place) => {
    const key = String(place || "");
    if (countryCache.has(key)) return countryCache.get(key);
    const value = _kfCountryLabelFromPlace(key);
    countryCache.set(key, value);
    return value;
  };

  function addSignal(signal) {
    if (!Number.isFinite(signal.year)) return;
    const key = [signal.tree, signal.person, signal.year, signal.kind, signal.fromCountry, signal.toCountry, signal.place].join("|");
    if (seenSignals.has(key)) return;
    seenSignals.add(key);
    signals.push(signal);
  }

  for (const src of selectedSources) {
    for (const ind of (src.individuals || [])) {
      const name = ind.name || "?";
      const surname = _kfSurnameOf(name) || "";
      if (_KF_HISTORICAL_TITLE_RE.test(name) && titleMarked.length < 40) {
        titleMarked.push({ tree: src.name, ..._kfLifeForTool(ind) });
      }
      const events = (ind.events || [])
        .filter(ev => ev && Number.isFinite(Number(ev.year)) && ev.place)
        .map(ev => ({
          type: String(ev.type || "").toUpperCase(),
          year: Number(ev.year),
          place: String(ev.place || ""),
          country: countryFor(ev.place),
        }))
        .sort((a, b) => a.year - b.year || a.type.localeCompare(b.type));
      let prevPlaced = null;
      for (const ev of events) {
        if (prevPlaced && prevPlaced.country && ev.country && prevPlaced.country !== ev.country) {
          addSignal({
            kind: "cross-country transition",
            tree: src.name,
            person: name,
            birth: ind.birth_year ?? null,
            death: ind.death_year ?? null,
            surname,
            year: ev.year,
            fromCountry: prevPlaced.country,
            toCountry: ev.country,
            fromPlace: prevPlaced.place,
            place: ev.place,
          });
        }
        if (ev.type === "IMMI" || ev.type === "EMIG") {
          addSignal({
            kind: ev.type === "IMMI" ? "immigration record" : "emigration record",
            tree: src.name,
            person: name,
            birth: ind.birth_year ?? null,
            death: ind.death_year ?? null,
            surname,
            year: ev.year,
            fromCountry: ev.type === "EMIG" ? ev.country : "",
            toCountry: ev.type === "IMMI" ? ev.country : "",
            place: ev.place,
          });
        }
        if (ev.country) prevPlaced = ev;
      }
    }
  }

  const surnameCounts = new Map();
  const routeCounts = new Map();
  const byWave = new Map();
  for (const sig of signals) {
    const decade = Math.floor(sig.year / 10) * 10;
    const route = _kfImmigrationRouteLabel(sig.fromCountry, sig.toCountry);
    const key = `${decade}|${route}`;
    let wave = byWave.get(key);
    if (!wave) {
      wave = {
        period: `${decade}s`,
        decade,
        route,
        count: 0,
        firstYear: sig.year,
        lastYear: sig.year,
        surnames: new Map(),
        kinds: new Map(),
        examples: [],
      };
      byWave.set(key, wave);
    }
    wave.count++;
    wave.firstYear = Math.min(wave.firstYear, sig.year);
    wave.lastYear = Math.max(wave.lastYear, sig.year);
    _kfAddCount(wave.surnames, sig.surname || "(unknown)");
    _kfAddCount(wave.kinds, sig.kind);
    if (wave.examples.length < 6) {
      wave.examples.push({
        person: sig.person,
        birth: sig.birth,
        death: sig.death,
        year: sig.year,
        from: sig.fromPlace || sig.fromCountry || null,
        to: sig.place || sig.toCountry || null,
        tree: sig.tree,
      });
    }
    _kfAddCount(surnameCounts, sig.surname || "(unknown)");
    _kfAddCount(routeCounts, route);
  }

  const waves = [...byWave.values()]
    .sort((a, b) => b.count - a.count || a.decade - b.decade || a.route.localeCompare(b.route))
    .slice(0, limit)
    .map(w => ({
      period: w.period,
      yearRange: w.firstYear === w.lastYear ? String(w.firstYear) : `${w.firstYear}-${w.lastYear}`,
      route: w.route,
      count: w.count,
      surnames: _kfTopCountsFromMap(w.surnames, 6),
      evidenceTypes: _kfTopCountsFromMap(w.kinds, 3),
      examples: w.examples,
    }));

  return {
    ok: true,
    scope: {
      selectedTrees: selectedSources.map(s => s.name),
      treeCount: selectedSources.length,
    },
    totals: {
      signals: signals.length,
      waves: byWave.size,
    },
    waves,
    importantSurnames: _kfTopCountsFromMap(surnameCounts, 12),
    commonRoutes: _kfTopCountsFromMap(routeCounts, 12),
    titleMarkedPeople: titleMarked.slice(0, 25),
    notes: [
      "Signals include explicit immigration/emigration records and inferred cross-country transitions between consecutive placed events.",
      "Title-marked people are candidates for historical significance because the source name includes a title or role; do not claim external fame without corroboration.",
    ],
  };
}

function _kfCollectSurnameMigrationDistances(opts = {}) {
  const data = _kfSelectedGenealogyFacts(opts);
  const moves = _kfMoveRowsFromFacts(data, { minMiles: 50 });
  const bySurname = new Map();
  for (const m of moves) {
    let row = bySurname.get(m.surname);
    if (!row) {
      row = { surname: m.surname, moveCount: 0, totalMiles: 0, maxMiles: 0, people: new Set(), examples: [] };
      bySurname.set(m.surname, row);
    }
    row.moveCount++;
    row.totalMiles += m.miles;
    row.maxMiles = Math.max(row.maxMiles, m.miles);
    row.people.add(`${m.tree}:${m.person}`);
    if (row.examples.length < 5) row.examples.push(m);
  }
  const surnames = [...bySurname.values()]
    .map(row => ({
      surname: row.surname,
      people: row.people.size,
      moveCount: row.moveCount,
      totalMiles: Math.round(row.totalMiles),
      maxMiles: Math.round(row.maxMiles),
      examples: row.examples.map(m => ({ person: m.person, years: `${m.fromYear}-${m.toYear}`, from: m.from, to: m.to, miles: Math.round(m.miles), tree: m.tree })),
    }))
    .sort((a, b) => b.totalMiles - a.totalMiles || b.maxMiles - a.maxMiles || a.surname.localeCompare(b.surname))
    .slice(0, Math.max(5, Math.min(30, parseInt(opts?.limit, 10) || 12)));
  return { ok: true, scope: { selectedTrees: data.sources }, totals: { moves: moves.length }, surnames };
}

function _kfCollectUrbanizationShift(opts = {}) {
  const data = _kfSelectedGenealogyFacts(opts);
  const buckets = new Map();
  for (const fact of data.facts) {
    if (!fact.geoLevel) continue;
    const decade = Math.floor(fact.year / 10) * 10;
    let bucket = buckets.get(decade);
    if (!bucket) {
      bucket = { decade, events: 0, city: 0, broader: 0, surnames: new Map(), examples: [] };
      buckets.set(decade, bucket);
    }
    bucket.events++;
    if (fact.geoLevel === "city") bucket.city++;
    else bucket.broader++;
    _kfAddCount(bucket.surnames, fact.surname);
    if (bucket.examples.length < 5) bucket.examples.push({ person: fact.name, year: fact.year, place: fact.normalizedPlace, tree: fact.tree });
  }
  const series = [...buckets.values()]
    .filter(b => b.events >= 3)
    .sort((a, b) => a.decade - b.decade)
    .map(b => ({
      decade: b.decade,
      events: b.events,
      cityEvents: b.city,
      cityShare: Math.round((b.city / Math.max(1, b.events)) * 100),
      topSurnames: _kfTopCountsFromMap(b.surnames, 5),
      examples: b.examples,
    }));
  const transitions = [];
  for (let i = 1; i < series.length; i++) {
    transitions.push({
      fromDecade: series[i - 1].decade,
      toDecade: series[i].decade,
      cityShareChange: series[i].cityShare - series[i - 1].cityShare,
      fromCityShare: series[i - 1].cityShare,
      toCityShare: series[i].cityShare,
    });
  }
  transitions.sort((a, b) => b.cityShareChange - a.cityShareChange);
  return {
    ok: true,
    scope: { selectedTrees: data.sources },
    series: series.slice(-20),
    biggestShifts: transitions.filter(t => t.cityShareChange > 0).slice(0, Math.max(3, Math.min(10, parseInt(opts?.limit, 10) || 6))),
    notes: ["City share means records geocoded to a named city rather than only a county, state, province, or country."],
  };
}

function _kfCollectFamilyCrossroads(opts = {}) {
  const data = _kfSelectedGenealogyFacts(opts);
  const byPlace = new Map();
  for (const fact of data.facts) {
    const place = fact.normalizedPlace || fact.place;
    if (!place) continue;
    let row = byPlace.get(place);
    if (!row) {
      row = { place, people: new Set(), surnames: new Map(), firstYear: fact.year, lastYear: fact.year, events: 0, examples: [] };
      byPlace.set(place, row);
    }
    row.events++;
    row.people.add(fact.key);
    _kfAddCount(row.surnames, fact.surname);
    row.firstYear = Math.min(row.firstYear, fact.year);
    row.lastYear = Math.max(row.lastYear, fact.year);
    if (row.examples.length < 6) row.examples.push({ person: fact.name, year: fact.year, event: fact.event, tree: fact.tree });
  }
  const crossroads = [...byPlace.values()]
    .map(row => ({
      place: row.place,
      people: row.people.size,
      events: row.events,
      yearRange: row.firstYear === row.lastYear ? String(row.firstYear) : `${row.firstYear}-${row.lastYear}`,
      surnameCount: row.surnames.size,
      topSurnames: _kfTopCountsFromMap(row.surnames, 8),
      examples: row.examples,
      score: row.people + row.surnames.size * 2 + Math.min(8, Math.floor((row.lastYear - row.firstYear) / 25)),
    }))
    .filter(row => row.people >= 2 || row.surnameCount >= 2)
    .sort((a, b) => b.score - a.score || b.people - a.people || a.place.localeCompare(b.place))
    .slice(0, Math.max(5, Math.min(30, parseInt(opts?.limit, 10) || 12)))
    .map(({ score, ...row }) => row);
  return { ok: true, scope: { selectedTrees: data.sources }, crossroads };
}

function _kfCollectStableBranches(opts = {}) {
  const data = _kfSelectedGenealogyFacts(opts);
  const bySurname = new Map();
  for (const fact of data.facts) {
    if (!fact.region) continue;
    let row = bySurname.get(fact.surname);
    if (!row) {
      row = { surname: fact.surname, events: 0, people: new Set(), regions: new Map(), firstYear: fact.year, lastYear: fact.year, examples: [] };
      bySurname.set(fact.surname, row);
    }
    row.events++;
    row.people.add(fact.key);
    _kfAddCount(row.regions, fact.region);
    row.firstYear = Math.min(row.firstYear, fact.year);
    row.lastYear = Math.max(row.lastYear, fact.year);
    if (row.examples.length < 5) row.examples.push({ person: fact.name, year: fact.year, place: fact.normalizedPlace, tree: fact.tree });
  }
  const branches = [...bySurname.values()]
    .filter(row => row.events >= 5 && row.people.size >= 2)
    .map(row => {
      const top = _kfTopCountsFromMap(row.regions, 4);
      const dominant = top[0] || { name: "", count: 0 };
      return {
        surname: row.surname,
        people: row.people.size,
        events: row.events,
        dominantRegion: dominant.name,
        dominantShare: Math.round((dominant.count / Math.max(1, row.events)) * 100),
        yearRange: `${row.firstYear}-${row.lastYear}`,
        topRegions: top,
        examples: row.examples,
      };
    })
    .sort((a, b) => b.dominantShare - a.dominantShare || b.events - a.events || a.surname.localeCompare(b.surname))
    .slice(0, Math.max(5, Math.min(30, parseInt(opts?.limit, 10) || 12)));
  return { ok: true, scope: { selectedTrees: data.sources }, stableBranches: branches };
}

function _kfCollectCoMigratingFamilies(opts = {}) {
  const data = _kfSelectedGenealogyFacts(opts);
  const moves = _kfMoveRowsFromFacts(data, { minMiles: 50 });
  const groups = new Map();
  for (const m of moves) {
    const decade = Math.floor(m.toYear / 10) * 10;
    const route = `${m.fromRegion || m.fromCountry || "unknown"} -> ${m.toRegion || m.toCountry || "unknown"}`;
    const key = `${decade}|${route}`;
    let group = groups.get(key);
    if (!group) {
      group = { decade, route, moves: 0, people: new Set(), surnames: new Map(), examples: [] };
      groups.set(key, group);
    }
    group.moves++;
    group.people.add(`${m.tree}:${m.person}`);
    _kfAddCount(group.surnames, m.surname);
    if (group.examples.length < 8) group.examples.push({ person: m.person, surname: m.surname, years: `${m.fromYear}-${m.toYear}`, from: m.from, to: m.to, miles: Math.round(m.miles), tree: m.tree });
  }
  const coMoves = [...groups.values()]
    .filter(g => g.people.size >= 2 || g.surnames.size >= 2)
    .map(g => ({
      decade: g.decade,
      route: g.route,
      moves: g.moves,
      people: g.people.size,
      surnames: _kfTopCountsFromMap(g.surnames, 8),
      examples: g.examples,
    }))
    .sort((a, b) => b.people - a.people || b.moves - a.moves || a.decade - b.decade)
    .slice(0, Math.max(5, Math.min(30, parseInt(opts?.limit, 10) || 12)));
  return { ok: true, scope: { selectedTrees: data.sources }, coMigratingGroups: coMoves };
}

const _KF_HISTORY_WINDOWS = [
  { name: "slavery era in the United States", start: 1619, end: 1865 },
  { name: "American Revolution", start: 1775, end: 1783 },
  { name: "Civil War", start: 1861, end: 1865 },
  { name: "Reconstruction", start: 1865, end: 1877 },
  { name: "Great Migration", start: 1916, end: 1970 },
  { name: "Great Depression", start: 1929, end: 1939 },
  { name: "World War I", start: 1914, end: 1918 },
  { name: "World War II", start: 1939, end: 1945 },
  { name: "Civil Rights era", start: 1954, end: 1968 },
];

function _kfPersonKnownSpan(person, facts) {
  let start = Number.isFinite(person.birth) ? person.birth : Infinity;
  let end = Number.isFinite(person.death) ? person.death : -Infinity;
  for (const fact of facts || []) {
    start = Math.min(start, fact.year);
    end = Math.max(end, fact.year);
  }
  if (start === Infinity || end === -Infinity) return null;
  if (end < start) end = start;
  return { start, end };
}

function _kfCollectHistoricalOverlaps(opts = {}) {
  const data = _kfSelectedGenealogyFacts(opts);
  const rows = [];
  const personByKey = new Map(data.persons.map(p => [p.key, p]));
  for (const [key, facts] of data.factsByPerson.entries()) {
    const person = personByKey.get(key);
    if (!person) continue;
    const span = _kfPersonKnownSpan(person, facts);
    if (!span) continue;
    for (const w of _KF_HISTORY_WINDOWS) {
      if (span.start <= w.end && span.end >= w.start) {
        rows.push({
          period: w.name,
          years: `${w.start}-${w.end}`,
          person: person.name,
          surname: person.surname,
          birth: person.birth,
          death: person.death,
          tree: person.tree,
          knownSpan: `${span.start}-${span.end}`,
          examplePlace: facts.find(f => f.year >= w.start && f.year <= w.end)?.normalizedPlace || facts[0]?.normalizedPlace || null,
        });
      }
    }
  }
  const byPeriod = new Map();
  for (const row of rows) {
    let p = byPeriod.get(row.period);
    if (!p) {
      p = { period: row.period, years: row.years, people: 0, surnames: new Map(), examples: [] };
      byPeriod.set(row.period, p);
    }
    p.people++;
    _kfAddCount(p.surnames, row.surname);
    if (p.examples.length < 8) p.examples.push(row);
  }
  const periods = [...byPeriod.values()]
    .map(p => ({ period: p.period, years: p.years, people: p.people, topSurnames: _kfTopCountsFromMap(p.surnames, 8), examples: p.examples }))
    .sort((a, b) => b.people - a.people || a.period.localeCompare(b.period))
    .slice(0, Math.max(5, Math.min(20, parseInt(opts?.limit, 10) || 9)));
  return {
    ok: true,
    scope: { selectedTrees: data.sources },
    periods,
    notes: ["Overlap means the person's known life or record span intersects the historical period; it does not prove direct participation."],
  };
}

function _kfCollectDistantBranchMarriages(opts = {}) {
  const data = _kfSelectedGenealogyFacts(opts);
  const factsByPerson = data.factsByPerson;
  const personByKey = new Map(data.persons.map(p => [p.key, p]));
  const rows = [];
  for (const fam of data.families) {
    const a = fam.husbKey ? personByKey.get(fam.husbKey) : null;
    const b = fam.wifeKey ? personByKey.get(fam.wifeKey) : null;
    if (!a || !b) continue;
    const aEvent = (factsByPerson.get(fam.husbKey) || []).find(f => f.lat != null && f.lon != null);
    const bEvent = (factsByPerson.get(fam.wifeKey) || []).find(f => f.lat != null && f.lon != null);
    if (!aEvent || !bEvent) continue;
    const miles = _kfHaversineMiles(aEvent.lat, aEvent.lon, bEvent.lat, bEvent.lon);
    if (miles < 100 && aEvent.country === bEvent.country) continue;
    rows.push({
      tree: fam.tree,
      spouseA: { name: a.name, birth: a.birth, death: a.death },
      spouseB: { name: b.name, birth: b.birth, death: b.death },
      surnameA: a.surname,
      surnameB: b.surname,
      placeA: aEvent.normalizedPlace || aEvent.place,
      placeB: bEvent.normalizedPlace || bEvent.place,
      yearA: aEvent.year,
      yearB: bEvent.year,
      miles: Math.round(miles),
      countryA: aEvent.country,
      countryB: bEvent.country,
    });
  }
  rows.sort((a, b) => b.miles - a.miles || a.spouseA.name.localeCompare(b.spouseA.name));
  return { ok: true, distantMarriages: rows.slice(0, Math.max(5, Math.min(30, parseInt(opts?.limit, 10) || 12))) };
}

function _kfParentsFromAnalysisFamilies(families) {
  const parents = new Map();
  for (const fam of families || []) {
    for (const child of (fam.childKeys || [])) parents.set(child, [fam.husbKey || null, fam.wifeKey || null]);
  }
  return parents;
}

function _kfCollectDeepestAncestryBranches(opts = {}) {
  const data = _kfSelectedGenealogyFacts(opts);
  const rows = [];
  const byKey = new Map(data.persons.map(p => [p.key, p]));
  const parents = _kfParentsFromAnalysisFamilies(data.families);
  for (const sourceName of data.sources) {
    const memo = new Map();
    const depthFor = (id, seen = new Set()) => {
      if (!id || seen.has(id)) return 0;
      if (memo.has(id)) return memo.get(id);
      seen.add(id);
      const ps = parents.get(id) || [];
      let best = 0;
      for (const p of ps) if (p && byKey.has(p)) best = Math.max(best, 1 + depthFor(p, seen));
      seen.delete(id);
      memo.set(id, best);
      return best;
    };
    for (const person of data.persons.filter(p => p.tree === sourceName)) {
      const depth = depthFor(person.key);
      if (depth <= 0) continue;
      rows.push({ tree: person.tree, person: person.name, birth: person.birth, death: person.death, surname: person.surname, generations: depth });
    }
  }
  const deepestPeople = rows
    .sort((a, b) => b.generations - a.generations || (a.birth ?? 9999) - (b.birth ?? 9999) || a.person.localeCompare(b.person))
    .slice(0, Math.max(5, Math.min(30, parseInt(opts?.limit, 10) || 12)));
  const bySurname = new Map();
  for (const row of rows) {
    let cur = bySurname.get(row.surname);
    if (!cur || row.generations > cur.maxGenerations) {
      cur = { surname: row.surname, maxGenerations: row.generations, example: row };
      bySurname.set(row.surname, cur);
    }
  }
  const branches = [...bySurname.values()]
    .sort((a, b) => b.maxGenerations - a.maxGenerations || a.surname.localeCompare(b.surname))
    .slice(0, Math.max(5, Math.min(20, parseInt(opts?.limit, 10) || 12)));
  return { ok: true, deepestPeople, deepestBranches: branches };
}

function _kfCollectMigrationJumps(opts = {}) {
  const data = _kfSelectedGenealogyFacts(opts);
  const minMiles = Number(opts?.minMiles) || 100;
  const moves = _kfMoveRowsFromFacts(data, { minMiles });
  const jumps = moves
    .map(m => ({
      ...m,
      milesPerYear: m.yearsElapsed > 0 ? Math.round((m.miles / Math.max(1, m.yearsElapsed)) * 10) / 10 : null,
      ambiguity: m.yearsElapsed > 10 ? "large time gap between records" : "tight record sequence",
    }))
    .sort((a, b) => b.miles - a.miles || b.yearsElapsed - a.yearsElapsed)
    .slice(0, Math.max(5, Math.min(30, parseInt(opts?.limit, 10) || 15)));
  const summary = jumps.length
    ? `Found ${moves.length} location jumps of at least ${Math.round(minMiles)} miles in the selected trees. The largest returned jump is ${jumps[0].person}, ${jumps[0].fromRegion || jumps[0].from} to ${jumps[0].toRegion || jumps[0].to}, ${Math.round(jumps[0].miles)} miles over ${jumps[0].yearsElapsed} years.`
    : `I did not find consecutive placed records at least ${Math.round(minMiles)} miles apart in the selected trees.`;
  return { ok: true, summary, scope: { selectedTrees: data.sources }, totals: { candidateJumps: moves.length, returnedJumps: jumps.length, minMiles }, jumps };
}

function _kfSelectedGenealogyAnalysisPayload(opts = {}) {
  const data = _kfSelectedGenealogyFacts(opts);
  return {
    sources: data.sources,
    persons: data.persons,
    facts: data.facts,
    families: data.families,
    limit: data.limit,
  };
}

async function _kfRunGenealogyAnalysis(kind, opts, fallback) {
  if (!_kfLoadedSources.size) return _kfTreeDataLoadingError();
  if (typeof _kfRunAnalysisInWorker === "function" &&
      (typeof _kfAnalysisWorkerMayBeAvailable !== "function" || _kfAnalysisWorkerMayBeAvailable())) {
    try {
      const payload = _kfSelectedGenealogyAnalysisPayload(opts || {});
      const result = await _kfRunAnalysisInWorker(kind, payload, opts || {});
      if (result && !result.error) return result;
    } catch (e) {
      console.warn("[kf] analysis worker failed:", e?.message || e);
    }
  }
  const result = fallback(opts || {});
  return result && typeof result === "object" ? { ...result, computedIn: "main" } : result;
}

function _kfTreeDataLoadingError() {
  return { error: "tree data is still loading; the DEMO tree should load automatically" };
}

// Page-control API for Claude. Each method returns a small status object that
// is sent back to Claude as tool-call output. To invoke a method, Claude
// emits a single line in its response of the form:
//   <<KFCALL:methodName({"arg":"value"})>>
// The browser parses these lines, calls the corresponding method, strips the
// markers from the displayed text, and (if any results came back) follows up
// with a context message containing the results.
function _kfFindIndi(query) {
  if (!lastIndividuals) return null;
  if (query?.startsWith("@") && query.endsWith("@") && lastIndiById?.has(query)) return lastIndiById.get(query);
  const q = String(query || "").toLowerCase().trim();
  if (!q) return null;
  for (const ind of lastIndividuals) {
    if (String(ind.raw_id || "").toLowerCase() === q) return ind;
  }
  for (const ind of lastIndividuals) {
    if (ind.name && ind.name.toLowerCase() === q) return ind;
  }
  for (const ind of lastIndividuals) {
    if (ind.name && ind.name.toLowerCase().includes(q)) return ind;
  }
  return null;
}
function _kfLatestDwellOf(ind) {
  if (!ind || !lastIndiIdxById) return -1;
  const idx = lastIndiIdxById.get(ind.id);
  if (idx === undefined) return -1;
  const dwells = indiDwells.get(idx);
  if (!dwells || !dwells.length) return -1;
  let latest = dwells[0];
  for (const di of dwells) if (dwellY[di] > dwellY[latest]) latest = di;
  return latest;
}
// ---------- kfApi helpers ----------

function _kfAncestorsByGen(rootId, parentsOf, maxGen) {
  const out = new Map();
  out.set(rootId, 0);
  const queue = [[rootId, 0]];
  while (queue.length) {
    const [id, gen] = queue.shift();
    if (gen >= (maxGen ?? 99)) continue;
    const par = parentsOf.get(id);
    if (!par) continue;
    for (const pid of par) {
      if (!pid || out.has(pid)) continue;
      out.set(pid, gen + 1);
      queue.push([pid, gen + 1]);
    }
  }
  return out;
}

function _kfDescendantsByGen(rootId, childrenOf, maxGen) {
  const out = new Map();
  out.set(rootId, 0);
  const queue = [[rootId, 0]];
  while (queue.length) {
    const [id, gen] = queue.shift();
    if (gen >= (maxGen ?? 99)) continue;
    const ch = childrenOf.get(id);
    if (!ch) continue;
    for (const cid of ch) {
      if (!cid || out.has(cid)) continue;
      out.set(cid, gen + 1);
      queue.push([cid, gen + 1]);
    }
  }
  return out;
}

function _kfOrdinal(n) {
  if (n === 1) return "1st"; if (n === 2) return "2nd"; if (n === 3) return "3rd";
  return n + "th";
}

function _kfKinshipLabel(up, down) {
  if (up === 0 && down === 0) return "self";
  if (up === 0) {
    if (down === 1) return "child";
    if (down === 2) return "grandchild";
    return "great-".repeat(down - 2) + "grandchild";
  }
  if (down === 0) {
    if (up === 1) return "parent";
    if (up === 2) return "grandparent";
    return "great-".repeat(up - 2) + "grandparent";
  }
  if (up === 1 && down === 1) return "sibling";
  if (down === 1 && up >= 2) {
    // LCA's child = aunt/uncle of the other; up steps up beyond that = great-...
    const greats = up - 2;
    return (greats > 0 ? "great-".repeat(greats) + "grand-" : up === 2 ? "" : "grand-") + "aunt/uncle";
  }
  if (up === 1 && down >= 2) {
    const greats = down - 2;
    return (greats > 0 ? "great-".repeat(greats) + "grand-" : down === 2 ? "" : "grand-") + "niece/nephew";
  }
  const n = Math.min(up, down) - 1;
  const removed = Math.abs(up - down);
  let label = _kfOrdinal(n) + " cousin";
  if (removed === 1) label += " once removed";
  else if (removed === 2) label += " twice removed";
  else if (removed >= 3) label += ` ${removed} times removed`;
  return label;
}

function _kfPathThroughLca(idA, idB, parentsOf) {
  const ancA = _kfAncestorsByGen(idA, parentsOf, 99);
  const ancB = _kfAncestorsByGen(idB, parentsOf, 99);
  let bestLca = null, bestSum = Infinity, ga = 0, gb = 0;
  for (const [id, da] of ancA) {
    const db = ancB.get(id);
    if (db == null) continue;
    if (da + db < bestSum) { bestSum = da + db; ga = da; gb = db; bestLca = id; }
  }
  if (!bestLca) return null;
  // Build chain idA → ... → bestLca → ... → idB. Use BFS to walk up; choose any
  // parent that's on the ancestor chain.
  function walkUp(start, lca, parentsMap) {
    const chain = [start];
    let cur = start;
    while (cur !== lca) {
      const par = parentsMap.get(cur);
      if (!par) return null;
      const ancMap = _kfAncestorsByGen(start, parentsMap, 99);
      let next = null;
      for (const pid of par) {
        if (!pid) continue;
        // pid must be an ancestor of start AND an ancestor-or-self of lca
        if (_kfAncestorsByGen(pid, parentsMap, 99).has(lca)) { next = pid; break; }
      }
      if (!next) return null;
      chain.push(next);
      cur = next;
    }
    return chain;
  }
  const upChain = walkUp(idA, bestLca, parentsOf);
  const downChain = walkUp(idB, bestLca, parentsOf);
  if (!upChain || !downChain) return null;
  // splice: A → ...up → LCA → reversed(B → ...up to LCA, dropping LCA)
  return upChain.concat(downChain.slice(0, -1).reverse());
}

function _kfLatestDwellLatLon(ind) {
  const idx = lastIndiIdxById?.get(ind.id);
  if (idx == null) return null;
  const dwells = indiDwells.get(idx);
  if (!dwells || dwells.length === 0) return null;
  let latest = dwells[0];
  for (const di of dwells) if (dwellY[di] > dwellY[latest]) latest = di;
  return { lat: dwellLat[latest], lon: dwellLon[latest], year: dwellY[latest] };
}

function _kfApplySubtreeFilter(idsSet, label) {
  // Save original state once (don't double-save on re-apply).
  if (_kfSubtreeFilter == null) {
    _kfSubtreeFilter = { prevBlood: lastBloodSet, prevFilter: curFilter, label };
  } else {
    _kfSubtreeFilter.label = label;
  }
  lastBloodSet = idsSet;
  rebuildSideArrays();
  curFilter = "blood";
  $("filt").value = "blood";
  fxCtx.clearRect(0, 0, W, H);
}

function _kfClearSubtreeFilter() {
  if (!_kfSubtreeFilter) return false;
  lastBloodSet = _kfSubtreeFilter.prevBlood;
  curFilter = _kfSubtreeFilter.prevFilter;
  $("filt").value = curFilter;
  rebuildSideArrays();
  _kfSubtreeFilter = null;
  fxCtx.clearRect(0, 0, W, H);
  return true;
}

function _kfActionValue(input, keys) {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const key of keys) {
      if (input[key] != null) return input[key];
    }
  }
  return input;
}

function _kfNormalizeClusterMode(input) {
  const raw = _kfActionValue(input, ["mode", "clusterMode", "value", "label", "name"]);
  const text = String(raw ?? "").trim();
  const key = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const aliases = new Map([
    ["none", "none"],
    ["no clustering", "none"],
    ["individuals", "none"],
    ["individual dots", "none"],
    ["pie", "pie"],
    ["lineage", "pie"],
    ["lineage clusters", "pie"],
    ["lineage pies", "pie"],
    ["parents", "parents"],
    ["parent", "parents"],
    ["parent knowledge", "parents"],
    ["known parents", "parents"],
    ["gender", "gender"],
    ["sex", "gender"],
    ["gender breakdown", "gender"],
    ["tree", "tree"],
    ["trees", "tree"],
    ["source", "tree"],
    ["sources", "tree"],
    ["gedcom", "tree"],
    ["gedcom tree", "tree"],
    ["by gedcom tree", "tree"],
    ["state", "state"],
    ["states", "state"],
    ["by state", "state"],
    ["us state", "state"],
    ["us states", "state"],
    ["by us state", "state"],
    ["by us states", "state"],
    ["group", "group"],
    ["groups", "group"],
    ["ai group", "group"],
    ["ai groups", "group"],
    ["custom group", "group"],
    ["custom groups", "group"],
    ["claude group", "group"],
    ["claude groups", "group"],
    ["dispersion", "dispersion"],
    ["on zoom", "dispersion"],
    ["density", "dispersion"],
    ["aggregate", "dispersion"],
  ]);
  return aliases.get(key) || key;
}

function _kfMapTargetFromChatText(text) {
  const raw = String(text || "").trim();
  const patterns = [
    /^(?:show|select|find|open)\s+(.+?)\s+(?:on|in)\s+(?:the\s+)?map\.?$/i,
    /^center\s+(?:on\s+)?(.+?)\.?$/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (!m) continue;
    return String(m[1] || "").trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

function _kfTryFastMapChatCommand(text) {
  const target = _kfMapTargetFromChatText(text);
  if (!target || !window.kfApi) return null;
  const ind = _kfFindIndi(target);
  if (ind) {
    const selected = window.kfApi.selectPerson(target);
    if (selected?.error) return selected;
    const centered = window.kfApi.centerOn(target);
    return { ok: true, fast: true, action: "showOnMap", person: selected.person, dwellYear: selected.dwellYear, centered: !centered?.error };
  }
  const centered = window.kfApi.centerOn(target);
  return centered?.ok ? { ...centered, fast: true, action: "showOnMap" } : null;
}

window.kfApi = {
  setYear(year) {
    const y = Math.max(minYear, Math.min(maxYear, Number(year)));
    if (!Number.isFinite(y)) return { error: "year not a number" };
    pushHistory();
    curYear = y;
    range.value = y;
    if (playing) { playing = false; _kfSetPlayButtonLabel(); }
    if (typeof _kfRefreshViewChrome === "function") _kfRefreshViewChrome(true);
    return { ok: true, year: Math.floor(y) };
  },
  play() {
    if (typeof _kfSetPlayback === "function") _kfSetPlayback(true);
    else if (!playing) playBtn.click();
    return { ok: true, playing: true };
  },
  pause() {
    if (typeof _kfSetPlayback === "function") _kfSetPlayback(false, { clearStop: true });
    else if (playing) playBtn.click();
    return { ok: true, playing: false };
  },
  setRoot(query) {
    const ind = _kfFindIndi(query);
    if (!ind) return { error: "no person matched: " + query };
    pushHistory();
    applyRoot(ind.id);
    return { ok: true, root: { id: ind.id, name: ind.name } };
  },
  selectPerson(query) {
    const ind = _kfFindIndi(query);
    if (!ind) return { error: "no person matched: " + query };
    const di = _kfLatestDwellOf(ind);
    if (di < 0) return { error: "no recorded events for " + ind.name };
    pushHistory();
    highlightedDwell = di;
    highlightInferredYear = -1;
    highlightInferredSrcYear = -1;
    curYear = dwellY[di];
    range.value = curYear;
    if (playing) { playing = false; _kfSetPlayButtonLabel(); }
    if (typeof _kfShowPersonCard === "function") _kfShowPersonCard(di);
    if (typeof _kfRefreshViewChrome === "function") _kfRefreshViewChrome(true);
    return { ok: true, person: { id: ind.id, name: ind.name }, dwellYear: dwellY[di] };
  },
  centerOn(query) {
    // Try person first; fall back to a geocoded place string.
    const ind = _kfFindIndi(query);
    if (ind) {
      const di = _kfLatestDwellOf(ind);
      if (di < 0) return { error: "no recorded events for " + ind.name };
      pushHistory();
      centerOnGeo(dwellLon[di], dwellLat[di]);
      return { ok: true, person: { id: ind.id, name: ind.name } };
    }
    if (geocoder) {
      const g = geocoder(query);
      if (g && Number.isFinite(g.lat) && Number.isFinite(g.lon)) {
        pushHistory();
        centerOnGeo(g.lon, g.lat);
        return { ok: true, place: query, lat: g.lat, lon: g.lon, level: g.level };
      }
    }
    return { error: "no person or place matched: " + query };
  },
  setProjection(name) {
    // Only Natural Earth is supported now; this is a back-compat stub so old
    // chat transcripts that say <<KFCALL:setProjection("...")>> don't error.
    return { ok: true, projection: "natural", note: "only Natural Earth is available" };
  },
  setKinLines(n) {
    n = _kfActionValue(n, ["n", "count", "value", "lines"]);
    n = Math.max(0, Math.min(20, parseInt(n, 10) || 0));
    _kfSetKinLines(n);
    return { ok: true, kinLines: n };
  },
  setClusterMode(mode) {
    mode = _kfNormalizeClusterMode(mode);
    const valid = ["none", "pie", "parents", "gender", "tree", "state", "group", "dispersion"];
    if (!valid.includes(mode)) return { error: "valid modes: " + valid.join(", ") };
    if (mode === "group" && !(typeof _kfEnsureActiveGroupRuntime === "function" && _kfEnsureActiveGroupRuntime())) {
      return { error: "create or activate an AI group set before selecting AI group clustering" };
    }
    $("clusterMode").value = mode;
    $("clusterMode").dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, clusterMode: mode };
  },
  createGroupSet(input) {
    if (typeof _kfCreateGroupSet !== "function") return { error: "AI group sets are not ready" };
    return _kfCreateGroupSet(input);
  },
  activateGroupSet(input) {
    if (typeof _kfActivateGroupSet !== "function") return { error: "AI group sets are not ready" };
    return _kfActivateGroupSet(input);
  },
  listGroupSets() {
    if (typeof _kfListGroupSets !== "function") return { error: "AI group sets are not ready" };
    return _kfListGroupSets();
  },
  saveGroupSet(input) {
    if (typeof _kfSaveGroupSet !== "function") return { error: "AI group sets are not ready" };
    return _kfSaveGroupSet(input);
  },
  deleteGroupSet(input) {
    if (typeof _kfDeleteGroupSet !== "function") return { error: "AI group sets are not ready" };
    return _kfDeleteGroupSet(input);
  },
  showYearTour() {
    if (typeof _kfShowYearTour === "function") {
      _kfShowYearTour();
      return { ok: true, year: Math.floor(curYear) };
    }
    return { error: "year tour is not ready" };
  },
  showOutliers(limit = 8) {
    if (typeof _kfShowOutlierReport === "function") {
      _kfShowOutlierReport(parseInt(limit, 10) || 8);
      return { ok: true, year: Math.floor(curYear) };
    }
    return { error: "outlier report is not ready" };
  },

  // Lens API — Claude or the user can register custom SQL queries that
  // drive a map visualization. Three shapes (state | country | latlon).
  // The literal token __YEAR__ in the SQL is substituted with the current
  // playback year on every fetch — use it for time-varying lenses.
  async saveLens(input) {
    const obj = (typeof input === "object" && input) || {};
    const name = (obj.name || "").trim();
    const sql = (obj.sql || "").trim();
    const shape = obj.shape;
    const validShapes = ["state", "country", "latlon", "line", "arc"];
    if (!name) return { error: "name required" };
    if (!sql) return { error: "sql required" };
    if (!validShapes.includes(shape)) return { error: "shape must be one of " + validShapes.join(", ") };
    // Validate by running once.
    const probeSql = sql.replace(/__YEAR__/g, String(Math.floor(curYear)));
    try {
      let j = _kfBrowserDb ? queryBrowserDb(probeSql, 1000) : null;
      if (!j && (location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
        const proxy = await detectChatProxy();
        if (proxy) {
          const r = await fetch(proxy + "/sql", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: probeSql, limit: 1000 }),
          });
          j = await r.json();
        }
      }
      if (!j) return { error: "browser SQL database not ready; cannot validate sql" };
      if (!j || !j.ok) return { error: "sql rejected: " + (j && j.error || "unknown") };
      // Validate columns vs shape.
      const sample = (j.rows && j.rows[0]) || {};
      const haveCount = sample.count != null || sample.n != null;
      let shapeOk = false;
      if (shape === "state")   shapeOk = (sample.state != null || sample.geo_st != null) && haveCount;
      if (shape === "country") shapeOk = (sample.country != null || sample.geo_cc != null) && haveCount;
      if (shape === "latlon")  shapeOk = sample.lat != null && sample.lon != null && haveCount;
      if (shape === "line" || shape === "arc")
        shapeOk = sample.from_lat != null && sample.from_lon != null
              && sample.to_lat != null   && sample.to_lon != null;
      if (!shapeOk && j.rows && j.rows.length > 0) {
        return { error: `query result is missing required columns for shape "${shape}". For state: state/geo_st + count/n. For country: country/geo_cc + count/n. For latlon: lat + lon + count/n.` };
      }
    } catch (e) {
      return { error: "sql probe failed: " + (e.message || e) };
    }
    // Replace existing lens with the same name.
    _kfLenses = _kfLenses.filter(l => l.name !== name);
    _kfLenses.push({ name, sql, shape, label: obj.label || null, created_at: new Date().toISOString() });
    _kfPersistLenses();
    _kfRenderLensDropdown();
    return { ok: true, lens: name, total_lenses: _kfLenses.length };
  },
  deleteLens(name) {
    if (!name) return { error: "name required" };
    const before = _kfLenses.length;
    _kfLenses = _kfLenses.filter(l => l.name !== name);
    _kfPersistLenses();
    if (_kfActiveLens === name) {
      _kfActiveLens = null; _kfLensData = null;
      if (_kfDeckOverlay) updateDeckDwellLayer();
    }
    _kfRenderLensDropdown();
    return { ok: true, removed: before - _kfLenses.length };
  },
  listLenses() {
    return { ok: true, lenses: _kfLenses.map(l => ({ name: l.name, shape: l.shape, created_at: l.created_at })) };
  },
  async activateLens(name) {
    if (!name) {
      _kfActiveLens = null; _kfLensData = null; _kfLensCaption = null;
      _kfRenderLensCaption();
      $("lensSel").value = "";
      $("lensDelete").disabled = true;
      $("lensFork").disabled = true;
      if (_kfDeckOverlay) updateDeckDwellLayer();
      return { ok: true, active: null };
    }
    if (!_kfLenses.find(l => l.name === name)) return { error: "no lens named: " + name };
    _kfActiveLens = name;
    _kfLensCacheKey = "";
    _kfLensCaption = null;
    _kfRenderLensCaption();
    $("lensSel").value = name;
    $("lensDelete").disabled = false;
    $("lensFork").disabled = false;
    await _kfFetchLensData();
    return { ok: true, active: name };
  },
  // Set a one-line caption for the currently-active lens. Renders below the
  // dropdown until the lens changes. Use after activating a lens to explain
  // what the user is looking at — e.g., "Florida lights up around 1920 as the
  // family migrates south".
  setLensCaption(text) {
    _kfLensCaption = (typeof text === "string" && text.trim()) ? text.trim() : null;
    _kfRenderLensCaption();
    return { ok: true };
  },
  // Render a non-map visualization in the sandboxed viz tab.
  // type: "svg" | "html" | "markdown" | "vega" | "mermaid" | "dot"
  // spec: SVG string, HTML string, markdown text, Vega-Lite JSON object,
  //       Mermaid DSL string, or DOT string respectively.
  // title: short label for the tab strip.
  showViz(input) {
    const obj = (typeof input === "object" && input) || {};
    const type = (obj.type || "").toLowerCase();
    if (!VIZ_TYPES.has(type)) {
      return { error: "type must be one of: " + Array.from(VIZ_TYPES).join(", ") };
    }
    if (obj.spec == null) return { error: "spec is required" };
    const id = ++_kfVizSeq;
    const v = {
      id,
      type,
      title: (obj.title && String(obj.title).trim()) || `${type} ${id}`,
      spec: obj.spec,
    };
    _kfVizList.push(v);
    while (_kfVizList.length > VIZ_MAX) _kfVizList.shift();
    _kfRenderViz(id);
    return { ok: true, id, type: v.type, title: v.title };
  },
  // Switch to an existing viz by id, or close the pane (id=null/0).
  showVizById(id) {
    if (!id) { _kfShowVizPane(false); return { ok: true, closed: true }; }
    const v = _kfVizList.find(x => x.id === Number(id));
    if (!v) return { error: "no viz with id " + id };
    _kfRenderViz(v.id);
    return { ok: true, id: v.id };
  },
  // List currently-rendered visualizations.
  listViz() {
    return { ok: true, viz: _kfVizList.map(v => ({ id: v.id, type: v.type, title: v.title })) };
  },
  setWindow(years) {
    // No-op stub — person markers stay visible for the entire lifespan now.
    return { ok: true, note: "window slider was removed; markers persist for each person's lifetime" };
  },
  setStatusFilter(_filter) {
    return { ok: true, note: "status filter was removed; person markers always represent people alive at the current year" };
  },
  setShowFilter(filter) {
    const valid = ["all", "blood", "ancestors"];
    if (!valid.includes(filter)) return { error: "valid: " + valid.join(", ") };
    $("filt").value = filter;
    $("filt").dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, show: filter };
  },
  // Submit a message to Claude on behalf of the user. Used by KFCHIP chips
  // so suggestion buttons trigger a real chat turn rather than a kfApi call.
  async sendChat(input) {
    const text = (typeof input === "string" ? input : input && input.text) || "";
    const displayText = (typeof input === "object" && input && input.displayText) ||
      (typeof _kfDisplayAiSuggestionQuestion === "function" ? _kfDisplayAiSuggestionQuestion(text) : text);
    if (!text) return { error: "text required" };
    const fast = _kfTryFastMapChatCommand(displayText);
    if (fast) return fast;
    if (typeof _kfAskQuestion === "function") {
      await _kfAskQuestion(String(text), { displayText: displayText || text });
      return { ok: true };
    }
    return { error: "chat not ready" };
  },
  back() { backOneStep(); return { ok: true }; },
  setZoom(k) {
    // MapLibre zoom levels are log2-based: zoom=0 is whole world, zoom=20+ is
    // city block. Old kfApi.setZoom took a linear "k" with 1=world, 64=city.
    // Translate: maplibre_zoom = log2(k) (so old 1 → 0, 64 → 6).
    const target = Math.max(1, Math.min(64, Number(k) || 1));
    pushHistory();
    if (_kfMap) {
      const mlZoom = Math.log2(target);
      _kfMap.easeTo({ zoom: mlZoom, duration: 300 });
    }
    return { ok: true, zoom: target };
  },
  zoomIn(factor) {
    const f = Math.max(1.1, Number(factor) || 2);
    if (_kfMap) {
      const cur = Math.pow(2, _kfMap.getZoom());
      return this.setZoom(cur * f);
    }
    return { error: "map not ready" };
  },
  zoomOut(factor) {
    const f = Math.max(1.1, Number(factor) || 2);
    if (_kfMap) {
      const cur = Math.pow(2, _kfMap.getZoom());
      return this.setZoom(cur / f);
    }
    return { error: "map not ready" };
  },
  getState() {
    const visible = typeof _kfVisibleMarkerData === "function" ? _kfVisibleMarkerData() : null;
    const viewportVisible = visible && typeof _kfVisibleMarkerViewportCount === "function"
      ? _kfVisibleMarkerViewportCount(visible.rows)
      : visible?.count || 0;
    return {
      ok: true,
      year: Math.floor(curYear),
      loop: _kfPlaybackLoopBounds(),
      window: dwellWindow,
      root: lastRootId ? { id: lastRootId, name: lastIndiById?.get(lastRootId)?.name } : null,
      selected: highlightedDwell >= 0 && lastIndividuals
        ? { name: lastIndividuals[dwellIndi[highlightedDwell]]?.name, year: dwellY[highlightedDwell] }
        : null,
      projection: projectionName,
      kinLines: kinLinesN,
      clusterMode,
      total: lastIndividuals?.length || 0,
      visiblePeople: visible?.count || 0,
      visiblePeopleInViewport: viewportVisible,
    };
  },
  findPerson(query) {
    const ind = _kfFindIndi(query);
    if (!ind) return { found: false };
    return { found: true, id: ind.id, name: ind.name, birth: ind.birth_year, death: ind.death_year };
  },
  // ---- v1.5 controls (multi-source switch, lineage, pins, branch filter,
  //                      structured timeline, kinship label, screenshot) ----

  setActiveTree(name) {
    if (!name || typeof name !== "string") return { error: "name required" };
    let target = _kfLoadedSources.has(name) || _kfTreeCache.has(name) ? name : null;
    if (!target) {
      const lower = name.toLowerCase();
      for (const k of _kfLoadedSources.keys()) if (k.toLowerCase().includes(lower)) { target = k; break; }
      if (!target) {
        for (const k of _kfTreeCache.keys()) if (k.toLowerCase().includes(lower)) { target = k; break; }
      }
    }
    if (!target) return { error: `tree "${name}" not in browser memory; reload it from disk` };
    if (target === _kfActiveTreeName) {
      const src = _kfLoadedSources.get(target);
      if (src?.source_id && !_kfSelectedSourceIds.has(src.source_id)) {
        _kfSelectedSourceIds.add(src.source_id);
        _kfEnsureSelectedSources();
        _kfRefreshBrowserViews();
        _kfRebuildSelectedVisualization({ preserveYear: true, preferredSourceName: target, preferActiveRoot: true });
        renderSources(_kfGetLoadedSourcesList());
        return { ok: true, active: target, selected: true };
      }
      return { ok: true, active: target, unchanged: true };
    }
    if (_kfLoadedSources.has(target)) {
      _kfActiveTreeName = target;
      const src = _kfLoadedSources.get(target);
      if (src?.source_id) _kfSelectedSourceIds.add(src.source_id);
      _kfEnsureSelectedSources();
      _kfRefreshBrowserViews();
      _kfRebuildSelectedVisualization({
        preserveYear: true,
        preferredSourceName: target,
        preferActiveRoot: true,
        selectRoot: true,
        centerRoot: true,
      });
      renderSources(_kfGetLoadedSourcesList());
      return { ok: true, active: target };
    }
    const text = _kfTreeCache.get(target);
    const fake = new File([text], target + ".ged", { type: "text/plain" });
    _kfSkipNextProxyLoad = true;
    _kfSkipNextSeed = true;
    // Fire and forget: processFile is async but we return synchronously so
    // Claude can chain calls. The caller can verify via getState() if needed.
    processFile(fake).catch(e => console.warn("[kf] setActiveTree:", e?.message || e));
    return { ok: true, active: target };
  },

  traceLineage(fromQuery, toQuery, opts) {
    if (!lastIndividuals || !lastParentsOf) return _kfTreeDataLoadingError();
    const a = _kfFindIndi(fromQuery), b = _kfFindIndi(toQuery);
    if (!a) return { error: "no person matched: " + fromQuery };
    if (!b) return { error: "no person matched: " + toQuery };
    const chain = _kfPathThroughLca(a.id, b.id, lastParentsOf);
    if (!chain) return { error: `${a.name} and ${b.name} are not in the same family graph` };
    const points = [];
    const labels = [];
    for (const id of chain) {
      const ind = lastIndiById.get(id);
      const p = ind ? _kfLatestDwellLatLon(ind) : null;
      if (p) { points.push({ lat: p.lat, lon: p.lon }); labels.push(ind.name); }
    }
    if (points.length < 2) return { error: "not enough recorded locations along the path" };
    const color = opts?.color || [255, 196, 64];
    _kfOverlayPaths.push({ points, color, label: `${a.name} → ${b.name}` });
    _kfRefreshMapActionOverlays();
    return {
      ok: true,
      from: { id: a.id, name: a.name },
      to: { id: b.id, name: b.name },
      hops: chain.length - 1,
      via: chain.map(id => lastIndiById.get(id)?.name).filter(Boolean),
      relationship: (() => {
        const ancA = _kfAncestorsByGen(a.id, lastParentsOf, 99);
        const ancB = _kfAncestorsByGen(b.id, lastParentsOf, 99);
        let lca = null, ga = 0, gb = 0, best = Infinity;
        for (const [id, da] of ancA) { const db = ancB.get(id); if (db != null && da + db < best) { best = da + db; ga = da; gb = db; lca = id; } }
        return lca ? _kfKinshipLabel(ga, gb) : null;
      })(),
    };
  },

  clearLineage() {
    const n = _kfOverlayPaths.length;
    _kfOverlayPaths = [];
    _kfRefreshMapActionOverlays();
    return { ok: true, cleared: n };
  },

  addRoute(arg1, arg2, arg3) {
    // Accept ({points,label,color}) | ([place/person/{lat,lon}, ...], label?, color?)
    // | (from, to, label?). This gives Claude a direct geographic-route tool
    // instead of misusing genealogy lineage paths for migration routes.
    let rawPoints, label, color;
    if (arg1 && typeof arg1 === "object" && !Array.isArray(arg1) && Array.isArray(arg1.points)) {
      rawPoints = arg1.points;
      label = arg1.label;
      color = arg1.color;
    } else if (Array.isArray(arg1)) {
      rawPoints = arg1;
      label = arg2;
      color = arg3;
    } else {
      rawPoints = [arg1, arg2].filter(v => v != null && v !== "");
      label = arg3;
    }
    if (!Array.isArray(rawPoints) || rawPoints.length < 2) return { error: "route needs at least two points" };
    const points = [];
    const labels = [];
    for (const point of rawPoints) {
      const resolved = _kfRoutePointFromInput(point);
      if (resolved?.error) return resolved;
      points.push({ lat: resolved.lat, lon: resolved.lon, label: resolved.label || "" });
      if (resolved.label) labels.push(resolved.label);
    }
    const routeColor = Array.isArray(color) && color.length >= 3 ? color : [255, 140, 40];
    _kfOverlayPaths.push({ points, color: routeColor, label: label || labels.join(" → ") });
    _kfRefreshMapActionOverlays();
    return { ok: true, route: { points: points.length, label: label || labels.join(" → ") } };
  },

  addPin(arg1, arg2, arg3, arg4) {
    // Accept either (placeName) | (lat, lon, label?) | ({lat,lon,label,color})
    let lat, lon, label, color;
    if (typeof arg1 === "object" && arg1) {
      ({ lat, lon, label, color } = arg1);
    } else if (typeof arg1 === "string" && arg2 == null) {
      if (!geocoder) return { error: "geocoder not ready" };
      const g = geocoder(arg1);
      if (!g) return { error: "no place matched: " + arg1 };
      lat = g.lat; lon = g.lon; label = arg1;
    } else {
      lat = Number(arg1); lon = Number(arg2); label = arg3; color = arg4;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { error: "lat/lon required" };
    _kfOverlayPins.push({ lat, lon, label: label || "", color: color || null });
    _kfRefreshMapActionOverlays();
    return { ok: true, pin: { lat, lon, label }, total: _kfOverlayPins.length };
  },

  clearPins() {
    const n = _kfOverlayPins.length;
    _kfOverlayPins = [];
    _kfRefreshMapActionOverlays();
    return { ok: true, cleared: n };
  },

  setSpeed(secPerYear) {
    const v = Number(secPerYear);
    if (!Number.isFinite(v) || v <= 0) return { error: "secPerYear must be > 0" };
    // The select dictates speed. Snap to nearest available option, but also
    // override the live select.value so the tick uses the requested value.
    speedSel.value = String(v);
    if (speedSel.value !== String(v)) {
      // Browser rejected non-listed value — pick the closest option.
      const options = Array.from(speedSel.options).map(o => parseFloat(o.value));
      let best = options[0], bestD = Infinity;
      for (const opt of options) { const d = Math.abs(opt - v); if (d < bestD) { best = opt; bestD = d; } }
      speedSel.value = String(best);
    }
    return { ok: true, secPerYear: parseFloat(speedSel.value) };
  },

  setLoopBegin(year) {
    pushHistory();
    return _kfSetLoopBegin(year == null ? curYear : year);
  },

  setLoopEnd(year) {
    pushHistory();
    return _kfSetLoopEnd(year == null ? curYear : year);
  },

  setLoopRange(beginYear, endYear) {
    pushHistory();
    return _kfSetLoopRange(beginYear, endYear);
  },

  clearLoopRange() {
    pushHistory();
    return _kfClearLoopRange();
  },

  playRange(fromYear, toYear, secPerYear) {
    const yA = Math.max(minYear, Math.min(maxYear, Number(fromYear)));
    const yB = Math.max(minYear, Math.min(maxYear, Number(toYear)));
    if (!Number.isFinite(yA) || !Number.isFinite(yB) || yB <= yA) return { error: "invalid range; need toYear > fromYear within data range" };
    if (secPerYear) this.setSpeed(secPerYear);
    pushHistory();
    curYear = yA;
    range.value = yA;
    _kfPlayStopAt = yB;
    if (typeof _kfSetPlayback === "function") _kfSetPlayback(true);
    else if (!playing) playBtn.click();
    return { ok: true, from: yA, to: yB, secPerYear: parseFloat(speedSel.value) };
  },

  showAncestors(query, maxGen) {
    if (!lastParentsOf || !lastIndiById) return _kfTreeDataLoadingError();
    const ind = _kfFindIndi(query);
    if (!ind) return { error: "no person matched: " + query };
    const m = _kfAncestorsByGen(ind.id, lastParentsOf, Math.max(1, parseInt(maxGen, 10) || 6));
    const ids = new Set(m.keys());
    pushHistory();
    _kfApplySubtreeFilter(ids, `ancestors of ${ind.name}`);
    return { ok: true, person: { id: ind.id, name: ind.name }, count: ids.size };
  },

  showDescendants(query, maxGen) {
    if (!lastChildrenOf || !lastIndiById) return _kfTreeDataLoadingError();
    const ind = _kfFindIndi(query);
    if (!ind) return { error: "no person matched: " + query };
    const m = _kfDescendantsByGen(ind.id, lastChildrenOf, Math.max(1, parseInt(maxGen, 10) || 6));
    const ids = new Set(m.keys());
    pushHistory();
    _kfApplySubtreeFilter(ids, `descendants of ${ind.name}`);
    return { ok: true, person: { id: ind.id, name: ind.name }, count: ids.size };
  },

  clearSubtreeFilter() {
    return _kfClearSubtreeFilter() ? { ok: true } : { ok: true, unchanged: true };
  },

  getDwellsForPerson(query) {
    if (!lastIndividuals) return _kfTreeDataLoadingError();
    const ind = _kfFindIndi(query);
    if (!ind) return { error: "no person matched: " + query };
    const idx = lastIndiIdxById.get(ind.id);
    const dwells = indiDwells.get(idx) || [];
    const sorted = dwells.slice().sort((a, b) => dwellY[a] - dwellY[b]);
    return {
      ok: true,
      person: { id: ind.id, name: ind.name, birth: ind.birth_year, death: ind.death_year },
      dwells: sorted.map(di => ({
        year: dwellY[di],
        type: EVENT_TYPE_LABEL[dwellType[di]] || "event",
        place: dwellPlace[di] >= 0 ? placesList[dwellPlace[di]] : null,
        lat: dwellLat[di],
        lon: dwellLon[di],
        exact: dwellExact[di] === 1,
      })),
    };
  },

  getRelationship(queryA, queryB) {
    if (!lastParentsOf || !lastIndiById) return _kfTreeDataLoadingError();
    const a = _kfFindIndi(queryA), b = _kfFindIndi(queryB);
    if (!a) return { error: "no person matched: " + queryA };
    if (!b) return { error: "no person matched: " + queryB };
    if (a.id === b.id) return { ok: true, label: "self", same: true };
    const ancA = _kfAncestorsByGen(a.id, lastParentsOf, 99);
    const ancB = _kfAncestorsByGen(b.id, lastParentsOf, 99);
    let lca = null, ga = 0, gb = 0, best = Infinity;
    for (const [id, da] of ancA) {
      const db = ancB.get(id);
      if (db != null && da + db < best) { best = da + db; ga = da; gb = db; lca = id; }
    }
    if (!lca) return { ok: true, label: "no relation found via parent links", related: false };
    const lcaInd = lastIndiById.get(lca);
    return {
      ok: true,
      a: { id: a.id, name: a.name },
      b: { id: b.id, name: b.name },
      label: _kfKinshipLabel(ga, gb),
      lca: { id: lca, name: lcaInd?.name, generations_to_a: ga, generations_to_b: gb },
    };
  },

  capturePng() {
    // Composite every visible map canvas (MapLibre, deck.gl overlays, and
    // fxCanvas) into one offscreen canvas and return a base64 PNG.
    const out = document.createElement("canvas");
    out.width = W; out.height = H;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#cfe2ec";
    ctx.fillRect(0, 0, W, H);
    if (_kfMap) {
      try { _kfMap.triggerRepaint(); } catch (_) {}
    }
    const wrap = document.getElementById("mapWrap");
    const wrapRect = wrap?.getBoundingClientRect?.();
    const canvases = wrap
      ? Array.from(wrap.querySelectorAll("canvas"))
        .filter(c => {
          const cs = getComputedStyle(c);
          return cs.display !== "none" && cs.visibility !== "hidden" && c.width > 0 && c.height > 0;
        })
      : [fxCanvas].filter(Boolean);
    for (const canvas of canvases) {
      try {
        const rect = canvas.getBoundingClientRect();
        const x = wrapRect ? rect.left - wrapRect.left : 0;
        const y = wrapRect ? rect.top - wrapRect.top : 0;
        const w = rect.width || W;
        const h = rect.height || H;
        ctx.drawImage(canvas, x, y, w, h);
      } catch (_) {}
    }
    const dataUrl = out.toDataURL("image/png");
    return { ok: true, dataUrl, width: W, height: H, bytes: Math.round(dataUrl.length * 0.75) };
  },

  exportAiReport() {
    if (typeof _kfExportAiReport !== "function") return { error: "AI report export is not ready" };
    return _kfExportAiReport();
  },

  // ---- Genealogy data lookups (no map mutation; complement to show*) ----

  async getImmigrationWaves(opts) {
    return _kfRunGenealogyAnalysis("immigrationWaves", opts, _kfCollectImmigrationWaves);
  },

  async getSurnameMigrationDistances(opts) {
    return _kfRunGenealogyAnalysis("surnameMigrationDistances", opts, _kfCollectSurnameMigrationDistances);
  },

  async getUrbanizationShift(opts) {
    return _kfRunGenealogyAnalysis("urbanizationShift", opts, _kfCollectUrbanizationShift);
  },

  async getFamilyCrossroads(opts) {
    return _kfRunGenealogyAnalysis("familyCrossroads", opts, _kfCollectFamilyCrossroads);
  },

  async getStableBranches(opts) {
    return _kfRunGenealogyAnalysis("stableBranches", opts, _kfCollectStableBranches);
  },

  async getCoMigratingFamilies(opts) {
    return _kfRunGenealogyAnalysis("coMigratingFamilies", opts, _kfCollectCoMigratingFamilies);
  },

  async getHistoricalOverlaps(opts) {
    return _kfRunGenealogyAnalysis("historicalOverlaps", opts, _kfCollectHistoricalOverlaps);
  },

  async getDistantBranchMarriages(opts) {
    return _kfRunGenealogyAnalysis("distantBranchMarriages", opts, _kfCollectDistantBranchMarriages);
  },

  async getDeepestAncestryBranches(opts) {
    return _kfRunGenealogyAnalysis("deepestAncestryBranches", opts, _kfCollectDeepestAncestryBranches);
  },

  async getMigrationJumps(opts) {
    return _kfRunGenealogyAnalysis("migrationJumps", opts, _kfCollectMigrationJumps);
  },

  getFamily(query) {
    if (!lastIndividuals || !lastIndiById) return _kfTreeDataLoadingError();
    const ind = _kfFindIndi(query);
    if (!ind) return { error: "no person matched: " + query };
    const par = lastParentsOf?.get(ind.id) || [null, null];
    const fa = par[0] ? lastIndiById.get(par[0]) : null;
    const mo = par[1] ? lastIndiById.get(par[1]) : null;
    const lite = p => p && { id: p.id, name: p.name, birth: p.birth_year, death: p.death_year };
    const siblings = [];
    if (ind.famc && lastFamilies?.has(ind.famc)) {
      const fam = lastFamilies.get(ind.famc);
      for (const cid of (fam.chil || [])) {
        if (cid === ind.id) continue;
        const c = lastIndiById.get(cid);
        if (c) siblings.push(lite(c));
      }
    }
    const spouses = [], children = [];
    if (ind.fams && lastFamilies) {
      for (const fid of ind.fams) {
        const fam = lastFamilies.get(fid);
        if (!fam) continue;
        const spId = fam.husb === ind.id ? fam.wife : (fam.wife === ind.id ? fam.husb : null);
        if (spId) { const s = lastIndiById.get(spId); if (s) spouses.push(lite(s)); }
        for (const cid of (fam.chil || [])) {
          const c = lastIndiById.get(cid);
          if (c) children.push(lite(c));
        }
      }
    }
    return {
      ok: true,
      person: lite(ind),
      parents: { father: lite(fa), mother: lite(mo) },
      siblings, spouses, children,
    };
  },

  getAncestors(query, maxGen) {
    if (!lastParentsOf || !lastIndiById) return _kfTreeDataLoadingError();
    const ind = _kfFindIndi(query);
    if (!ind) return { error: "no person matched: " + query };
    const m = _kfAncestorsByGen(ind.id, lastParentsOf, parseInt(maxGen, 10) || 6);
    const list = [];
    for (const [id, gen] of m) {
      if (id === ind.id) continue;
      const i = lastIndiById.get(id);
      if (i) list.push({ id, name: i.name, birth: i.birth_year, death: i.death_year, generation: gen });
    }
    list.sort((a, b) => a.generation - b.generation || (a.birth ?? 0) - (b.birth ?? 0));
    return { ok: true, person: { id: ind.id, name: ind.name }, ancestors: list, total: list.length };
  },

  getDescendants(query, maxGen) {
    if (!lastChildrenOf || !lastIndiById) return _kfTreeDataLoadingError();
    const ind = _kfFindIndi(query);
    if (!ind) return { error: "no person matched: " + query };
    const m = _kfDescendantsByGen(ind.id, lastChildrenOf, parseInt(maxGen, 10) || 6);
    const list = [];
    for (const [id, gen] of m) {
      if (id === ind.id) continue;
      const i = lastIndiById.get(id);
      if (i) list.push({ id, name: i.name, birth: i.birth_year, death: i.death_year, generation: gen });
    }
    list.sort((a, b) => a.generation - b.generation || (a.birth ?? 0) - (b.birth ?? 0));
    return { ok: true, person: { id: ind.id, name: ind.name }, descendants: list, total: list.length };
  },

  getMigrations(query) {
    if (!lastIndividuals) return _kfTreeDataLoadingError();
    const ind = _kfFindIndi(query);
    if (!ind) return { error: "no person matched: " + query };
    const idx = lastIndiIdxById.get(ind.id);
    const dwells = (indiDwells.get(idx) || []).slice().sort((a, b) => dwellY[a] - dwellY[b]);
    const moves = [];
    for (let i = 1; i < dwells.length; i++) {
      const a = dwells[i - 1], b = dwells[i];
      if (Math.abs(dwellLat[a] - dwellLat[b]) < 0.01 && Math.abs(dwellLon[a] - dwellLon[b]) < 0.01) continue;
      moves.push({
        from: {
          year: dwellY[a],
          place: dwellPlace[a] >= 0 ? placesList[dwellPlace[a]] : null,
          lat: dwellLat[a], lon: dwellLon[a],
        },
        to: {
          year: dwellY[b],
          place: dwellPlace[b] >= 0 ? placesList[dwellPlace[b]] : null,
          lat: dwellLat[b], lon: dwellLon[b],
        },
        years_elapsed: dwellY[b] - dwellY[a],
        miles: Math.round(_kfHaversineMiles(dwellLat[a], dwellLon[a], dwellLat[b], dwellLon[b]) * 10) / 10,
      });
    }
    return {
      ok: true,
      person: { id: ind.id, name: ind.name, birth: ind.birth_year, death: ind.death_year },
      moves, count: moves.length,
    };
  },

  getContemporaries(query, year, opts) {
    if (!lastIndividuals) return _kfTreeDataLoadingError();
    const ind = _kfFindIndi(query);
    if (!ind) return { error: "no person matched: " + query };
    let y = year != null ? Number(year) : ind.birth_year;
    if (!Number.isFinite(y)) y = Math.floor(curYear);
    const radiusYears = (opts && Number.isFinite(opts.radiusYears)) ? opts.radiusYears : 0;
    const minY = y - radiusYears, maxY = y + radiusYears;
    const out = [];
    for (const other of lastIndividuals) {
      if (other.id === ind.id) continue;
      const by = other.birth_year, dy = other.death_year;
      if (by == null) continue;
      if (by > maxY) continue;
      const effDeath = dy != null ? dy : by + 90;
      if (effDeath < minY) continue;
      out.push({ id: other.id, name: other.name, birth: by, death: dy });
      if (out.length >= 200) break;
    }
    return { ok: true, person: { id: ind.id, name: ind.name }, year: y, radiusYears, contemporaries: out, total: out.length };
  },

  findPeople(criteria) {
    if (!_kfLoadedSources.size) return _kfTreeDataLoadingError();
    return _kfFindPeopleRows(criteria || {});
  },

  setHighlight(idsOrNames, opts) {
    if (!lastIndividuals) return _kfTreeDataLoadingError();
    if (!Array.isArray(idsOrNames)) return { error: "expected array of person ids or names" };
    const set = new Set(), resolved = [];
    for (const q of idsOrNames) {
      const ind = _kfFindIndi(q);
      if (ind) { set.add(ind.id); resolved.push({ id: ind.id, name: ind.name }); }
    }
    if (set.size === 0) return { error: "no people resolved" };
    _kfHighlightSet = set;
    if (opts && Array.isArray(opts.color) && opts.color.length === 3) _kfHighlightColor = opts.color.map(Number);
    fxCtx.clearRect(0, 0, W, H);
    return { ok: true, count: set.size, persons: resolved };
  },

  clearHighlight() {
    const had = _kfHighlightSet != null;
    _kfHighlightSet = null;
    fxCtx.clearRect(0, 0, W, H);
    return { ok: true, cleared: had };
  },

  // Run a sequence of kfApi calls in order. Each step is `{method, args}`,
  // with `args` matching what the method expects (a value or an array that
  // gets spread). Stops at the first step that returns `{error}` unless
  // `continueOnError: true` is set. Returns `{ok, results, executed}`.
  // Cannot recurse: chain inside chain is rejected.
  async chain(input) {
    let steps, continueOnError = false;
    if (Array.isArray(input)) {
      steps = input;
    } else if (input && typeof input === "object") {
      steps = input.steps;
      continueOnError = !!input.continueOnError;
    } else {
      return { error: "chain expects { steps: [...] } or [...]" };
    }
    if (!Array.isArray(steps)) return { error: "chain.steps must be an array of {method, args}" };
    const results = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step || typeof step.method !== "string") {
        results.push({ error: `step ${i}: must be {method, args}` });
        if (!continueOnError) break;
        continue;
      }
      if (step.method === "chain") {
        results.push({ error: `step ${i}: cannot nest chain` });
        if (!continueOnError) break;
        continue;
      }
      const fn = this[step.method];
      if (typeof fn !== "function") {
        results.push({ error: `step ${i}: unknown method "${step.method}"` });
        if (!continueOnError) break;
        continue;
      }
      try {
        let r = Array.isArray(step.args) ? fn.apply(this, step.args) : fn.call(this, step.args);
        if (r && typeof r.then === "function") r = await r;
        results.push(r);
        if (r && r.error && !continueOnError) break;
      } catch (e) {
        results.push({ error: e.message || String(e) });
        if (!continueOnError) break;
      }
    }
    return { ok: true, executed: results.length, results };
  },

  // Run a read-only SQL query against the loaded GEDCOM database. Returns
  // {ok, rows, truncated, totalRows}. Promise-based; the chat layer awaits
  // before sending the result back to Claude. Results capped at 200 rows.
  async sql(query) {
    // Browser DB is the primary path for all users on the hosted site.
    // Only fall through to the local proxy when running on localhost (dev).
    if (_kfBrowserDb) {
      return queryBrowserDb(query);
    }
    // Dev localhost: fall back to local proxy SQL endpoint if running
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
      const proxy = await detectChatProxy();
      if (proxy) {
        try {
          const r = await fetch(proxy + "/sql", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, limit: 200 }),
          });
          return await r.json();
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      }
    }
    // VIP fallback: D1 (browser DB not ready yet, e.g. sql.js still loading)
    if (_clerkToken && _kfSourceId != null) {
      try {
        const r = await fetch("/api/gedcom/query", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + _clerkToken },
          body: JSON.stringify({ sql: query }),
        });
        const data = await r.json();
        if (data.error) return { ok: false, error: data.error };
        return { ok: true, rows: data.rows, truncated: data.truncated, totalRows: data.total };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    }
    return { ok: false, error: "no GEDCOM loaded — drop a .ged file to enable SQL queries" };
  },
  // Submit a message to the chat programmatically (used by KFCHIP suggestion buttons)
  chat(input) {
    const text = (typeof input === "string" ? input : input && input.text) || "";
    const displayText = (typeof input === "object" && input && input.displayText) ||
      (typeof _kfDisplayAiSuggestionQuestion === "function" ? _kfDisplayAiSuggestionQuestion(text) : text);
    const fast = _kfTryFastMapChatCommand(displayText);
    if (fast) return fast;
    if (typeof _kfAskQuestion === "function" && text) {
      return _kfAskQuestion(String(text), { displayText: displayText || text }).then(() => ({ ok: true }));
    }
    return { ok: false, error: "chat not ready" };
  },
};
