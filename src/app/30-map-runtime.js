const _ro = new ResizeObserver(() => { resize(); renderMigBar(); });
queueMicrotask(() => { const wrap = $("mapWrap"); if (wrap) _ro.observe(wrap); });

let _baseDirty = false;

// d3-zoom, d3-drag, versor quaternion helpers, and Safari GestureEvent
// handlers all removed. MapLibre owns pan/zoom/pinch/rotate now, and
// fxCanvas has pointer-events:none so interactions fall through to the map.

function _kfIsClusterSelectionMode() {
  return clusterMode !== "none" && !!_kfActiveLens === false &&
    (clusterMode === "aggregate" || clusterMode === "pie" || clusterMode === "parents" ||
     clusterMode === "gender"    || clusterMode === "tree" || clusterMode === "state" ||
     clusterMode === "group"     || (clusterMode === "dispersion" && zoomTransform.k < 2));
}

function _kfPickDeckClusterAt(x, y) {
  const clusters = _kfGetClustersForDeck();
  if (!clusters || !clusters.length) return null;
  let bestCluster = null, bestD2 = Infinity;
  for (const cl of clusters) {
    if (!cl.position) continue;
    const [lon, lat] = cl.position;
    const p = _kfMap ? _kfMap.project([lon, lat]) : null;
    if (!p) continue;
    const dx = p.x - x, dy = p.y - y;
    const d2 = dx * dx + dy * dy;
    const rPx = ((cl.radius || 0) + 8) ** 2;
    if (d2 < rPx && d2 < bestD2) { bestD2 = d2; bestCluster = cl; }
  }
  return bestCluster;
}

function _kfPickClusterAt(x, y) {
  if (clusterMode === "aggregate" || (clusterMode === "dispersion" && zoomTransform.k < 2)) {
    return _kfPickDeckClusterAt(x, y);
  }
  return _kfHitTestFxCluster(x, y);
}

($("mapWrap")).addEventListener("click", e => {
  if (!timelineLoaded) return;
  const _rect = $("mapWrap").getBoundingClientRect();
  const x = e.clientX - _rect.left, y = e.clientY - _rect.top;

  // In cluster modes the individual dots are hidden, so clicking the map
  // selects the cluster. Person selection happens from the cluster tab list.
  if (_kfIsClusterSelectionMode()) {
    const cluster = _kfPickClusterAt(x, y);
    if (cluster && cluster.members && cluster.members.length) {
      const selectedFocusId = highlightedDwell >= 0 && lastIndividuals && dwellIndi
        ? lastIndividuals[dwellIndi[highlightedDwell]]?.id || null
        : null;
      pushHistory();
      highlightedDwell = -1;
      highlightInferredYear = -1;
      highlightInferredSrcYear = -1;
      if (playing) { playing = false; _kfSetPlayButtonLabel(); }
      _kfShowClusterCard(cluster, { selectedId: selectedFocusId, focusId: selectedFocusId || lastRootId });
      fxCtx.clearRect(0, 0, W, H);
    }
    return;
  }

  const HIT_RADIUS = _kfIsMobileLayout() ? 24 : 14;
  const HIT_R2 = HIT_RADIUS * HIT_RADIUS;
  rebuildPersonMarkers();
  let bestI = -1, bestDist = Infinity;
  for (let m = 0; m < _kfDwellCount; m++) {
    const i = _kfPersonDwell[m];
    if (i == null || i < 0) continue;
    const sx = dwellSx[i], sy = dwellSy[i];
    if (sx < 0 || sx > W || sy < 0 || sy > H) continue;
    const ddx = sx - x, ddy = sy - y;
    const dist = ddx * ddx + ddy * ddy;
    if (dist < bestDist) { bestDist = dist; bestI = i; }
  }
  if (bestI < 0 || bestDist > HIT_R2) return;
  pushHistory();
  const sameAsSelected = highlightedDwell === bestI && highlightInferredYear < 0;
  if (sameAsSelected) {
    highlightedDwell = -1;
    highlightInferredYear = -1;
    highlightInferredSrcYear = -1;
    _kfHidePersonCard();
  } else {
    highlightedDwell = bestI;
    highlightInferredYear = -1;
    highlightInferredSrcYear = -1;
    if (playing) { playing = false; _kfSetPlayButtonLabel(); }
    _kfShowPersonCard(bestI);
  }
  fxCtx.clearRect(0, 0, W, H);
});

function hitTestMap(x, y, hitR2 = 14 * 14) {
  if (!timelineLoaded) return -1;
  rebuildPersonMarkers();
  let bestI = -1, bestDist = Infinity;
  for (let m = 0; m < _kfDwellCount; m++) {
    const i = _kfPersonDwell[m];
    if (i == null || i < 0) continue;
    const sx = dwellSx[i], sy = dwellSy[i];
    if (sx < 0 || sx > W || sy < 0 || sy > H) continue;
    const ddx = sx - x, ddy = sy - y;
    const dist = ddx * ddx + ddy * ddy;
    if (dist < bestDist) { bestDist = dist; bestI = i; }
  }
  return bestDist <= hitR2 ? bestI : -1;
}

const hoverTip = $("hoverTip");
function _kfHitTestFxCluster(mx, my) {
  if (!_kfFxClusterHits || !_kfFxClusterHits.length) return null;
  for (const c of _kfFxClusterHits) {
    if (c.kind === "circle") {
      const dx = mx - c.cx, dy = my - c.cy;
      if (dx * dx + dy * dy <= c.r * c.r) return c;
    } else if (c.kind === "state") {
      if (!_kfStateFeatures) continue;
      const ll = projection.invert([mx, my]);
      if (!ll) continue;
      const f = _kfStateFeatures[c.stateIdx];
      if (!f) continue;
      const bb = _kfStateBoxes && _kfStateBoxes[c.stateIdx];
      if (bb && (ll[0] < bb[0] || ll[0] > bb[2] || ll[1] < bb[1] || ll[1] > bb[3])) continue;
      if (d3.geoContains(f, ll)) return c;
    }
  }
  return null;
}

($("mapWrap")).addEventListener("mousemove", e => {
  const _rect = $("mapWrap").getBoundingClientRect();
  const _mx = e.clientX - _rect.left, _my = e.clientY - _rect.top;
  // Cluster hover takes precedence over individual-person hover. With person
  // markers hidden in cluster modes, dwell hit-test would miss anyway; in
  // hull mode (where dots ARE visible) cluster shape is large so the user
  // can still hover the dots in gaps between cluster ring outlines.
  const cluster = _kfHitTestFxCluster(_mx, _my);
  if (cluster) {
    hoverTip.innerHTML = _kfFormatClusterTooltip(cluster);
    hoverTip.style.left = (_mx + 12) + "px";
    hoverTip.style.top  = (_my + 12) + "px";
    hoverTip.style.display = "block";
    return;
  }
  // Per-person hover removed by request — only cluster hover surfaces
  // breakdowns. Hide the tooltip when no cluster is under the cursor.
  hoverTip.style.display = "none";
});
($("mapWrap")).addEventListener("mouseleave", () => { hoverTip.style.display = "none"; });

// View-history stack (infinite). Each entry is a snapshot of the user-visible
// view state at a point in time. We push BEFORE a change is committed so the
// Back button restores what was on screen before that interaction.
const viewHistory = [];
let _restoringView = false;
function snapshotView() {
  const mv = _kfMap && _kfMap.loaded()
    ? { center: _kfMap.getCenter().toArray(), zoom: _kfMap.getZoom(), bearing: _kfMap.getBearing() }
    : null;
  return {
    highlightedDwell, highlightInferredYear, highlightInferredSrcYear,
    curYear,
    loopBegin: _kfLoopBegin,
    loopEnd: _kfLoopEnd,
    zoom: { ...zoomTransform },
    mapView: mv,
    rootId: lastRootId,
  };
}
function pushHistory() {
  if (_restoringView) return;
  viewHistory.push(snapshotView());
}
function restoreView(s) {
  if (!s) return;
  _restoringView = true;
  try {
    if (s.rootId !== lastRootId && s.rootId) applyRoot(s.rootId);
    highlightedDwell = s.highlightedDwell;
    highlightInferredYear = s.highlightInferredYear;
    highlightInferredSrcYear = s.highlightInferredSrcYear;
    curYear = s.curYear;
    _kfLoopBegin = Number.isFinite(s.loopBegin) ? s.loopBegin : null;
    _kfLoopEnd = Number.isFinite(s.loopEnd) ? s.loopEnd : null;
    range.value = curYear;
    // Restore the MapLibre map view if we captured one. zoomTransform is
    // legacy state; the map's own center/zoom is what actually positions
    // the basemap and our re-projected dwells.
    if (_kfMap && s.mapView) {
      _kfMap.jumpTo({ center: s.mapView.center, zoom: s.mapView.zoom, bearing: s.mapView.bearing || 0 });
    }
    if (timelineLoaded) {
      projectAll();
      fxCtx.clearRect(0, 0, W, H);
      if (highlightedDwell >= 0) _kfShowPersonCard(highlightedDwell);
      if (typeof _kfRefreshViewChrome === "function") _kfRefreshViewChrome(true);
    }
    _kfRefreshLoopControls();
  } finally {
    _restoringView = false;
  }
}
function backOneStep() {
  if (viewHistory.length === 0) return;
  const s = viewHistory.pop();
  restoreView(s);
}

