// ---------- Chat ----------
const chatHistoryEl = $("chatHistory");
const chatInputEl = $("chatInput");
const chatFormEl = $("chatForm");
const chatSendBtn = $("chatSend");
const chatScopeEl = $("chatScope");
const chatQuestionRailEl = $("chatQuestionRail");
const chatAnswerEl = $("chatAnswer");
const chatHistoryDrawerEl = $("chatHistoryDrawer");
const chatInsightHeaderEl = $("chatInsightHeader");
const chatInsightScopeEl = $("chatInsightScope");
const chatInsightModeEl = $("chatInsightMode");
const chatArtifactsEl = $("chatArtifacts");
const chatEvidenceEl = $("chatEvidence");
const chatEvidenceBodyEl = $("chatEvidenceBody");
const chatHistory = []; // [{ role, content }]
const CHAT_KEY_LS = "kf-anthropic-key";
const chatArtifacts = [];
let _kfChatArtifactSeq = 0;
let _kfActiveChatTurnKey = "";
let _kfRenderedChatChipRefs = [];

const _spEl = $("selectedPerson");
const _personEmptyEl = $("personEmpty");
const _clusterEl = $("selectedCluster");
const _clusterEmptyEl = $("clusterEmpty");
const _mobileSheetHandleEl = $("mobileSheetHandle");
const _mobileSheetTabsEl = $("sideTabs");
const _mobileSheetTitleEl = $("mobileSheetTitle");
let _kfSuppressSideTabClickUntil = 0;
let _kfActiveSideTab = "chat";
let _kfChatScopePendingTap = null;
let _kfChatScopeDispatching = false;
let _kfChatScopeLastHandledAt = 0;
let _kfChatScopeLastRenderKey = "";
let _kfChatMoreQuestionsOpen = false;

function _kfIsSideTabActive(tab) {
  return _kfActiveSideTab === tab;
}

function _kfBindTapOrClick(el, handler) {
  if (!el || typeof handler !== "function") return;
  let tap = null;
  el.addEventListener("pointerdown", e => {
    if (e.pointerType === "mouse" || el.disabled) return;
    tap = { x: e.clientX, y: e.clientY, canceled: false };
  });
  el.addEventListener("pointermove", e => {
    if (!tap) return;
    if (Math.abs(e.clientX - tap.x) > 10 || Math.abs(e.clientY - tap.y) > 10) {
      tap.canceled = true;
    }
  });
  el.addEventListener("pointercancel", () => { tap = null; });
  el.addEventListener("pointerup", e => {
    if (e.pointerType === "mouse" || !tap || tap.canceled || el.disabled) {
      tap = null;
      return;
    }
    tap = null;
    el.dataset.kfTapHandled = "1";
    e.preventDefault();
    e.stopPropagation();
    handler(e);
    setTimeout(() => { delete el.dataset.kfTapHandled; }, 500);
  });
  el.addEventListener("click", e => {
    if (el.dataset.kfTapHandled === "1" || el.disabled) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    handler(e);
  });
}

function _kfUpdateMobileSheetTitle(tab) {
  if (!_mobileSheetTitleEl) return;
  _mobileSheetTitleEl.textContent =
    tab === "map" ? "Map" :
    tab === "person" ? "People" :
    tab === "cluster" ? "Cluster" :
    tab === "trees" ? "Trees" :
    tab === "tour" ? "Tour" :
    "AI";
}

function _kfSyncSideTabChrome(tab) {
  document.querySelectorAll("#sideTabs [data-side-tab]").forEach(btn => {
    btn.classList.toggle("on", btn.dataset.sideTab === tab);
  });
  document.querySelectorAll("#chatPanel .sidePane").forEach(pane => {
    pane.classList.toggle("on", tab !== "map" && pane.id === `${tab}Pane`);
  });
  _kfUpdateMobileSheetTitle(tab);
}

function _kfMarkMapTabActive() {
  if (!_kfIsMobileLayout()) return;
  _kfActiveSideTab = "map";
  if (typeof _kfSetMobileUxState === "function") _kfSetMobileUxState({ tab: "map" });
  _kfSyncSideTabChrome("map");
}

function _kfSyncMobileControlHeight() {
  const ui = $("ui");
  if (!ui) return;
  const tabs = $("sideTabs");
  const handle = $("mobileSheetHandle");
  const tabsHeight = _kfIsMobileLayout() ? 0 : (tabs?.getBoundingClientRect().height || 0);
  const h = Math.ceil(
    ui.getBoundingClientRect().height +
    tabsHeight +
    (handle?.getBoundingClientRect().height || 0),
  ) + 8;
  document.documentElement.style.setProperty("--kf-mobile-ui-h", `${Math.max(118, h)}px`);
}

function _kfSetMobileSheetState(state) {
  const panel = $("panel");
  if (!panel) return;
  const next = state === "full" || state === "open" ? state : "peek";
  panel.dataset.sheet = next;
  if (typeof _kfSetMobileUxState === "function") _kfSetMobileUxState({ sheet: next });
  if (next === "peek") _kfMarkMapTabActive();
  if (_mobileSheetHandleEl) {
    _mobileSheetHandleEl.setAttribute("aria-expanded", next !== "peek" ? "true" : "false");
    _mobileSheetHandleEl.setAttribute(
      "aria-label",
      next === "peek" ? "Open details panel" : "Adjust details panel",
    );
  }
  requestAnimationFrame(() => { resize(); renderMigBar(); });
}

function _kfPromoteMobileSheet() {
  const cur = $("panel")?.dataset.sheet || "peek";
  _kfSetMobileSheetState(cur === "peek" ? "open" : "full");
}

function _kfDemoteMobileSheet() {
  const cur = $("panel")?.dataset.sheet || "peek";
  _kfSetMobileSheetState(cur === "full" ? "open" : "peek");
}

function _kfBumpMobileSheetForTab(tab) {
  if (!_kfIsMobileLayout()) return;
  if (tab === "map") {
    _kfSetMobileSheetState("peek");
    return;
  }
  _kfSetMobileSheetState("open");
}

function _kfSetSideTab(tab) {
  let next = tab === "map" || tab === "person" || tab === "cluster" || tab === "trees" || tab === "tour" ? tab : "chat";
  if (next === "map" && !_kfIsMobileLayout()) next = "chat";
  if (next === "tour" && _kfDerivedCacheReady && typeof _kfShowYearTour === "function") _kfShowYearTour(false);
  if (_kfIsMobileLayout() && next !== "map" && playing) {
    if (typeof _kfSetPlayback === "function") _kfSetPlayback(false, { clearStop: true });
    else {
      playing = false;
      if (typeof _kfSetPlayButtonLabel === "function") _kfSetPlayButtonLabel();
    }
  }
  _kfActiveSideTab = next;
  if (typeof _kfSetMobileUxState === "function") _kfSetMobileUxState({ tab: next });
  _kfSyncSideTabChrome(next);
  if (next === "chat" && typeof _kfRefreshChatScope === "function") _kfRefreshChatScope();
  _kfBumpMobileSheetForTab(next);
}
document.querySelectorAll("#sideTabs [data-side-tab]").forEach(btn => {
  _kfBindTapOrClick(btn, e => {
    if (Date.now() < _kfSuppressSideTabClickUntil) {
      e?.preventDefault();
      e?.stopPropagation();
      return;
    }
    _kfSetSideTab(btn.dataset.sideTab);
  });
});
if (_kfIsMobileLayout()) _kfMarkMapTabActive();
else _kfUpdateMobileSheetTitle("chat");
_kfSetMobileSheetState("peek");
_kfSyncMobileControlHeight();
window.addEventListener("resize", () => {
  _kfSyncMobileControlHeight();
  if (!_kfIsMobileLayout()) {
    _kfSetMobileSheetState("peek");
    if (_kfActiveSideTab === "map") _kfSetSideTab("chat");
  } else if (($("panel")?.dataset.sheet || "peek") === "peek") {
    _kfMarkMapTabActive();
  }
});
const _kfMobileUiResizeObserver = typeof ResizeObserver !== "undefined"
  ? new ResizeObserver(() => _kfSyncMobileControlHeight())
  : null;
