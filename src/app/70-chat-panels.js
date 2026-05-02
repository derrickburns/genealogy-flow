// ---------- Chat ----------
const chatHistoryEl = $("chatHistory");
const chatInputEl = $("chatInput");
const chatFormEl = $("chatForm");
const chatSendBtn = $("chatSend");
const chatScopeEl = $("chatScope");
const chatHistory = []; // [{ role, content }]
const CHAT_KEY_LS = "kf-anthropic-key";

const _spEl = $("selectedPerson");
const _personEmptyEl = $("personEmpty");
const _clusterEl = $("selectedCluster");
const _clusterEmptyEl = $("clusterEmpty");

function _kfSetSideTab(tab) {
  const next = tab === "person" || tab === "cluster" ? tab : "chat";
  document.querySelectorAll("#sideTabs [data-side-tab]").forEach(btn => {
    btn.classList.toggle("on", btn.dataset.sideTab === next);
  });
  document.querySelectorAll("#chatPanel .sidePane").forEach(pane => {
    pane.classList.toggle("on", pane.id === `${next}Pane`);
  });
}
document.querySelectorAll("#sideTabs [data-side-tab]").forEach(btn => {
  btn.addEventListener("click", () => _kfSetSideTab(btn.dataset.sideTab));
});

const EVENT_LABEL = {
  BIRT: "Born",
  DEAT: "Died",
  MARR: "Married",
  RESI: "Lived",
  EMIG: "Emigrated",
  IMMI: "Immigrated",
  CENS: "Census",
  BURI: "Buried",
  CHR: "Christened",
  BAPM: "Baptized",
  OCCU: "Occupation",
  EDUC: "Education",
  RELI: "Religion",
  NATU: "Naturalization",
  WILL: "Will",
};
const EVENT_NOUN_LABEL = {
  BIRT: "birth",
  DEAT: "death",
  MARR: "marriage",
  RESI: "residence",
  EMIG: "emigration",
  IMMI: "immigration",
  CENS: "census",
  BURI: "burial",
  CHR: "christening",
  BAPM: "baptism",
  OCCU: "occupation",
  EDUC: "education",
  RELI: "religion",
  NATU: "naturalization",
  WILL: "will",
};

function _kfEventPlainLabel(type, opts = {}) {
  const tag = String(type || "").trim().toUpperCase();
  const noun = EVENT_NOUN_LABEL[tag];
  const title = EVENT_LABEL[tag];
  const label = opts.noun ? noun : title;
  if (!label) return opts.noun ? "recorded event" : "Recorded event";
  return opts.lower ? label.toLowerCase() : label;
}

function _kfPlainEnglishEventText(text) {
  const tags = Object.keys(EVENT_NOUN_LABEL).join("|");
  return String(text || "").replace(new RegExp(`\\b(${tags})\\b`, "g"), tag => _kfEventPlainLabel(tag, { noun: true }));
}

function _kfRgb(rgb) {
  const r = Math.max(0, Math.min(255, Math.round(rgb?.[0] ?? 128)));
  const g = Math.max(0, Math.min(255, Math.round(rgb?.[1] ?? 128)));
  const b = Math.max(0, Math.min(255, Math.round(rgb?.[2] ?? 128)));
  return `rgb(${r},${g},${b})`;
}

function _kfClusterModeLabel(mode = clusterMode) {
  return ({
    aggregate: "Density",
    dispersion: "Density",
    pie: "Lineage",
    parents: "Parent knowledge",
    gender: "Gender",
    tree: "Tree",
    state: "State",
  })[mode] || "Cluster";
}

function _kfClusterSliceEntries(c) {
  if (clusterMode === "parents") {
    const counts = c.parents || [0, 0, 0];
    return [
      { label: "2 parents known", count: counts[0] || 0, color: [80, 160, 100] },
      { label: "1 parent known", count: counts[1] || 0, color: [220, 150, 60] },
      { label: "0 parents known", count: counts[2] || 0, color: [200, 80, 80] },
    ];
  }
  if (clusterMode === "gender") {
    const counts = c.genders || [0, 0, 0];
    return [
      { label: "Male", count: counts[0] || 0, color: COLOR_GENDER_M },
      { label: "Female", count: counts[1] || 0, color: COLOR_GENDER_F },
      { label: "Unknown", count: counts[2] || 0, color: COLOR_GENDER_U },
    ];
  }
  if (clusterMode === "tree" && c.sourceCounts) {
    return Array.from(c.sourceCounts.entries()).map(([sid, count]) => {
      const name = c.sourceNames?.get(sid) || String(sid);
      return { label: name.replace(/\.ged$/i, ""), count, color: _kfTreeColorForName(name) };
    });
  }
  const counts = c.sides || [0, 0, 0];
  return [
    { label: "Paternal", count: counts[0] || 0, color: COLOR_PATERNAL },
    { label: "Maternal", count: counts[1] || 0, color: COLOR_MATERNAL },
    { label: "Other", count: counts[2] || 0, color: COLOR_OTHER },
  ];
}

function _kfConicGradient(entries, fallback) {
  const total = entries.reduce((sum, e) => sum + (e.count || 0), 0);
  if (!total) return _kfRgb(fallback || COLOR_OTHER);
  let start = 0;
  const stops = [];
  for (const e of entries) {
    if (!e.count) continue;
    const end = start + (e.count / total) * 100;
    stops.push(`${_kfRgb(e.color)} ${start.toFixed(2)}% ${end.toFixed(2)}%`);
    start = end;
  }
  return stops.length ? `conic-gradient(${stops.join(",")})` : _kfRgb(fallback || COLOR_OTHER);
}

function _kfClusterSwatchHtml(c) {
  if (clusterMode === "state" && c.abbr) {
    const col = TREE_PALETTE[_kfTreeColorFromName(c.abbr)];
    return `<span class="cluster-swatch" style="background:${_kfRgb(col)};">${escHtml(c.abbr)}</span>`;
  }
  if (clusterMode === "aggregate" || clusterMode === "dispersion") {
    return `<span class="cluster-swatch" style="background:${_kfRgb(c.color || clusterDominantColor(c))};"></span>`;
  }
  const bg = _kfConicGradient(_kfClusterSliceEntries(c), c.color || clusterDominantColor(c));
  return `<span class="cluster-swatch" style="background:${bg};"></span>`;
}