function centerOnGeo(lon, lat, opts = {}) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
  if (_kfMap) {
    const target = { center: [lon, lat], duration: 600, essential: true };
    const zoom = Number(typeof opts === "number" ? opts : opts.zoom);
    if (Number.isFinite(zoom)) target.zoom = Math.max(0, Math.min(18, zoom));
    _kfMap.flyTo(target);
  }
}

let staticLabelRects = [];
function rectsOverlap(a, b) {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

function drawBase() {
  // MapLibre GL renders the basemap (land, ocean, country/state borders,
  // labels) directly via vector tiles. baseCanvas is hidden via CSS. The
  // only thing this stub still does is reset the label-rect collision set
  // so frame()'s in-frame text rendering can place labels without
  // duplicates.
  staticLabelRects = [];
}

const COLOR_PATERNAL   = [40, 100, 220];
const COLOR_MATERNAL   = [220, 60, 90];
const COLOR_OTHER      = [80, 160, 100];
const COLOR_NO_PARENT  = [0, 0, 0];
const COLOR_ONE_PARENT = [110, 110, 115];
// Gender palette. M = blue (matches paternal), F = red (matches maternal),
// U/unknown = neutral gray so unset sex is visually distinct from confirmed.
const COLOR_GENDER_M   = [40, 100, 220];
const COLOR_GENDER_F   = [220, 60, 90];
const COLOR_GENDER_U   = [140, 140, 150];
// Tree palette. The selected-tree color cache starts from a stable name hash
// but linearly probes to avoid same-color tree slices within the active set.
const TREE_PALETTE = [
  [40, 100, 220], [220, 60, 90],  [80, 160, 100],
  [200, 130, 50], [140, 80, 200], [60, 180, 200],
  [200, 80, 160], [140, 150, 60],
];
let _kfTreeColorIdx = 0;
function _kfHashString(name) {
  if (!name) return 0;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}
function _kfTreeColorFromName(name) {
  return _kfHashString(name) % TREE_PALETTE.length;
}
function _kfHslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)      { r = c; g = x; }
  else if (h < 120){ r = x; g = c; }
  else if (h < 180){ g = c; b = x; }
  else if (h < 240){ g = x; b = c; }
  else if (h < 300){ r = x; b = c; }
  else             { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
function _kfTreeColorKey(rgb) {
  return `${rgb[0]},${rgb[1]},${rgb[2]}`;
}
let _kfTreeColorCacheKey = "";
let _kfTreeColorCache = new Map();
function _kfBuildTreeColorCache() {
  const sources = _kfSelectedVizSourceList();
  const key = sources.map(s => `${s.source_id}:${s.name}`).join("|");
  if (key === _kfTreeColorCacheKey) return;
  _kfTreeColorCacheKey = key;
  _kfTreeColorCache = new Map();
  const used = new Set();
  const sorted = sources.slice().sort((a, b) => (a.source_id || 0) - (b.source_id || 0) || a.name.localeCompare(b.name));
  for (const src of sorted) {
    const start = _kfTreeColorFromName(src.name);
    let color = null;
    for (let step = 0; step < TREE_PALETTE.length; step++) {
      const candidate = TREE_PALETTE[(start + step) % TREE_PALETTE.length];
      const colorKey = _kfTreeColorKey(candidate);
      if (!used.has(colorKey)) { color = candidate; break; }
    }
    if (!color) {
      let salt = 0;
      do {
        const hue = (_kfHashString(`${src.name}:${salt}`) % 360 + 360) % 360;
        color = _kfHslToRgb(hue, 0.62, 0.48);
        salt++;
      } while (used.has(_kfTreeColorKey(color)) && salt < 720);
    }
    _kfTreeColorCache.set(src.name, color);
    used.add(_kfTreeColorKey(color));
  }
}
function _kfTreeColorForName(name) {
  _kfBuildTreeColorCache();
  return _kfTreeColorCache.get(name) || TREE_PALETTE[_kfTreeColorFromName(name)];
}
let colorMode = "lineage";  // "lineage" | "gender" | "tree"
function colorFor(s) { return s === 0 ? COLOR_PATERNAL : s === 1 ? COLOR_MATERNAL : COLOR_OTHER; }
function colorForFinal(side, _parStat, indiIdx) {
  if (colorMode === "gender") {
    const ind = (indiIdx != null && lastIndividuals) ? lastIndividuals[indiIdx] : null;
    const sex = ind && ind.sex;
    return sex === "M" ? COLOR_GENDER_M : sex === "F" ? COLOR_GENDER_F : COLOR_GENDER_U;
  }
  if (colorMode === "tree") {
    const name = _kfSourceNameForIndiIdx(indiIdx);
    return _kfTreeColorForName(name);
  }
  return colorFor(side);
}
function updateMapLegend() {
  const el = document.getElementById("mapLegend");
  if (!el || el.classList.contains("hidden")) return;

  // --- compute viewport stats ---
  const isIndividualMode = !(clusterMode === "pie" || clusterMode === "parents" ||
    clusterMode === "gender" || clusterMode === "tree" ||
    clusterMode === "aggregate" || clusterMode === "dispersion" || clusterMode === "state" ||
    clusterMode === "group");

  let total = _kfDwellCount || 0;
  let inView = total;
  // [paternal, maternal, other]
  const sideTot = [0, 0, 0], sideView = [0, 0, 0];
  // {M, F, U}
  const sexTot = {M:0, F:0, U:0}, sexView = {M:0, F:0, U:0};
  const treeTot = new Map(), treeView = new Map();
  function incTree(map, name) {
    map.set(name, (map.get(name) || 0) + 1);
  }

  const bounds = _kfMap && _kfMap.getBounds ? _kfMap.getBounds() : null;
  let groupLegendEntries = null;
  if (clusterMode === "group" && typeof _kfActiveGroupLegendEntries === "function") {
    groupLegendEntries = _kfActiveGroupLegendEntries(bounds);
    total = groupLegendEntries.reduce((sum, e) => sum + e.total, 0);
    inView = groupLegendEntries.reduce((sum, e) => sum + e.visible, 0);
  }

  if (bounds && total && _kfDwellPositions && _kfPersonDwell && _kfPersonIndi && clusterMode !== "group") {
    const bW = bounds.getWest(), bE = bounds.getEast();
    const bS = bounds.getSouth(), bN = bounds.getNorth();
    inView = 0;
    for (let m = 0; m < total; m++) {
      const lon = _kfDwellPositions[m * 2];
      const lat = _kfDwellPositions[m * 2 + 1];
      const v = lon >= bW && lon <= bE && lat >= bS && lat <= bN;
      if (v) inView++;
      if (isIndividualMode) {
        const side = (dwellSide && _kfPersonDwell[m] >= 0) ? (dwellSide[_kfPersonDwell[m]] ?? 2) : 2;
        const si = side < 2 ? side : 2;
        sideTot[si]++;
        if (v) sideView[si]++;
        const ind = lastIndividuals ? lastIndividuals[_kfPersonIndi[m]] : null;
        const sx = ind ? (ind.sex === "M" ? "M" : ind.sex === "F" ? "F" : "U") : "U";
        sexTot[sx]++;
        if (v) sexView[sx]++;
        const treeName = _kfSourceNameForIndiIdx(_kfPersonIndi[m]);
        incTree(treeTot, treeName);
        if (v) incTree(treeView, treeName);
      }
    }
  } else if (isIndividualMode && total && _kfPersonDwell && _kfPersonIndi) {
    for (let m = 0; m < total; m++) {
      const side = (dwellSide && _kfPersonDwell[m] >= 0) ? (dwellSide[_kfPersonDwell[m]] ?? 2) : 2;
      const si = side < 2 ? side : 2;
      sideTot[si]++; sideView[si]++;
      const ind = lastIndividuals ? lastIndividuals[_kfPersonIndi[m]] : null;
      const sx = ind ? (ind.sex === "M" ? "M" : ind.sex === "F" ? "F" : "U") : "U";
      sexTot[sx]++; sexView[sx]++;
      incTree(treeTot, _kfSourceNameForIndiIdx(_kfPersonIndi[m]));
      incTree(treeView, _kfSourceNameForIndiIdx(_kfPersonIndi[m]));
    }
  }

  // suffix: "view/total" or just "total" if no bounds info
  function cnt(t, v) {
    if (!t) return "";
    const s = bounds ? `${v} / ${t}` : `${t}`;
    return ` <span style="color:#9aa6bc;font-size:10px;font-variant-numeric:tabular-nums;">(${s})</span>`;
  }
  function dot(rgb, label, t, v) {
    const c = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    return `<div><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${c};margin-right:5px;vertical-align:middle;"></span>${label}${cnt(t, v)}</div>`;
  }
  function hdr(text) {
    return `<div style="font-weight:700;font-size:10px;letter-spacing:0.06em;text-transform:uppercase;color:#888;margin:5px 0 3px;">${text}</div>`;
  }
  function swatch(color, size, shape, label, t, v) {
    let s = "";
    if (shape === "diamond") {
      s = `<span style="display:inline-block;width:${size}px;height:${size}px;border-radius:1px;transform:rotate(45deg);border:1.5px solid ${color};margin-right:6px;vertical-align:middle;"></span>`;
    } else if (shape === "square") {
      s = `<span style="display:inline-block;width:${size}px;height:${size}px;border:1.5px solid ${color};margin-right:6px;vertical-align:middle;"></span>`;
    } else if (shape === "arc") {
      s = `<span style="display:inline-block;width:${size+4}px;height:${Math.ceil(size/2)+2}px;border-top:2px solid ${color};border-radius:50% 50% 0 0;margin-right:5px;vertical-align:middle;"></span>`;
    } else {
      s = `<span style="display:inline-block;width:${size}px;height:${size}px;border-radius:50%;background:${color};margin-right:5px;vertical-align:middle;"></span>`;
    }
    return `<div>${s}${label}${cnt(t, v)}</div>`;
  }

  let html = "";

  // Cluster-specific legends override the particle color legend
  if (clusterMode === "pie") {
    html += hdr("Lineage clusters");
    html += dot(COLOR_PATERNAL, "Paternal slice");
    html += dot(COLOR_MATERNAL, "Maternal slice");
    html += dot(COLOR_OTHER,    "Collateral slice");
    html += `<div style="font-size:10px;color:#9aa6bc;margin-top:3px;">Circle size = people count</div>`;
  } else if (clusterMode === "parents") {
    html += hdr("Parent knowledge");
    html += dot([80, 160, 100],  "2 parents known");
    html += dot([200, 160, 60],  "1 parent known");
    html += dot([180, 80, 80],   "0 parents known");
    html += `<div style="font-size:10px;color:#9aa6bc;margin-top:3px;">Circle size = people count</div>`;
  } else if (clusterMode === "gender") {
    html += hdr("Gender clusters");
    html += dot(COLOR_GENDER_M, "Male");
    html += dot(COLOR_GENDER_F, "Female");
    html += dot(COLOR_GENDER_U, "Unknown");
    html += `<div style="font-size:10px;color:#9aa6bc;margin-top:3px;">Circle size = people count</div>`;
  } else if (clusterMode === "tree") {
    html += hdr("Tree clusters");
    for (const src of _kfSelectedVizSourceList()) {
      html += dot(_kfTreeColorForName(src.name), src.name.replace(/\.ged$/i, ""));
    }
    html += `<div style="font-size:10px;color:#9aa6bc;margin-top:3px;">Circle size = people count</div>`;
  } else if (clusterMode === "aggregate" || clusterMode === "dispersion") {
    html += hdr("Density");
    html += `<div><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#2864dc;margin-right:5px;vertical-align:middle;"></span>Few people</div>`;
    html += `<div><span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#2864dc;margin-right:5px;vertical-align:middle;"></span>Many people</div>`;
  } else if (clusterMode === "state") {
    html += hdr("US States");
    html += `<div style="font-size:10px;color:#566480;">Color and label show the state abbreviation. Circle size = people count.</div>`;
  } else if (clusterMode === "group") {
    html += hdr(_kfActiveGroupSetLabel ? _kfActiveGroupSetLabel() : "AI groups");
    const entries = groupLegendEntries || [];
    if (entries.length) {
      for (const entry of entries) html += dot(entry.color, entry.label, entry.total, entry.visible);
      html += `<div style="font-size:10px;color:#9aa6bc;margin-top:3px;">Circle size = people count. Color = AI-defined group.</div>`;
    } else {
      html += `<div style="font-size:10px;color:#566480;">No active AI group members are visible for this year.</div>`;
    }
  } else {
    // "none" or unknown — show individual particle legend
    if (colorMode === "gender") {
      html += hdr("Gender");
      html += dot(COLOR_GENDER_M, "Male",    sexTot.M, sexView.M);
      html += dot(COLOR_GENDER_F, "Female",  sexTot.F, sexView.F);
      html += dot(COLOR_GENDER_U, "Unknown", sexTot.U, sexView.U);
    } else if (colorMode === "tree") {
      html += hdr("Tree");
      const sources = _kfSelectedVizSourceList();
      for (const src of sources) {
        html += dot(
          _kfTreeColorForName(src.name),
          src.name.replace(/\.ged$/i, ""),
          treeTot.get(src.name) || 0,
          treeView.get(src.name) || 0,
        );
      }
    } else {
      html += hdr("Lineage");
      html += dot(COLOR_PATERNAL, "Paternal line", sideTot[0], sideView[0]);
      html += dot(COLOR_MATERNAL, "Maternal line", sideTot[1], sideView[1]);
      html += dot(COLOR_OTHER,    "Collateral",    sideTot[2], sideView[2]);
      html += hdr("Parents");
      html += swatch("#566480", 10, "circle",  "Both known");
      html += swatch("#566480",  9, "diamond", "One unknown");
      html += swatch("#566480",  9, "square",  "Both unknown");
    }
    html += hdr("Place precision");
    html += swatch("rgba(42,74,140,0.86)", 8, "circle", "City point");
    html += swatch("rgba(42,74,140,0.54)", 16, "circle", "County/region area");
    html += swatch("rgba(42,74,140,0.36)", 24, "circle", "State/country area");
    html += `<div style="font-size:10px;color:#9aa6bc;margin-top:2px;">Large translucent circles mean approximate locations, not exact cities.</div>`;
  }

  if (flowFromY && flowFromY.length && clusterMode === "none" && !_kfActiveLens) {
    html += hdr("Migration");
    if (migrationViz === "observations") {
      html += swatch("#2a4a8c", 12, "arc", "Observation pulse");
      html += `<div style="font-size:10px;color:#9aa6bc;margin-top:2px;">Arcs appear near the destination record date; faint arcs mark gaps over ${FLOW_AMBIGUOUS_GAP_YEARS} years.</div>`;
    } else {
      html += swatch("#2a4a8c", 8, "circle", "Continuous movement");
      html += `<div style="font-size:10px;color:#9aa6bc;margin-top:2px;">Short gaps animate between records; long gaps animate only near the destination year.</div>`;
    }
  }

  // Kin lines annotation (appended regardless of cluster mode)
  if (kinLinesN > 0) {
    html += hdr("Kin lines");
    html += swatch(`rgb(${COLOR_PATERNAL[0]},${COLOR_PATERNAL[1]},${COLOR_PATERNAL[2]})`, 12, "arc",
      "Paternal lineage");
    html += swatch(`rgb(${COLOR_MATERNAL[0]},${COLOR_MATERNAL[1]},${COLOR_MATERNAL[2]})`, 12, "arc",
      "Maternal lineage");
    html += swatch(`rgb(${COLOR_OTHER[0]},${COLOR_OTHER[1]},${COLOR_OTHER[2]})`, 12, "arc",
      "Collateral");
    html += `<div style="font-size:10px;color:#9aa6bc;margin-top:2px;">Arc color = lineage side of source person &middot; ${kinLinesN} nearest kin</div>`;
  }

  // Summary stats
  if (total > 0) {
    const viewStr = bounds ? `${inView} / ${total}` : `${total}`;
    html += `<div style="border-top:1px solid #e0e6ee;margin-top:5px;padding-top:4px;font-size:10px;color:#566480;font-variant-numeric:tabular-nums;">`;
    html += `<span style="font-weight:700;">${viewStr}</span> shown in ${Math.floor(curYear)}`;
    if (bounds) html += ` <span style="color:#9aa6bc;">(view / total)</span>`;
    html += `</div>`;
  }

  el.innerHTML = html;
}

function drawShape(ctx, x, y, r, ps) {
  if (ps === 2) {
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  } else if (ps === 1) {
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawPrecisionMarker(ctx, x, y, level, rgb, parentStatus = 0, opacityScale = 1) {
  const alpha = Math.max(0.05, Math.min(1, (_kfGeoMarkerAlpha(level) / 255) * opacityScale));
  if (_kfGeoIsImprecise(level)) {
    const r = _kfGeoMarkerRadiusPx(level);
    ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.min(0.75, alpha + 0.16).toFixed(3)})`;
    ctx.lineWidth = level === GEO_LEVEL_COUNTRY ? 1.4 : 1;
    ctx.beginPath();
    ctx.arc(x, y, r + 2, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.min(0.95, alpha).toFixed(3)})`;
  drawShape(ctx, x, y, 4.2, parentStatus);
}

function lowerBound(arr, order, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (arr[order[m]] < target) lo = m + 1; else hi = m; }
  return lo;
}

function drawGreatCircle(ctx, lon0, lat0, lon1, lat1) {
  const dist = d3.geoDistance([lon0, lat0], [lon1, lat1]);
  if (dist < 1e-6) return;
  const interp = d3.geoInterpolate([lon0, lat0], [lon1, lat1]);
  const segs = Math.max(2, Math.min(40, Math.ceil(dist * 30)));
  let started = false;
  ctx.beginPath();
  for (let i = 0; i <= segs; i++) {
    const p = safeProject(interp(i / segs));
    if (!p) { started = false; continue; }
    if (!started) { ctx.moveTo(p[0], p[1]); started = true; }
    else ctx.lineTo(p[0], p[1]);
  }
  ctx.stroke();
}

function positionOnGreatCircle(lon0, lat0, lon1, lat1, t) {
  return safeProject(d3.geoInterpolate([lon0, lat0], [lon1, lat1])(t));
}

function safeProject(lonlat) {
  const p = projection(lonlat);
  if (!p) return null;
  if (projectionName === "ortho") {
    const r = projection.rotate();
    const center = [-r[0], -r[1]];
    if (d3.geoDistance(lonlat, center) > Math.PI / 2 + 0.001) return null;
  }
  return p;
}
function projectAll() {
  for (let i = 0; i < dwellLat.length; i++) {
    const p = safeProject([dwellLon[i], dwellLat[i]]);
    if (p) { dwellSx[i] = p[0]; dwellSy[i] = p[1]; } else { dwellSx[i] = -9999; dwellSy[i] = -9999; }
  }
  for (let i = 0; i < flowFromLat.length; i++) {
    const a = safeProject([flowFromLon[i], flowFromLat[i]]); const b = safeProject([flowToLon[i], flowToLat[i]]);
    flowFromSx[i] = a ? a[0] : -9999; flowFromSy[i] = a ? a[1] : -9999;
    flowToSx[i] = b ? b[0] : -9999; flowToSy[i] = b ? b[1] : -9999;
  }
}

function frame(activeTrailFade) {
  // While the MapLibre basemap is being dragged/zoomed, the fxCanvas dwell
  // positions change every tick. The trail-fade compositing leaves ghost
  // pixels at old positions, which produces a blink. Force a full clear
  // during map movement so each frame redraws cleanly.
  if (_kfMapMoving || migrationViz === "observations" || migrationViz === "lines" || highlightedDwell >= 0) {
    fxCtx.clearRect(0, 0, W, H);
  } else {
    fxCtx.globalCompositeOperation = "destination-out";
    fxCtx.fillStyle = `rgba(0,0,0,${activeTrailFade})`;
    fxCtx.fillRect(0, 0, W, H);
    fxCtx.globalCompositeOperation = "source-over";
  }
  if (!timelineLoaded) return;
  _kfRefreshViewChrome();

  const y = curYear, dw = dwellWindow;
  const lo = lowerBound(dwellY, dwellOrder, y - dw), hi = lowerBound(dwellY, dwellOrder, y + 1);
  fxCtx.textAlign = "left"; fxCtx.textBaseline = "middle";
  const renderClusters = clusterMode !== "none" && clusterMode !== "dispersion";
  const useDispersion = clusterMode === "dispersion" && zoomTransform.k < 2;
  const useClusterReplace = renderClusters;
  // Aggregate and dispersion (at low zoom) cluster modes are drawn by deck.gl.
  // The fxCanvas cluster path is only kept for "pie" which has no clean deck.gl equivalent.
  const clusterOnDeck = !!_kfDeckOverlay && (
       clusterMode === "aggregate"
    || (clusterMode === "dispersion" && zoomTransform.k < 2)
  );
  if ((renderClusters || useDispersion) && !clusterOnDeck) {
    // Cluster aggregation now uses the person-marker set — one dwell entry
    // per ALIVE person at curYear (filtered by ancestors/blood/status the
    // same way deck.gl renders). This fixes the bug where clusters counted
    // long-dead people because the legacy loop iterated all past dwells.
    const visible = [];
    for (let m = 0; m < _kfDwellCount; m++) {
      const i = _kfPersonDwell[m];
      if (i == null || i < 0) continue;
      const sx = dwellSx[i], sy = dwellSy[i];
      if (sx < -10 || sx > W + 10 || sy < -10 || sy > H + 10) continue;
      if (clusterMode === "group" && (typeof _kfGroupIndexForDwell !== "function" || _kfGroupIndexForDwell(i) < 0)) continue;
      visible.push(i);
    }
    const mode = useDispersion ? "aggregate" : clusterMode;
    drawClusters(visible, clusterRadius, mode, y, dw);
    if (highlightedDwell >= 0) drawHighlight();
    return;
  }
  if (!_kfDwellsOnDeck) {
    rebuildPersonMarkers();
    for (let m = 0; m < _kfDwellCount; m++) {
      const i = _kfPersonDwell[m];
      if (i == null || i < 0) continue;
      const sx = dwellSx[i], sy = dwellSy[i];
      if (sx < -10 || sx > W + 10 || sy < -10 || sy > H + 10) continue;
      const c = colorForFinal(dwellSide[i], dwellSrc[i], dwellIndi[i]);
      const level = dwellLevel ? dwellLevel[i] : (dwellExact[i] ? GEO_LEVEL_CITY : GEO_LEVEL_ADMIN1);
      drawPrecisionMarker(fxCtx, sx, sy, level, c, dwellSrc[i]);
    }
  }

  if (_kfFlowsOnDeck) {
    // Flows render via deck.gl ArcLayer; skip the fxCanvas flow paths.
  } else if (migrationViz === "observations") {
    const fLen = flowFromY.length;
    for (let i = 0; i < fLen; i++) {
      const pulse = _kfObservationPulse(i, y);
      if (!pulse || !_kfFlowPassesFilter(i)) continue;
      const lon0 = flowFromLon[i], lat0 = flowFromLat[i], lon1 = flowToLon[i], lat1 = flowToLat[i];
      if (lon0 === lon1 && lat0 === lat1) continue;
      const c = colorForFinal(flowSide[i], flowSrc[i], flowIndi[i]);
      const alpha = pulse.ambiguous
        ? (0.12 + 0.22 * pulse.strength)
        : (0.35 + 0.45 * pulse.strength);
      fxCtx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha.toFixed(3)})`;
      fxCtx.lineWidth = pulse.ambiguous ? 0.8 : 1.6;
      drawGreatCircle(fxCtx, lon0, lat0, lon1, lat1);
      const fromLevel = flowFromLevel ? flowFromLevel[i] : (flowExact[i] ? GEO_LEVEL_CITY : GEO_LEVEL_ADMIN1);
      if (_kfGeoIsImprecise(fromLevel)) {
        const p0 = safeProject([lon0, lat0]);
        if (p0) drawPrecisionMarker(fxCtx, p0[0], p0[1], fromLevel, c, flowSrc[i], 0.55 * pulse.strength);
      }
      const p = safeProject([lon1, lat1]);
      if (p) {
        fxCtx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${Math.min(0.9, alpha + 0.2).toFixed(3)})`;
        fxCtx.lineWidth = pulse.ambiguous ? 1 : 1.5;
        fxCtx.beginPath();
        fxCtx.arc(p[0], p[1], pulse.ambiguous ? 7 + 6 * pulse.strength : 5 + 5 * pulse.strength, 0, Math.PI * 2);
        fxCtx.stroke();
      }
    }
  } else if (migrationViz === "lines") {
    const fLen = flowFromY.length;
    for (let i = 0; i < fLen; i++) {
      if (flowToY[i] > y) continue;
      const age = y - flowToY[i];
      if (age > 200) continue;
      const fs = flowSide[i], fp = flowSrc[i], idi = flowIndi[i];
      if (!_kfFlowPassesFilter(i)) continue;
      const lon0 = flowFromLon[i], lat0 = flowFromLat[i], lon1 = flowToLon[i], lat1 = flowToLat[i];
      if (lon0 === lon1 && lat0 === lat1) continue;
      const c = colorForFinal(fs, fp, idi);
      const alpha = Math.max(0.08, 1 - age / 80) * 0.55;
      fxCtx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha.toFixed(3)})`;
      fxCtx.lineWidth = age < 3 ? 1.2 : 0.5;
      drawGreatCircle(fxCtx, lon0, lat0, lon1, lat1);
    }
  } else if (migrationViz !== "discrete") {
    const fHi = lowerBound(flowFromY, flowFromOrder, y + 1);
    for (let k = 0; k < fHi; k++) {
      const i = flowFromOrder[k];
      if (flowToY[i] < y - 1) continue;
      let t;
      if (migrationViz === "pulse") {
        const win = 1.0;
        if (y < flowToY[i] - win || y > flowToY[i] + 0.1) continue;
        t = Math.max(0, Math.min(1, (y - (flowToY[i] - win)) / win));
      } else {
        const span = Math.max(1, flowToY[i] - flowFromY[i]);
        t = Math.max(0, Math.min(1, (y - flowFromY[i]) / span));
      }
      if (t <= 0 || t >= 1) continue;
      const fs = flowSide[i], fp = flowSrc[i], idi = flowIndi[i];
      if (!_kfFlowPassesFilter(i)) continue;
      const p = positionOnGreatCircle(flowFromLon[i], flowFromLat[i], flowToLon[i], flowToLat[i], t);
      if (!p) continue;
      const c = colorForFinal(fs, fp, idi);
      const fromLevel = flowFromLevel ? flowFromLevel[i] : (flowExact[i] ? GEO_LEVEL_CITY : GEO_LEVEL_ADMIN1);
      if (_kfGeoIsImprecise(fromLevel)) {
        const p0 = safeProject([flowFromLon[i], flowFromLat[i]]);
        if (p0) drawPrecisionMarker(fxCtx, p0[0], p0[1], fromLevel, c, fp, 0.45);
      }
      fxCtx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.95)`;
      const r = flowExact[i] ? 2.6 : 1.9;
      drawShape(fxCtx, p[0], p[1], r, fp);
    }
  }

  // Kin lines / pins / lineage paths / multi-highlight are now rendered by
  // deck.gl when the overlay is active; fall back to fxCanvas only if
  // deck.gl is unavailable. drawHighlight (the single selected dwell with
  // pulse) stays on fxCanvas — single point, animated, cheap.
  if (!_kfDeckOverlay) {
    if (kinLinesN > 0 && lastIndiIdxById && zoomTransform.k >= 4) drawKinLines(lo, hi, y, dw);
    if (_kfOverlayPaths.length) drawKfPaths();
    if (_kfOverlayPins.length) drawKfPins();
    if (_kfHighlightSet && lastIndiIdxById) drawKfHighlights();
  }
  if (highlightedDwell >= 0) drawHighlight();
}

