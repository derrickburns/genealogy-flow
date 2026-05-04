// ---------- Derived UX/cache layer ----------
//
// These helpers keep explanatory UI cheap. Expensive-ish summaries are keyed
// by the state boundary that changes them: tree graph, focus person, visible
// marker set, or selected cluster membership.
const _kfDerivedCache = {
  treeFacts: null,
  visible: null,
  visibleByYear: new Map(),
  visibleByYearIndividuals: null,
  yearDigest: new Map(),
  yearDigestIndividuals: null,
  cluster: new Map(),
  clusterIndividuals: null,
  activeClusterLabel: "",
  activeDigestMode: "",
  lastChromeKey: "",
  lastDigestRenderKey: "",
};

function _kfNameShort(name) {
  return String(name || "?").replace(/\s+/g, " ").trim();
}

function _kfSourceSelectionKey() {
  const sources = typeof _kfSelectedVizSourceList === "function" ? _kfSelectedVizSourceList() : [];
  return sources.map(s => s.source_id || s.name).sort().join(",");
}

function _kfFilterKey() {
  const surn = _kfSurnameFilter ? Array.from(_kfSurnameFilter).sort().join(",") : "";
  return `${curFilter}|${_kfSexFilter || ""}|${surn}`;
}

function _kfEventLabelForDwell(di) {
  return EVENT_TYPE_LABEL[dwellType?.[di]] || "event";
}

function _kfDwellPlace(di) {
  return (dwellPlace && placesList && dwellPlace[di] >= 0) ? placesList[dwellPlace[di]] : "";
}

function _kfShortPlace(place, maxParts = 2) {
  const parts = String(place || "").split(",").map(s => s.trim()).filter(Boolean);
  return parts.slice(0, maxParts).join(", ") || "";
}

function _kfPlaceEvidence(place, exact = false) {
  if (!place) return { label: "no place", rank: 5, tone: "risk" };
  if (exact) return { label: "city exact", rank: 0, tone: "good" };
  const parts = String(place).split(",").map(s => s.trim()).filter(Boolean);
  if (parts.length >= 4) return { label: "city/county/state", rank: 1, tone: "good" };
  if (parts.length === 3) return { label: "partial place", rank: 2, tone: "info" };
  if (parts.length === 2) return { label: "state only", rank: 3, tone: "warn" };
  return { label: "vague place", rank: 4, tone: "warn" };
}

function _kfEventForDwell(di) {
  const idx = dwellIndi?.[di];
  const ind = idx >= 0 && lastIndividuals ? lastIndividuals[idx] : null;
  if (!ind) return null;
  return _kfTreeFacts().eventByDwell?.[di] || null;
}

function _kfEventDwellKey(year, place, typeCode = "") {
  return `${year}|${place || ""}|${typeCode}`;
}

function _kfYearsFromDateText(date) {
  const matches = String(date || "").match(/\b\d{3,4}\b/g) || [];
  return matches
    .map(v => parseInt(v, 10))
    .filter(y => Number.isFinite(y) && y >= 1000 && y <= 2100);
}

function _kfEventDateBounds(ev) {
  const date = String(ev?.date || "").trim();
  const upper = date.toUpperCase();
  const years = _kfYearsFromDateText(date);
  const fallbackStart = Number(ev?.year);
  const fallbackEnd = Number(ev?.year_end ?? ev?.year);
  if (!years.length && Number.isFinite(fallbackStart)) {
    return {
      earliest: fallbackStart,
      latest: Number.isFinite(fallbackEnd) ? fallbackEnd : fallbackStart,
      label: String(ev?.year ?? ""),
    };
  }
  if (!years.length) return { earliest: null, latest: null, label: "" };
  const first = years[0];
  const last = years[years.length - 1];
  if (/\bBEF(?:ORE)?\b/.test(upper)) return { earliest: null, latest: first, label: date || String(first) };
  if (/\bAFT(?:ER)?\b/.test(upper)) return { earliest: first, latest: null, label: date || String(first) };
  if (/\b(FROM|BET)\b/.test(upper) && years.length >= 2) return { earliest: first, latest: last, label: date || `${first}-${last}` };
  if (/\bTO\b/.test(upper) && !/\bFROM\b/.test(upper)) return { earliest: null, latest: last, label: date || String(last) };
  if (/\bFROM\b/.test(upper) && years.length === 1) return { earliest: first, latest: null, label: date || String(first) };
  if (/\b(ABT|ABOUT|EST|CAL|CIRCA|CA)\b/.test(upper)) return { earliest: first - 2, latest: first + 2, label: date || String(first) };
  if (years.length >= 2) return { earliest: first, latest: last, label: date || `${first}-${last}` };
  return { earliest: first, latest: first, label: date || String(first) };
}

function _kfDateBoundsFromEventOrYear(ev, year) {
  if (ev) return _kfEventDateBounds(ev);
  if (Number.isFinite(Number(year))) {
    const y = Number(year);
    return { earliest: y, latest: y, label: String(y) };
  }
  return { earliest: null, latest: null, label: "" };
}