function _kfClusterCount(c) {
  return Number.isFinite(c?.count) ? c.count : (c?.members?.length || 0);
}

function _kfClusterBreakdownHtml(c) {
  const rows = [
    ["Year", String(Math.floor(curYear))],
    ["Mode", _kfClusterModeLabel()],
    ["People", String(_kfClusterCount(c))],
  ];
  if (c.abbr) rows.push(["Region", c.abbr]);
  const entries = _kfClusterSliceEntries(c).filter(e => e.count);
  if (entries.length) rows.push([
    clusterMode === "parents" ? "Parents" : clusterMode === "gender" ? "Gender" : clusterMode === "tree" ? "Trees" : "Lineage",
    entries.map(e => `${e.label} ${e.count}`).join(" · "),
  ]);
  return `<div class="cluster-breakdown">` + rows.map(([k, v]) =>
    `<div><b>${escHtml(k)}</b><span>${escHtml(v)}</span></div>`
  ).join("") + `</div>`;
}

function _kfClusterMemberColor(di, c) {
  if (clusterMode === "parents") {
    return dwellSrc[di] === 0 ? [80, 160, 100] : dwellSrc[di] === 1 ? [220, 150, 60] : [200, 80, 80];
  }
  if (clusterMode === "gender") {
    const ind = lastIndividuals?.[dwellIndi[di]];
    return ind?.sex === "M" ? COLOR_GENDER_M : ind?.sex === "F" ? COLOR_GENDER_F : COLOR_GENDER_U;
  }
  if (clusterMode === "tree") {
    return _kfTreeColorForName(_kfSourceNameForIndiIdx(dwellIndi[di]));
  }
  if (clusterMode === "state" && c?.abbr) {
    return TREE_PALETTE[_kfTreeColorFromName(c.abbr)];
  }
  return colorForFinal(dwellSide[di], dwellSrc[di], dwellIndi[di]);
}

function _kfClusterMemberMarkerHtml(di, c) {
  const ps = dwellSrc[di];
  const shape = ps === 2 ? "square" : ps === 1 ? "diamond" : "circle";
  return `<span class="cluster-marker ${shape}" style="background:${_kfRgb(_kfClusterMemberColor(di, c))};"></span>`;
}

let _kfClusterRelationCache = null;
function _kfSpouseIdsFor(id) {
  const out = new Set();
  if (!id || !lastFamilies) return out;
  for (const fam of lastFamilies.values()) {
    if (fam?.husb === id && fam.wife) out.add(fam.wife);
    else if (fam?.wife === id && fam.husb) out.add(fam.husb);
  }
  return out;
}

function _kfRelationDirectnessRank(m, n) {
  if (m === 0 && n === 0) return 0; // focus/self
  if (n === 0) return 1;            // ancestor
  if (m === 0) return 2;            // descendant
  if (m === 1 && n === 1) return 3; // sibling
  return 5;                         // cousin/collateral blood relation
}

function _kfRelationMapsForFocus(focusId) {
  if (!focusId || !lastIndividuals || !lastParentsOf || !lastChildrenOf) {
    return { relation: relationCache || new Map(), distance: relDistCache || new Map(), directness: new Map() };
  }
  if (_kfClusterRelationCache &&
      _kfClusterRelationCache.focusId === focusId &&
      _kfClusterRelationCache.parentsOf === lastParentsOf &&
      _kfClusterRelationCache.childrenOf === lastChildrenOf &&
      _kfClusterRelationCache.families === lastFamilies) {
    return _kfClusterRelationCache.maps;
  }

  const mn = new Map();
  mn.set(focusId, [0, 0]);
  const queue = [[focusId, 0, 0]];
  let head = 0;
  while (head < queue.length) {
    const [cur, m, n] = queue[head++];
    if (n === 0) {
      const par = lastParentsOf.get(cur);
      if (par) {
        for (const p of par) {
          if (!p || mn.has(p)) continue;
          mn.set(p, [m + 1, 0]);
          queue.push([p, m + 1, 0]);
        }
      }
    }
    const kids = lastChildrenOf.get(cur);
    if (kids) {
      for (const ch of kids) {
        if (mn.has(ch)) continue;
        mn.set(ch, [m, n + 1]);
        queue.push([ch, m, n + 1]);
      }
    }
  }

  const spouses = _kfSpouseIdsFor(focusId);
  const relation = new Map();
  const distance = new Map();
  const directness = new Map();
  for (const ind of lastIndividuals) {
    const pair = mn.get(ind.id);
    if (pair) {
      const [m, n] = pair;
      relation.set(ind.id, formatRelation(m, n, focusId, ind.id, lastParentsOf));
      distance.set(ind.id, m + n);
      directness.set(ind.id, _kfRelationDirectnessRank(m, n));
    } else if (spouses.has(ind.id)) {
      relation.set(ind.id, "Sp");
      distance.set(ind.id, 2.5);
      directness.set(ind.id, 4);
    } else {
      relation.set(ind.id, "");
      distance.set(ind.id, Infinity);
      directness.set(ind.id, 9);
    }
  }

  const maps = { relation, distance, directness };
  _kfClusterRelationCache = { focusId, parentsOf: lastParentsOf, childrenOf: lastChildrenOf, families: lastFamilies, maps };
  return maps;
}

function _kfClusterLocationEvidenceRank(di) {
  const place = (dwellPlace && placesList && dwellPlace[di] >= 0) ? placesList[dwellPlace[di]] : "";
  return _kfPlaceEvidence(place, !!dwellExact?.[di]).rank;
}

function _kfClusterFocus(c, opts = {}) {
  const selectedId = opts.selectedId ||
    (highlightedDwell >= 0 && lastIndividuals && dwellIndi
      ? lastIndividuals[dwellIndi[highlightedDwell]]?.id || null
      : null);
  const focusId = opts.focusId || selectedId || lastRootId || null;
  const focus = focusId && lastIndiById ? lastIndiById.get(focusId) : null;
  return { selectedId, focusId, focus };
}