function drawKfHighlights() {
  const c = _kfHighlightColor;
  fxCtx.lineWidth = 2.5;
  fxCtx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},0.95)`;
  fxCtx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.18)`;
  for (const id of _kfHighlightSet) {
    const idx = lastIndiIdxById.get(id);
    if (idx == null) continue;
    const dwells = indiDwells.get(idx);
    if (!dwells || !dwells.length) continue;
    let latest = dwells[0];
    for (const di of dwells) if (dwellY[di] > dwellY[latest]) latest = di;
    const sx = dwellSx[latest], sy = dwellSy[latest];
    if (sx <= -1000) continue;
    fxCtx.beginPath(); fxCtx.arc(sx, sy, 9, 0, Math.PI * 2);
    fxCtx.fill(); fxCtx.stroke();
  }
}

function drawKfPaths() {
  for (const path of _kfOverlayPaths) {
    if (!path.points || path.points.length < 2) continue;
    const c = path.color || [255, 196, 64];
    fxCtx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},0.92)`;
    fxCtx.lineWidth = 2.2;
    fxCtx.setLineDash([6, 3]);
    let started = false;
    for (let i = 0; i < path.points.length - 1; i++) {
      const a = path.points[i], b = path.points[i + 1];
      const pa = projection([a.lon, a.lat]);
      const pb = projection([b.lon, b.lat]);
      if (!pa || !pb || !Number.isFinite(pa[0]) || !Number.isFinite(pb[0])) { started = false; continue; }
      // Use the existing great-circle helper for proper arc rendering on ortho.
      drawGreatCircle(fxCtx, a.lon, a.lat, b.lon, b.lat);
    }
    fxCtx.setLineDash([]);
    // Endpoint dots
    for (const pt of path.points) {
      const p = projection([pt.lon, pt.lat]);
      if (!p || !Number.isFinite(p[0])) continue;
      fxCtx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},1)`;
      fxCtx.beginPath();
      fxCtx.arc(p[0], p[1], 4, 0, Math.PI * 2);
      fxCtx.fill();
      fxCtx.strokeStyle = "rgba(20,28,48,0.85)";
      fxCtx.lineWidth = 1;
      fxCtx.stroke();
    }
    if (path.label) {
      const mid = path.points[Math.floor(path.points.length / 2)];
      const p = projection([mid.lon, mid.lat]);
      if (p && Number.isFinite(p[0])) drawKfLabel(p[0] + 6, p[1] - 6, path.label, c);
    }
  }
}