function _kfTreeFacts() {
  if (_kfDerivedCache.treeFacts &&
      _kfDerivedCache.treeFacts.individuals === lastIndividuals &&
      _kfDerivedCache.treeFacts.dwellY === dwellY &&
      _kfDerivedCache.treeFacts.indiDwells === indiDwells) {
    return _kfDerivedCache.treeFacts;
  }

  const byId = new Map();
  const byIdx = [];
  const eventByDwell = [];
  if (!lastIndividuals) {
    _kfDerivedCache.treeFacts = { individuals: lastIndividuals, dwellY, indiDwells, byId, byIdx, eventByDwell };
    return _kfDerivedCache.treeFacts;
  }

  for (let idx = 0; idx < lastIndividuals.length; idx++) {
    const ind = lastIndividuals[idx];
    const issues = [];
    const events = (ind.events || [])
      .filter(ev => ev && Number.isFinite(Number(ev.year)))
      .slice()
      .sort((a, b) => Number(a.year) - Number(b.year));
    const birth = Number.isFinite(Number(ind.birth_year)) ? Number(ind.birth_year) : null;
    const death = Number.isFinite(Number(ind.death_year)) ? Number(ind.death_year) : null;
    const birthEv = events.find(ev => ev.type === "BIRT") || null;
    const deathEv = events.find(ev => ev.type === "DEAT") || null;
    const birthBounds = _kfDateBoundsFromEventOrYear(birthEv, birth);
    const deathBounds = _kfDateBoundsFromEventOrYear(deathEv, death);
    if (birthBounds.earliest != null && deathBounds.latest != null && birthBounds.earliest > deathBounds.latest + 1) {
      issues.push(`birth date is after recorded death (${birthBounds.label || birthBounds.earliest})`);
    }
    const seenPlaces = new Set();
    let vaguePlaces = 0;
    let rangedEvents = 0;
    const exactEventBuckets = new Map();
    const fallbackEventBuckets = new Map();
    for (const ev of events) {
      const y = Number(ev.year);
      const place = String(ev.place || "").trim();
      const typeCode = EVENT_TYPE_CODE[ev.type] ?? 10;
      const exactKey = _kfEventDwellKey(y, place, typeCode);
      const fallbackKey = _kfEventDwellKey(y, place, "");
      if (!exactEventBuckets.has(exactKey)) exactEventBuckets.set(exactKey, ev);
      if (!fallbackEventBuckets.has(fallbackKey)) fallbackEventBuckets.set(fallbackKey, ev);
      const eventLabel = _kfEventPlainLabel(ev.type, { noun: true });
      const bounds = _kfEventDateBounds(ev);
      if (ev.type !== "BIRT" && birthBounds.earliest != null && bounds.latest != null && bounds.latest < birthBounds.earliest - 1) {
        issues.push(`${eventLabel} is before recorded birth (${bounds.label || y})`);
      }
      if (ev.type !== "DEAT" && deathBounds.latest != null && bounds.earliest != null && bounds.earliest > deathBounds.latest + 1) {
        issues.push(`${eventLabel} is after recorded death (${bounds.label || y})`);
      }
      const yEnd = Number(ev.year_end ?? ev.year);
      if (Number.isFinite(yEnd) && yEnd - y > 10) {
        rangedEvents++;
        issues.push(`wide date range ${y}-${yEnd}`);
      }
      if (place) {
        seenPlaces.add(place);
        if (_kfPlaceEvidence(place, false).rank >= 3) vaguePlaces++;
      }
    }
    const dwellsForInd = indiDwells?.get(idx) || [];
    for (const di of dwellsForInd) {
      const y = dwellY?.[di];
      const place = _kfDwellPlace(di);
      const typeCode = dwellType?.[di] ?? "";
      eventByDwell[di] =
        exactEventBuckets.get(_kfEventDwellKey(y, place, typeCode)) ||
        fallbackEventBuckets.get(_kfEventDwellKey(y, place, "")) ||
        null;
    }
    const first = events[0] || null;
    const last = events[events.length - 1] || null;
    const facts = {
      ind,
      idx,
      events,
      issues: Array.from(new Set(issues)).slice(0, 8),
      vaguePlaces,
      rangedEvents,
      placeCount: seenPlaces.size,
      first,
      last,
      birthEv,
      deathEv,
    };
    byIdx[idx] = facts;
    byId.set(ind.id, facts);
  }

  _kfDerivedCache.treeFacts = { individuals: lastIndividuals, dwellY, indiDwells, byId, byIdx, eventByDwell };
  return _kfDerivedCache.treeFacts;
}

function _kfFactsForInd(ind) {
  if (!ind) return null;
  return _kfTreeFacts().byId.get(ind.id) || null;
}

function _kfBadgeHtml(label, tone = "") {
  return `<span class="ux-badge${tone ? " " + tone : ""}">${escHtml(label)}</span>`;
}

function _kfBadgesHtml(badges) {
  const html = badges.filter(Boolean).map(b => _kfBadgeHtml(b.label, b.tone)).join("");
  return html ? `<div class="ux-badges">${html}</div>` : "";
}

function _kfDwellEvidenceBadges(di) {
  const idx = dwellIndi?.[di];
  const ind = idx >= 0 && lastIndividuals ? lastIndividuals[idx] : null;
  const place = _kfDwellPlace(di);
  const ev = _kfEventForDwell(di);
  const placeEvidence = _kfPlaceEvidence(place, !!dwellExact?.[di]);
  const badges = [placeEvidence];
  if (ev && Number(ev.year_end ?? ev.year) > Number(ev.year)) {
    const gap = Number(ev.year_end ?? ev.year) - Number(ev.year);
    badges.push({ label: gap > 10 ? "wide date range" : "date range", tone: gap > 10 ? "warn" : "info" });
  }
  if (ind && ind.death_year == null && Number.isFinite(Number(ind.birth_year))) {
    badges.push({ label: _kfPersonMayBeAliveAtYear(ind, Math.floor(curYear)) ? "presumed living" : "past lifespan", tone: "info" });
  }
  if (ind && ind.death_year != null) badges.push({ label: "deceased", tone: "info" });
  return badges;
}