function _kfClusterMemberRows(c, opts = {}) {
  const focus = _kfClusterFocus(c, opts);
  const relMaps = _kfRelationMapsForFocus(focus.focusId);
  const selectedSources = typeof _kfSelectedVizSourceList === "function" ? _kfSelectedVizSourceList() : [];
  const showSource = selectedSources.length > 1 || clusterMode === "tree";
  const rows = [];
  const seen = new Set();
  for (const di of c.members || []) {
    const idx = dwellIndi ? dwellIndi[di] : -1;
    const ind = idx >= 0 && lastIndividuals ? lastIndividuals[idx] : null;
    if (!ind || seen.has(ind.id)) continue;
    seen.add(ind.id);
    const life = [
      ind.birth_year ? `b. ${ind.birth_year}` : "",
      ind.death_year ? `d. ${ind.death_year}` : "",
    ].filter(Boolean).join(" ");
    const rel = relMaps.relation.get(ind.id) || "";
    const place = (dwellPlace && placesList && dwellPlace[di] >= 0) ? placesList[dwellPlace[di]] : "";
    const year = Number.isFinite(dwellY?.[di]) ? dwellY[di] : "";
    const sourceName = _kfSourceNameForIndiIdx(idx) || "";
    const sourceLabel = sourceName ? sourceName.replace(/\.ged$/i, "") : "";
    const eventLabel = EVENT_TYPE_LABEL[dwellType?.[di]] || "event";
    const yearDelta = Number.isFinite(year) ? Math.abs(year - Math.floor(curYear)) : Infinity;
    const meta = [
      rel,
      life,
      showSource ? sourceLabel : "",
      place ? `${eventLabel} ${place}` : "",
    ].filter(Boolean).join(" · ");
    rows.push({
      di,
      id: ind.id,
      name: ind.name || "?",
      rel,
      life,
      place,
      year,
      sourceName,
      selectedRank: focus.selectedId && focus.selectedId === ind.id ? 0 : 1,
      sortDist: relMaps.distance.get(ind.id) ?? Infinity,
      directnessRank: relMaps.directness.get(ind.id) ?? 9,
      locationEvidenceRank: _kfClusterLocationEvidenceRank(di),
      yearDelta,
      birthYear: Number.isFinite(ind.birth_year) ? ind.birth_year : 9999,
      html: `<button type="button" class="cluster-person" data-di="${di}">` +
        _kfClusterMemberMarkerHtml(di, c) +
        `<span>` +
          `<span class="cluster-person-name">${escHtml(ind.name || "?")}</span>` +
          (meta ? `<span class="cluster-person-meta">${escHtml(meta)}</span>` : "") +
          _kfDwellEvidenceBadgesHtml(di) +
        `</span>` +
        `<span class="cluster-person-year">${escHtml(year)}</span>` +
      `</button>`,
    });
  }
  rows.sort((a, b) => {
    if (a.selectedRank !== b.selectedRank) return a.selectedRank - b.selectedRank;
    if (clusterMode === "tree") {
      const treeCmp = a.sourceName.localeCompare(b.sourceName);
      if (treeCmp) return treeCmp;
    }
    const ad = Number.isFinite(a.sortDist) ? a.sortDist : 1e9;
    const bd = Number.isFinite(b.sortDist) ? b.sortDist : 1e9;
    if (ad !== bd) return ad - bd;
    if (a.directnessRank !== b.directnessRank) return a.directnessRank - b.directnessRank;
    if (a.locationEvidenceRank !== b.locationEvidenceRank) return a.locationEvidenceRank - b.locationEvidenceRank;
    if (a.yearDelta !== b.yearDelta) return a.yearDelta - b.yearDelta;
    if (clusterMode !== "tree") {
      const treeCmp = a.sourceName.localeCompare(b.sourceName);
      if (treeCmp) return treeCmp;
    }
    return a.birthYear - b.birthYear || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
  rows.focus = focus;
  return rows;
}

function _kfClusterPrompt(c, rows) {
  const people = rows.slice(0, 30).map(r => {
    const bits = [r.name, r.rel && r.rel !== "self" ? r.rel : "", r.life, r.place].filter(Boolean);
    return bits.join(" / ");
  }).join("; ");
  const more = rows.length > 30 ? `; plus ${rows.length - 30} more` : "";
  return `Analyze this ${_kfClusterModeLabel().toLowerCase()} cluster in ${Math.floor(curYear)}. It contains ${rows.length} people. People: ${people}${more}.`;
}

function _kfShowClusterCard(c, opts = {}) {
  if (!_clusterEl) return;
  const rows = _kfClusterMemberRows(c, opts);
  const title = c.abbr ? `${c.abbr} cluster` : `${_kfClusterModeLabel()} cluster`;
  const prompt = _kfClusterPrompt(c, rows);
  const focusName = rows.focus?.focus?.name || "";
  const orderText = focusName
    ? `Ordered by relation to ${focusName}${clusterMode === "tree" ? ", grouped by tree" : ""}`
    : "Ordered by relation, evidence quality, and event year";
  _kfSetActiveClusterLabel(title);
  _clusterEl.innerHTML =
    `<div class="cluster-head">` +
      _kfClusterSwatchHtml(c) +
      `<div>` +
        `<div class="cluster-title">${escHtml(title)}</div>` +
        `<div class="cluster-sub">${rows.length} ${rows.length === 1 ? "person" : "people"} visible in ${Math.floor(curYear)}</div>` +
      `</div>` +
    `</div>` +
    _kfClusterBreakdownHtml(c) +
    _kfClusterDigestHtml(c, rows) +
    _kfClusterIssuesHtml(c, rows) +
    _kfClusterQuestionHtml(rows) +
    `<div class="cluster-list-head"><span>People</span><span>${escHtml(orderText)}</span></div>` +
    `<div class="cluster-list">${rows.map(r => r.html).join("")}</div>` +
    `<div class="cluster-actions"><button type="button" class="cluster-ask" data-ask="${escHtml(prompt)}">Explain this cluster</button></div>`;
  _clusterEl.hidden = false;
  if (_clusterEmptyEl) _clusterEmptyEl.hidden = true;
  _kfSetSideTab("cluster");

  _clusterEl.querySelectorAll(".cluster-person").forEach(btn => {
    btn.addEventListener("click", () => {
      const di = Number(btn.dataset.di);
      if (!Number.isFinite(di) || di < 0) return;
      pushHistory();
      highlightedDwell = di;
      highlightInferredYear = -1;
      highlightInferredSrcYear = -1;
      if (playing) { playing = false; playBtn.textContent = "Play"; }
      _kfShowPersonCard(di);
      fxCtx.clearRect(0, 0, W, H);
      applyExpansion();
    });
  });

  _clusterEl.querySelector(".cluster-ask")?.addEventListener("click", async () => {
    const text = _clusterEl.querySelector(".cluster-ask")?.dataset.ask;
    await _kfAskQuestion(text);
  });
  _kfBindQuestionChips(_clusterEl);
}

function _kfNormalizedPlaceForDisplay(place) {
  const rawPlace = String(place || "").trim();
  if (!rawPlace) return "";
  if (geocoder && typeof geocoder.normalizePlace === "function") {
    return geocoder.normalizePlace(rawPlace) || rawPlace;
  }
  return rawPlace;
}

function _kfPersonTimelinePlaceHtml(rawPlace) {
  if (!rawPlace) return "";
  const normalized = _kfNormalizedPlaceForDisplay(rawPlace);
  const shown = normalized || rawPlace;
  return shown ? `<span class="sp-tl-place">${escHtml(shown)}</span>` : "";
}

function _kfPersonTimelineHtml(ind, clickedType, clickedYear) {
  if (!ind) return "";
  const events = (ind.events || []).filter(ev => ev && Number.isFinite(parseInt(ev.year, 10)));
  if (!events.length) return "";
  events.sort((a, b) => parseInt(a.year, 10) - parseInt(b.year, 10));
  const birthYear = parseInt(ind.birth_year, 10);
  const items = events.map(ev => {
    const yr = parseInt(ev.year, 10);
    const label = _kfEventPlainLabel(ev.type);
    const placeHtml = _kfPersonTimelinePlaceHtml(ev.place || "");
    const isActive = clickedType !== undefined
      && ev.type === clickedType && String(ev.year) === String(clickedYear);
    const age = Number.isFinite(birthYear) ? yr - birthYear : null;
    const ageHtml = age != null && age > 0 ? `<span class="sp-tl-age">age ${age}</span>` : "";
    return `<li class="sp-tl-item${isActive ? " highlight" : ""}">` +
      `<span class="sp-tl-year">${yr}</span>` +
      `<span class="sp-tl-dot"></span>` +
      `<span class="sp-tl-body">` +
        `<span class="sp-tl-label">${escHtml(label)}</span>` +
        placeHtml +
        ageHtml +
      `</span>` +
    `</li>`;
  }).join("");
  return `<ul class="sp-timeline">${items}</ul>`;
}

function _kfPersonLineageHtml(ind) {
  if (!ind || !lastRootId || !lastIndiById) return "";
  const root = lastIndiById.get(lastRootId);
  if (!root) return "";
  const lifeOf = (p) => {
    const parts = [];
    if (p.birth_year) parts.push(`b. ${p.birth_year}`);
    if (p.death_year) parts.push(`d. ${p.death_year}`);
    return parts.join(" ");
  };
  const personRow = (p, tag) => {
    const ls = lifeOf(p);
    const cls = tag === "HOME" ? " home" : tag === "HERE" ? " here" : "";
    return `<li class="sp-ln-person${cls}">` +
      `<span class="sp-ln-name">${escHtml(p.name)}</span>` +
      (ls ? `<span class="sp-ln-life">${escHtml(ls)}</span>` : "") +
      (tag ? `<span class="sp-ln-tag">${tag}</span>` : "") +
    `</li>`;
  };
  if (ind.id === lastRootId) {
    return `<ul class="sp-lineage">${personRow(root, "HOME")}</ul>`;
  }
  const path = pathFromRoot(ind.id);
  if (!path) return `<div class="sp-lineage-empty">No connection to home person.</div>`;
  const items = [personRow(root, "HOME")];
  for (let i = 0; i < path.length; i++) {
    const step = path[i];
    items.push(`<li class="sp-ln-step">${escHtml(step.label)}</li>`);
    const p = lastIndiById.get(step.id);
    if (p) {
      const isLast = i === path.length - 1;
      items.push(personRow(p, isLast ? "HERE" : null));
    }
  }
  return `<ul class="sp-lineage">${items.join("")}</ul>`;
}

function _kfRelativeBlockHtml(label, ind) {
  if (!ind) return "";
  const lifespan = [
    ind.birth_year ? `b. ${ind.birth_year}` : "",
    ind.death_year ? `d. ${ind.death_year}` : ""
  ].filter(Boolean).join(" ");
  return `<div class="sp-rel">` +
    `<div class="sp-rel-head">` +
      `<span class="sp-rel-label">${escHtml(label)}</span>` +
      `<span class="sp-rel-name">${escHtml(ind.name)}</span>` +
      (lifespan ? `<span class="sp-rel-life">${escHtml(lifespan)}</span>` : "") +
    `</div>` +
  `</div>`;
}

function _kfLivingAgeLabel(ind) {
  const birthYear = Number.parseInt(ind?.birth_year, 10);
  if (!Number.isFinite(birthYear)) return "";
  const thisYear = new Date().getFullYear();
  if (birthYear > thisYear) return "";
  if (ind?.death_year != null) return "";
  if (typeof _kfPersonMayBeAliveAtYear === "function" && !_kfPersonMayBeAliveAtYear(ind, thisYear)) return "";
  return `age ${thisYear - birthYear}`;
}

function _kfShowPersonCard(di) {
  if (!_spEl || !lastIndividuals) return;
  const idx = dwellIndi[di];
  const ind = lastIndividuals[idx];
  if (!ind) return;

  const sex = ind.sex === "M" ? "Male" : ind.sex === "F" ? "Female" : "";
  const age = _kfLivingAgeLabel(ind);
  const rel = (relationCache && ind.id !== lastRootId) ? (relationCache.get(ind.id) || "") : "";
  console.log("[kf] personCard rel:", ind.id, "->", JSON.stringify(rel), "cacheSize:", relationCache?.size, "rootId:", lastRootId);
  const sub = [sex, age, rel].filter(Boolean).join(" · ");

  const clickedType = dwellType[di];
  const clickedYear = dwellY[di];
  const evidenceHtml = _kfDwellEvidenceBadgesHtml(di);
  const storyHtml = _kfPersonStoryHtml(ind, di);
  const issuesHtml = _kfPersonIssuesHtml(ind, di);
  const questionsHtml = _kfPersonQuestionHtml(ind);
  const evHtml = _kfPersonTimelineHtml(ind, clickedType, clickedYear);
  const lineageHtml = _kfPersonLineageHtml(ind);
  const hasLineage = !!lineageHtml;
  const tabsHtml = (evHtml || hasLineage)
    ? `<div class="sp-tabs">` +
        (evHtml ? `<button class="sp-tab on" data-pane="timeline">Timeline</button>` : "") +
        (hasLineage ? `<button class="sp-tab${evHtml ? "" : " on"}" data-pane="lineage">Lineage</button>` : "") +
      `</div>`
    : "";
  const panesHtml =
    (evHtml ? `<div class="sp-pane on" data-pane="timeline">${evHtml}</div>` : "") +
    (hasLineage ? `<div class="sp-pane${evHtml ? "" : " on"}" data-pane="lineage">${lineageHtml}</div>` : "");

  // Parents
  let parentsHtml = "";
  const parents = lastParentsOf ? lastParentsOf.get(ind.id) : null;
  if (parents && lastIndiById) {
    const [fid, mid] = parents;
    const father = fid ? lastIndiById.get(fid) : null;
    const mother = mid ? lastIndiById.get(mid) : null;
    if (father || mother) {
      parentsHtml = `<div class="sp-section"><div class="sp-section-head">Parents</div>` +
        (father ? _kfRelativeBlockHtml("Father", father) : "") +
        (mother ? _kfRelativeBlockHtml("Mother", mother) : "") +
        `</div>`;
    }
  }

  // Children
  let childrenHtml = "";
  const childIds = lastChildrenOf ? lastChildrenOf.get(ind.id) : null;
  if (childIds && childIds.length && lastIndiById) {
    const childs = childIds.map(cid => lastIndiById.get(cid)).filter(Boolean);
    if (childs.length) {
      childs.sort((a, b) => (a.birth_year || 9999) - (b.birth_year || 9999));
      childrenHtml = `<div class="sp-section"><div class="sp-section-head">Children (${childs.length})</div>` +
        childs.map(c => {
          const sx = c.sex === "M" ? "Son" : c.sex === "F" ? "Daughter" : "Child";
          return _kfRelativeBlockHtml(sx, c);
        }).join("") +
        `</div>`;
    }
  }

  const askText = `Explain why ${ind.name} is shown here in ${Math.floor(curYear)}, including the event, location evidence, and relationship context.`;
  _spEl.innerHTML =
    `<div class="sp-name">${escHtml(ind.name)}</div>` +
    (sub ? `<div class="sp-sub">${escHtml(sub)}</div>` : "") +
    evidenceHtml +
    storyHtml +
    issuesHtml +
    questionsHtml +
    tabsHtml +
    panesHtml +
    parentsHtml +
    childrenHtml +
    `<div class="sp-actions">` +
    `<button class="sp-ask" data-ask="${escHtml(askText)}">Explain this marker</button>` +
    `<button class="sp-dismiss">Dismiss</button>` +
    `</div>`;
  _spEl.hidden = false;
  if (_personEmptyEl) _personEmptyEl.hidden = true;
  _kfSetSideTab("person");

  _spEl.querySelectorAll(".sp-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      const which = btn.dataset.pane;
      _spEl.querySelectorAll(".sp-tab").forEach(b => b.classList.toggle("on", b.dataset.pane === which));
      _spEl.querySelectorAll(".sp-pane").forEach(p => p.classList.toggle("on", p.dataset.pane === which));
    });
  });

  _spEl.querySelector(".sp-ask").addEventListener("click", async () => {
    const text = _spEl.querySelector(".sp-ask").dataset.ask;
    await _kfAskQuestion(text);
  });
  _kfBindQuestionChips(_spEl);
  _spEl.querySelector(".sp-dismiss").addEventListener("click", () => {
    _kfHidePersonCard();
    highlightedDwell = -1;
    highlightInferredYear = -1;
    highlightInferredSrcYear = -1;
    fxCtx.clearRect(0, 0, W, H);
    updatePanel(true);
  });
}