if (_kfMobileUiResizeObserver && $("ui")) _kfMobileUiResizeObserver.observe($("ui"));

function _kfInstallMobileSheetHandle(handleEl, opts = {}) {
  if (!handleEl) return;
  let drag = null;
  handleEl.addEventListener("pointerdown", e => {
    if (!_kfIsMobileLayout()) return;
    if (opts.ignoreDragSelector && e.target.closest(opts.ignoreDragSelector)) return;
    drag = {
      y: e.clientY,
      moved: false,
      ignoreTap: !!opts.ignoreTapSelector && !!e.target.closest(opts.ignoreTapSelector),
    };
    handleEl.setPointerCapture?.(e.pointerId);
  });
  handleEl.addEventListener("pointermove", e => {
    if (!drag) return;
    if (Math.abs(e.clientY - drag.y) > 8) {
      drag.moved = true;
      e.preventDefault();
    }
  });
  handleEl.addEventListener("pointerup", e => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    const moved = drag.moved;
    const ignoreTap = drag.ignoreTap;
    drag = null;
    if (moved) _kfSuppressSideTabClickUntil = Date.now() + 350;
    if (!moved) {
      if (ignoreTap) return;
      const cur = $("panel")?.dataset.sheet || "peek";
      if (cur === "peek") _kfSetMobileSheetState("open");
      else _kfSetMobileSheetState("peek");
    } else if (dy < -45) {
      _kfPromoteMobileSheet();
    } else if (dy > 45) {
      _kfDemoteMobileSheet();
    }
  });
  handleEl.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const cur = $("panel")?.dataset.sheet || "peek";
      _kfSetMobileSheetState(cur === "peek" ? "open" : "peek");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      _kfPromoteMobileSheet();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      _kfDemoteMobileSheet();
    }
  });
}
_kfInstallMobileSheetHandle(_mobileSheetHandleEl);
_kfInstallMobileSheetHandle(_mobileSheetTabsEl, { ignoreTapSelector: "[data-side-tab]" });
_kfInstallMobileSheetHandle($("ui"), { ignoreDragSelector: "button,input,select,textarea,.rangeMark" });

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
    group: "AI groups",
  })[mode] || "Cluster";
}

function _kfClusterSliceEntries(c) {
  if (clusterMode === "group" && typeof _kfGroupSliceEntries === "function") {
    return _kfGroupSliceEntries(c);
  }
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
    clusterMode === "parents" ? "Parents" : clusterMode === "gender" ? "Gender" : clusterMode === "tree" ? "Trees" : clusterMode === "group" ? "AI groups" : "Lineage",
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
  if (clusterMode === "group" && typeof _kfGroupIndexForDwell === "function") {
    const gi = _kfGroupIndexForDwell(di);
    if (gi >= 0 && typeof _kfGroupColor === "function") return _kfGroupColor(gi);
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
  const title = c.abbr ? `${c.abbr} cluster` :
    clusterMode === "group" && typeof _kfActiveGroupSetLabel === "function" ? `${_kfActiveGroupSetLabel()} cluster` :
    `${_kfClusterModeLabel()} cluster`;
  const prompt = _kfClusterPrompt(c, rows);
  const focusName = rows.focus?.focus?.name || "";
  const orderText = focusName
    ? `Ordered by relation to ${focusName}${clusterMode === "tree" ? ", grouped by tree" : ""}`
    : "Ordered by relation, evidence quality, and event year";
  _kfLastClusterContext = {
    title,
    year: Math.floor(curYear),
    mode: _kfClusterModeLabel(),
    count: rows.length,
    breakdown: _kfClusterSliceEntries(c)
      .filter(entry => entry.count)
      .map(entry => `${entry.label}: ${entry.count}`),
    people: rows.slice(0, 20).map(r => [r.name, r.rel && r.rel !== "self" ? r.rel : "", r.life, r.place].filter(Boolean).join(" / ")),
  };
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
    `<div class="cluster-list-head"><span class="cluster-list-title">People</span><span class="cluster-list-order">${escHtml(orderText)}</span></div>` +
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
      if (playing) { playing = false; _kfSetPlayButtonLabel(); }
      _kfShowPersonCard(di);
      fxCtx.clearRect(0, 0, W, H);
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
  _kfSetPeopleControlsCollapsed(true);

  const sex = ind.sex === "M" ? "Male" : ind.sex === "F" ? "Female" : "";
  const age = _kfLivingAgeLabel(ind);
  const rel = (relationCache && ind.id !== lastRootId) ? (relationCache.get(ind.id) || "") : "";
  console.log("[kf] personCard rel:", ind.id, "->", JSON.stringify(rel), "cacheSize:", relationCache?.size, "rootId:", lastRootId);
  const sub = [sex, age, rel].filter(Boolean).join(" · ");

  const clickedType = dwellType[di];
  const clickedYear = dwellY[di];
  const evidenceHtml = _kfDwellEvidenceBadgesHtml(di);
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
    if (_kfIsMobileLayout()) _kfSetMobileSheetState("peek");
    highlightedDwell = -1;
    highlightInferredYear = -1;
    highlightInferredSrcYear = -1;
    fxCtx.clearRect(0, 0, W, H);
    if (typeof _kfRefreshViewChrome === "function") _kfRefreshViewChrome(true);
  });
}

function _kfHidePersonCard() {
  if (_spEl) { _spEl.hidden = true; _spEl.innerHTML = ""; }
  if (_personEmptyEl) _personEmptyEl.hidden = false;
  _kfSetPeopleControlsCollapsed(false);
}
let _chatBusy = false;
const _kfQueuedChatQuestions = [];
let _kfChatDiagramSeq = 0;
const _kfChatDiagramSpecs = new Map();