function _kfDwellEvidenceBadgesHtml(di) {
  if (!_kfShowDataQualityConcerns) return "";
  return _kfBadgesHtml(_kfDwellEvidenceBadges(di));
}

function _kfPersonIssuesHtml(ind, di = -1) {
  return "";
}

function _kfQuestionChipsHtml(questions) {
  const uniq = [];
  const seen = new Set();
  for (const q of questions) {
    const text = String(q || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    uniq.push(text);
  }
  if (!uniq.length) return "";
  return `<div class="ux-section"><h4>Useful questions</h4><div class="ux-question-row">` +
    uniq.slice(0, 5).map(q => `<button type="button" class="ux-question" data-question="${escHtml(q)}">${escHtml(q)}</button>`).join("") +
    `</div></div>`;
}

async function _kfAskQuestion(text, opts = {}) {
  const requestText = String(text || "").trim();
  if (!requestText) return { error: "text required" };
  const displayText = String(
    opts.displayText ||
    (typeof _kfDisplayAiSuggestionQuestion === "function" ? _kfDisplayAiSuggestionQuestion(requestText) : requestText)
  ).trim();
  if (typeof _kfIsSideTabActive === "function" && _kfIsSideTabActive("chat")) {
    if (typeof _kfBumpMobileSheetForTab === "function") _kfBumpMobileSheetForTab("chat");
  } else {
    _kfSetSideTab("chat");
  }
  if (_chatBusy) {
    chatInputEl.value = displayText || requestText;
    chatInputEl.focus();
    return { error: "Claude is already answering a question" };
  }
  chatHistory.push({ role: "user", content: displayText || requestText });
  renderChat();
  _chatBusy = true;
  chatSendBtn.disabled = true;
  chatSendBtn.textContent = "...";
  try {
    await runChatTurn(requestText);
    return { ok: true };
  }
  catch (err) {
    const message = err.message || String(err);
    appendError(message);
    return { error: message };
  }
  finally { _chatBusy = false; chatSendBtn.disabled = false; chatSendBtn.textContent = "Send"; }
}

function _kfBindQuestionChips(root) {
  if (!root) return;
  root.querySelectorAll(".ux-question[data-question]").forEach(btn => {
    const handler = () => {
      const text = btn.dataset.question || "";
      _kfAskQuestion(
        typeof _kfAugmentAiSuggestionQuestion === "function" ? _kfAugmentAiSuggestionQuestion(text) : text,
        { displayText: text }
      );
    };
    if (typeof _kfBindTapOrClick === "function") _kfBindTapOrClick(btn, handler);
    else btn.addEventListener("click", handler);
  });
}

function _kfVisibleMarkerData() {
  const y = Math.floor(curYear);
  const key = `${_kfSourceSelectionKey()}|${lastRootId || ""}|${y}|${_kfFilterKey()}|${colorMode}`;
  if (_kfDerivedCache.visible &&
      _kfDerivedCache.visible.key === key &&
      _kfDerivedCache.visible.individuals === lastIndividuals &&
      _kfDerivedCache.visible.personDwell === _kfPersonDwell) {
    return _kfDerivedCache.visible;
  }
  if (!timelineLoaded || !lastIndividuals) {
    _kfDerivedCache.visible = { key, individuals: lastIndividuals, personDwell: _kfPersonDwell, rows: [], count: 0 };
    return _kfDerivedCache.visible;
  }
  rebuildPersonMarkers();
  const rows = [];
  const sourceCounts = new Map();
  let exact = 0;
  let weak = 0;
  for (let m = 0; m < (_kfDwellCount || 0); m++) {
    const di = _kfPersonDwell[m];
    const idx = _kfPersonIndi[m];
    const ind = lastIndividuals[idx];
    if (!ind) continue;
    const source = _kfSourceNameForIndiIdx(idx);
    sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
    const place = _kfDwellPlace(di);
    const year = Number.isFinite(dwellY?.[di]) ? dwellY[di] : "";
    const eventLabel = _kfEventLabelForDwell(di);
    const level = dwellLevel ? dwellLevel[di] : (dwellExact?.[di] ? GEO_LEVEL_CITY : GEO_LEVEL_ADMIN1);
    const ev = _kfPlaceEvidence(place, !!dwellExact?.[di]);
    if (ev.rank <= 1) exact++;
    if (ev.rank >= 3) weak++;
    rows.push({ marker: m, di, idx, ind, source, place, year, eventLabel, evidence: ev, precision: _kfGeoLevelName(level), imprecise: _kfGeoIsImprecise(level) });
  }
  const data = { key, individuals: lastIndividuals, personDwell: _kfPersonDwell, rows, count: rows.length, sourceCounts, exact, weak };
  _kfDerivedCache.visible = data;
  return data;
}

function _kfVisibleMarkerViewportCount(rows = null) {
  const items = rows || (typeof _kfVisibleMarkerData === "function" ? _kfVisibleMarkerData().rows : []);
  const bounds = _kfMap && _kfMap.getBounds ? _kfMap.getBounds() : null;
  if (!bounds || !_kfDwellPositions || !items) return items?.length || 0;
  const bW = bounds.getWest(), bE = bounds.getEast();
  const bS = bounds.getSouth(), bN = bounds.getNorth();
  let count = 0;
  for (const row of items) {
    const m = row?.marker;
    if (!Number.isFinite(m) || m < 0) continue;
    const lon = _kfDwellPositions[m * 2];
    const lat = _kfDwellPositions[m * 2 + 1];
    if (lon >= bW && lon <= bE && lat >= bS && lat <= bN) count++;
  }
  return count;
}

function _kfVisibleRowsForYear(yint) {
  if (_kfDerivedCache.visibleByYearIndividuals !== lastIndividuals) {
    _kfDerivedCache.visibleByYear.clear();
    _kfDerivedCache.yearDigest.clear();
    _kfDerivedCache.visibleByYearIndividuals = lastIndividuals;
    _kfDerivedCache.yearDigestIndividuals = lastIndividuals;
  }
  const key = `${_kfSourceSelectionKey()}|${lastRootId || ""}|${yint}|${_kfFilterKey()}`;
  const cached = _kfDerivedCache.visibleByYear.get(key);
  if (cached) return cached;
  if (!timelineLoaded || !lastIndividuals || !indiDwells || !dwellY) {
    const empty = { key, y: yint, rows: [], count: 0, exact: 0, weak: 0, sourceCounts: new Map(), placeCounts: new Map() };
    _kfDerivedCache.visibleByYear.set(key, empty);
    return empty;
  }
  const rows = [];
  const sourceCounts = new Map();
  const placeCounts = new Map();
  let exact = 0;
  let weak = 0;
  for (let idx = 0; idx < lastIndividuals.length; idx++) {
    const ind = lastIndividuals[idx];
    if (!ind) continue;
    if (!_kfPersonMayBeAliveAtYear(ind, yint)) continue;
    if (curFilter === "ancestors" && !_kfIsDirectAncestorIndiIdx(idx)) continue;
    if (curFilter === "blood" && lastBloodSet && !lastBloodSet.has(ind.id)) continue;
    if (_kfSexFilter && ind.sex !== _kfSexFilter) continue;
    if (_kfSurnameFilter) {
      const sn = _kfSurnameOf(ind.name);
      if (!sn || !_kfSurnameFilter.has(sn)) continue;
    }
    const di = _kfLatestValidDwellForIndi(idx, yint);
    if (di < 0) continue;
    const source = _kfSourceNameForIndiIdx(idx);
    const place = _kfDwellPlace(di);
    const placeHead = _kfShortPlace(place, 1);
    const level = dwellLevel ? dwellLevel[di] : (dwellExact?.[di] ? GEO_LEVEL_CITY : GEO_LEVEL_ADMIN1);
    const evidence = _kfPlaceEvidence(place, !!dwellExact?.[di]);
    if (evidence.rank <= 1) exact++;
    if (evidence.rank >= 3) weak++;
    if (source) sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
    if (placeHead) placeCounts.set(placeHead, (placeCounts.get(placeHead) || 0) + 1);
    rows.push({
      marker: rows.length,
      di,
      idx,
      ind,
      source,
      place,
      placeShort: _kfShortPlace(place, 2),
      year: Number.isFinite(dwellY?.[di]) ? dwellY[di] : "",
      eventLabel: _kfEventLabelForDwell(di),
      evidence,
      precision: _kfGeoLevelName(level),
      imprecise: _kfGeoIsImprecise(level),
    });
  }
  const data = { key, y: yint, rows, count: rows.length, exact, weak, sourceCounts, placeCounts };
  _kfTrimDerivedCache(_kfDerivedCache.visibleByYear, _kfDerivedCacheLimit());
  _kfDerivedCache.visibleByYear.set(key, data);
  return data;
}

function _kfDerivedCacheLimit() {
  return (typeof _kfIsMobileLayout === "function" && _kfIsMobileLayout()) ? 24 : 80;
}

function _kfTrimDerivedCache(cache, limit) {
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function _kfYearDigestPersonLabel(row) {
  if (!row) return "";
  const name = _kfNameShort(row.ind?.name);
  const place = row.placeShort || _kfShortPlace(row.place, 2);
  return place ? `${name} (${place})` : name;
}

function _kfYearDigestData(yint) {
  if (_kfDerivedCache.yearDigestIndividuals !== lastIndividuals) {
    _kfDerivedCache.yearDigest.clear();
    _kfDerivedCache.yearDigestIndividuals = lastIndividuals;
  }
  const key = `${_kfSourceSelectionKey()}|${lastRootId || ""}|${yint}|${_kfFilterKey()}`;
  const cached = _kfDerivedCache.yearDigest.get(key);
  if (cached) return cached;
  const current = _kfVisibleRowsForYear(yint);
  const previous = _kfVisibleRowsForYear(yint - 1);
  const currentById = new Map(current.rows.map(r => [r.ind.id, r]));
  const previousById = new Map(previous.rows.map(r => [r.ind.id, r]));
  const appeared = [];
  const disappeared = [];
  const moved = [];
  const weak = [];
  const issues = [];
  for (const row of current.rows) {
    const prev = previousById.get(row.ind.id);
    if (!prev) appeared.push(row);
    else if (prev.di !== row.di && prev.place !== row.place) moved.push({ row, prev });
    if (row.evidence.rank >= 3) weak.push(row);
    const facts = _kfFactsForInd(row.ind);
    if (facts?.issues.length) issues.push({ row, issue: facts.issues[0] });
  }
  for (const row of previous.rows) {
    if (!currentById.has(row.ind.id)) disappeared.push(row);
  }
  appeared.sort((a, b) => Math.abs((a.ind.birth_year ?? yint) - yint) - Math.abs((b.ind.birth_year ?? yint) - yint) || _kfNameShort(a.ind.name).localeCompare(_kfNameShort(b.ind.name)));
  disappeared.sort((a, b) => Math.abs((a.ind.death_year ?? yint) - (yint - 1)) - Math.abs((b.ind.death_year ?? yint) - (yint - 1)) || _kfNameShort(a.ind.name).localeCompare(_kfNameShort(b.ind.name)));
  moved.sort((a, b) => Math.abs((a.row.year || yint) - yint) - Math.abs((b.row.year || yint) - yint) || _kfNameShort(a.row.ind.name).localeCompare(_kfNameShort(b.row.ind.name)));
  weak.sort((a, b) => b.evidence.rank - a.evidence.rank || _kfNameShort(a.ind.name).localeCompare(_kfNameShort(b.ind.name)));
  const topPlaces = Array.from(current.placeCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const data = { key, y: yint, current, previous, appeared, disappeared, moved, weak, issues, topPlaces };
  _kfTrimDerivedCache(_kfDerivedCache.yearDigest, _kfDerivedCacheLimit());
  _kfDerivedCache.yearDigest.set(key, data);
  return data;
}

function _kfYearDigestMetricHtml(value, label) {
  return `<div class="year-digest-metric"><span class="year-digest-num">${escHtml(value)}</span><span class="year-digest-label">${escHtml(label)}</span></div>`;
}

function _kfYearDigestHtml() {
  const y = Math.floor(curYear);
  const d = _kfYearDigestData(y);
  const lines = [];
  if (d.moved.length) {
    const examples = d.moved.slice(0, 2).map(m => `${_kfNameShort(m.row.ind.name)}: ${m.prev.placeShort || _kfShortPlace(m.prev.place, 2) || "unknown"} -> ${m.row.placeShort || _kfShortPlace(m.row.place, 2) || "unknown"}`);
    lines.push(`Location updates: ${examples.join("; ")}.`);
  }
  if (d.appeared.length) {
    const examples = d.appeared.slice(0, 2).map(r => {
      const born = r.ind.birth_year === y ? "born" : "first shown";
      return `${_kfNameShort(r.ind.name)} ${born}${r.placeShort ? " at " + r.placeShort : ""}`;
    });
    lines.push(`New on map: ${examples.join("; ")}.`);
  }
  if (d.disappeared.length) {
    const examples = d.disappeared.slice(0, 2).map(r => {
      const died = r.ind.death_year === y - 1 ? "died" : "left visible lifespan";
      return `${_kfNameShort(r.ind.name)} ${died}`;
    });
    lines.push(`No longer shown: ${examples.join("; ")}.`);
  }
  if (!lines.length && d.topPlaces.length) {
    lines.push(`No person-marker changes from ${y - 1}. Top places: ${d.topPlaces.map(([p, n]) => `${p} ${n}`).join(", ")}.`);
  } else if (!lines.length) {
    lines.push(`No person-marker changes from ${y - 1}.`);
  }
  if (d.weak.length) {
    const examples = d.weak.slice(0, 2).map(_kfYearDigestPersonLabel);
    lines.push(`Weak place evidence: ${d.weak.length.toLocaleString()} marker${d.weak.length === 1 ? "" : "s"}${examples.length ? `, including ${examples.join("; ")}` : ""}.`);
  } else if (d.issues.length) {
    const ex = d.issues[0];
    lines.push(`Data check: ${_kfNameShort(ex.row.ind.name)} - ${ex.issue}.`);
  }
  return `<div class="year-digest-head"><span class="year-digest-title">What changed in ${y}</span><span class="year-digest-sub">vs ${y - 1}</span></div>` +
    `<ul class="year-digest-list">${lines.slice(0, 4).map(line => `<li>${escHtml(line)}</li>`).join("")}</ul>`;
}

function _kfMapTopLabels(map, limit = 3) {
  return Array.from(map.entries())
    .filter(([label]) => label)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([label, count]) => `${String(label).replace(/\.ged$/i, "")} ${count.toLocaleString()}`);
}

function _kfYearDigestHeaderHtml(title, sub = "") {
  return `<div class="year-digest-head">` +
    `<span class="year-digest-title">${escHtml(title)}</span>` +
    (sub ? `<span class="year-digest-sub">${escHtml(sub)}</span>` : "") +
    `</div>`;
}

function _kfMobileConceptCardsHtml() {
  if (typeof _kfIsMobileLayout === "function" && !_kfIsMobileLayout()) return "";
  return `<div class="mobileConceptCards" aria-label="How to read this view">` +
    `<div class="mobileConceptCard"><b>Time changes the map.</b><span>Markers are people alive or possibly alive in the selected year.</span></div>` +
    `<div class="mobileConceptCard"><b>Trees define scope.</b><span>Checked trees control the map, clusters, AI, and search.</span></div>` +
    `<div class="mobileConceptCard"><b>Movement is evidence.</b><span>Long gaps animate near the destination year so we do not imply decades of travel.</span></div>` +
    `<div class="mobileConceptCard"><b>Clusters are shortcuts.</b><span>Tap a cluster to understand a branch before reading individual records.</span></div>` +
    `</div>`;
}

function _kfYearTourHtml() {
  if (!timelineLoaded || !lastIndividuals) {
    return _kfYearDigestHeaderHtml("Guided tour") +
      _kfMobileConceptCardsHtml() +
      `<ul class="year-digest-list"><li>Load one or more GEDCOM trees to enable the year tour.</li></ul>`;
  }
  const y = Math.floor(curYear);
  const d = _kfYearDigestData(y);
  const sourceBits = _kfMapTopLabels(d.current.sourceCounts, 3);
  const placeBits = _kfMapTopLabels(d.current.placeCounts, 3);
  const lines = [];
  lines.push(`${d.current.count.toLocaleString()} people are visible under the current tree/filter scope.`);
  if (sourceBits.length) lines.push(`Largest loaded sources in this view: ${sourceBits.join(", ")}.`);
  if (placeBits.length) lines.push(`Most common places: ${placeBits.join(", ")}.`);
  if (d.moved.length) {
    const m = d.moved[0];
    lines.push(`Most recent location update: ${_kfNameShort(m.row.ind.name)} moved from ${m.prev.placeShort || _kfShortPlace(m.prev.place, 2) || "unknown"} to ${m.row.placeShort || _kfShortPlace(m.row.place, 2) || "unknown"}.`);
  }
  if (d.appeared.length) {
    const r = d.appeared[0];
    lines.push(`Newly visible example: ${_kfYearDigestPersonLabel(r)}.`);
  }
  if (_kfShowDataQualityConcerns && d.weak.length) lines.push(`${d.weak.length.toLocaleString()} visible markers have weak place evidence; use "weak evidence" to review them.`);
  if (!lines.length) lines.push("This year has no notable marker changes under the current filters.");
  return _kfYearDigestHeaderHtml(`Guided tour for ${y}`, _kfViewModeLabel()) +
    _kfMobileConceptCardsHtml() +
    `<div class="year-digest-metrics">` +
      _kfYearDigestMetricHtml(d.current.count.toLocaleString(), "shown") +
      _kfYearDigestMetricHtml(d.current.exact.toLocaleString(), "specific") +
      (_kfShowDataQualityConcerns ? _kfYearDigestMetricHtml(d.current.weak.toLocaleString(), "weak") : "") +
      _kfYearDigestMetricHtml(d.moved.length.toLocaleString(), "move") +
    `</div>` +
    `<ul class="year-digest-list">${lines.slice(0, 6).map(line => `<li>${escHtml(line)}</li>`).join("")}</ul>`;
}

function _kfHideYearDigest() {
  _kfDerivedCache.activeDigestMode = "";
  _kfRenderActiveYearDigest();
}

function _kfBindYearDigestControls(digestEl) {
  digestEl.querySelector("[data-year-digest-close]")?.addEventListener("click", _kfHideYearDigest);
}

function _kfRenderActiveYearDigest(force = false) {
  const digestEl = $("tourPaneContent");
  if (!digestEl) return;
  const key = `${_kfSourceSelectionKey()}|${lastRootId || ""}|${Math.floor(curYear)}|${_kfFilterKey()}|${_kfDerivedCache.activeDigestMode}|${timelineLoaded ? 1 : 0}`;
  if (!force && key === _kfDerivedCache.lastDigestRenderKey) return;
  _kfDerivedCache.lastDigestRenderKey = key;
  digestEl.innerHTML = _kfYearTourHtml();
  _kfBindYearDigestControls(digestEl);
}

function _kfShowYearTour(selectTab = true) {
  _kfDerivedCache.activeDigestMode = "tour";
  _kfRenderActiveYearDigest(true);
  if (selectTab && typeof _kfSetSideTab === "function") _kfSetSideTab("tour");
}

function _kfOutlierReportMarkdown(limit = 8) {
  if (!_kfShowDataQualityConcerns) return "Data quality concerns are hidden. Turn on **show data quality concerns** in Trees to review weak place evidence or chronology warnings.";
  if (!timelineLoaded || !lastIndividuals) return "Load GEDCOM data before reviewing weak evidence.";
  const y = Math.floor(curYear);
  const rows = _kfVisibleRowsForYear(y).rows;
  const items = [];
  for (const row of rows) {
    const facts = _kfFactsForInd(row.ind);
    const issue = facts?.issues?.[0] || "";
    const weakPlace = row.evidence.rank >= 3;
    if (!issue && !weakPlace) continue;
    const score = (issue ? 6 : 0) + row.evidence.rank;
    const bits = [];
    if (issue) bits.push(issue);
    if (weakPlace) bits.push(`${row.evidence.label}: ${row.place || "no place"}`);
    items.push({ score, row, issue: bits.join("; ") });
  }
  items.sort((a, b) => b.score - a.score || _kfNameShort(a.row.ind.name).localeCompare(_kfNameShort(b.row.ind.name)));
  if (!items.length) {
    return `**Weak evidence review for ${y}**\n\nNo visible records have obvious weak-place or chronology warnings under the current tree/filter scope.`;
  }
  const lines = items.slice(0, limit).map((item, i) => {
    const row = item.row;
    const src = row.source ? ` (${row.source.replace(/\.ged$/i, "")})` : "";
    const place = row.place ? ` at ${row.place}` : "";
    return `${i + 1}. **${_kfNameShort(row.ind.name)}**${src} - ${row.eventLabel} ${row.year || y}${place}: ${item.issue}`;
  });
  return `**Weak evidence review for ${y}**\n\nThese visible records deserve attention first because their place evidence is vague, their date range is wide, or the timeline has a chronology warning.\n\n${lines.join("\n")}`;
}

function _kfShowOutlierReport(limit = 8) {
  _kfHideYearDigest();
  _kfSetSideTab("chat");
  chatHistory.push({
    role: "bot",
    content: _kfOutlierReportMarkdown(limit),
    chips: [
      {
        label: "Ask Claude to investigate",
        method: "chat",
        args: `Find the weakest location evidence in the checked trees at ${Math.floor(curYear)} and explain what should be verified first.`,
      },
    ],
  });
  renderChat();
}

function _kfCurrentViewExplanationMarkdown() {
  if (!timelineLoaded || !lastIndividuals) return "Load GEDCOM data to see a view explanation.";
  const y = Math.floor(curYear);
  const data = _kfVisibleMarkerData();
  const sources = typeof _kfSelectedVizSourceList === "function" ? _kfSelectedVizSourceList() : [];
  const sourceNames = sources.map(s => (s.name || "").replace(/\.ged$/i, "")).filter(Boolean);
  const mode = _kfViewModeLabel();
  const clusterText = clusterMode === "none"
    ? "Markers are individual people who are alive or may be alive at the selected year."
    : `Markers are grouped with ${_kfClusterModeLabel(clusterMode).toLowerCase()} clustering; click a cluster for its ranked people list and evidence summary.`;
  const migrationText = migrationViz === "observations"
    ? "Migration is shown as observation pulses, so a long date range does not imply continuous travel."
    : "Migration is shown continuously between recorded location observations; switch to observation pulses when long date ranges would be misleading.";
  const evidenceLine = _kfShowDataQualityConcerns
    ? `\n- Evidence: **${data.exact.toLocaleString()} specific markers**, **${data.weak.toLocaleString()} weak markers**`
    : "";
  return `**Why this view looks this way**\n\n- Year: **${y}**\n- Scope: **${sourceNames.length ? sourceNames.join(", ") : "all loaded trees"}**\n- Filters: **${mode}**\n- Visible people: **${data.count.toLocaleString()}**${evidenceLine}\n\n${clusterText}\n\n${migrationText}`;
}

function _kfExplainCurrentView() {
  _kfSetSideTab("chat");
  chatHistory.push({
    role: "bot",
    content: _kfCurrentViewExplanationMarkdown(),
    chips: [
      { label: "Tour this year", method: "showYearTour", args: null },
      ...(_kfShowDataQualityConcerns ? [{ label: "Review weak evidence", method: "showOutliers", args: 8 }] : []),
    ],
  });
  renderChat();
}

function _kfViewModeLabel() {
  const cluster = clusterMode === "none" ? "not clustered" : `clustered by ${_kfClusterModeLabel(clusterMode).toLowerCase()}`;
  const filter = curFilter === "blood" ? "blood relatives" : curFilter === "ancestors" ? "ancestors" : "all people";
  const sex = _kfSexFilter === "M" ? "men" : _kfSexFilter === "F" ? "women" : "";
  return [filter, sex, cluster].filter(Boolean).join(" | ");
}

function _kfMobileContextStripHtml(y, data, sourceCount) {
  if (!timelineLoaded || !lastIndividuals) {
    return `<b>Start here</b> <span>Select a tree, then scrub the year to watch family history move.</span>`;
  }
  const trees = sourceCount || (_kfLoadedSources?.size || 0);
  const treeText = `${trees} ${trees === 1 ? "tree" : "trees"}`;
  const markerText = clusterMode === "none"
    ? `${data.count.toLocaleString()} alive/maybe alive`
    : `${data.count.toLocaleString()} people grouped`;
  const scope = curFilter === "blood" ? "blood relatives" : curFilter === "ancestors" ? "ancestors" : "all people";
  return `<b>${y}</b> <span>${markerText} | ${treeText} | ${scope} | last known locations</span>`;
}

function _kfRefreshViewChrome(force = false) {
  const summaryEl = $("viewSummary");
  const breadEl = $("focusBreadcrumb");
  const whyEl = $("viewWhy");
  const digestEl = $("tourPaneContent");
  const mobileContextEl = $("mobileContextStrip");
  if (!summaryEl && !breadEl && !whyEl && !digestEl && !mobileContextEl) return;
  const y = Math.floor(curYear);
  const data = _kfVisibleMarkerData();
  const sourceCount = (typeof _kfSelectedVizSourceList === "function" ? _kfSelectedVizSourceList().length : 0) || (_kfLoadedSources?.size || 0);
  const selected = highlightedDwell >= 0 && lastIndividuals ? lastIndividuals[dwellIndi[highlightedDwell]] : null;
  const root = lastRootId && lastIndiById ? lastIndiById.get(lastRootId) : null;
  const key = `${_kfSourceSelectionKey()}|${y}|${data.count}|${sourceCount}|${_kfViewModeLabel()}|${root?.id || ""}|${selected?.id || ""}|${_kfDerivedCache.activeClusterLabel}`;
  if (!force && key === _kfDerivedCache.lastChromeKey) return;
  _kfDerivedCache.lastChromeKey = key;
  if (summaryEl) {
    summaryEl.textContent = timelineLoaded
      ? `${y} | ${_kfViewModeLabel()}`
      : "Load GEDCOM data to begin.";
  }
  if (breadEl) {
    const bits = [];
    if (selected && selected.id !== root?.id) bits.push(`Selected: ${_kfNameShort(selected.name)}`);
    if (_kfDerivedCache.activeClusterLabel && clusterMode !== "none") bits.push(`Cluster: ${_kfDerivedCache.activeClusterLabel}`);
    breadEl.hidden = bits.length === 0;
    breadEl.textContent = bits.join(" > ");
  }
  if (whyEl) whyEl.hidden = !timelineLoaded || !lastIndividuals;
  const tourIsVisible = typeof _kfIsSideTabActive === "function"
    ? _kfIsSideTabActive("tour")
    : digestEl?.closest(".sidePane")?.classList.contains("on");
  if (digestEl && tourIsVisible) _kfRenderActiveYearDigest();
  if (mobileContextEl) {
    mobileContextEl.hidden = false;
    mobileContextEl.innerHTML = _kfMobileContextStripHtml(y, data, sourceCount);
  }
  const chatIsVisible = typeof _kfIsSideTabActive === "function"
    ? _kfIsSideTabActive("chat")
    : document.getElementById("chatPane")?.classList.contains("on");
  if (chatIsVisible && typeof _kfRefreshChatScope === "function") _kfRefreshChatScope();
}

$("viewWhy")?.addEventListener("click", () => _kfExplainCurrentView());

function _kfSetActiveClusterLabel(label) {
  _kfDerivedCache.activeClusterLabel = label || "";
  _kfRefreshViewChrome(true);
}

function _kfClusterDigestHtml(c, rows) {
  if (_kfDerivedCache.clusterIndividuals !== lastIndividuals) {
    _kfDerivedCache.cluster.clear();
    _kfDerivedCache.clusterIndividuals = lastIndividuals;
  }
  const key = `${_kfSourceSelectionKey()}|${lastRootId || ""}|${clusterMode}|${Math.floor(curYear)}|${rows.map(r => r.di).join(",")}|${rows.focus?.focusId || ""}`;
  const cached = _kfDerivedCache.cluster.get(key);
  if (cached?.digestHtml) return cached.digestHtml;
  const bullets = [];
  const total = rows.length;
  bullets.push(`${total} ${total === 1 ? "person is" : "people are"} visible here in ${Math.floor(curYear)}.`);
  const sourceCounts = new Map();
  const placeCounts = new Map();
  let exact = 0, weak = 0, issueCount = 0;
  for (const r of rows) {
    if (r.sourceName) sourceCounts.set(r.sourceName, (sourceCounts.get(r.sourceName) || 0) + 1);
    const placeHead = r.place ? r.place.split(",")[0].trim() : "";
    if (placeHead) placeCounts.set(placeHead, (placeCounts.get(placeHead) || 0) + 1);
    if (r.locationEvidenceRank <= 1) exact++;
    if (r.locationEvidenceRank >= 3) weak++;
    const ind = lastIndividuals?.[dwellIndi?.[r.di]];
    issueCount += _kfFactsForInd(ind)?.issues.length ? 1 : 0;
  }
  const topSource = Array.from(sourceCounts.entries()).sort((a, b) => b[1] - a[1])[0];
  const closest = rows.find(r => Number.isFinite(r.sortDist) && r.sortDist > 0) || rows[0];
  if (closest) bullets.push(`Closest listed person to the focus: ${closest.name}${closest.rel ? ` (${closest.rel})` : ""}.`);
  const topPlace = Array.from(placeCounts.entries()).sort((a, b) => b[1] - a[1])[0];
  if (topPlace) bullets.push(`Most common place label: ${topPlace[0]} (${topPlace[1]}).`);
  if (topSource) bullets.push(`Largest source: ${topSource[0].replace(/\.ged$/i, "")} (${topSource[1]}).`);
  if (_kfShowDataQualityConcerns) {
    bullets.push(weak
      ? `Evidence to review: ${weak} weak place markers; ${exact} city/specific markers.`
      : `Evidence looks specific for this cluster: ${exact} city/specific markers.`);
    if (issueCount) bullets.push(`${issueCount} ${issueCount === 1 ? "person has" : "people have"} data issues worth checking.`);
  }
  const html = `<div class="ux-section cluster-digest"><h4>Most useful things to know</h4><ul class="ux-list">${bullets.map(b => `<li>${escHtml(b)}</li>`).join("")}</ul></div>`;
  _kfTrimDerivedCache(_kfDerivedCache.cluster, (typeof _kfIsMobileLayout === "function" && _kfIsMobileLayout()) ? 40 : 120);
  _kfDerivedCache.cluster.set(key, { ...(cached || {}), digestHtml: html });
  return html;
}

function _kfClusterIssuesHtml(c, rows) {
  return "";
}

function _kfClusterQuestionHtml(rows) {
  const focusName = rows.focus?.focus?.name || "the focus person";
  return _kfQuestionChipsHtml([
    `Why are these people clustered in ${Math.floor(curYear)}?`,
    `Who are the closest relatives to ${focusName} in this cluster?`,
    `Which records explain this cluster's locations?`,
    ...(_kfShowDataQualityConcerns ? [`Find data problems in this cluster.`] : []),
  ]);
}

function _kfPersonQuestionHtml(ind) {
  const name = ind?.name || "this person";
  return _kfQuestionChipsHtml([
    `Why is ${name} shown here in ${Math.floor(curYear)}?`,
    `Summarize ${name}'s migration story.`,
    ...(_kfShowDataQualityConcerns ? [`What evidence is weakest for ${name}?`] : []),
    `Who are ${name}'s closest relatives?`,
  ]);
}