function _kfHidePersonCard() {
  if (_spEl) { _spEl.hidden = true; _spEl.innerHTML = ""; }
  if (_personEmptyEl) _personEmptyEl.hidden = false;
}
let _chatBusy = false;
let _kfChatDiagramSeq = 0;
const _kfChatDiagramSpecs = new Map();

function escChat(s) { return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

// Inline transforms: applied AFTER HTML-escape so the surrounding text is safe.
// Order matters: code spans first (so their contents aren't transformed),
// then links, then bold/italic.
function _kfInlineMd(s) {
  return escChat(s)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
}

// Build a sandboxed inline iframe that renders a Mermaid diagram. Same
// security model as the viz tab — sandbox='allow-scripts' with no
// allow-same-origin, so the renderer can't read parent localStorage.
function _kfOpenChatMermaid(id) {
  const spec = _kfChatDiagramSpecs.get(Number(id));
  if (!spec || !window.kfApi || typeof window.kfApi.showViz !== "function") return;
  window.kfApi.showViz({ type: "mermaid", title: "Chat diagram", spec });
}

function _kfChatMermaidIframe(src) {
  const id = ++_kfChatDiagramSeq;
  _kfChatDiagramSpecs.set(id, String(src || ""));
  if (_kfChatDiagramSpecs.size > 80) {
    const oldest = _kfChatDiagramSpecs.keys().next().value;
    _kfChatDiagramSpecs.delete(oldest);
  }
  const text = JSON.stringify(String(src || ""));
  const idJson = JSON.stringify(id);
  const srcdoc = `<!doctype html><html><head><style>
    html,body{margin:0;padding:6px 0;background:transparent;font:13px/1.4 system-ui;}
    body{cursor:pointer;}
    #out{max-width:100%;overflow:auto;}
    #out svg{max-width:100%;height:auto;display:block;}
    pre.err{color:#b00020;background:#fff3f3;padding:6px;border-radius:4px;font-size:11px;white-space:pre-wrap;}
  </style>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"><\/script>
  </head><body><div id="out"><pre class="mermaid"></pre></div>
  <script>
    const src=${text};
    const diagramId=${idJson};
    document.addEventListener('click', () => parent.postMessage({type:'kf-mermaid-open', id:diagramId}, '*'));
    document.querySelector('.mermaid').textContent=src;
    mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'default'});
    mermaid.run().then(()=>{
      // Tell the parent how tall to make the iframe — strict-sandbox can't
      // resize itself so we postMessage the rendered SVG height.
      const svg=document.querySelector('#out svg');
      const h=svg ? Math.ceil(svg.getBoundingClientRect().height)+12 : 80;
      parent.postMessage({type:'kf-mermaid-size', h}, '*');
    }).catch(e=>{
      document.getElementById('out').innerHTML='<pre class="err">'+(e.message||e)+'</pre>';
      parent.postMessage({type:'kf-mermaid-size', h:60}, '*');
    });
  <\/script>
  </body></html>`;
  const safe = srcdoc.replace(/&/g,"&amp;").replace(/"/g,"&quot;");
  return `<span class="chatDiagram" data-mermaid-id="${id}">` +
    `<iframe class="chatMermaid" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${safe}" title="diagram"></iframe>` +
    `<span class="chatDiagramBar"><button type="button" class="chatDiagramOpen" data-mermaid-id="${id}">Open as tab</button></span>` +
  `</span>`;
}

// Block-level markdown renderer: paragraphs, headers, lists, tables, code
// fences (with language detection so ```mermaid blocks render as diagrams),
// blockquotes, and horizontal rules. Inline transforms run via _kfInlineMd.
function renderMd(s) {
  const lines = String(s).split("\n");
  const out = [];
  let inFence = false, fenceLang = "", fenceBuf = [];
  let listType = null;
  let paraBuf = [];
  let tableBuf = [];  // accumulates pipe-delimited rows
  function closeList() {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  }
  function flushTable() {
    if (!tableBuf.length) return;
    // Split each row by | and trim cells; skip separator rows (only dashes/colons/spaces/pipes)
    const isSep = r => /^[\|\s\-:]+$/.test(r);
    const rows = tableBuf.filter(r => !isSep(r));
    if (rows.length) {
      const splitRow = r => r.replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      const [header, ...body] = rows;
      const ths = splitRow(header).map(c => `<th>${_kfInlineMd(c)}</th>`).join("");
      const trs = body.map(r => `<tr>${splitRow(r).map(c => `<td>${_kfInlineMd(c)}</td>`).join("")}</tr>`).join("");
      out.push(`<table style="border-collapse:collapse;font-size:11px;margin:6px 0;width:100%;"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`);
    }
    tableBuf = [];
  }
  function flushPara() {
    if (paraBuf.length) {
      out.push(`<p>${paraBuf.map(_kfInlineMd).join("<br>")}</p>`);
      paraBuf = [];
    }
  }
  function flushFence() {
    flushPara();
    closeList();
    if (fenceLang === "mermaid") {
      out.push(_kfChatMermaidIframe(fenceBuf.join("\n")));
    } else {
      out.push(`<pre><code>${escChat(fenceBuf.join("\n"))}</code></pre>`);
    }
    inFence = false; fenceLang = ""; fenceBuf = [];
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```\s*(\w*)\s*$/);
    if (fence) {
      if (inFence) flushFence();
      else { flushPara(); closeList(); flushTable(); inFence = true; fenceLang = fence[1] || ""; }
      continue;
    }
    if (inFence) { fenceBuf.push(line); continue; }
    // Table rows: lines that start (or end) with a pipe character
    if (/^\s*\|/.test(line)) {
      flushPara(); closeList();
      tableBuf.push(line);
      continue;
    } else if (tableBuf.length) {
      flushTable();
    }
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      flushPara(); closeList();
      out.push(`<h${h[1].length}>${_kfInlineMd(h[2])}</h${h[1].length}>`);
      continue;
    }
    if (/^(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushPara(); closeList();
      out.push("<hr>");
      continue;
    }
    const bullet = line.match(/^[\-\*\+]\s+(.+)$/);
    if (bullet) {
      flushPara();
      if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
      out.push(`<li>${_kfInlineMd(bullet[1])}</li>`);
      continue;
    }
    const num = line.match(/^(\d+)\.\s+(.+)$/);
    if (num) {
      flushPara();
      if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
      out.push(`<li value="${num[1]}">${_kfInlineMd(num[2])}</li>`);
      continue;
    }
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) {
      flushPara(); closeList();
      out.push(`<blockquote>${_kfInlineMd(bq[1])}</blockquote>`);
      continue;
    }
    if (line.trim() === "") {
      flushPara(); closeList();
      continue;
    }
    closeList();
    paraBuf.push(line);
  }
  flushPara(); closeList(); flushTable();
  if (inFence) flushFence();
  return out.join("");
}

// Inline mermaid iframes can't size themselves under strict sandbox.
// They postMessage their rendered height; we resize their iframe element
// to match so diagrams don't get clipped by an arbitrary fixed height.
window.addEventListener("message", e => {
  if (!e.data) return;
  if (e.data.type === "kf-mermaid-open") {
    _kfOpenChatMermaid(e.data.id);
    return;
  }
  if (e.data.type === "kf-mermaid-size") {
    const frames = chatHistoryEl ? chatHistoryEl.querySelectorAll("iframe.chatMermaid") : [];
    for (const f of frames) {
      if (f.contentWindow === e.source) {
        f.style.height = (Math.max(80, Number(e.data.h) || 80)) + "px";
        break;
      }
    }
  }
});
const CHAT_TOOLS_LS = "kf-chat-show-tools";
let _chatShowTools = localStorage.getItem(CHAT_TOOLS_LS) !== "0";
function renderChat() {
  if (chatHistory.length === 0) {
    chatHistoryEl.innerHTML = `<div class="empty">Ask anything: "Where did the family migrate between 1880 and 1940?", "Who's selected and how are we related?", "Summarize my paternal line." Set your Anthropic API key with the key button — stored locally only.</div>`;
    return;
  }
  const visible = _chatShowTools ? chatHistory : chatHistory.filter(m => m.kind !== "tool");
  if (visible.length === 0) {
    chatHistoryEl.innerHTML = `<div class="empty">Tool calls hidden. Toggle "tools" to show them.</div>`;
    return;
  }
  // Sticky-scroll: only follow the bottom if the user was already there.
  // If they've scrolled up (e.g., to click a chip from an earlier message),
  // preserve their position so the click doesn't yank them to the bottom.
  const stickThreshold = 30;
  const wasAtBottom =
    chatHistoryEl.scrollHeight - chatHistoryEl.scrollTop - chatHistoryEl.clientHeight < stickThreshold;
  const prevScrollTop = chatHistoryEl.scrollTop;
  chatHistoryEl.innerHTML = visible.map((m, mi) => {
    const body = m.role === "user" ? escChat(m.content) : renderMd(_kfPlainEnglishEventText(m.content));
    const chips = (m.chips && m.chips.length)
      ? `<div class="chatChips">${m.chips.map((c, ci) => `<button class="chatChip${c._spent ? " spent" : ""}" data-mi="${mi}" data-ci="${ci}">${escChat(_kfPlainEnglishEventText(c.label || "(chip)"))}</button>`).join("")}</div>`
      : "";
    return `<div class="msg ${m.role}${m.kind === "tool" ? " tool" : ""}"><span class="who">${m.role === "user" ? "you" : m.kind === "tool" ? "tool" : "claude"}</span><div class="body">${body}</div>${chips}</div>`;
  }).join("");
  // Wire chip clicks. Each chip carries an action (kfApi method + args) that
  // fires once on click, mirroring how KFCALL markers work but via UI.
  chatHistoryEl.querySelectorAll(".chatChip").forEach(btn => {
    btn.addEventListener("click", async () => {
      const mi = Number(btn.dataset.mi);
      const ci = Number(btn.dataset.ci);
      const m = visible[mi];
      const chip = m && m.chips && m.chips[ci];
      if (!chip) return;
      // Persist "spent" on the chip data so it survives re-renders that
      // happen when _kfReportChipResult pushes a tool message back.
      chip._spent = true;
      btn.classList.add("spent");
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = "...";
      try { await _kfDispatchChip(chip); }
      finally {
        // Re-render will have replaced this DOM node; the .spent class is
        // re-applied from chip._spent so we don't need to touch the new btn.
      }
    });
  });
  chatHistoryEl.querySelectorAll(".chatDiagramOpen[data-mermaid-id]").forEach(btn => {
    btn.addEventListener("click", () => _kfOpenChatMermaid(btn.dataset.mermaidId));
  });
  if (wasAtBottom) chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
  else chatHistoryEl.scrollTop = prevScrollTop;
}

async function _kfDispatchChip(chip) {
  if (!chip) return;
  // Surface broken chips: parseChips emits these with method=null and an
  // _error/_body so the user sees what failed instead of silently nothing.
  if (!chip.method) {
    const err = chip._error || "chip missing method";
    const preview = chip._body ? `\n\n\`\`\`\n${chip._body.slice(0, 600)}\n\`\`\`` : "";
    chatHistory.push({
      role: "bot",
      kind: "tool",
      content: `\u2717 **broken chip**: ${err}${preview}\n\n*The most common cause is multi-line SQL in \`args\` with raw newlines instead of \`\\n\`. Ask Claude to re-emit chips with single-line JSON or compact SQL.*`,
    });
    renderChat();
    return;
  }
  const fn = window.kfApi && window.kfApi[chip.method];
  if (typeof fn !== "function") {
    _kfReportChipResult(chip, { error: `no kfApi method: ${chip.method}` });
    return;
  }
  try {
    const args = chip.args;
    const r = Array.isArray(args)
      ? await fn.apply(window.kfApi, args)
      : await fn.call(window.kfApi, args);
    // For lens-author chips, auto-activate after save and report row count.
    if (chip.method === "saveLens" && r && r.ok && r.lens && window.kfApi.activateLens) {
      const a = await window.kfApi.activateLens(r.lens);
      _kfReportChipResult(chip, { saved: r.lens, activated: a });
    } else {
      _kfReportChipResult(chip, r);
    }
  } catch (e) {
    _kfReportChipResult(chip, { error: e?.message || String(e) });
  }
}

// Surface chip dispatch outcomes inline in the chat so the user knows
// SOMETHING happened even when the result is "lens activated but matched
// zero rows for the current year". Silent failures were the previous bug.
function _kfReportChipResult(chip, r) {
  let summary;
  if (r && r.error) {
    summary = `\u2717 **${chip.label || chip.method}** failed: ${r.error}`;
  } else if (chip.method === "saveLens") {
    const lensName = (chip.args && chip.args.name) || (r && r.saved) || "lens";
    if (_kfLensData === null) {
      // _kfFetchLensData null means the SQL itself failed — show what we know.
      summary = `\u2717 **${chip.label || lensName}** saved but the SQL failed at runtime. Check the chat-proxy console for the full sqlite error, or paste the lens SQL into the SQL panel to debug.`;
    } else if (Array.isArray(_kfLensData) && _kfLensData.length === 0) {
      summary = `\u26A0 **${chip.label || lensName}** activated, but **0 rows match at year ${Math.floor(curYear)}**. Try scrubbing the timeline, or the SQL may need adjusting (e.g., \`__YEAR__\` placeholder, source filter).`;
    } else {
      const n = (Array.isArray(_kfLensData) && _kfLensData.length) || "?";
      summary = `\u2713 **${chip.label || lensName}** activated. ${n} rows rendered. Open Options \u2192 Lens to switch off.`;
    }
  } else if (chip.method === "activateLens") {
    summary = `\u2713 **${chip.label}** activated.`;
  } else if (chip.method === "showViz") {
    if (r && r.ok) {
      summary = `\u2713 **${chip.label || r.title || r.type}** opened in a new tab above the map.`;
    } else {
      summary = `\u2717 **${chip.label || chip.method}** failed: ${r && r.error || "unknown error"}`;
    }
  } else {
    const out = (r && typeof r === "object") ? JSON.stringify(r).slice(0, 200) : String(r);
    summary = `\u2713 **${chip.label || chip.method}**: ${out}`;
  }
  // Push as a regular bot message (not kind:"tool") so it's always visible
  // regardless of the "tools on/off" toggle. Chip results are user-facing
  // feedback, not internal plumbing.
  chatHistory.push({ role: "bot", content: summary });
  renderChat();
  const last = chatHistoryEl.lastElementChild;
  if (last && last.scrollIntoView) {
    last.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}
function appendError(text) {
  chatHistoryEl.insertAdjacentHTML("beforeend", `<div class="msg bot err"><span class="who">error</span><div class="body">${escChat(_kfPlainEnglishEventText(text))}</div></div>`);
  chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
}

function _kfChatScopeQuestions(root, selected, visible) {
  const y = Math.floor(curYear);
  const questions = [
    `Explain what changed on the map in ${y}.`,
    `Summarize the migration story for the visible people in ${y}.`,
    `Find the weakest location evidence in the checked trees at ${y}.`,
  ];
  if (selected?.name) questions.unshift(`Why is ${selected.name} shown here in ${y}?`);
  else if (root?.name) questions.unshift(`What should I notice about ${root.name}'s family in ${y}?`);
  if (visible?.count > 500) questions.push(`Give me the simplest way to understand these ${visible.count} visible people.`);
  return questions.slice(0, 5);
}

function _kfBindChatScopeQuestions() {
  if (!chatScopeEl) return;
  chatScopeEl.querySelectorAll("[data-chat-scope-question]").forEach(btn => {
    btn.addEventListener("click", () => {
      const text = btn.getAttribute("data-chat-scope-question") || "";
      if (!text) return;
      if (typeof _kfAskQuestion === "function") _kfAskQuestion(text);
      else {
        chatInputEl.value = text;
        chatInputEl.focus();
      }
    });
  });
}

function _kfRefreshChatScope() {
  if (!chatScopeEl) return;
  if (!timelineLoaded || !lastIndividuals) {
    chatScopeEl.hidden = true;
    chatScopeEl.innerHTML = "";
    return;
  }
  chatScopeEl.hidden = false;
  const visible = typeof _kfVisibleMarkerData === "function" ? _kfVisibleMarkerData() : null;
  const root = lastRootId && lastIndiById ? lastIndiById.get(lastRootId) : null;
  const selected = highlightedDwell >= 0 && lastIndividuals ? lastIndividuals[dwellIndi[highlightedDwell]] : null;
  const questions = _kfChatScopeQuestions(root, selected, visible);
  chatScopeEl.innerHTML = questions.length
    ? `<div class="chat-scope-actions" aria-label="Suggested questions">${questions.map(q => `<button type="button" class="chat-scope-question" data-chat-scope-question="${escChat(q)}">${escChat(q)}</button>`).join("")}</div>`
    : "";
  _kfBindChatScopeQuestions();
}

function _kfLoggedInUserContextLine() {
  const user = (typeof _clerkInstance !== "undefined" && _clerkInstance?.user) ? _clerkInstance.user : null;
  const email =
    user?.primaryEmailAddress?.emailAddress ||
    (typeof document !== "undefined" ? document.getElementById("authEmail")?.textContent?.trim() : "") ||
    "";
  const tier = (typeof _clerkUserTier !== "undefined" && _clerkUserTier) ? _clerkUserTier : "anon";
  if (!email) return "Logged-in user: not signed in.";
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.fullName || "";
  const tierLabel = tier === "vip" ? "VIP" : tier === "regular" ? "member" : tier;
  return `Logged-in user: ${name ? `${name} <${email}>` : email} (${tierLabel}).`;
}

function buildChatContext() {
  const lines = [];
  lines.push(_kfLoggedInUserContextLine());
  if (lastIndividuals) {
    lines.push(`Tree: ${lastIndividuals.length.toLocaleString()} individuals, ${dwellY ? dwellY.length.toLocaleString() : 0} events.`);
    lines.push(`Year range: ${minYear}-${maxYear}.`);
  }
  if (typeof _kfSelectedVizSourceList === "function") {
    const sources = _kfSelectedVizSourceList();
    if (sources.length) lines.push(`Selected trees: ${sources.map(s => s.name).join("; ")}.`);
  }
  if (lastRootId) {
    const root = lastIndiById?.get(lastRootId);
    if (root) lines.push(`Root: ${root.name} (${root.birth_year ?? "?"}-${root.death_year ?? "?"}).`);
  }
  lines.push(`Currently viewing year: ${Math.floor(curYear)}, year-window: ${dwellWindow}y back.`);
  if (typeof _kfViewModeLabel === "function") lines.push(`Current map filters: ${_kfViewModeLabel()}.`);
  if (highlightedDwell >= 0 && lastIndividuals) {
    const sel = lastIndividuals[dwellIndi[highlightedDwell]];
    if (sel) {
      const place = dwellPlace[highlightedDwell] >= 0 ? placesList[dwellPlace[highlightedDwell]] : "";
      lines.push(`Selected: ${sel.name} (${sel.birth_year ?? "?"}-${sel.death_year ?? "?"})${place ? ", at " + place : ""}, dwell year ${dwellY[highlightedDwell]}.`);
    }
  }
  // Visible people in the actual map marker set: one marker per person,
  // using the latest valid dwell at the current year after all filters.
  if (timelineLoaded) {
    const visibleRows = typeof _kfVisibleMarkerData === "function" ? _kfVisibleMarkerData().rows : [];
    const showSource = typeof _kfSelectedVizSourceList === "function" && _kfSelectedVizSourceList().length > 1;
    const values = [];
    for (const row of visibleRows) {
      const source = showSource && row.source ? `; ${row.source}` : "";
      values.push(`${row.ind.name} (${row.year}, ${row.place || "unknown place"}${source})`);
      if (values.length >= 80) break;
    }
    if (values.length > 0) {
      lines.push(`Currently rendered map markers (max 80; alive/presumed-alive after filters): ${values.join("; ")}.`);
    }
  }
  return lines.join("\n");
}