function escChat(s) { return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

function _kfHideToolMarkersInChatText(text) {
  if (_chatShowTools) return String(text || "");
  return String(text || "")
    .replace(/<<KFCALL:\w+\((.*?)\)>>/gs, "")
    .replace(/<<KFCALL:[\s\S]*$/g, "")
    .trimEnd();
}

let _kfChatEntityCacheKey = "";
let _kfChatEntityCache = { people: new Map(), places: new Map() };

function _kfChatEntityKey(s) {
  return String(s || "").toLowerCase().replace(/[.,;:!?]+$/g, "").replace(/\s+/g, " ").trim();
}

function _kfChatAddPersonAlias(map, alias, canonical) {
  const key = _kfChatEntityKey(alias);
  if (key.length >= 5 && key.includes(" ") && !map.has(key)) map.set(key, canonical);
}

function _kfChatCanCenterPerson(ind) {
  if (!ind) return false;
  const di = typeof _kfLatestDwellOf === "function" ? _kfLatestDwellOf(ind) : -1;
  return di >= 0 && Number.isFinite(dwellLat?.[di]) && Number.isFinite(dwellLon?.[di]);
}

function _kfChatCanCenterPlace(place) {
  if (!geocoder) return false;
  const g = geocoder(place);
  return !!(g && Number.isFinite(g.lat) && Number.isFinite(g.lon));
}

function _kfChatAddPlaceAlias(map, alias, target, geoMemo) {
  const key = _kfChatEntityKey(alias);
  if (key.length < 4 || map.has(key)) return;
  const resolvedTarget = String(target || alias || "").trim();
  if (!resolvedTarget) return;
  let canCenter = geoMemo?.get(resolvedTarget);
  if (canCenter == null) {
    canCenter = _kfChatCanCenterPlace(resolvedTarget);
    geoMemo?.set(resolvedTarget, canCenter);
  }
  if (canCenter) map.set(key, resolvedTarget);
}

function _kfChatBuildEntityCache() {
  const loadedKey = _kfLoadedSources
    ? [..._kfLoadedSources.values()].map(s => `${s.source_id || s.name}:${s.n_individuals || 0}:${s.n_events || 0}`).join("|")
    : "";
  const selectedKey = _kfSelectedSourceIds ? [..._kfSelectedSourceIds].join(",") : "";
  const lastIdx = lastIndividuals && lastIndividuals.length ? lastIndividuals.length - 1 : -1;
  const geoKey = geocoder ? "geo1" : "geo0";
  const sourceKey = `${loadedKey}::${selectedKey}::${geoKey}::${lastIndividuals?.length || 0}:${lastIndividuals?.[0]?.id || ""}:${lastIdx >= 0 ? lastIndividuals[lastIdx]?.id || "" : ""}`;
  if (sourceKey === _kfChatEntityCacheKey) return _kfChatEntityCache;
  const people = new Map();
  const places = new Map();
  const placeGeoMemo = new Map();
  if (lastIndividuals) {
    for (const ind of lastIndividuals) {
      if (!_kfChatCanCenterPerson(ind)) continue;
      const name = String(ind?.name || "").trim();
      if (!name || name === "?") continue;
      _kfChatAddPersonAlias(people, name, name);
      _kfChatAddPersonAlias(people, name.replace(/,.*/, ""), name);
      _kfChatAddPersonAlias(people, name.replace(/^(Sir|Dame|Lady|Lord|King|Queen|Prince|Princess|Duke|Duchess|Earl|Count|Countess|Baron|Baroness|Rev\.?|Dr\.?)\s+/i, "").replace(/,.*/, ""), name);
    }
  }
  if (_kfLoadedSources) {
    for (const src of _kfLoadedSources.values()) {
      for (const ind of (src.individuals || [])) {
        for (const ev of (ind.events || [])) {
          const place = String(ev?.place || "").trim();
          if (!place) continue;
          _kfChatAddPlaceAlias(places, place, place, placeGeoMemo);
          const parts = place.split(",").map(p => p.trim()).filter(Boolean);
          parts.forEach((part, idx) => {
            _kfChatAddPlaceAlias(places, part, idx === 0 ? place : part, placeGeoMemo);
          });
          if (parts.length >= 2) _kfChatAddPlaceAlias(places, `${parts[0]}, ${parts[parts.length - 1]}`, place, placeGeoMemo);
        }
      }
    }
  }
  _kfChatEntityCacheKey = sourceKey;
  _kfChatEntityCache = { people, places };
  return _kfChatEntityCache;
}

function _kfChatEntityForText(text) {
  const { people, places } = _kfChatBuildEntityCache();
  const key = _kfChatEntityKey(text);
  if (people.has(key)) return { type: "person", value: people.get(key) };
  if (places.has(key) && _kfChatCanCenterPlace(places.get(key))) return { type: "place", value: places.get(key) };
  return null;
}

function _kfAutoLinkChatBody(root) {
  if (!root || !lastIndividuals) return;
  const entityRe = /\b[A-Z][A-Za-z'’.-]*(?:\s+(?:[A-Z][A-Za-z'’.-]*|of|de|del|la|le|van|von|der|den|the)){0,5}\b/g;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (parent.closest("a,button,code,pre,script,style,iframe,.chatDiagram")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    entityRe.lastIndex = 0;
    let match, last = 0, changed = false;
    const frag = document.createDocumentFragment();
    while ((match = entityRe.exec(text))) {
      const label = match[0];
      const entity = _kfChatEntityForText(label);
      if (!entity) continue;
      if (match.index > last) frag.append(document.createTextNode(text.slice(last, match.index)));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chatInlineLink";
      btn.dataset.chatLinkType = entity.type;
      btn.dataset.chatLinkValue = entity.value;
      btn.textContent = label;
      frag.append(btn);
      last = match.index + label.length;
      changed = true;
    }
    if (!changed) continue;
    if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

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
const _chatToolsPref = localStorage.getItem(CHAT_TOOLS_LS);
let _chatShowTools = _chatToolsPref === "1";

function _kfChatTreeScopeLabel() {
  if (typeof _kfSelectedVizSourceList !== "function") return "No selected trees";
  const sources = _kfSelectedVizSourceList();
  if (!sources.length) return "No selected trees";
  const names = sources.map(s => String(s.common_name || s.name || "Tree").replace(/\.(ged|gedcom|json)$/i, ""));
  if (names.length <= 2) return names.join(" + ");
  return `${names.slice(0, 2).join(" + ")} + ${names.length - 2} more`;
}

function _kfRefreshChatInsightHeader() {
  if (!chatInsightHeaderEl) return;
  const parts = [];
  if (timelineLoaded && Number.isFinite(curYear)) parts.push(String(Math.floor(curYear)));
  parts.push(_kfChatTreeScopeLabel());
  if (highlightedDwell >= 0 && lastIndividuals) {
    const ind = lastIndividuals[dwellIndi[highlightedDwell]];
    if (ind?.name) parts.push(`selected: ${ind.name}`);
  } else if (_kfLastClusterContext?.title) {
    parts.push(`cluster: ${_kfLastClusterContext.title}`);
  }
  if (chatInsightScopeEl) chatInsightScopeEl.textContent = parts.filter(Boolean).join(" | ");
  if (chatInsightModeEl) {
    const toolCount = chatHistory.filter(m => m.kind === "tool" || m.kind === "action").length;
    chatInsightModeEl.textContent = toolCount
      ? `${toolCount} evidence item${toolCount === 1 ? "" : "s"}`
      : "Evidence first";
  }
}

function _kfArtifactKindLabel(kind) {
  return kind === "viz" ? "VIZ" :
    kind === "group" ? "GROUP" :
    kind === "route" ? "ROUTE" :
    kind === "pin" ? "PIN" :
    kind === "report" ? "PDF" :
    "MAP";
}

function _kfShowMapFromArtifact() {
  if (typeof _kfShowVizPane === "function") _kfShowVizPane(false);
  if (typeof _kfSetSideTab === "function" && _kfIsMobileLayout()) _kfSetSideTab("map");
}

async function _kfOpenAiArtifact(id) {
  const artifact = chatArtifacts.find(a => a.id === Number(id));
  if (!artifact) return;
  if (artifact.action === "showVizById" && window.kfApi?.showVizById) {
    const args = artifact.args || {};
    const result = window.kfApi.showVizById(args?.id || args);
    if (result?.error && args?.type && args?.spec != null && window.kfApi?.showViz) {
      const restored = window.kfApi.showViz({ type: args.type, title: args.title || artifact.title, spec: args.spec });
      if (restored?.error && typeof appendError === "function") appendError(`Could not open artifact: ${restored.error}`);
    } else if (result?.error && typeof appendError === "function") {
      appendError(`Could not open artifact: ${result.error}`);
    }
    if (typeof _kfSetSideTab === "function" && _kfIsMobileLayout()) _kfSetSideTab("map");
    return;
  }
  if (artifact.action === "activateGroupSet" && window.kfApi?.activateGroupSet) {
    await window.kfApi.activateGroupSet(artifact.args?.id || artifact.args);
    _kfShowMapFromArtifact();
    return;
  }
  if (artifact.action === "traceLineage" && window.kfApi?.traceLineage) {
    const args = artifact.args || {};
    const result = await window.kfApi.traceLineage(args.from, args.to, args.opts || {});
    if (result?.error && typeof appendError === "function") appendError(`Could not open artifact: ${result.error}`);
    _kfShowMapFromArtifact();
    return;
  }
  if (artifact.action === "addRoute" && window.kfApi?.addRoute) {
    const result = await window.kfApi.addRoute(artifact.args || {});
    if (result?.error && typeof appendError === "function") appendError(`Could not open artifact: ${result.error}`);
    _kfShowMapFromArtifact();
    return;
  }
  if (artifact.action === "addPin" && window.kfApi?.addPin) {
    const result = await window.kfApi.addPin(artifact.args || {});
    if (result?.error && typeof appendError === "function") appendError(`Could not open artifact: ${result.error}`);
    _kfShowMapFromArtifact();
    return;
  }
  if (artifact.action === "exportAiReport" && window.kfApi?.exportAiReport) {
    await window.kfApi.exportAiReport();
    return;
  }
  _kfShowMapFromArtifact();
}

function _kfRenderChatArtifacts() {
  if (!chatArtifactsEl) return;
  if (!chatArtifacts.length) {
    chatArtifactsEl.hidden = true;
    chatArtifactsEl.innerHTML = "";
    return;
  }
  chatArtifactsEl.hidden = false;
  const cards = chatArtifacts.slice(0, 8).map(a => {
    const title = escChat(a.title || "Artifact");
    const subtitle = a.subtitle ? `<span>${escChat(a.subtitle)}</span>` : "";
    return `<button type="button" class="chatArtifact" data-artifact-id="${a.id}">` +
      `<b>${_kfArtifactKindLabel(a.kind)}</b><span class="chatArtifactText"><strong>${title}</strong>${subtitle}</span>` +
    `</button>`;
  }).join("");
  chatArtifactsEl.innerHTML = `<div class="chatRailHead">Artifacts</div><div class="chatArtifactRail">${cards}</div>`;
  chatArtifactsEl.querySelectorAll("[data-artifact-id]").forEach(btn => {
    _kfBindTapOrClick(btn, () => {
      _kfOpenAiArtifact(btn.dataset.artifactId).catch(e => appendError(`Could not open artifact: ${e?.message || e}`));
    });
  });
}

function _kfRecordAiArtifact(input = {}) {
  if (!input || typeof input !== "object") return null;
  const title = String(input.title || input.label || input.kind || "Artifact").trim();
  if (!title) return null;
  const action = input.action || "map";
  const key = input.key || `${input.kind || "map"}:${action}:${title}:${JSON.stringify(input.args || null)}`;
  const existing = chatArtifacts.find(a => a.key === key);
  if (existing) {
    existing.subtitle = input.subtitle || existing.subtitle;
    existing.args = input.args || existing.args;
    existing.updated_at = Date.now();
    _kfRenderChatArtifacts();
    return existing;
  }
  const artifact = {
    id: ++_kfChatArtifactSeq,
    key,
    kind: input.kind || "map",
    title,
    subtitle: input.subtitle || "",
    action,
    args: input.args || null,
    created_at: Date.now(),
  };
  chatArtifacts.unshift(artifact);
  while (chatArtifacts.length > 24) chatArtifacts.pop();
  _kfRenderChatArtifacts();
  return artifact;
}

function _kfClearChatArtifacts() {
  chatArtifacts.length = 0;
  _kfChatArtifactSeq = 0;
  _kfRenderChatArtifacts();
}

function _kfRenderChatEvidence() {
  if (!chatEvidenceEl || !chatEvidenceBodyEl) return;
  const evidence = chatHistory.filter(m => m.kind === "tool" || m.kind === "action");
  if (!evidence.length) {
    chatEvidenceEl.hidden = true;
    chatEvidenceBodyEl.innerHTML = "";
    return;
  }
  chatEvidenceEl.hidden = false;
  const summary = chatEvidenceEl.querySelector("summary");
  if (summary) summary.textContent = `Evidence (${evidence.length})`;
  chatEvidenceBodyEl.innerHTML = evidence.slice(-10).map(m => {
    const label = m.kind === "tool" ? "Tool result" : "Action";
    return `<div class="chatEvidenceItem"><b>${label}</b><div>${renderMd(_kfPlainEnglishEventText(_kfHideToolMarkersInChatText(m.content || "")))}</div></div>`;
  }).join("");
}

function _kfChatContentSignal(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  const normalized = raw
    .replace(/<<KFCALL:[\s\S]*$/g, "")
    .replace(/<<KFCALL:\w+\((.*?)\)>>/gs, "")
    .replace(/<<KFCHIP:[\s\S]*?>>/gs, "")
    .replace(/[`*_]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return !!normalized && !new Set([
    "thinking...",
    "thinking",
    "using the data...",
    "using the data",
    "summarizing evidence gathered so far...",
  ]).has(normalized);
}

function _kfChatMessageHasSignal(m) {
  if (!m || m.kind === "tool" || m.kind === "action") return false;
  if (m.role === "user") return _kfChatContentSignal(m.content);
  return _kfChatContentSignal(_kfHideToolMarkersInChatText(m.content || ""));
}

function _kfBuildChatTurns() {
  const turns = [];
  let current = null;
  for (let i = 0; i < chatHistory.length; i++) {
    const m = chatHistory[i];
    if (!m) continue;
    if (m.role === "user") {
      current = {
        key: `turn-${i}`,
        userIndex: i,
        question: String(m.content || "").trim(),
        user: m,
        messages: [],
        chips: [],
        answered: false,
        pending: false,
      };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = {
        key: "system",
        userIndex: -1,
        question: "Status",
        user: null,
        messages: [],
        chips: [],
        answered: false,
        pending: false,
      };
      turns.push(current);
    }
    current.messages.push(m);
    if (m.chips?.length) {
      for (const chip of m.chips) current.chips.push({ message: m, chip });
    }
    if (_kfChatMessageHasSignal(m) && m.role !== "user" && m.kind !== "notice") current.answered = true;
    if (String(m.content || "").trim() === "_thinking..._" || String(m.content || "").trim() === "_summarizing evidence gathered so far..._") current.pending = true;
  }
  return turns;
}

function _kfQuestionChipLabel(text) {
  const s = _kfPlainEnglishEventText(String(text || "")).replace(/\s+/g, " ").trim();
  return s.length > 74 ? s.slice(0, 71) + "..." : s || "Question";
}

function _kfRenderQuestionRail(turns) {
  if (!chatQuestionRailEl) return;
  const questionTurns = turns.filter(t => t.user);
  if (!questionTurns.length) {
    chatQuestionRailEl.hidden = true;
    chatQuestionRailEl.innerHTML = "";
    return;
  }
  chatQuestionRailEl.hidden = false;
  chatQuestionRailEl.innerHTML = `<div class="chatRailHead">Questions</div><div class="chatQuestionChips">` +
    questionTurns.map((turn, idx) => {
      const cls = [
        "chatQuestionChip",
        turn.answered ? "answered" : "unanswered",
        turn.pending && !turn.answered ? "pending" : "",
        turn.key === _kfActiveChatTurnKey ? "active" : "",
      ].filter(Boolean).join(" ");
      const state = turn.answered ? "Answered" : turn.pending ? "Researching" : "Unanswered";
      return `<button type="button" class="${cls}" data-chat-turn="${escChat(turn.key)}" title="${escChat(turn.question)}">` +
        `<span>${idx + 1}. ${escChat(_kfQuestionChipLabel(turn.question))}</span><b>${state}</b></button>`;
    }).join("") + `</div>`;
  chatQuestionRailEl.querySelectorAll("[data-chat-turn]").forEach(btn => {
    _kfBindTapOrClick(btn, () => {
      _kfActiveChatTurnKey = btn.dataset.chatTurn || "";
      renderChat();
    });
  });
}

function _kfChatMessageHtml(m, opts = {}) {
  const rawContent = m.role === "user" ? m.content : _kfHideToolMarkersInChatText(m.content);
  const body = m.role === "user" ? escChat(rawContent) : renderMd(_kfPlainEnglishEventText(rawContent));
  const kindClass = m.kind === "tool" ? " tool" : m.kind === "action" ? " action" : m.kind === "notice" ? " notice" : m.kind === "error" ? " err" : "";
  const who = opts.who || (m.role === "user" ? "you" : m.kind === "tool" ? "tool" : m.kind === "action" ? "action" : m.kind === "notice" ? "app" : "claude");
  return `<div class="msg ${m.role}${kindClass}"><span class="who">${escChat(who)}</span><div class="body">${body}</div></div>`;
}

function _kfActivityCard(turn) {
  const toolRounds = turn.messages.filter(m => m.kind === "tool").length;
  const actions = turn.messages.filter(m => m.kind === "action" || m.kind === "notice").length;
  const phase = toolRounds >= MAX_TOOL_ROUNDS ? "Summarizing evidence" :
    toolRounds > 0 ? "Researching with tree data" :
    "Reading the selected trees";
  const stats = [
    toolRounds ? `${toolRounds} tool ${toolRounds === 1 ? "round" : "rounds"}` : "",
    actions ? `${actions} action ${actions === 1 ? "event" : "events"}` : "",
  ].filter(Boolean).join(" · ");
  return `<div class="chatActivityCard" aria-live="polite">` +
    `<div class="chatActivityTrack"><span></span><span></span><span></span><span></span></div>` +
    `<b>${phase}</b><p>${stats || "Preparing the first evidence pass."}</p>` +
  `</div>`;
}

function _kfAnswerMessagesForTurn(turn) {
  const candidates = turn.messages.filter(m => m.kind !== "tool" && m.kind !== "action");
  const signal = candidates.filter(m => _kfChatMessageHasSignal(m));
  if (signal.length) return signal;
  const errors = candidates.filter(m => /\[error\]|\berror\b/i.test(String(m.content || "")));
  if (errors.length) return errors;
  return [];
}

function _kfRenderActiveAnswer(turns) {
  if (!chatAnswerEl) return;
  if (!turns.length) {
    chatAnswerEl.innerHTML = `<div class="empty">Ask anything: "Where did the family migrate between 1880 and 1940?", "Who's selected and how are we related?", "Summarize my paternal line." Set your Anthropic API key with the key button — stored locally only.</div>`;
    return;
  }
  let turn = turns.find(t => t.key === _kfActiveChatTurnKey);
  if (!turn) {
    turn = turns[turns.length - 1];
    _kfActiveChatTurnKey = turn.key;
  }
  _kfRenderedChatChipRefs = [];
  const answerMessages = _kfAnswerMessagesForTurn(turn);
  const answerHtml = answerMessages.length
    ? answerMessages.map(m => _kfChatMessageHtml(m, { who: m.kind === "notice" ? "app" : "answer" })).join("")
    : _kfActivityCard(turn);
  const chipsHtml = turn.chips.length
    ? `<div class="chatChips chatAnswerChips">${turn.chips.map(({ chip }, i) => {
        _kfRenderedChatChipRefs.push(turn.chips[i]);
        return `<button type="button" class="chatChip${chip._spent ? " spent" : ""}" data-chip-ref="${i}" title="${escChat(_kfPlainEnglishEventText(chip.label || "(chip)"))}">${escChat(_kfPlainEnglishEventText(chip.label || "(chip)"))}</button>`;
      }).join("")}</div>`
    : "";
  chatAnswerEl.innerHTML =
    `<section class="chatActiveAnswer">` +
      (turn.user ? `<div class="chatActiveQuestion"><span>Question</span><p>${escChat(turn.question || "Question")}</p></div>` : "") +
      `<div class="chatActiveBody">${answerHtml}${chipsHtml}</div>` +
    `</section>`;
  _kfBindChatAnswerControls(chatAnswerEl);
}

function _kfRenderHistoryDrawer(visible) {
  if (!chatHistoryEl) return;
  if (chatHistoryDrawerEl) {
    chatHistoryDrawerEl.hidden = chatHistory.length === 0;
    const summary = chatHistoryDrawerEl.querySelector("summary");
    if (summary) summary.textContent = `History (${visible.length})`;
  }
  if (!visible.length) {
    chatHistoryEl.innerHTML = `<div class="empty">Tool calls hidden. Toggle "tools" to show them.</div>`;
    return;
  }
  chatHistoryEl.innerHTML = visible.map(m => _kfChatMessageHtml(m)).join("");
}

function _kfBindChatAnswerControls(root) {
  root.querySelectorAll(".msg.bot:not(.tool):not(.action) .body").forEach(_kfAutoLinkChatBody);
  root.querySelectorAll(".chatInlineLink[data-chat-link-type]").forEach(btn => {
    btn.addEventListener("click", () => {
      const value = btn.dataset.chatLinkValue || "";
      if (!value || !window.kfApi) return;
      if (btn.dataset.chatLinkType === "person") {
        window.kfApi.selectPerson(value);
        window.kfApi.centerOn(value);
      } else {
        window.kfApi.centerOn(value);
      }
    });
  });
  root.querySelectorAll(".chatChip[data-chip-ref]").forEach(btn => {
    _kfBindTapOrClick(btn, async () => {
      const ref = _kfRenderedChatChipRefs[Number(btn.dataset.chipRef)];
      const chip = ref?.chip;
      if (!chip) return;
      btn.classList.add("running");
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = "...";
      let spentChanged = false;
      try {
        const ok = await _kfDispatchChip(chip);
        if (ok !== false) {
          chip._spent = true;
          spentChanged = true;
        }
      } finally {
        if (btn.isConnected) {
          btn.disabled = !!chip._spent;
          btn.classList.toggle("spent", !!chip._spent);
          btn.classList.remove("running");
          btn.textContent = orig;
        } else if (spentChanged) {
          renderChat();
        }
      }
    });
  });
  root.querySelectorAll(".chatDiagramOpen[data-mermaid-id]").forEach(btn => {
    btn.addEventListener("click", () => _kfOpenChatMermaid(btn.dataset.mermaidId));
  });
}

function renderChat() {
  _kfRefreshChatInsightHeader();
  _kfRenderChatArtifacts();
  _kfRenderChatEvidence();
  const turns = _kfBuildChatTurns();
  if (!_kfActiveChatTurnKey || !turns.some(t => t.key === _kfActiveChatTurnKey)) {
    _kfActiveChatTurnKey = turns.length ? turns[turns.length - 1].key : "";
  }
  _kfRenderQuestionRail(turns);
  _kfRenderActiveAnswer(turns);
  const visible = _chatShowTools ? chatHistory : chatHistory.filter(m => m.kind !== "tool" && m.kind !== "action");
  _kfRenderHistoryDrawer(visible);
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
    return false;
  }
  const fn = window.kfApi && window.kfApi[chip.method];
  if (typeof fn !== "function") {
    _kfReportChipResult(chip, { error: `no kfApi method: ${chip.method}` });
    return false;
  }
  try {
    const args = _kfChipDispatchArgs(chip);
    const r = Array.isArray(args)
      ? await fn.apply(window.kfApi, args)
      : await fn.call(window.kfApi, args);
    // For lens-author chips, auto-activate after save and report row count.
    if (chip.method === "saveLens" && r && r.ok && r.lens && window.kfApi.activateLens) {
      const a = await window.kfApi.activateLens(r.lens);
      _kfReportChipResult(chip, { saved: r.lens, activated: a });
      return true;
    } else if ((chip.method === "sendChat" || chip.method === "chat") && r && r.ok) {
      return true;
    } else if ((chip.method === "sendChat" || chip.method === "chat") && r && r.error) {
      chatHistory.push({ role: "bot", content: `*[error]* ${r.error}` });
      renderChat();
      return false;
    } else {
      _kfReportChipResult(chip, r);
      return !(r && r.error);
    }
  } catch (e) {
    _kfReportChipResult(chip, { error: e?.message || String(e) });
    return false;
  }
}

const _KF_AI_VISUALIZATION_SUFFIX =
  "Answer in concise prose. For named people and family-specific claims, separate direct tree evidence from inference and historical context. When a map view, chart, timeline, network, or diagram would make the answer clearer, also create it as a visualization tab or activate the appropriate map view. If no visualization would help, say so briefly.";

function _kfAugmentAiSuggestionQuestion(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (raw.includes(_KF_AI_VISUALIZATION_SUFFIX)) return raw;
  return `${raw}\n\n${_KF_AI_VISUALIZATION_SUFFIX}`;
}

function _kfDisplayAiSuggestionQuestion(text) {
  let raw = String(text || "").trim();
  if (raw.endsWith(_KF_AI_VISUALIZATION_SUFFIX)) {
    raw = raw.slice(0, -_KF_AI_VISUALIZATION_SUFFIX.length).trim();
  }
  return raw;
}

function _kfChipDispatchArgs(chip) {
  const method = String(chip?.method || "");
  const args = chip?.args;
  if (method !== "chat" && method !== "sendChat") return args;
  if (typeof args === "string") return {
    text: _kfAugmentAiSuggestionQuestion(args),
    displayText: _kfDisplayAiSuggestionQuestion(args),
  };
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const text = typeof args.text === "string" ? args.text : "";
    return text ? {
      ...args,
      text: _kfAugmentAiSuggestionQuestion(text),
      displayText: args.displayText || _kfDisplayAiSuggestionQuestion(text),
    } : args;
  }
  return args;
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
      summary = `\u2713 **${chip.label || lensName}** activated. ${n} rows rendered.`;
    }
  } else if (chip.method === "activateLens") {
    summary = `\u2713 **${chip.label}** activated.`;
  } else if (chip.method === "showViz") {
    if (r && r.ok) {
      summary = `\u2713 **${chip.label || r.title || r.type}** opened in a new tab above the map.`;
    } else {
      summary = `\u2717 **${chip.label || chip.method}** failed: ${r && r.error || "unknown error"}`;
    }
  } else if (chip.method === "traceLineage") {
    const from = r?.from?.name || (Array.isArray(chip.args) ? chip.args[0] : "");
    const to = r?.to?.name || (Array.isArray(chip.args) ? chip.args[1] : "");
    const relation = r?.relationship ? ` Relationship: ${r.relationship}.` : "";
    summary = `\u2713 **${chip.label || "Trace lineage"}** drew a lineage path${from && to ? ` from **${from}** to **${to}**` : ""}.${relation}`;
  } else if (chip.method === "addRoute") {
    const label = r?.route?.label || chip.label || "Route";
    summary = `\u2713 **${label}** was added to the map.`;
  } else if (chip.method === "addPin") {
    const label = r?.pin?.label || chip.label || "Pin";
    summary = `\u2713 **${label}** was pinned on the map.`;
  } else if (chip.method === "selectPerson") {
    const name = r?.person?.name || chip.label || "Person";
    summary = `\u2713 Selected **${name}**.`;
  } else if (chip.method === "centerOn") {
    const name = r?.person?.name || r?.place || chip.label || "Location";
    summary = `\u2713 Centered the map on **${name}**.`;
  } else if (chip.method === "setClusterMode") {
    summary = `\u2713 Switched clustering to **${r?.mode || chip.args || chip.label || "selected mode"}**.`;
  } else if (r && r.ok) {
    summary = `\u2713 **${chip.label || chip.method}** completed.`;
  } else {
    const out = (r && typeof r === "object") ? JSON.stringify(r).slice(0, 200) : String(r);
    summary = `\u2713 **${chip.label || chip.method}**: ${out}`;
  }
  // User-triggered chip feedback is not tool output and should remain visible
  // when tool logs are hidden. Mark it as a notice so it is not replayed back
  // to Claude as if Claude said it.
  chatHistory.push({ role: "bot", kind: "notice", content: summary });
  renderChat();
  const last = chatAnswerEl?.lastElementChild || chatHistoryEl?.lastElementChild;
  if (last && last.scrollIntoView) {
    last.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}
function appendError(text) {
  chatHistory.push({ role: "bot", kind: "error", content: `*[error]* ${String(text || "")}` });
  renderChat();
}

const _KF_STANDARD_AI_QUESTIONS = [
  {
    label: "Immigration waves",
    text: "Summarize the waves of immigration in my family. Separate direct tree evidence, inferred transitions, and historical context. Cite important surnames, transition years, and people with source-marked historical significance.",
  },
  {
    label: "Farthest-moving surnames",
    text: "Which surnames moved the farthest across generations? Cite example people, routes, and approximate distances, and mark movement as inferred when it comes from separated records.",
  },
  {
    label: "Rural to city",
    text: "When did my family shift from rural places to cities? Identify the biggest transition decades and branches.",
  },
  {
    label: "Family crossroads",
    text: "Which places acted as family crossroads? Explain which surnames and branches repeatedly appear there.",
  },
  {
    label: "Stable branches",
    text: "Which branches stayed geographically stable the longest? Cite the dominant places and year ranges.",
  },
  {
    label: "Moved together",
    text: "Which families or surnames repeatedly migrated together? Cite shared routes and example people, and distinguish repeated tree patterns from historical context.",
  },
  {
    label: "History overlaps",
    text: "Which ancestors were alive during slavery, wars, or major historical transitions? Separate direct tree evidence from historical context, and make clear that overlap does not prove participation.",
  },
  {
    label: "Distant marriages",
    text: "Which marriages joined geographically distant branches? Cite spouse names, places, and approximate distance.",
  },
  {
    label: "Deepest branches",
    text: "Which branch has the deepest documented ancestry? Rank the deepest people and surnames by generation depth.",
  },
  {
    label: "Migration jumps",
    text: "Where are the biggest unexplained migration jumps? Flag jumps with large time gaps between records and avoid implying continuous travel across the whole gap.",
  },
];

function _kfStandardAiQuestions() {
  return _KF_STANDARD_AI_QUESTIONS.map(q => q.text);
}

function _kfQuestionDef(label, text) {
  return { label, text };
}

function _kfIsYearDependentQuestion(q) {
  const text = String(q?.text || "").toLowerCase();
  return /\b(this year|visible people|current year|shown here|in \d{3,4}|at \d{3,4}|visible in|pattern in)\b/.test(text);
}

function _kfIsCacheableScopeQuestion(q) {
  const text = String(q?.text || "");
  if (typeof _kfIsTreeLevelCacheableQuestion === "function") {
    return _kfIsTreeLevelCacheableQuestion(text);
  }
  return !_kfIsYearDependentQuestion(q) && _KF_STANDARD_AI_QUESTIONS.some(s => s.text === text);
}

function _kfOrderChatScopeQuestions(questions, primaryCount) {
  const primary = [];
  const used = new Set();
  for (const q of questions) {
    if (_kfIsYearDependentQuestion(q) || !_kfIsCacheableScopeQuestion(q)) continue;
    primary.push(q);
    used.add(q.text);
    if (primary.length >= primaryCount) break;
  }
  const yearDependent = questions.filter(q => !used.has(q.text) && _kfIsYearDependentQuestion(q));
  const otherCacheable = questions.filter(q => !used.has(q.text) && !_kfIsYearDependentQuestion(q) && _kfIsCacheableScopeQuestion(q));
  const other = questions.filter(q => !used.has(q.text) && !_kfIsYearDependentQuestion(q) && !_kfIsCacheableScopeQuestion(q));
  return {
    primary,
    secondary: [...yearDependent, ...otherCacheable, ...other],
  };
}

function _kfChatScopeQuestions(root, selected, visible) {
  const y = Math.floor(curYear);
  const questions = [
    _kfQuestionDef("This year", `Explain this year in plain language.`),
    _kfQuestionDef("Visible people", `Why are these people visible in ${y}?`),
    _kfQuestionDef("Migration story", `Summarize the migration story for the visible people in ${y}. Separate recorded locations, inferred movement, and historical context.`),
    _kfQuestionDef("Cluster pattern", `Explain the biggest place or cluster pattern in ${y}.`),
    ..._kfStandardAiQuestions(),
  ];
  if (_kfShowDataQualityConcerns) questions.push(_kfQuestionDef("Weak evidence", `Find the weakest location evidence in the checked trees at ${y}.`));
  if (selected?.name) questions.unshift(_kfQuestionDef("Selected person", `Why is ${selected.name} shown here in ${y}?`));
  else if (root?.name) questions.unshift(_kfQuestionDef("Home person", `What should I notice about ${root.name}'s family in ${y}?`));
  if (visible?.count > 500) questions.push(_kfQuestionDef("Simplify view", `Give me the simplest way to understand these ${visible.count} visible people.`));
  const out = [];
  const seen = new Set();
  for (const q of questions) {
    const item = typeof q === "string"
      ? (_KF_STANDARD_AI_QUESTIONS.find(s => s.text === q) || _kfQuestionDef(q, q))
      : q;
    const text = String(item.text || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push({ label: item.label || text, text });
  }
  return out.slice(0, 12);
}

function _kfBindChatScopeQuestions() {
  if (!chatScopeEl) return;
  if (chatScopeEl.dataset.kfQuestionDelegate === "1") return;
  chatScopeEl.dataset.kfQuestionDelegate = "1";
  const buttonFrom = target => target?.closest?.("[data-chat-scope-question]");
  const clearPending = () => { _kfChatScopePendingTap = null; };
  const dispatch = (text, button = null) => {
    text = String(text || "").trim();
    if (!text || _kfChatScopeDispatching) return;
    _kfChatScopeDispatching = true;
    _kfChatScopeLastHandledAt = Date.now();
    if (button?.isConnected) {
      button.classList.add("running");
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    }
    const finish = () => {
      _kfChatScopeDispatching = false;
      if (button?.isConnected) {
        button.disabled = false;
        button.classList.remove("running");
        button.removeAttribute("aria-busy");
      }
      _kfRefreshChatScope(true);
    };
    try {
      if (typeof _kfAskQuestion === "function") {
        Promise.resolve(_kfAskQuestion(_kfAugmentAiSuggestionQuestion(text), { displayText: text, queueIfBusy: true }))
          .catch(e => appendError(e?.message || String(e)));
      } else {
        chatInputEl.value = text;
        chatInputEl.focus();
      }
    } catch (e) {
      appendError(e?.message || String(e));
    } finally {
      setTimeout(finish, 120);
    }
  };
  chatScopeEl.addEventListener("pointerdown", e => {
    const btn = buttonFrom(e.target);
    if (!btn || btn.disabled) return;
    _kfChatScopePendingTap = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      text: btn.getAttribute("data-chat-scope-question") || "",
      button: btn,
    };
  });
  window.addEventListener("pointerup", e => {
    const tap = _kfChatScopePendingTap;
    if (!tap || tap.pointerId !== e.pointerId) return;
    clearPending();
    if (Math.abs(e.clientX - tap.x) > 10 || Math.abs(e.clientY - tap.y) > 10) return;
    e.preventDefault();
    dispatch(tap.text, tap.button);
  });
  window.addEventListener("pointercancel", clearPending);
  chatScopeEl.addEventListener("click", e => {
    const btn = buttonFrom(e.target);
    if (!btn) return;
    e.preventDefault();
    if (Date.now() - _kfChatScopeLastHandledAt < 500) return;
    dispatch(btn.getAttribute("data-chat-scope-question") || "", btn);
  });
}

function _kfToggleChatMoreQuestions(e) {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  _kfChatScopePendingTap = null;
  _kfChatMoreQuestionsOpen = !_kfChatMoreQuestionsOpen;
  _kfChatScopeLastRenderKey = "";
  _kfRefreshChatScope(true);
}

function _kfBindChatMoreToggle() {
  if (!chatScopeEl) return;
  chatScopeEl.querySelectorAll("[data-chat-more]").forEach(btn => {
    if (btn.dataset.kfMoreBound === "1") return;
    btn.dataset.kfMoreBound = "1";
    _kfBindTapOrClick(btn, _kfToggleChatMoreQuestions);
  });
}

function _kfRefreshChatScope(force = false) {
  if (!chatScopeEl) return;
  if (_kfChatScopePendingTap || _kfChatScopeDispatching) return;
  if (!timelineLoaded || !lastIndividuals) {
    chatScopeEl.hidden = true;
    chatScopeEl.innerHTML = "";
    _kfChatScopeLastRenderKey = "";
    return;
  }
  chatScopeEl.hidden = false;
  const visible = typeof _kfVisibleMarkerData === "function" ? _kfVisibleMarkerData() : null;
  const root = lastRootId && lastIndiById ? lastIndiById.get(lastRootId) : null;
  const selected = highlightedDwell >= 0 && lastIndividuals ? lastIndividuals[dwellIndi[highlightedDwell]] : null;
  const questions = _kfChatScopeQuestions(root, selected, visible);
  const key = questions.map(q => `${q.label}:${q.text}`).join("|");
  if (!force && key === _kfChatScopeLastRenderKey) return;
  _kfChatScopeLastRenderKey = key;
  const renderQuestion = q => {
    const yearDependent = _kfIsYearDependentQuestion(q);
    const cls = `chatChip chat-scope-question${yearDependent ? " year-dependent" : ""}`;
    const label = yearDependent
      ? `${escChat(q.label)} <span class="chip-badge">YEAR</span>`
      : escChat(q.label);
    return `<button type="button" class="${cls}" data-chat-scope-question="${escChat(q.text)}" title="${escChat(q.text)}">${label}</button>`;
  };
  const primaryCount = _kfIsMobileLayout() ? 3 : 4;
  const { primary, secondary } = _kfOrderChatScopeQuestions(questions, primaryCount);
  chatScopeEl.innerHTML = questions.length
    ? `<div class="chatScopeHead">Suggested questions</div>` +
      `<div class="chatChips chat-scope-actions" aria-label="Suggested questions">${primary.map(renderQuestion).join("")}</div>` +
      (secondary.length
        ? `<button type="button" class="chatMoreToggle" data-chat-more="1" aria-expanded="${_kfChatMoreQuestionsOpen ? "true" : "false"}">${_kfChatMoreQuestionsOpen ? "Fewer ideas" : `More ideas (${secondary.length})`}</button>` +
          (_kfChatMoreQuestionsOpen ? `<div class="chatMoreQuestions"><div class="chatChips">${secondary.map(renderQuestion).join("")}</div></div>` : "")
        : "")
    : "";
  _kfBindChatMoreToggle();
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

let _kfLastClusterContext = null;

function _kfChatContextProfile(userMsg = "", opts = {}) {
  const q = String(userMsg || "").toLowerCase();
  const cacheSafe = !!opts.cacheSafe;
  const wantsBroadTree = /\b(immigration|migration waves?|migration patterns?|family story|summari[sz]e|deepest|slavery|war|historical|rural|urban|crossroads|stable branches|distant marriages|moved together|co-?migrat|farthest|jumps?)\b/.test(q);
  const wantsMap = /\b(map|marker|visible|shown|current view|current year|viewport|screen|where|location|place|state|city|cluster|nearby|around|all over|same time|together)\b/.test(q);
  const wantsList = /\b(who|which|list|people|persons|markers|visible people|shown|everyone|all|same time|together|all over)\b/.test(q);
  return {
    includeUser: !cacheSafe,
    includeSelected: !cacheSafe && highlightedDwell >= 0 && /\b(selected|this person|this marker|marker|him|her|they|them|relation|relationship|lineage|family|parents|children|spouse|why|where is|who is|show|center)\b/.test(q),
    includeVisibleCounts: !cacheSafe && timelineLoaded && wantsMap,
    includeViewport: !cacheSafe && timelineLoaded && /\b(viewport|screen|current map|on map|visible|shown)\b/.test(q),
    includeTopPlaces: !cacheSafe && timelineLoaded && wantsMap,
    includeMarkerSample: !cacheSafe && timelineLoaded && wantsMap && wantsList && !wantsBroadTree,
    includeCluster: !cacheSafe && /\b(cluster|this group|these people|selected group)\b/.test(q),
    markerSampleLimit: Number.isFinite(Number(opts.markerSampleLimit)) ? Math.max(0, Math.min(40, Number(opts.markerSampleLimit))) : 20,
  };
}

function _kfAppendVisibleMarkerContext(lines, profile) {
  if (!profile.includeVisibleCounts && !profile.includeTopPlaces && !profile.includeMarkerSample) return;
  const visible = typeof _kfVisibleMarkerData === "function" ? _kfVisibleMarkerData() : null;
  const visibleRows = visible?.rows || [];
  const totalVisible = visible?.count ?? visibleRows.length;
  lines.push(`Visible map marker total after current tree/filter/year: ${totalVisible.toLocaleString()} people.`);
  if (profile.includeViewport) {
    const viewportVisible = typeof _kfVisibleMarkerViewportCount === "function"
      ? _kfVisibleMarkerViewportCount(visibleRows)
      : totalVisible;
    if (viewportVisible !== totalVisible) {
      lines.push(`Current map viewport contains ${viewportVisible.toLocaleString()} of those ${totalVisible.toLocaleString()} people; legend counts are shown as viewport / total.`);
    }
  }
  if (visible?.sourceCounts?.size) {
    const sources = Array.from(visible.sourceCounts.entries())
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .slice(0, 5)
      .map(([name, n]) => `${String(name || "unknown").replace(/\.ged$/i, "")}: ${n}`);
    if (sources.length) lines.push(`Visible marker counts by tree: ${sources.join("; ")}.`);
  }
  if (profile.includeTopPlaces && typeof _kfVisibleRowsForYear === "function") {
    const yearly = _kfVisibleRowsForYear(Math.floor(curYear));
    const places = Array.from(yearly.placeCounts.entries())
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .slice(0, 8)
      .map(([place, n]) => `${place}: ${n}`);
    if (places.length) lines.push(`Top places among visible markers: ${places.join("; ")}.`);
  }
  if (profile.includeMarkerSample && profile.markerSampleLimit > 0) {
    const showSource = typeof _kfSelectedVizSourceList === "function" && _kfSelectedVizSourceList().length > 1;
    const values = [];
    for (const row of visibleRows) {
      const source = showSource && row.source ? `; ${row.source}` : "";
      const precision = row.imprecise && row.precision ? `; approximate ${row.precision}` : "";
      values.push(`${row.ind.name} (${row.year}, ${row.place || "unknown place"}${precision}${source})`);
      if (values.length >= profile.markerSampleLimit) break;
    }
    if (values.length > 0) {
      lines.push(`Small sample of rendered map markers only (first ${values.length.toLocaleString()} of ${totalVisible.toLocaleString()}, not the total): ${values.join("; ")}.`);
    }
  }
}

function _kfAppendClusterContext(lines, profile) {
  if (!profile.includeCluster || !_kfLastClusterContext) return;
  const c = _kfLastClusterContext;
  lines.push(`Selected cluster: ${c.title}; ${c.count.toLocaleString()} people visible in ${c.year}; mode ${c.mode}.`);
  if (c.breakdown.length) lines.push(`Cluster breakdown: ${c.breakdown.join("; ")}.`);
  if (c.people.length) lines.push(`Cluster people sample: ${c.people.join("; ")}${c.count > c.people.length ? `; plus ${c.count - c.people.length} more` : ""}.`);
}

function buildChatContext(userMsg = "", opts = {}) {
  const profile = _kfChatContextProfile(userMsg, opts);
  const lines = [];
  if (profile.includeUser) lines.push(_kfLoggedInUserContextLine());
  if (lastIndividuals) {
    lines.push(`Tree: ${lastIndividuals.length.toLocaleString()} individuals, ${dwellY ? dwellY.length.toLocaleString() : 0} events.`);
    lines.push(`Year range: ${minYear}-${maxYear}.`);
  }
  lines.push("Evidence rule for this answer: named-person and family-specific claims must come from selected tree data or tool results; inferred movement must be labeled as inference; broader history must be labeled as context, not tree evidence.");
  if (typeof _kfSelectedVizSourceList === "function") {
    const sources = _kfSelectedVizSourceList();
    if (sources.length) lines.push(`Selected trees: ${sources.map(s => s.name).join("; ")}.`);
    if (sources.some(s => _kfIsPublicDemoSourceName(s.name))) {
      lines.push("DEMO privacy note: living people are anonymized and retain birth years and birth locations only; names, relationships, full dates, and other living-person details are intentionally removed.");
    }
  }
  if (!opts.cacheSafe) {
    lines.push(`Data quality concerns setting: ${_kfShowDataQualityConcerns ? "on" : "off"}. This indicates ${_kfShowDataQualityConcerns ? "interest" : "lack of current interest"} in weak evidence, chronology warnings, and data-quality visualizations.`);
    if (lastRootId) {
      const root = lastIndiById?.get(lastRootId);
      if (root) lines.push(`Root: ${root.name} (${root.birth_year ?? "?"}-${root.death_year ?? "?"}).`);
    }
    lines.push(`Currently viewing year: ${Math.floor(curYear)}, year-window: ${dwellWindow}y back.`);
    if (typeof _kfViewModeLabel === "function") lines.push(`Current map filters: ${_kfViewModeLabel()}.`);
  }
  if (profile.includeSelected && highlightedDwell >= 0 && lastIndividuals) {
    const sel = lastIndividuals[dwellIndi[highlightedDwell]];
    if (sel) {
      const place = dwellPlace[highlightedDwell] >= 0 ? placesList[dwellPlace[highlightedDwell]] : "";
      lines.push(`Selected: ${sel.name} (${sel.birth_year ?? "?"}-${sel.death_year ?? "?"})${place ? ", at " + place : ""}, dwell year ${dwellY[highlightedDwell]}.`);
    }
  }
  _kfAppendVisibleMarkerContext(lines, profile);
  _kfAppendClusterContext(lines, profile);
  return lines.join("\n");
}