function drawKfPins() {
  for (const pin of _kfOverlayPins) {
    const p = projection([pin.lon, pin.lat]);
    if (!p || !Number.isFinite(p[0])) continue;
    const c = pin.color || [220, 80, 80];
    // Drop-shadow circle + crosshair
    fxCtx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.95)`;
    fxCtx.beginPath();
    fxCtx.arc(p[0], p[1], 6, 0, Math.PI * 2);
    fxCtx.fill();
    fxCtx.strokeStyle = "rgba(255,255,255,0.95)";
    fxCtx.lineWidth = 2;
    fxCtx.stroke();
    fxCtx.strokeStyle = "rgba(20,28,48,0.85)";
    fxCtx.lineWidth = 1;
    fxCtx.beginPath();
    fxCtx.moveTo(p[0] - 9, p[1]); fxCtx.lineTo(p[0] + 9, p[1]);
    fxCtx.moveTo(p[0], p[1] - 9); fxCtx.lineTo(p[0], p[1] + 9);
    fxCtx.stroke();
    if (pin.label) drawKfLabel(p[0] + 9, p[1] - 9, pin.label, c);
  }
}

function drawKfLabel(x, y, text, c) {
  fxCtx.font = "bold 11px -apple-system, sans-serif";
  fxCtx.textAlign = "left"; fxCtx.textBaseline = "middle";
  const tw = fxCtx.measureText(text).width;
  fxCtx.fillStyle = "rgba(255,255,255,0.92)";
  fxCtx.fillRect(x - 2, y - 8, tw + 6, 16);
  fxCtx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},0.85)`;
  fxCtx.lineWidth = 1;
  fxCtx.strokeRect(x - 2, y - 8, tw + 6, 16);
  fxCtx.fillStyle = "rgba(20,28,48,0.96)";
  fxCtx.fillText(text, x + 1, y);
}

function drawKinLines(lo, hi, y, dw) {
  // Build map: indi index -> dwell index for visible/passes-filter dwells
  const visibleByIndi = new Map();
  for (let k = lo; k < hi; k++) {
    const i = dwellOrder[k];
    const dyy = y - dwellY[i]; if (dyy < 0) continue;
    if (curFilter === "ancestors" && !_kfIsDirectAncestorIndiIdx(dwellIndi[i])) continue;
    if (curFilter === "blood" && !dwellBlood[i]) continue;
    if (!typeFilter.has(dwellType[i])) continue;
    const sx = dwellSx[i], sy = dwellSy[i];
    if (sx < -10 || sx > W + 10 || sy < -10 || sy > H + 10) continue;
    const indi = dwellIndi[i];
    visibleByIndi.set(indi, i); // last-wins = latest event, matching the dominant visible marker
  }
  const drawn = new Set();
  fxCtx.lineWidth = 0.6;
  for (const [indiIdx, dwellI] of visibleByIndi) {
    const ind = lastIndividuals[indiIdx];
    if (!ind) continue;
    const relatives = nearestRelativesByDag(ind.id);
    const n = Math.min(kinLinesN, relatives.length);
    for (let r = 0; r < n; r++) {
      const relIdx = lastIndiIdxById.get(relatives[r].id);
      if (relIdx === undefined) continue;
      const otherDwell = visibleByIndi.get(relIdx);
      if (otherDwell === undefined) continue;
      const a = Math.min(dwellI, otherDwell), b = Math.max(dwellI, otherDwell);
      const key = a * 1e7 + b;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const alpha = Math.max(0.08, 0.55 * (1 - r / Math.max(kinLinesN, 1)));
      const c = colorForFinal(dwellSide[dwellI], 0, dwellIndi[dwellI]);
      fxCtx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha.toFixed(2)})`;
      // Straight line between already-projected endpoints. At zoom >= 4 the
      // great-circle curvature over the visible arc is sub-pixel, so the
      // straight line is visually identical and ~100x cheaper than
      // interpolating a great circle.
      fxCtx.beginPath();
      fxCtx.moveTo(dwellSx[dwellI], dwellSy[dwellI]);
      fxCtx.lineTo(dwellSx[otherDwell], dwellSy[otherDwell]);
      fxCtx.stroke();
    }
  }
}

function buildClusters(visible, radius) {
  const r2 = radius * radius;
  const clusters = [];
  for (const i of visible) {
    const x = dwellSx[i], y = dwellSy[i];
    let chosen = null;
    let bestDist = Infinity;
    for (const cl of clusters) {
      const dx = cl.cx - x, dy = cl.cy - y;
      const d = dx * dx + dy * dy;
      if (d <= r2 && d < bestDist) { chosen = cl; bestDist = d; }
    }
    const sd = dwellSide[i];
    const ps = dwellSrc[i];                // parent-knowledge: 0=both, 1=one, 2=none
    const ind = lastIndividuals && lastIndividuals[dwellIndi[i]];
    const gx = ind && ind.sex === "M" ? 0 : ind && ind.sex === "F" ? 1 : 2;
    const gg = typeof _kfGroupIndexForDwell === "function" ? _kfGroupIndexForDwell(i) : -1;
    if (chosen) {
      const n = chosen.members.length;
      chosen.cx = (chosen.cx * n + x) / (n + 1);
      chosen.cy = (chosen.cy * n + y) / (n + 1);
      chosen.members.push(i);
      if (sd === 0 || sd === 1 || sd === 2) chosen.sides[sd] += 1;
      if (ps === 0 || ps === 1 || ps === 2) chosen.parents[ps] += 1;
      chosen.genders[gx] += 1;
      if (gg >= 0) chosen.groups[gg] = (chosen.groups[gg] || 0) + 1;
    } else {
      const cl = {
        cx: x, cy: y, members: [i],
        sides:   [0, 0, 0],   // [paternal, maternal, other] lineage from root
        parents: [0, 0, 0],   // [both-known, one-known, none-known]
        genders: [0, 0, 0],   // [M, F, U]
        groups: [],
      };
      if (sd === 0 || sd === 1 || sd === 2) cl.sides[sd] += 1;
      if (ps === 0 || ps === 1 || ps === 2) cl.parents[ps] += 1;
      cl.genders[gx] += 1;
      if (gg >= 0) cl.groups[gg] = (cl.groups[gg] || 0) + 1;
      clusters.push(cl);
    }
  }
  return clusters;
}

// Populated by drawClusters in fxCanvas-rendered modes; consumed by the
// mapWrap mousemove handler so hovering over a pie/state shows the
// cluster's composition rather than any single person.
let _kfFxClusterHits = [];

function clusterDominantColor(cl) {
  let best = 2, bestN = -1;
  for (let s = 0; s < 3; s++) if (cl.sides[s] > bestN) { best = s; bestN = cl.sides[s]; }
  return colorFor(best);
}

function convexHull(pts) {
  if (pts.length < 3) return pts.slice();
  const sorted = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

function drawClusters(visible, radius, mode, year, dw) {
  // Reset the hit list each frame; hover tooltip on mapWrap reads it.
  _kfFxClusterHits = [];
  if (visible.length === 0) return;
  const clusters = buildClusters(visible, radius);
  if (mode === "state") {
    // Cluster persons by their CURRENT US state (computed once from the
    // usStates topojson on first state-mode access). Render the actual
    // state polygon, colored by hash of the abbreviation, intensity scaled
    // by count. Counts are placed inside (or with a leader line for small
    // states like RI / DC).
    if (!ensureStateIndex()) return;
    const stateCounts = new Map();
    const stateBreak = new Map();   // state idx → {sides, parents, genders, members}
    for (let m = 0; m < _kfDwellCount; m++) {
      const di = _kfPersonDwell[m];
      if (di == null || di < 0) continue;
      const s = _kfDwellState[di];
      if (s < 0) continue;
      stateCounts.set(s, (stateCounts.get(s) || 0) + 1);
      let b = stateBreak.get(s);
      if (!b) { b = { sides: [0,0,0], parents: [0,0,0], genders: [0,0,0], members: [] }; stateBreak.set(s, b); }
      b.members.push(di);
      const sd = dwellSide[di], ps = dwellSrc[di];
      if (sd >= 0 && sd < 3) b.sides[sd]++;
      if (ps >= 0 && ps < 3) b.parents[ps]++;
      const ind = lastIndividuals && lastIndividuals[dwellIndi[di]];
      const gx = ind && ind.sex === "M" ? 0 : ind && ind.sex === "F" ? 1 : 2;
      b.genders[gx]++;
    }
    if (!stateCounts.size) return;
    for (const [s, count] of stateCounts) {
      const b = stateBreak.get(s) || {};
      _kfFxClusterHits.push({
        kind: "state",
        stateIdx: s,
        abbr: _kfStateAbbrByIdx[s],
        count,
        members: b.members,
        sides: b.sides, parents: b.parents, genders: b.genders,
      });
    }
    let maxCount = 0;
    for (const v of stateCounts.values()) if (v > maxCount) maxCount = v;
    // d3.geoPath needs a projection with a `.stream()` method. Our callable
    // MapLibre adapter doesn't have one, so wrap it via d3.geoTransform.
    const _kfTransform = d3.geoTransform({
      point(x, y) {
        const p = projection([x, y]);
        if (p && Number.isFinite(p[0])) this.stream.point(p[0], p[1]);
      },
    });
    const cpFill = d3.geoPath(_kfTransform, fxCtx);
    const cpProj = d3.geoPath(_kfTransform);
    // Polygon pass.
    for (const [s, count] of stateCounts) {
      const f = _kfStateFeatures[s];
      if (!f) continue;
      const intensity = count / maxCount;
      const colorIdx = _kfTreeColorFromName(_kfStateAbbrByIdx[s] || String(s));
      const col = TREE_PALETTE[colorIdx];
      fxCtx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${(0.18 + 0.45 * intensity).toFixed(3)})`;
      fxCtx.beginPath(); cpFill(f); fxCtx.fill();
      fxCtx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},0.85)`;
      fxCtx.lineWidth = 1;
      fxCtx.beginPath(); cpFill(f); fxCtx.stroke();
    }
    // Label pass — centroid for big states, leader line for small.
    fxCtx.font = "bold 11px -apple-system, sans-serif";
    fxCtx.textAlign = "center"; fxCtx.textBaseline = "middle";
    for (const [s, count] of stateCounts) {
      const f = _kfStateFeatures[s];
      if (!f) continue;
      const c = cpProj.centroid(f);
      if (!c || isNaN(c[0])) continue;
      const text = `${_kfStateAbbrByIdx[s] || ""} ${count}`;
      const tw = fxCtx.measureText(text).width;
      const labelArea = (tw + 8) * 16;
      const stateArea = Math.abs(cpProj.area(f));
      let lx = c[0], ly = c[1], leader = false;
      if (stateArea < labelArea * 1.4) {
        // Small state — push label right by 32px and draw a leader.
        lx = c[0] + 32; ly = c[1] + 4; leader = true;
      }
      // Pill background
      fxCtx.fillStyle = "rgba(255,255,255,0.92)";
      fxCtx.fillRect(lx - tw/2 - 4, ly - 8, tw + 8, 16);
      fxCtx.strokeStyle = "rgba(20,28,48,0.45)";
      fxCtx.lineWidth = 0.5;
      fxCtx.strokeRect(lx - tw/2 - 4, ly - 8, tw + 8, 16);
      if (leader) {
        fxCtx.strokeStyle = "rgba(20,28,48,0.55)";
        fxCtx.lineWidth = 1;
        fxCtx.beginPath();
        fxCtx.moveTo(c[0], c[1]);
        fxCtx.lineTo(lx - tw/2 - 4, ly);
        fxCtx.stroke();
      }
      fxCtx.fillStyle = "rgba(20,28,48,1)";
      fxCtx.fillText(text, lx, ly);
    }
    fxCtx.textAlign = "left"; fxCtx.textBaseline = "middle";
    return;
  }
  if (mode === "tree") {
    // N-slice pie keyed by GEDCOM source. The visualization graph is already
    // the selected source set, with every individual carrying its source id,
    // so cluster slices now reflect the same tree chips selected for SQL/AI.
    for (const cl of clusters) {
      const sourceCounts = new Map();
      const sourceNames = new Map();
      const seenIndi = new Set();
      for (const i of cl.members) {
        const indi = dwellIndi[i];
        const sid = _kfSourceIdForIndiIdx(indi);
        const rawId = _kfVizRawIdByIndi?.[indi] || indi;
        const seenKey = `${sid}:${rawId}`;
        if (seenIndi.has(seenKey)) continue;
        seenIndi.add(seenKey);
        const sname = _kfSourceNameForIndiIdx(indi);
        sourceCounts.set(sid, (sourceCounts.get(sid) || 0) + 1);
        sourceNames.set(sid, sname);
      }
      if (!sourceCounts.size) continue;
      let total = 0;
      for (const v of sourceCounts.values()) total += v;
      const r = Math.max(8, Math.min(28, 5 + Math.sqrt(total) * 4));
      let start = -Math.PI / 2;
      const sorted = Array.from(sourceCounts.entries()).sort((a, b) => a[0] - b[0]);
      for (const [sid, count] of sorted) {
        const slice = (count / total) * Math.PI * 2;
        const c = _kfTreeColorForName(sourceNames.get(sid) || "");
        fxCtx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.85)`;
        fxCtx.beginPath();
        fxCtx.moveTo(cl.cx, cl.cy);
        fxCtx.arc(cl.cx, cl.cy, r, start, start + slice);
        fxCtx.closePath();
        fxCtx.fill();
        start += slice;
      }
      fxCtx.strokeStyle = "rgba(255,255,255,0.9)";
      fxCtx.lineWidth = 1.2;
      fxCtx.beginPath();
      fxCtx.arc(cl.cx, cl.cy, r, 0, Math.PI * 2);
      fxCtx.stroke();
      if (total > 1) {
        fxCtx.fillStyle = "rgba(20,28,48,0.95)";
        fxCtx.font = "bold 10px -apple-system, sans-serif";
        fxCtx.textAlign = "center"; fxCtx.textBaseline = "middle";
        fxCtx.fillText(String(total), cl.cx, cl.cy);
        fxCtx.textAlign = "left"; fxCtx.textBaseline = "middle";
      }
      _kfFxClusterHits.push({
        kind: "circle", cx: cl.cx, cy: cl.cy, r,
        count: total,
        members: cl.members,
        sides: cl.sides, parents: cl.parents, genders: cl.genders,
        sourceCounts, sourceNames,
      });
    }
    return;
  }
  if (mode === "group") {
    const runtime = typeof _kfEnsureActiveGroupRuntime === "function" ? _kfEnsureActiveGroupRuntime() : null;
    if (!runtime) return;
    for (const cl of clusters) {
      const counts = cl.groups || [];
      const total = counts.reduce((sum, n) => sum + (n || 0), 0);
      if (!total) continue;
      const r = Math.max(8, Math.min(28, 5 + Math.sqrt(total) * 4));
      let start = -Math.PI / 2;
      for (let gi = 0; gi < runtime.groups.length; gi++) {
        const count = counts[gi] || 0;
        if (!count) continue;
        const slice = (count / total) * Math.PI * 2;
        const c = runtime.groups[gi].color || _kfGroupColor(gi);
        fxCtx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.86)`;
        fxCtx.beginPath();
        fxCtx.moveTo(cl.cx, cl.cy);
        fxCtx.arc(cl.cx, cl.cy, r, start, start + slice);
        fxCtx.closePath();
        fxCtx.fill();
        start += slice;
      }
      fxCtx.strokeStyle = "rgba(255,255,255,0.9)";
      fxCtx.lineWidth = 1.2;
      fxCtx.beginPath();
      fxCtx.arc(cl.cx, cl.cy, r, 0, Math.PI * 2);
      fxCtx.stroke();
      if (total > 1) {
        fxCtx.fillStyle = "rgba(20,28,48,0.95)";
        fxCtx.font = "bold 10px -apple-system, sans-serif";
        fxCtx.textAlign = "center"; fxCtx.textBaseline = "middle";
        fxCtx.fillText(String(total), cl.cx, cl.cy);
        fxCtx.textAlign = "left"; fxCtx.textBaseline = "middle";
      }
      _kfFxClusterHits.push({
        kind: "circle", cx: cl.cx, cy: cl.cy, r,
        count: total,
        members: cl.members.filter(di => (typeof _kfGroupIndexForDwell !== "function" || _kfGroupIndexForDwell(di) >= 0)),
        sides: cl.sides, parents: cl.parents, genders: cl.genders,
        groupCounts: counts.slice(),
      });
    }
    return;
  }
  if (mode === "pie" || mode === "parents" || mode === "gender") {
    // Three-slice pie chart per cluster. Counts and colors vary by mode:
    //   pie     — paternal / maternal / other (lineage from root)
    //   parents — 2 known / 1 known / 0 known biological parents recorded
    //   gender  — male / female / unknown
    let counts, colors;
    if (mode === "pie") {
      colors = [colorFor(0), colorFor(1), colorFor(2)];
    } else if (mode === "parents") {
      // green = both known, amber = one known, red = none known
      colors = [[80, 160, 100], [220, 150, 60], [200, 80, 80]];
    } else {
      // gender: blue = M, red = F, gray = U
      colors = [[40, 100, 220], [220, 60, 90], [140, 140, 150]];
    }
    for (const cl of clusters) {
      counts = mode === "pie" ? cl.sides : mode === "parents" ? cl.parents : cl.genders;
      const total = counts[0] + counts[1] + counts[2];
      if (total === 0) continue;
      const r = Math.max(8, Math.min(28, 5 + Math.sqrt(total) * 4));
      let start = -Math.PI / 2;
      for (let s = 0; s < 3; s++) {
        if (counts[s] === 0) continue;
        const slice = (counts[s] / total) * Math.PI * 2;
        const c = colors[s];
        fxCtx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.85)`;
        fxCtx.beginPath();
        fxCtx.moveTo(cl.cx, cl.cy);
        fxCtx.arc(cl.cx, cl.cy, r, start, start + slice);
        fxCtx.closePath();
        fxCtx.fill();
        start += slice;
      }
      fxCtx.strokeStyle = "rgba(255,255,255,0.9)";
      fxCtx.lineWidth = 1.2;
      fxCtx.beginPath();
      fxCtx.arc(cl.cx, cl.cy, r, 0, Math.PI * 2);
      fxCtx.stroke();
      if (total > 1) {
        fxCtx.fillStyle = "rgba(20,28,48,0.95)";
        fxCtx.font = "bold 10px -apple-system, sans-serif";
        fxCtx.textAlign = "center"; fxCtx.textBaseline = "middle";
        fxCtx.fillText(String(total), cl.cx, cl.cy);
        fxCtx.textAlign = "left"; fxCtx.textBaseline = "middle";
      }
      _kfFxClusterHits.push({
        kind: "circle", cx: cl.cx, cy: cl.cy, r,
        count: total,
        members: cl.members,
        sides: cl.sides, parents: cl.parents, genders: cl.genders,
      });
    }
    return;
  }
  // aggregate (default)
  for (const cl of clusters) {
    const n = cl.members.length;
    const r = Math.max(5, Math.min(28, 4 + Math.sqrt(n) * 4));
    const c = clusterDominantColor(cl);
    fxCtx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.8)`;
    fxCtx.beginPath();
    fxCtx.arc(cl.cx, cl.cy, r, 0, Math.PI * 2);
    fxCtx.fill();
    fxCtx.strokeStyle = "rgba(255,255,255,0.9)";
    fxCtx.lineWidth = 1.4;
    fxCtx.stroke();
    if (n > 1) {
      fxCtx.fillStyle = "rgba(20,28,48,0.95)";
      fxCtx.font = "bold 10px -apple-system, sans-serif";
      fxCtx.textAlign = "center"; fxCtx.textBaseline = "middle";
      fxCtx.fillText(String(n), cl.cx, cl.cy);
      fxCtx.textAlign = "left"; fxCtx.textBaseline = "middle";
    }
  }
}

function drawHighlight() {
  const i = highlightedDwell;
  if (i < 0) return;
  const yint = Math.floor(curYear);
  if (highlightInferredYear >= 0) {
    if (yint !== highlightInferredYear) return;
  } else {
    const ind = lastIndividuals && lastIndividuals[dwellIndi[i]];
    if (dwellY[i] < yint - dwellWindow || dwellY[i] > yint) return;
    if (ind) {
      if (ind.birth_year != null && ind.birth_year > yint) return;
      if (ind.death_year != null && ind.death_year < yint) return;
    }
  }
  const sx = dwellSx[i], sy = dwellSy[i];
  if (sx <= -1000) return;
  const sd = dwellSide[i], ps = dwellSrc[i];
  const dotColor = colorForFinal(sd, ps, dwellIndi[i]);
  fxCtx.fillStyle = `rgba(${dotColor[0]},${dotColor[1]},${dotColor[2]},1)`;
  drawShape(fxCtx, sx, sy, 9, ps);
  fxCtx.strokeStyle = "rgba(255,255,255,0.95)";
  fxCtx.lineWidth = 2.5;
  if (ps === 2) fxCtx.strokeRect(sx - 9, sy - 9, 18, 18);
  else if (ps === 1) { fxCtx.beginPath(); fxCtx.moveTo(sx, sy - 9); fxCtx.lineTo(sx + 9, sy); fxCtx.lineTo(sx, sy + 9); fxCtx.lineTo(sx - 9, sy); fxCtx.closePath(); fxCtx.stroke(); }
  else { fxCtx.beginPath(); fxCtx.arc(sx, sy, 9, 0, Math.PI * 2); fxCtx.stroke(); }
  const t = performance.now() / 1000;
  for (let rr = 0; rr < 3; rr++) {
    const phase = ((t + rr * 0.45) % 1.4) / 1.4;
    const radius = 12 + phase * 70;
    fxCtx.strokeStyle = `rgba(255,180,30,${(0.7 * (1 - phase)).toFixed(3)})`;
    fxCtx.lineWidth = 3;
    fxCtx.beginPath(); fxCtx.arc(sx, sy, radius, 0, Math.PI * 2); fxCtx.stroke();
  }
}

function pruneInvalidHighlightSelection() {
  const i = highlightedDwell;
  if (i < 0) return;
  const yint = Math.floor(curYear);
  if (highlightInferredYear >= 0) {
    if (yint !== highlightInferredYear) clearHighlight();
    return;
  }
  const ind = lastIndividuals && lastIndividuals[dwellIndi[i]];
  if (dwellY[i] < yint - dwellWindow || dwellY[i] > yint) { clearHighlight(); return; }
  if (ind) {
    if (ind.birth_year != null && ind.birth_year > yint) { clearHighlight(); return; }
    if (ind.death_year != null && ind.death_year < yint) { clearHighlight(); return; }
  }
}

// Mobile Safari is memory-sensitive during long animations. Cap refresh work at
// 30fps while preserving playback speed by accumulating elapsed time between
// rendered ticks instead of slowing the timeline.
const MOBILE_REFRESH_FPS = 30;
const MOBILE_REFRESH_INTERVAL_MS = 1000 / MOBILE_REFRESH_FPS;
let last = 0;
let _kfLastMobileAnimationFrameAt = 0;
let _kfLastMobileDeckUpdateAt = 0;

function _kfShouldRunAnimationTick(now) {
  if (!_kfIsMobileLayout()) return true;
  if (!_kfLastMobileAnimationFrameAt) {
    _kfLastMobileAnimationFrameAt = now;
    return true;
  }
  if (now - _kfLastMobileAnimationFrameAt < MOBILE_REFRESH_INTERVAL_MS) return false;
  _kfLastMobileAnimationFrameAt = now;
  return true;
}

function _kfShouldUpdateDeckLayers(now) {
  if (!_kfIsMobileLayout()) return true;
  if (now - _kfLastMobileDeckUpdateAt < MOBILE_REFRESH_INTERVAL_MS) return false;
  _kfLastMobileDeckUpdateAt = now;
  return true;
}

function tick(now) {
  if (!_kfShouldRunAnimationTick(now)) {
    requestAnimationFrame(tick);
    return;
  }
  const dt = last ? (now - last) / 1000 : 0;
  last = now;
  if (timelineLoaded) {
    if (isDraggingSlider) {
      curYear = parseFloat(range.value);
    } else if (playing) {
      const sp = parseFloat(speedSel.value);
      curYear += sp * dt;
      // Auto-stop for kfApi.playRange — once we've crossed the requested end
      // year, pause exactly there.
      if (_kfPlayStopAt != null && curYear >= _kfPlayStopAt) {
        curYear = _kfPlayStopAt;
        playing = false;
        _kfSetPlayButtonLabel();
        _kfPlayStopAt = null;
      } else if (_kfPlayStopAt == null) {
        const loop = _kfPlaybackLoopBounds();
        if (loop.active) {
          if (curYear > loop.end || curYear < loop.begin) curYear = loop.begin;
        } else if (curYear > maxYear) {
          curYear = minYear;
        }
      }
      range.value = curYear;
    } else {
      curYear = parseFloat(range.value);
    }
    const yint = Math.floor(curYear);
    const ystr = String(yint);
    if (yearWatermarkEl) yearWatermarkEl.textContent = ystr;
    if (yearThumbLabelEl && range) {
      yearThumbLabelEl.textContent = ystr;
      const pct = (curYear - parseFloat(range.min)) / Math.max(1, parseFloat(range.max) - parseFloat(range.min));
      yearThumbLabelEl.style.setProperty("--year-pos", (pct * 100) + "%");
    }
    updateMapLegend();
    _kfRefreshLoopControls();
    if (_kfIsMobileLayout() && typeof _kfRefreshViewChrome === "function") _kfRefreshViewChrome();
  }
  // MapLibre owns the basemap and projection state — no more lerp/transform
  // dance. We just re-project dwells whenever the map moves (_baseDirty is
  // set by map.on('move') in initMapLibre).
  if (_baseDirty) {
    _baseDirty = false;
    if (timelineLoaded) { projectAll(); fxCtx.clearRect(0, 0, W, H); }
  }
  // Person markers feed BOTH deck rendering and fxCanvas cluster aggregation,
  // so rebuild them every tick whenever a tree is loaded — independent of
  // whether the deck overlay has finished initializing. Cache key inside
  // rebuildPersonMarkers makes this near-free when nothing changed.
  if (timelineLoaded) rebuildPersonMarkers();
  if (timelineLoaded) pruneInvalidHighlightSelection();
  // Year-varying lenses re-fetch when curYear changes. Cache key inside
  // makes this a no-op for static lenses (and during the same year).
  if (_kfActiveLens) _kfFetchLensData();
  if (_kfDwellsOnDeck && _kfDeckOverlay && timelineLoaded && _kfShouldUpdateDeckLayers(now)) updateDeckDwellLayer();
  frame(parseFloat(trailSel.value));
  updateNowMarker();
  requestAnimationFrame(tick);
}

function _kfSetPlayback(next, opts = {}) {
  const wantPlaying = !!next && timelineLoaded && !playBtn.disabled;
  if (wantPlaying) {
    // Mobile range inputs do not reliably deliver pointerup/pointercancel after
    // native slider interaction. If this flag stays true, tick() keeps pinning
    // curYear to range.value and playback appears broken.
    isDraggingSlider = false;
  }
  playing = wantPlaying;
  _kfSetPlayButtonLabel();
  if (playing) {
    const loop = _kfPlaybackLoopBounds();
    if (_kfPlayStopAt == null && loop.active && (curYear < loop.begin || curYear > loop.end)) {
      curYear = loop.begin;
      range.value = curYear;
    }
    clearHighlight();
  } else if (opts.clearStop) {
    _kfPlayStopAt = null;
  }
}

let _kfPlayPointerHandledAt = 0;
function _kfTogglePlaybackFromUser(e) {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  _kfSetPlayback(!playing);
}

playBtn.addEventListener("pointerdown", e => {
  if (_kfIsMobileLayout() || e.pointerType === "touch") {
    e.preventDefault();
  }
});
playBtn.addEventListener("pointerup", e => {
  if (_kfIsMobileLayout() || e.pointerType === "touch") {
    _kfPlayPointerHandledAt = Date.now();
    _kfTogglePlaybackFromUser(e);
  }
});
playBtn.addEventListener("click", e => {
  if (Date.now() - _kfPlayPointerHandledAt < 600) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  _kfTogglePlaybackFromUser(e);
});


const middleEl = $("middle");
function clearHighlight() {
  if (highlightedDwell < 0 && highlightInferredYear < 0) return;
  highlightedDwell = -1; highlightInferredYear = -1; highlightInferredSrcYear = -1;
  fxCtx.clearRect(0, 0, W, H);
  _kfHidePersonCard();
  _kfRefreshViewChrome(true);
}
function _kfEndSliderDrag() {
  isDraggingSlider = false;
}
range.addEventListener("input", () => { curYear = parseFloat(range.value); clearHighlight(); _kfRefreshViewChrome(true); });
range.addEventListener("pointerdown", () => { isDraggingSlider = true; pushHistory(); });
range.addEventListener("pointerup", _kfEndSliderDrag);
range.addEventListener("pointercancel", _kfEndSliderDrag);
range.addEventListener("change", _kfEndSliderDrag);
range.addEventListener("touchend", _kfEndSliderDrag, { passive: true });
range.addEventListener("touchcancel", _kfEndSliderDrag, { passive: true });
range.addEventListener("mouseup", _kfEndSliderDrag);
range.addEventListener("blur", _kfEndSliderDrag);
window.addEventListener("pointerup", _kfEndSliderDrag, true);
window.addEventListener("pointercancel", _kfEndSliderDrag, true);
$("rot").addEventListener("input", e => {
  // Rotate the map's view bearing instead of d3 projection rotation. With
  // Mercator, "rotation" means turning the compass — north no longer up.
  if (_kfMap) _kfMap.setBearing(parseFloat(e.target.value) || 0);
});
