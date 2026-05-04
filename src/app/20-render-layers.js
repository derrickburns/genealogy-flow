// ---------- deck.gl ScatterplotLayer for dwells ----------

// Person markers — one dot per LIVING person at curYear, located at the
// most recent dwell on or before curYear. Replaces per-event dwell markers.
// Buffers are reused across years; rebuilt only when curYear (or anything
// that affects coloring/filtering) changes.
let _kfPersonIndi = null;     // Int32Array — maps marker index → lastIndividuals index
let _kfPersonDwell = null;    // Int32Array — maps marker index → dwell index used for position
let _kfPersonsCacheYear = -Infinity;
let _kfDwellCount = 0;
// ---------- Lens (Claude-defined cluster queries) ----------
//
// A "lens" is a saved SQL query Claude (or the user) can register. The query
// produces points or regions on the map. Three shapes:
//   - state:   SELECT geo_st AS state, n AS count [, label] FROM ...
//   - country: SELECT geo_cc AS country, n AS count [, label] FROM ...
//   - latlon:  SELECT lat, lon, n AS count [, label] FROM ...
//
// The token __YEAR__ in the SQL is substituted with the current playback
// year on every fetch. Use it for time-varying lenses; omit for static ones.
//
// Lenses are persisted to localStorage so they survive reloads.

// Visualization tab state. Each entry is {id, type, title, spec}. The
// iframe srcdoc renders the active one. Sandboxed (no allow-same-origin)
// so a malicious or buggy spec can't read parent localStorage / kfApi.
// Personal-use scope: in-memory only, no persistence, no quota cap beyond
// keeping the most recent 12 to avoid unbounded growth.
let _kfVizList = [];
let _kfActiveVizId = null;
let _kfVizSeq = 0;
const VIZ_MAX = 12;

const LENS_LS_KEY = "kf-lenses";
let _kfLenses = (() => {
  try { return JSON.parse(localStorage.getItem(LENS_LS_KEY) || "[]"); }
  catch (_) { return []; }
})();
let _kfActiveLens = null;
let _kfLensData = null;
let _kfLensCacheKey = "";
let _kfLensCaption = null;
// Tree-match overlay: shows record-linker confirmed matches across loaded
// trees. Toggled by the "tree matches" overlay chip. _kfMatchData is the
// raw fetch result, _kfMatchSrcNames maps source_id -> tree name (used for
// hover tooltip later if we add it).
let _kfMatchOverlayOn = false;
let _kfMatchData = null;
let _kfLoadedTreeCount = 0; // updated by renderSources; gates "tree matches" overlay chip
let _kfMatchSrcNames = null;
let _kfMatchFetching = false;
function _kfRenderLensCaption() {
  const el = document.getElementById("lensCaption");
  if (!el) return;
  if (_kfLensCaption && _kfActiveLens) {
    el.textContent = _kfLensCaption;
    el.style.display = "block";
  } else {
    el.style.display = "none";
  }
}

function _kfPersistLenses() {
  try { localStorage.setItem(LENS_LS_KEY, JSON.stringify(_kfLenses)); } catch (_) {}
}

function _kfRenderLensDropdown() {
  const sel = document.getElementById("lensSel");
  if (!sel) return;
  const cur = _kfActiveLens || sel.value || "";
  sel.innerHTML = `<option value="">none</option>` +
    _kfLenses.map(l => `<option value="${escHtml(l.name)}">${escHtml(l.name)}</option>`).join("");
  sel.value = cur;
  document.getElementById("lensDelete").disabled = !sel.value;
  const info = document.getElementById("lensInfo");
  if (info) {
    const lens = _kfLenses.find(l => l.name === sel.value);
    info.textContent = lens ? `${lens.shape} · ${_kfLenses.length} saved` : `${_kfLenses.length} saved`;
  }
}

let _kfLensFetching = false;
async function _kfFetchLensData() {
  if (!_kfActiveLens) { _kfLensData = null; _kfLensCacheKey = ""; return; }
  if (_kfLensFetching) return;     // serialize fetches; tick fires per frame
  const lens = _kfLenses.find(l => l.name === _kfActiveLens);
  if (!lens) { _kfLensData = null; return; }
  const yint = Math.floor(curYear);
  const sql = lens.sql.replace(/__YEAR__/g, String(yint));
  const cacheKey = `${lens.name}|${sql}`;
  if (cacheKey === _kfLensCacheKey) return;
  _kfLensFetching = true;
  try {
    let j = _kfBrowserDb ? queryBrowserDb(sql, 1000) : null;
    if (!j && (location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
      const proxy = await detectChatProxy();
      if (!proxy) return;
      const r = await fetch(proxy + "/sql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: sql, limit: 1000 }),
      });
      j = await r.json();
    }
    if (j && j.ok) {
      _kfLensData = j.rows || [];
      _kfLensCacheKey = cacheKey;
      if (_kfDeckOverlay) updateDeckDwellLayer();
    } else {
      console.warn("[lens] sql error:", j && j.error);
      _kfLensData = null;
    }
  } catch (e) {
    console.warn("[lens] fetch error:", e?.message || e);
    _kfLensData = null;
  } finally {
    _kfLensFetching = false;
  }
}

// ---------------- Sandboxed visualization tab ----------------
// Renderer types:
//   svg       — raw SVG markup; rendered as-is inside the sandbox
//   html      — raw HTML; rendered inside the sandbox
//   markdown  — text; rendered via marked
//   vega      — Vega-Lite spec (JSON); rendered via vega-embed
//   mermaid   — Mermaid DSL (text); rendered via mermaid
//   dot       — GraphViz DOT (text); rendered via @viz-js/viz to SVG
// All run inside an iframe with sandbox="allow-scripts" only — no
// same-origin, so the renderer cannot reach parent localStorage / kfApi.
const VIZ_TYPES = new Set(["svg", "html", "markdown", "vega", "mermaid", "dot"]);

// IMPORTANT: every literal close-script tag in the strings below is written
// with a backslash before the slash. The HTML parser ends a script block
// at the first close tag it sees, regardless of JS string or comment
// boundaries — so an unescaped close tag here (even inside this comment!)
// would terminate the OUTER module script and break the whole page. The
// browser treats the escaped form inside a JS string as just the plain tag
// (the backslash before slash is ignored), so renders work fine.
function _kfVizSrcDoc(type, spec) {
  const head = `<style>
    html, body { margin:0; padding:0; background:#fff; color:#1c2433; font:13px/1.4 -apple-system, BlinkMacSystemFont, sans-serif; }
    body { padding:14px; box-sizing:border-box; min-height:100vh; }
    #out { max-width:100%; overflow:auto; }
    #out svg { max-width:100%; height:auto; }
    pre.err { color:#b00020; background:#fff3f3; padding:8px; border-radius:4px; white-space:pre-wrap; word-wrap:break-word; }
    table { border-collapse:collapse; }
    th, td { border:1px solid #e0e6ee; padding:4px 8px; text-align:left; }
    th { background:#f5f7fb; font-weight:600; }
  </style>`;
  const errShim = `<script>
    window.addEventListener('error', e => {
      const o = document.getElementById('out') || document.body;
      o.insertAdjacentHTML('beforeend', '<pre class="err">' + (e.error?.stack || e.message || 'unknown error') + '</pre>');
    });
  <\/script>`;
  if (type === "svg") {
    return `<!doctype html><html><head>${head}</head><body><div id="out">${String(spec || "")}</div></body></html>`;
  }
  if (type === "html") {
    return `<!doctype html><html><head>${head}</head><body><div id="out">${String(spec || "")}</div></body></html>`;
  }
  if (type === "markdown") {
    const text = JSON.stringify(String(spec || ""));
    return `<!doctype html><html><head>${head}${errShim}
      <script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"><\/script>
      </head><body><div id="out"></div>
      <script>
        const md = ${text};
        document.getElementById('out').innerHTML = marked.parse(md);
      <\/script></body></html>`;
  }
  if (type === "vega") {
    const specJson = JSON.stringify(spec);
    return `<!doctype html><html><head>${head}${errShim}
      <script src="https://cdn.jsdelivr.net/npm/vega@5/build/vega.min.js"><\/script>
      <script src="https://cdn.jsdelivr.net/npm/vega-lite@5/build/vega-lite.min.js"><\/script>
      <script src="https://cdn.jsdelivr.net/npm/vega-embed@6/build/vega-embed.min.js"><\/script>
      </head><body><div id="out"></div>
      <script>
        const spec = ${specJson};
        vegaEmbed('#out', spec, {actions:false, renderer:'svg'}).catch(e => {
          document.getElementById('out').innerHTML = '<pre class="err">' + (e.message || e) + '</pre>';
        });
      <\/script></body></html>`;
  }
  if (type === "mermaid") {
    const text = JSON.stringify(String(spec || ""));
    return `<!doctype html><html><head>${head}${errShim}
      <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"><\/script>
      </head><body><div id="out"><pre class="mermaid"></pre></div>
      <script>
        const src = ${text};
        document.querySelector('.mermaid').textContent = src;
        mermaid.initialize({startOnLoad:false, securityLevel:'strict', theme:'default'});
        mermaid.run().catch(e => {
          document.getElementById('out').innerHTML = '<pre class="err">' + (e.message || e) + '</pre>';
        });
      <\/script></body></html>`;
  }
  if (type === "dot") {
    const text = JSON.stringify(String(spec || ""));
    return `<!doctype html><html><head>${head}${errShim}
      </head><body><div id="out"></div>
      <script type="module">
        try {
          const mod = await import('https://cdn.jsdelivr.net/npm/@viz-js/viz@3/lib/viz-standalone.mjs');
          const viz = await mod.instance();
          const dot = ${text};
          const svg = viz.renderSVGElement(dot);
          document.getElementById('out').appendChild(svg);
        } catch (e) {
          document.getElementById('out').innerHTML = '<pre class="err">' + (e.message || e) + '</pre>';
        }
      <\/script></body></html>`;
  }
  return `<!doctype html><html><body><pre class="err">unknown viz type: ${String(type)}</pre></body></html>`;
}

let _kfVizShowSpec = false;

function _kfSpecSrcDoc(type, spec) {
  // Pretty-print the spec so the user can see exactly what was sent.
  // Vega specs are JSON; mermaid/dot/svg/html/markdown specs are strings.
  const text = (typeof spec === "string")
    ? spec
    : JSON.stringify(spec, null, 2);
  const safe = String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html><html><head><style>
    html, body { margin:0; padding:0; background:#fbfbfd; color:#1c2433; font:12px/1.45 ui-monospace, "SF Mono", Menlo, monospace; }
    body { padding:14px; box-sizing:border-box; }
    pre { white-space:pre-wrap; word-break:break-word; margin:0; }
    .meta { color:#7a8aa0; font-size:11px; margin-bottom:8px; padding-bottom:6px; border-bottom:1px solid #e0e6ee; }
  </style></head><body>
    <div class="meta">type: <b>${type}</b> &mdash; this is the raw spec sent to the renderer. Look for empty data.values, wrong field names, or missing columns.</div>
    <pre>${safe}</pre>
  </body></html>`;
}

function _kfRenderViz(id) {
  const v = _kfVizList.find(x => x.id === id);
  if (!v) return;
  _kfActiveVizId = id;
  const frame = $("vizFrame");
  if (!frame) return;
  frame.srcdoc = _kfVizShowSpec
    ? _kfSpecSrcDoc(v.type, v.spec)
    : _kfVizSrcDoc(v.type, v.spec);
  // Reflect the toggle state on the button so it's clear what mode you're in.
  const btn = $("vizSpecToggle");
  if (btn) {
    btn.style.background = _kfVizShowSpec ? "#2a4a8c" : "transparent";
    btn.style.color = _kfVizShowSpec ? "#fff" : "#566480";
    btn.textContent = _kfVizShowSpec ? "viz" : "spec";
  }
  _kfShowVizPane(true);
}

function _kfRenderVizTabs() {
  const bar = $("vizTabBar");
  if (!bar) return;
  const hasExtraVizTabs = _kfVizList.length > 0;
  bar.hidden = !hasExtraVizTabs;
  if (!hasExtraVizTabs) {
    bar.innerHTML = "";
    return;
  }
  const isMapActive = !$("vizPane").classList.contains("on");
  let html = `<button class="vizTab${isMapActive ? " on" : ""}" data-tab="map">Map</button>`;
  for (const v of _kfVizList) {
    html += `<button class="vizTab${v.id === _kfActiveVizId ? " on" : ""}" data-id="${v.id}" title="${escHtml(v.title || v.type)}">${escHtml(v.title || v.type)}<span class="tabClose" data-close="${v.id}">&times;</span></button>`;
  }
  bar.innerHTML = html;
  bar.querySelector("[data-tab='map']").addEventListener("click", () => _kfShowVizPane(false));
  bar.querySelectorAll(".vizTab[data-id]").forEach(el => {
    el.addEventListener("click", e => {
      if (e.target.dataset.close) { _kfCloseViz(Number(e.target.dataset.close)); return; }
      _kfRenderViz(Number(el.dataset.id));
    });
  });
}

function _kfCloseViz(id) {
  _kfVizList = _kfVizList.filter(v => v.id !== id);
  if (_kfActiveVizId === id) {
    const next = _kfVizList[_kfVizList.length - 1];
    if (next) _kfRenderViz(next.id);
    else _kfShowVizPane(false);
  } else {
    _kfRenderVizTabs();
  }
}

function _kfShowVizPane(on) {
  const pane = $("vizPane");
  if (!pane) return;
  pane.classList.toggle("on", !!on);
  if (!on) _kfActiveVizId = null;
  _kfRenderVizTabs();
}

// Wire viz pane controls.
queueMicrotask(() => {
  const specBtn = $("vizSpecToggle");
  if (specBtn) specBtn.addEventListener("click", () => {
    _kfVizShowSpec = !_kfVizShowSpec;
    if (_kfActiveVizId) _kfRenderViz(_kfActiveVizId);
  });
});

function makeLensLayer() {
  if (!_kfActiveLens || !_kfLensData || !_kfLensData.length) return null;
  const lens = _kfLenses.find(l => l.name === _kfActiveLens);
  if (!lens) return null;
  if (lens.shape === "state") return makeLensStateLayer(lens, _kfLensData);
  if (lens.shape === "country") return makeLensCountryLayer(lens, _kfLensData);
  if (lens.shape === "latlon") return makeLensLatLonLayer(lens, _kfLensData);
  if (lens.shape === "line") return makeLensLineLayer(lens, _kfLensData);
  if (lens.shape === "arc") return makeLensArcLayer(lens, _kfLensData);
  return null;
}

function makeLensStateLayer(lens, rows) {
  if (!ensureStateIndex()) return null;
  if (!deck || !deck.PolygonLayer) return null;
  const NAME_TO_ABBR = {};
  for (const [abbr, name] of Object.entries(US_STATE_ABBR)) NAME_TO_ABBR[name.toLowerCase()] = abbr;
  // Build state-abbr → count map from rows.
  const counts = new Map();
  for (const row of rows) {
    const abbr = (row.state || row.geo_st || row.STATE || "").toUpperCase();
    const n = Number(row.count ?? row.n ?? 0);
    if (abbr && n > 0) counts.set(abbr, n);
  }
  if (!counts.size) return null;
  let maxCount = 0;
  for (const v of counts.values()) if (v > maxCount) maxCount = v;
  // Build polygon data: one entry per matched state
  const polys = [];
  for (let s = 0; s < _kfStateFeatures.length; s++) {
    const abbr = _kfStateAbbrByIdx[s];
    const n = abbr ? counts.get(abbr) : null;
    if (!n) continue;
    const f = _kfStateFeatures[s];
    if (!f || !f.geometry) continue;
    const poly = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates[0][0] : f.geometry.coordinates[0];
    polys.push({ polygon: poly, count: n, abbr, intensity: n / maxCount });
  }
  if (!polys.length) return null;
  return new deck.PolygonLayer({
    id: "kf-lens-state",
    data: polys,
    getPolygon: d => d.polygon,
    getFillColor: d => {
      const colorIdx = _kfTreeColorFromName(d.abbr);
      const c = TREE_PALETTE[colorIdx];
      return [c[0], c[1], c[2], Math.round((0.18 + 0.45 * d.intensity) * 255)];
    },
    getLineColor: d => {
      const c = TREE_PALETTE[_kfTreeColorFromName(d.abbr)];
      return [c[0], c[1], c[2], 220];
    },
    getLineWidth: 1,
    lineWidthUnits: "pixels",
    stroked: true,
    filled: true,
    pickable: false,
  });
}

function makeLensCountryLayer(lens, rows) {
  // Country lookup needs world geometries which we don't keep parsed in
  // browser. For v1, render countries as labeled dots at country centroids
  // from the gazetteer. Simpler than polygon rendering.
  if (!gazetteer || !gazetteer.countries) return null;
  if (!deck || !deck.ScatterplotLayer) return null;
  const counts = new Map();
  for (const row of rows) {
    const cc = (row.country || row.geo_cc || row.CC || "").toUpperCase();
    const n = Number(row.count ?? row.n ?? 0);
    if (cc && n > 0) counts.set(cc, n);
  }
  if (!counts.size) return null;
  let maxCount = 0;
  for (const v of counts.values()) if (v > maxCount) maxCount = v;
  const data = [];
  for (const c of gazetteer.countries) {
    const n = counts.get(c.cc);
    if (!n) continue;
    data.push({ position: [c.lon, c.lat], count: n, cc: c.cc, intensity: n / maxCount });
  }
  if (!data.length) return null;
  return new deck.ScatterplotLayer({
    id: "kf-lens-country",
    data,
    getPosition: d => d.position,
    getFillColor: d => {
      const c = TREE_PALETTE[_kfTreeColorFromName(d.cc)];
      return [c[0], c[1], c[2], Math.round((0.45 + 0.45 * d.intensity) * 255)];
    },
    getRadius: d => 6 + 18 * Math.sqrt(d.intensity),
    radiusUnits: "pixels",
    stroked: true,
    getLineColor: [255, 255, 255, 230],
    lineWidthUnits: "pixels",
    getLineWidth: 1.4,
    pickable: false,
  });
}

function makeLensLineLayer(lens, rows) {
  if (!deck || !deck.LineLayer) return null;
  const data = [];
  for (const row of rows) {
    const fromLat = Number(row.from_lat);
    const fromLon = Number(row.from_lon);
    const toLat = Number(row.to_lat);
    const toLon = Number(row.to_lon);
    if (!Number.isFinite(fromLat) || !Number.isFinite(fromLon)
        || !Number.isFinite(toLat) || !Number.isFinite(toLon)) continue;
    const r = row.color_r != null ? Number(row.color_r) : 200;
    const g = row.color_g != null ? Number(row.color_g) : 130;
    const b = row.color_b != null ? Number(row.color_b) : 50;
    const a = row.alpha != null ? Number(row.alpha) : 200;
    const w = row.width != null ? Number(row.width) : 1.4;
    data.push({ from: [fromLon, fromLat], to: [toLon, toLat], color: [r, g, b, a], width: w });
  }
  if (!data.length) return null;
  return new deck.LineLayer({
    id: "kf-lens-line",
    data,
    getSourcePosition: d => d.from,
    getTargetPosition: d => d.to,
    getColor: d => d.color,
    getWidth: d => d.width,
    widthUnits: "pixels",
    pickable: false,
  });
}

function makeLensArcLayer(lens, rows) {
  if (!deck || !deck.ArcLayer) return null;
  // Arcs render as great-circle splines. To imply direction visually we use
  // a faint source color and bright target color — colors flow toward the
  // target, suggesting an arrow without needing arrow-head sprites.
  const data = [];
  for (const row of rows) {
    const fromLat = Number(row.from_lat);
    const fromLon = Number(row.from_lon);
    const toLat = Number(row.to_lat);
    const toLon = Number(row.to_lon);
    if (!Number.isFinite(fromLat) || !Number.isFinite(fromLon)
        || !Number.isFinite(toLat) || !Number.isFinite(toLon)) continue;
    const r = row.color_r != null ? Number(row.color_r) : 200;
    const g = row.color_g != null ? Number(row.color_g) : 130;
    const b = row.color_b != null ? Number(row.color_b) : 50;
    const aFrom = row.alpha_source != null ? Number(row.alpha_source) :
                  (row.alpha != null ? Number(row.alpha) * 0.15 : 30);
    const aTo   = row.alpha_target != null ? Number(row.alpha_target) :
                  (row.alpha != null ? Number(row.alpha) : 220);
    const w = row.width != null ? Number(row.width) : 1.6;
    data.push({
      from: [fromLon, fromLat], to: [toLon, toLat],
      sourceColor: [r, g, b, aFrom], targetColor: [r, g, b, aTo],
      width: w,
    });
  }
  if (!data.length) return null;
  return new deck.ArcLayer({
    id: "kf-lens-arc",
    data,
    getSourcePosition: d => d.from,
    getTargetPosition: d => d.to,
    getSourceColor: d => d.sourceColor,
    getTargetColor: d => d.targetColor,
    getWidth: d => d.width,
    widthUnits: "pixels",
    greatCircle: true,
    pickable: false,
  });
}

function makeLensLatLonLayer(lens, rows) {
  if (!deck || !deck.ScatterplotLayer) return null;
  let maxCount = 0;
  for (const row of rows) {
    const n = Number(row.count ?? row.n ?? 0);
    if (n > maxCount) maxCount = n;
  }
  const data = [];
  for (const row of rows) {
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    const n = Number(row.count ?? row.n ?? 0);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || n <= 0) continue;
    data.push({ position: [lon, lat], count: n, label: row.label || "", intensity: n / maxCount });
  }
  if (!data.length) return null;
  return new deck.ScatterplotLayer({
    id: "kf-lens-latlon",
    data,
    getPosition: d => d.position,
    getFillColor: d => [200, 130, 50, Math.round((0.45 + 0.45 * d.intensity) * 255)],
    getRadius: d => 5 + 16 * Math.sqrt(d.intensity),
    radiusUnits: "pixels",
    stroked: true,
    getLineColor: [255, 255, 255, 230],
    lineWidthUnits: "pixels",
    getLineWidth: 1.4,
    pickable: false,
  });
}

// Tree-match overlay -----------------------------------------------------
// Renders cross-tree person matches as halo rings on both endpoints connected
// by a thin line. Production uses a conservative browser-side matcher over
// checked GEDCOMs; localhost can still fall back to proxy person_links.
// Linked endpoints come from the events table (latest event with lat/lon).
// Year filter: only shows matches where at least one endpoint has its
// latest event year <= curYear (so the visualization respects the timeline).
const _KF_MATCH_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

function _kfMatchNormText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function _kfMatchNameParts(name) {
  const tokens = _kfMatchNormText(name).split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && _KF_MATCH_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  const first = tokens[0] || "";
  const surname = tokens.length > 1 ? tokens[tokens.length - 1] : "";
  return { first, surname, full: tokens.join(" "), tokens };
}

function _kfMatchNameScore(a, b) {
  if (!a.first || !a.surname || !b.first || !b.surname) return 0;
  if (a.first !== b.first || a.surname !== b.surname) return 0;
  if (a.full === b.full) return 1;
  const at = new Set(a.tokens), bt = new Set(b.tokens);
  let shared = 0;
  for (const t of at) if (bt.has(t)) shared++;
  const union = new Set([...a.tokens, ...b.tokens]).size || 1;
  return 0.78 + 0.18 * (shared / union);
}

function _kfMatchYearScore(a, b, missingScore) {
  if (a == null || b == null) return missingScore;
  const d = Math.abs(Number(a) - Number(b));
  if (d === 0) return 1;
  if (d <= 1) return 0.9;
  if (d <= 2) return 0.75;
  if (d <= 5) return 0.45;
  return 0;
}

function _kfMatchParentNames(src, ind) {
  const fam = ind?.famc ? src.families?.get(ind.famc) : null;
  if (!fam) return [];
  const byId = new Map((src.individuals || []).map(p => [p.id, p]));
  return [fam.husb, fam.wife].map(id => id ? byId.get(id)?.name || "" : "").filter(Boolean);
}

function _kfMatchParentScore(srcA, indA, srcB, indB) {
  const pa = _kfMatchParentNames(srcA, indA).map(_kfMatchNameParts);
  const pb = _kfMatchParentNames(srcB, indB).map(_kfMatchNameParts);
  if (!pa.length || !pb.length) return 0.5;
  let best = 0;
  for (const a of pa) {
    for (const b of pb) {
      const full = a.full && a.full === b.full;
      const surname = a.surname && a.surname === b.surname;
      if (full) best = Math.max(best, 1);
      else if (surname) best = Math.max(best, 0.7);
    }
  }
  return best;
}

function _kfLatestMatchEvent(ind) {
  if (!ind || !geocoder) return null;
  const birthYear = Number.isFinite(ind.birth_year) ? ind.birth_year : null;
  const deathYear = Number.isFinite(ind.death_year) ? ind.death_year : null;
  let best = null;
  for (const ev of (ind.events || [])) {
    const y = Number(ev.year);
    if (!Number.isFinite(y) || !ev.place) continue;
    if (birthYear != null && y < birthYear - 1) continue;
    if (deathYear != null && y > deathYear + 1) continue;
    const g = geocoder(ev.place);
    if (!g) continue;
    if (!best || y > best.year) best = { lat: g.lat, lon: g.lon, year: y };
  }
  return best;
}

function _kfBuildBrowserMatchData() {
  const sources = _kfSelectedSourceSnapshots().filter(src => src && (src.individuals || []).length);
  if (sources.length < 2) return { ok: false, reason: "select at least two trees" };
  if (!geocoder) return { ok: false, reason: "geocoder not ready" };

  const rows = [];
  for (let ai = 0; ai < sources.length; ai++) {
    for (let bi = ai + 1; bi < sources.length; bi++) {
      const srcA = sources[ai], srcB = sources[bi];
      const indexB = new Map();
      for (const indB of srcB.individuals || []) {
        const nb = _kfMatchNameParts(indB.name);
        if (!nb.first || !nb.surname) continue;
        const by = Number.isFinite(indB.birth_year) ? indB.birth_year : null;
        const years = by == null ? [null] : [by - 1, by, by + 1];
        for (const y of years) {
          const key = `${nb.first}|${nb.surname}|${y == null ? "unknown" : y}`;
          let bucket = indexB.get(key);
          if (!bucket) { bucket = []; indexB.set(key, bucket); }
          bucket.push({ ind: indB, name: nb });
        }
      }
      const candidates = [];
      for (const indA of srcA.individuals || []) {
        const na = _kfMatchNameParts(indA.name);
        if (!na.first || !na.surname) continue;
        const ay = Number.isFinite(indA.birth_year) ? indA.birth_year : null;
        const keys = ay == null
          ? [`${na.first}|${na.surname}|unknown`]
          : [`${na.first}|${na.surname}|${ay - 1}`, `${na.first}|${na.surname}|${ay}`, `${na.first}|${na.surname}|${ay + 1}`, `${na.first}|${na.surname}|unknown`];
        const seen = new Set();
        for (const key of keys) {
          const bucket = indexB.get(key) || [];
          for (const item of bucket) {
            const indB = item.ind;
            if (seen.has(indB.id)) continue;
            seen.add(indB.id);
            if (indA.sex && indB.sex && indA.sex !== "U" && indB.sex !== "U" && indA.sex !== indB.sex) continue;
            const nameScore = _kfMatchNameScore(na, item.name);
            if (nameScore <= 0) continue;
            const birthScore = _kfMatchYearScore(indA.birth_year, indB.birth_year, 0.45);
            const deathScore = _kfMatchYearScore(indA.death_year, indB.death_year, 0.35);
            const parentScore = _kfMatchParentScore(srcA, indA, srcB, indB);
            const score = 0.46 * nameScore + 0.28 * birthScore + 0.14 * deathScore + 0.12 * parentScore;
            if (score < 0.82) continue;
            const ea = _kfLatestMatchEvent(indA);
            const eb = _kfLatestMatchEvent(indB);
            if (!ea || !eb) continue;
            candidates.push({ score, indA, indB, ea, eb });
          }
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      const usedA = new Set(), usedB = new Set();
      for (const c of candidates) {
        if (usedA.has(c.indA.id) || usedB.has(c.indB.id)) continue;
        usedA.add(c.indA.id);
        usedB.add(c.indB.id);
        rows.push({
          score: Number(c.score.toFixed(3)),
          origin: "browser:auto",
          source_a: srcA.source_id,
          indi_a: c.indA.id,
          name_a: c.indA.name || c.indA.id,
          by_a: c.indA.birth_year ?? null,
          dy_a: c.indA.death_year ?? null,
          lat_a: c.ea.lat,
          lon_a: c.ea.lon,
          year_a: c.ea.year,
          source_a_name: srcA.name,
          source_b: srcB.source_id,
          indi_b: c.indB.id,
          name_b: c.indB.name || c.indB.id,
          by_b: c.indB.birth_year ?? null,
          dy_b: c.indB.death_year ?? null,
          lat_b: c.eb.lat,
          lon_b: c.eb.lon,
          year_b: c.eb.year,
          source_b_name: srcB.name,
        });
        if (rows.length >= 2000) break;
      }
    }
  }
  rows.sort((a, b) => b.score - a.score);
  return { ok: true, rows: rows.slice(0, 2000), count: rows.length };
}

async function _kfFetchMatchData() {
  const browserMatches = _kfBuildBrowserMatchData();
  if (browserMatches.ok) {
    const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if ((browserMatches.rows || []).length || !local) {
      _kfMatchData = browserMatches.rows || [];
      _kfMatchSrcNames = new Map();
      for (const row of _kfMatchData) {
        _kfMatchSrcNames.set(row.source_a, row.source_a_name);
        _kfMatchSrcNames.set(row.source_b, row.source_b_name);
      }
      return { ok: true, count: _kfMatchData.length };
    }
  }
  if (location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    _kfMatchData = null;
    return browserMatches;
  }
  const proxy = await detectChatProxy();
  if (!proxy) {
    _kfMatchData = null;
    return browserMatches.reason ? browserMatches : { ok: false, reason: "no proxy running" };
  }
  if (_kfMatchFetching) return { ok: false, reason: "already fetching" };
  _kfMatchFetching = true;
  try {
    const sql = `
      WITH last_evt AS (
        SELECT source_id, individual_id,
               lat, lon, year,
               ROW_NUMBER() OVER (
                 PARTITION BY source_id, individual_id
                 ORDER BY year DESC, rowid DESC
               ) AS rn
        FROM events
        WHERE lat IS NOT NULL AND lon IS NOT NULL
      )
      SELECT
        l.score,
        l.origin,
        l.source_a, l.indi_a,
        ia.name AS name_a, ia.birth_year AS by_a, ia.death_year AS dy_a,
        ea.lat AS lat_a, ea.lon AS lon_a, ea.year AS year_a,
        sa.name AS source_a_name,
        l.source_b, l.indi_b,
        ib.name AS name_b, ib.birth_year AS by_b, ib.death_year AS dy_b,
        eb.lat AS lat_b, eb.lon AS lon_b, eb.year AS year_b,
        sb.name AS source_b_name
      FROM person_links l
      JOIN individuals ia ON ia.source_id = l.source_a AND ia.id = l.indi_a
      JOIN individuals ib ON ib.source_id = l.source_b AND ib.id = l.indi_b
      JOIN sources sa ON sa.id = l.source_a
      JOIN sources sb ON sb.id = l.source_b
      LEFT JOIN last_evt ea ON ea.source_id = l.source_a AND ea.individual_id = l.indi_a AND ea.rn = 1
      LEFT JOIN last_evt eb ON eb.source_id = l.source_b AND eb.individual_id = l.indi_b AND eb.rn = 1
      WHERE (l.origin LIKE 'auto:%' OR l.origin = 'manual:confirmed')
        AND l.score >= 0.75
        AND ea.lat IS NOT NULL AND eb.lat IS NOT NULL
      ORDER BY l.score DESC
      LIMIT 2000
    `;
    const r = await fetch(proxy + "/sql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql, limit: 2000 }),
    });
    const j = await r.json();
    if (!j || !j.ok) {
      _kfMatchData = null;
      return { ok: false, reason: j?.error || "sql error" };
    }
    _kfMatchData = j.rows || [];
    // Build source-name lookup so each match knows which trees it bridges.
    _kfMatchSrcNames = new Map();
    for (const row of _kfMatchData) {
      _kfMatchSrcNames.set(row.source_a, row.source_a_name);
      _kfMatchSrcNames.set(row.source_b, row.source_b_name);
    }
    return { ok: true, count: _kfMatchData.length };
  } catch (e) {
    _kfMatchData = null;
    return { ok: false, reason: e?.message || String(e) };
  } finally {
    _kfMatchFetching = false;
  }
}

function _kfFilterMatchRows() {
  if (!_kfMatchData) return [];
  const yint = Math.floor(curYear);
  // Show a match if BOTH endpoints have a known event year and that year
  // is <= curYear. (If year is null we assume the match is always relevant
  // and let it through — better than hiding sparse data.)
  const out = [];
  for (const r of _kfMatchData) {
    const ya = r.year_a, yb = r.year_b;
    const aOk = (ya == null) || (ya <= yint);
    const bOk = (yb == null) || (yb <= yint);
    if (!aOk && !bOk) continue;
    out.push(r);
  }
  return out;
}

function makeMatchLineLayer() {
  if (!_kfMatchOverlayOn) return null;
  if (!deck || !deck.LineLayer) return null;
  const rows = _kfFilterMatchRows();
  if (!rows.length) return null;
  return new deck.LineLayer({
    id: "kf-match-lines",
    data: rows,
    getSourcePosition: r => [r.lon_a, r.lat_a],
    getTargetPosition: r => [r.lon_b, r.lat_b],
    // Color encodes match confidence: high score => more saturated.
    getColor: r => {
      const s = Math.max(0, Math.min(1, (r.score - 0.75) / 0.25));
      const a = Math.round(80 + s * 120);
      return [220, 80, 200, a];
    },
    getWidth: 1.3,
    widthUnits: "pixels",
    pickable: false,
  });
}

function makeMatchRingLayer() {
  if (!_kfMatchOverlayOn) return null;
  if (!deck || !deck.ScatterplotLayer) return null;
  const rows = _kfFilterMatchRows();
  if (!rows.length) return null;
  // One ring per linked endpoint (so each match contributes 2 rings).
  const positions = [];
  const colors = [];
  for (const r of rows) {
    const s = Math.max(0, Math.min(1, (r.score - 0.75) / 0.25));
    const a = Math.round(140 + s * 100);
    positions.push(r.lon_a, r.lat_a);
    positions.push(r.lon_b, r.lat_b);
    for (let k = 0; k < 2; k++) colors.push(220, 80, 200, a);
  }
  return new deck.ScatterplotLayer({
    id: "kf-match-rings",
    data: { length: positions.length / 2, attributes: {
      getPosition:  { value: new Float32Array(positions), size: 2 },
      getLineColor: { value: new Uint8Array(colors), size: 4 },
    }},
    getRadius: 7,
    radiusUnits: "pixels",
    stroked: true,
    filled: false,
    lineWidthUnits: "pixels",
    getLineWidth: 1.6,
    pickable: false,
  });
}

// For the "by gedcom tree" cluster mode: maps each browser-index person to
// the set of sources they appear in across all loaded GEDCOMs (via
// person_clusters). Populated after each GEDCOM load + linker run.
let _kfPersonSources = null;
// For the "by state" cluster mode: dwellState[i] is the index into
// _kfStateFeatures of the US state containing dwell i, or -1 if outside the
// US. Lazy-built on first state-mode access (one-time ~100ms cost).
let _kfDwellState = null;
let _kfStateFeatures = null;
let _kfStateAbbrByIdx = null;
let _kfStateBoxes = null;
function ensureStateIndex() {
  if (_kfDwellState && _kfStateFeatures) return true;
  if (!usStates || !dwellLat || !dwellLat.length) return false;
  const fc = topojson.feature(usStates, usStates.objects.states);
  _kfStateFeatures = fc.features;
  const NAME_TO_ABBR = {};
  for (const [abbr, name] of Object.entries(US_STATE_ABBR)) NAME_TO_ABBR[name.toLowerCase()] = abbr;
  _kfStateAbbrByIdx = _kfStateFeatures.map(f => {
    const n = (f.properties && f.properties.name) || "";
    return NAME_TO_ABBR[n.toLowerCase()] || null;
  });
  _kfStateBoxes = _kfStateFeatures.map(f => {
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    function visit(coords) {
      if (typeof coords[0] === "number") {
        if (coords[0] < minLon) minLon = coords[0];
        if (coords[0] > maxLon) maxLon = coords[0];
        if (coords[1] < minLat) minLat = coords[1];
        if (coords[1] > maxLat) maxLat = coords[1];
      } else for (const c of coords) visit(c);
    }
    if (f.geometry && f.geometry.coordinates) visit(f.geometry.coordinates);
    return [minLon, minLat, maxLon, maxLat];
  });
  const N = dwellLat.length;
  _kfDwellState = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    _kfDwellState[i] = -1;
    const lon = dwellLon[i], lat = dwellLat[i];
    if (lon < -180 || lon > -60 || lat < 17 || lat > 75) continue;
    for (let s = 0; s < _kfStateFeatures.length; s++) {
      const bb = _kfStateBoxes[s];
      if (lon < bb[0] || lon > bb[2] || lat < bb[1] || lat > bb[3]) continue;
      if (d3.geoContains(_kfStateFeatures[s], [lon, lat])) { _kfDwellState[i] = s; break; }
    }
  }
  return true;
}

function buildDeckDwellData() {
  // Allocate the fixed-size per-person buffers based on the persons in the
  // active tree. The actual content is filled by rebuildPersonMarkers, which
  // varies with curYear.
  if (!lastIndividuals || !lastIndividuals.length) {
    _kfDwellPositions = _kfDwellColors = _kfDwellRadii = null;
    _kfPersonIndi = _kfPersonDwell = null;
    _kfDwellCount = 0;
    _kfPersonsCacheYear = -Infinity;
    return;
  }
  const N = lastIndividuals.length;
  _kfDwellPositions = new Float32Array(N * 2);
  _kfDwellColors    = new Uint8Array(N * 4);
  _kfDwellRadii     = new Float32Array(N);
  _kfPersonIndi     = new Int32Array(N);
  _kfPersonDwell    = new Int32Array(N);
  _kfPersonsCacheYear = -Infinity;
  rebuildPersonMarkers();
}

// Approximate adult life expectancy at age 5+ (so historical infant mortality
// is excluded — anyone in a GEDCOM record almost by definition survived early
// childhood). Sourced from rough US/European cohort tables; the goal is "show
// person markers for a reasonable plausible lifespan", not actuarial accuracy.
function _kfInferredDeathYear(ind) {
  if (ind.death_year != null) return ind.death_year;
  if (ind.birth_year == null) return null;
  const decade = Math.floor(ind.birth_year / 10) * 10;
  const sex = ind.sex;
  let life;
  if      (decade < 1700) life = sex === "F" ? 50 : 48;
  else if (decade < 1800) life = sex === "F" ? 52 : 50;
  else if (decade < 1850) life = sex === "F" ? 55 : 52;
  else if (decade < 1900) life = sex === "F" ? 60 : 55;
  else if (decade < 1930) life = sex === "F" ? 68 : 62;
  else if (decade < 1960) life = sex === "F" ? 75 : 70;
  else if (decade < 1990) life = sex === "F" ? 80 : 74;
  else                    life = sex === "F" ? 82 : 78;
  return ind.birth_year + life;
}

function _kfPersonMayBeAliveAtYear(ind, yint) {
  if (!ind) return false;
  if (ind.birth_year != null && ind.birth_year > yint) return false;
  if (ind.death_year != null) return ind.death_year >= yint;
  if (ind.birth_year == null) return true;
  if (yint - ind.birth_year >= 115) return false;
  const inferred = _kfInferredDeathYear(ind);
  return inferred == null || yint <= inferred + 15;
}

function _kfLatestValidDwellForIndi(indiIdx, yint) {
  if (!lastIndividuals || !indiDwells || !dwellY) return -1;
  const ind = lastIndividuals[indiIdx];
  if (!_kfPersonMayBeAliveAtYear(ind, yint)) return -1;
  const dwells = indiDwells.get(indiIdx);
  if (!dwells || !dwells.length) return -1;
  let bestDi = -1, bestY = -Infinity;
  for (const di of dwells) {
    const y = dwellY[di];
    if (y <= yint && y > bestY) { bestY = y; bestDi = di; }
  }
  return bestDi;
}

function rebuildPersonMarkers() {
  if (!lastIndividuals || !indiDwells || !dwellY) return;
  // Allocate buffers if they don't exist yet — guards against ticks that fire
  // between `lastIndividuals = ...` and `buildDeckDwellData()` during
  // processFile/applyRoot. Otherwise we'd write into null typed arrays.
  if (!_kfDwellPositions || _kfDwellPositions.length < lastIndividuals.length * 2) {
    const N = lastIndividuals.length;
    _kfDwellPositions = new Float32Array(N * 2);
    _kfDwellColors    = new Uint8Array(N * 4);
    _kfDwellRadii     = new Float32Array(N);
    _kfPersonIndi     = new Int32Array(N);
    _kfPersonDwell    = new Int32Array(N);
    _kfPersonsCacheYear = -Infinity;  // force a fresh build below
  }
  const yint = Math.floor(curYear);
  // Cache key includes any state that affects which persons render or where.
  const surnSig = _kfSurnameFilter ? Array.from(_kfSurnameFilter).sort().join(",") : "";
  const key = `${yint}|${colorMode}|${curFilter}|${_kfSexFilter || ""}|${surnSig}|${lastRootId || ""}`;
  if (_kfPersonsCacheYear === key) return;
  _kfPersonsCacheYear = key;
  const N = lastIndividuals.length;
  let count = 0;
  for (let idx = 0; idx < N; idx++) {
    const ind = lastIndividuals[idx];
    if (!ind) continue;
    if (!_kfPersonMayBeAliveAtYear(ind, yint)) continue;
    // Lineage / blood / status filters still apply
    if (curFilter === "ancestors" && !_kfIsDirectAncestorIndiIdx(idx)) continue;
    if (curFilter === "blood" && lastBloodSet && !lastBloodSet.has(ind.id)) continue;
    if (_kfSexFilter && ind.sex !== _kfSexFilter) continue;
    if (_kfSurnameFilter) {
      const sn = _kfSurnameOf(ind.name);
      if (!sn || !_kfSurnameFilter.has(sn)) continue;
    }
    const bestDi = _kfLatestValidDwellForIndi(idx, yint);
    if (bestDi < 0) continue;
    _kfDwellPositions[count * 2]     = dwellLon[bestDi];
    _kfDwellPositions[count * 2 + 1] = dwellLat[bestDi];
    _kfDwellRadii[count]             = dwellExact[bestDi] ? 4 : 3;
    const c = colorForFinal(dwellSide[bestDi], dwellSrc[bestDi], idx);
    _kfDwellColors[count * 4]     = c[0];
    _kfDwellColors[count * 4 + 1] = c[1];
    _kfDwellColors[count * 4 + 2] = c[2];
    _kfDwellColors[count * 4 + 3] = 220;
    _kfPersonIndi[count]  = idx;
    _kfPersonDwell[count] = bestDi;
    count++;
  }
  _kfDwellCount = count;
}

function refreshDeckDwellColors() {
  // Color depends on which dwell each person uses, which we recompute in
  // rebuildPersonMarkers. Force a rebuild on next call by invalidating cache.
  _kfPersonsCacheYear = -Infinity;
}

function makeDwellLayer() {
  // Cluster modes replace the dot view with a different visualization. Hide
  // the person layer when one of those is active so deck doesn't paint dots
  // underneath the cluster overlay.
  const useDispersion = clusterMode === "dispersion" && zoomTransform.k < 2;
  const replaceMode = clusterMode === "aggregate" || clusterMode === "pie"
                    || clusterMode === "parents"   || clusterMode === "gender"
                    || clusterMode === "tree"      || clusterMode === "state"
                    || useDispersion
                    || !!_kfActiveLens;   // active lens replaces dwells too
  if (replaceMode) return null;
  if (typeof deck === "undefined" || !deck.ScatterplotLayer) return null;
  rebuildPersonMarkers();
  if (!_kfDwellCount) return null;
  // subarray with a year-keyed reference change so deck re-uploads when year ticks.
  const N = _kfDwellCount;
  return new deck.ScatterplotLayer({
    id: "kf-persons",
    data: {
      length: N,
      attributes: {
        getPosition:  { value: _kfDwellPositions.subarray(0, N * 2), size: 2 },
        getFillColor: { value: _kfDwellColors.subarray(0, N * 4),    size: 4 },
        getRadius:    { value: _kfDwellRadii.subarray(0, N),         size: 1 },
      },
    },
    radiusUnits: "pixels",
    pickable: false,
    stroked: false,
    updateTriggers: {
      getPosition:  _kfPersonsCacheYear,
      getFillColor: _kfPersonsCacheYear + ":" + colorMode,
    },
  });
}

function updateDeckDwellLayer() {
  if (!_kfDeckOverlay) return;
  // Rebuild the person-marker arrays first so EVERYTHING downstream — both
  // deck layers and the fxCanvas cluster path — uses the same alive-at-curYear
  // person set. Otherwise cluster counts include long-dead people via stale
  // dwell history.
  rebuildPersonMarkers();
  // deck.gl renders in array order; later layers paint on top. Stack:
  // hull → arcs → kin → lineage → dwells → aggregate → highlight → pins → labels.
  const layers = [
    makeLensLayer(),       // user/Claude-defined SQL cluster — drawn under everything else
    makeFlowLayer(),
    makeFlowDestLayer(),
    makeKinLinesLayer(),
    makeLineageLayer(),
    makeDwellLayer(),
    makeAggregateLayer(),
    makeAggregateLabelsLayer(),
    makeMatchLineLayer(),
    makeHighlightLayer(),
    makePinsLayer(),
    makePinLabelsLayer(),
  ].filter(Boolean);
  _kfDeckOverlay.setProps({ layers });
}

function buildDeckFlowData() {
  if (!flowFromLat || !flowFromLat.length) {
    _kfFlowSourcePos = _kfFlowTargetPos = _kfFlowColors = _kfFlowYears = null;
    _kfFlowInterpolators = null;
    _kfFlowsOnDeck = false;
    return;
  }
  const F = flowFromLat.length;
  _kfFlowSourcePos = new Float32Array(F * 2);
  _kfFlowTargetPos = new Float32Array(F * 2);
  _kfFlowColors    = new Uint8Array(F * 4);
  _kfFlowYears     = new Float32Array(F);
  _kfFlowInterpolators = new Array(F);
  for (let i = 0; i < F; i++) {
    _kfFlowSourcePos[i * 2]     = flowFromLon[i];
    _kfFlowSourcePos[i * 2 + 1] = flowFromLat[i];
    _kfFlowTargetPos[i * 2]     = flowToLon[i];
    _kfFlowTargetPos[i * 2 + 1] = flowToLat[i];
    _kfFlowYears[i]             = flowToY[i];
    const c = colorForFinal(flowSide[i], flowSrc[i], flowIndi[i]);
    _kfFlowColors[i * 4]     = c[0];
    _kfFlowColors[i * 4 + 1] = c[1];
    _kfFlowColors[i * 4 + 2] = c[2];
    _kfFlowColors[i * 4 + 3] = 160;  // ~0.62 alpha; arcs subtler than dots
    _kfFlowInterpolators[i] = d3.geoInterpolate(
      [flowFromLon[i], flowFromLat[i]],
      [flowToLon[i],   flowToLat[i]],
    );
  }
  _kfFlowsOnDeck = true;
}

function refreshDeckFlowColors() {
  if (!_kfFlowColors || !flowFromLat) return;
  const F = flowFromLat.length;
  for (let i = 0; i < F; i++) {
    const c = colorForFinal(flowSide[i], flowSrc[i], flowIndi[i]);
    _kfFlowColors[i * 4]     = c[0];
    _kfFlowColors[i * 4 + 1] = c[1];
    _kfFlowColors[i * 4 + 2] = c[2];
  }
}

let _kfFlowParticlePositions = new Float32Array(0);
let _kfFlowParticleColors = new Uint8Array(0);
let _kfFlowDestPositions = new Float32Array(0);
let _kfFlowDestColors = new Uint8Array(0);
let _kfFlowDestRadii = new Float32Array(0);
let _kfFlowDestWidths = new Float32Array(0);
let _kfFlowArcSourcePositions = new Float32Array(0);
let _kfFlowArcTargetPositions = new Float32Array(0);
let _kfFlowArcSourceColors = new Uint8Array(0);
let _kfFlowArcTargetColors = new Uint8Array(0);
let _kfFlowArcWidths = new Float32Array(0);
let _kfFlowInterpolators = null;
const _kfDeckDataAlwaysDirty = () => false;

function _kfBufferSize(required) {
  let n = 1;
  while (n < required) n *= 2;
  return n;
}

function _kfEnsureFlowParticleCapacity(points) {
  if (_kfFlowParticlePositions.length < points * 2) _kfFlowParticlePositions = new Float32Array(_kfBufferSize(points * 2));
  if (_kfFlowParticleColors.length < points * 4) _kfFlowParticleColors = new Uint8Array(_kfBufferSize(points * 4));
}

function _kfEnsureFlowDestCapacity(points) {
  if (_kfFlowDestPositions.length < points * 2) _kfFlowDestPositions = new Float32Array(_kfBufferSize(points * 2));
  if (_kfFlowDestColors.length < points * 4) _kfFlowDestColors = new Uint8Array(_kfBufferSize(points * 4));
  if (_kfFlowDestRadii.length < points) _kfFlowDestRadii = new Float32Array(_kfBufferSize(points));
  if (_kfFlowDestWidths.length < points) _kfFlowDestWidths = new Float32Array(_kfBufferSize(points));
}

function _kfEnsureFlowArcCapacity(arcs) {
  if (_kfFlowArcSourcePositions.length < arcs * 2) _kfFlowArcSourcePositions = new Float32Array(_kfBufferSize(arcs * 2));
  if (_kfFlowArcTargetPositions.length < arcs * 2) _kfFlowArcTargetPositions = new Float32Array(_kfBufferSize(arcs * 2));
  if (_kfFlowArcSourceColors.length < arcs * 4) _kfFlowArcSourceColors = new Uint8Array(_kfBufferSize(arcs * 4));
  if (_kfFlowArcTargetColors.length < arcs * 4) _kfFlowArcTargetColors = new Uint8Array(_kfBufferSize(arcs * 4));
  if (_kfFlowArcWidths.length < arcs) _kfFlowArcWidths = new Float32Array(_kfBufferSize(arcs));
}

// Phase 4: pins, lineage paths, highlights, kin lines as deck.gl layers.
// Data volumes here are small (pins ≤ 50, paths ≤ 5, highlights ≤ 50, kin
// lines ≤ a few thousand) so we use object-array data instead of binary
// attributes — simpler and the diff cost is negligible.

function makePinsLayer() {
  if (!_kfOverlayPins.length || !deck || !deck.ScatterplotLayer) return null;
  return new deck.ScatterplotLayer({
    id: "kf-pins",
    data: _kfOverlayPins,
    getPosition: d => [d.lon, d.lat],
    getFillColor: d => {
      const c = d.color || [220, 80, 80];
      return [c[0], c[1], c[2], 240];
    },
    getRadius: 6,
    radiusUnits: "pixels",
    stroked: true,
    getLineColor: [255, 255, 255, 240],
    lineWidthUnits: "pixels",
    getLineWidth: 2,
    pickable: false,
  });
}

function makePinLabelsLayer() {
  if (!deck || !deck.TextLayer) return null;
  const pins = _kfOverlayPins.filter(p => p.label);
  if (!pins.length) return null;
  return new deck.TextLayer({
    id: "kf-pin-labels",
    data: pins,
    getPosition: d => [d.lon, d.lat],
    getText: d => d.label,
    getSize: 11,
    sizeUnits: "pixels",
    getColor: [20, 28, 48, 240],
    background: true,
    getBackgroundColor: [255, 255, 255, 235],
    backgroundPadding: [4, 2],
    getPixelOffset: [12, -10],
    fontWeight: 600,
  });
}

function makeLineageLayer() {
  if (!_kfOverlayPaths.length || !deck || !deck.PathLayer) return null;
  return new deck.PathLayer({
    id: "kf-lineage",
    data: _kfOverlayPaths,
    getPath: d => d.points.map(pt => [pt.lon, pt.lat]),
    getColor: d => {
      const c = d.color || [255, 196, 64];
      return [c[0], c[1], c[2], 235];
    },
    getWidth: 2.5,
    widthUnits: "pixels",
    capRounded: true,
    jointRounded: true,
    pickable: false,
  });
}

function makeHighlightLayer() {
  if (!_kfHighlightSet || !lastIndiIdxById || !indiDwells || !deck || !deck.ScatterplotLayer) return null;
  const yint = Math.floor(curYear);
  const points = [];
  for (const id of _kfHighlightSet) {
    const idx = lastIndiIdxById.get(id);
    if (idx == null) continue;
    const latest = _kfLatestValidDwellForIndi(idx, yint);
    if (latest < 0) continue;
    points.push([dwellLon[latest], dwellLat[latest]]);
  }
  if (!points.length) return null;
  const c = _kfHighlightColor;
  return new deck.ScatterplotLayer({
    id: "kf-highlight",
    data: points,
    getPosition: d => d,
    getFillColor: [c[0], c[1], c[2], 46],
    stroked: true,
    getLineColor: [c[0], c[1], c[2], 240],
    lineWidthUnits: "pixels",
    getLineWidth: 2.5,
    getRadius: 9,
    radiusUnits: "pixels",
    pickable: false,
  });
}

// Cluster computation helpers — shared by aggregate, dispersion, and hull
// modes. Re-uses the existing buildClusters() (screen-space pixel clustering
// keyed on dwellSx/dwellSy) so cluster boundaries stay consistent with the
// fxCanvas paths for the modes we haven't migrated (pie). Caches the result
// per (year, zoom, radius, filter, window) key — clusters only change when
// one of those changes.
let _kfClusterCache = null;
let _kfClusterCacheKey = "";
function _kfBuildClustersForDeck() {
  if (!timelineLoaded) return null;
  // Use person-marker set so cluster counts reflect alive-at-curYear persons
  // rather than every past event.
  const visible = [];
  for (let m = 0; m < _kfDwellCount; m++) {
    const i = _kfPersonDwell[m];
    if (i == null || i < 0) continue;
    const sx = dwellSx[i], sy = dwellSy[i];
    if (sx < -10 || sx > W + 10 || sy < -10 || sy > H + 10) continue;
    visible.push(i);
  }
  if (!visible.length) return null;
  const clusters = buildClusters(visible, clusterRadius);
  const out = [];
  for (const cl of clusters) {
    let sumLat = 0, sumLon = 0;
    for (const i of cl.members) {
      sumLat += dwellLat[i];
      sumLon += dwellLon[i];
    }
    const lat = sumLat / cl.members.length;
    const lon = sumLon / cl.members.length;
    const total = cl.sides[0] + cl.sides[1] + cl.sides[2];
    const r = Math.max(5, Math.min(28, 4 + Math.sqrt(total) * 4));
    const color = clusterDominantColor(cl);
    // Carry the per-cluster breakdown vectors through to the layer data so
    // hover tooltips can show the composition without recomputing.
    out.push({
      position: [lon, lat], radius: r, color, count: total,
      members: cl.members,
      sides: cl.sides.slice(),
      parents: cl.parents.slice(),
      genders: cl.genders.slice(),
    });
  }
  return out;
}

// Format a hover tooltip describing the composition of a cluster — never
// any single person. Shape-agnostic; called by both deck onHover and the
// fxCanvas hit-testing path.
function _kfFormatClusterTooltip(c) {
  const total = c.count;
  const title = c.abbr
    ? `${c.abbr} &nbsp;${total} ${total === 1 ? "person" : "people"}`
    : `${total} ${total === 1 ? "person" : "people"}`;
  const lines = [`<div class="tipName">${title}</div>`];
  lines.push(`<div class="tipYrs">Click for people, relatives, and evidence details.</div>`);
  return lines.join("");
}
function _kfGetClustersForDeck() {
  const key = `${Math.floor(curYear)}|${zoomTransform.k.toFixed(2)}|${clusterRadius}|${curFilter}|${dwellWindow}|${clusterMode}`;
  if (_kfClusterCacheKey !== key) {
    _kfClusterCacheKey = key;
    _kfClusterCache = _kfBuildClustersForDeck();
  }
  return _kfClusterCache;
}

function makeAggregateLayer() {
  const isAggregate = clusterMode === "aggregate"
                   || (clusterMode === "dispersion" && zoomTransform.k < 2);
  if (!isAggregate) return null;
  if (!deck || !deck.ScatterplotLayer) return null;
  const data = _kfGetClustersForDeck();
  if (!data || !data.length) return null;
  return new deck.ScatterplotLayer({
    id: "kf-aggregate",
    data,
    getPosition: d => d.position,
    getFillColor: d => [d.color[0], d.color[1], d.color[2], 200],
    getRadius: d => d.radius,
    radiusUnits: "pixels",
    stroked: true,
    getLineColor: [255, 255, 255, 230],
    lineWidthUnits: "pixels",
    getLineWidth: 1.4,
    pickable: true,
    onHover: ({ object, x, y }) => {
      if (!object) { hoverTip.style.display = "none"; return; }
      hoverTip.innerHTML = _kfFormatClusterTooltip(object);
      hoverTip.style.left = (x + 12) + "px";
      hoverTip.style.top  = (y + 12) + "px";
      hoverTip.style.display = "block";
    },
  });
}

function makeAggregateLabelsLayer() {
  const isAggregate = clusterMode === "aggregate"
                   || (clusterMode === "dispersion" && zoomTransform.k < 2);
  if (!isAggregate) return null;
  if (!deck || !deck.TextLayer) return null;
  const data = _kfGetClustersForDeck();
  if (!data) return null;
  const labeled = data.filter(d => d.count > 1);
  if (!labeled.length) return null;
  return new deck.TextLayer({
    id: "kf-aggregate-labels",
    data: labeled,
    getPosition: d => d.position,
    getText: d => String(d.count),
    getSize: 10,
    sizeUnits: "pixels",
    getColor: [20, 28, 48, 245],
    fontWeight: 700,
    pickable: false,
  });
}

function makeKinLinesLayer() {
  if (!kinLinesN || !lastIndiIdxById || !lastIndividuals) return null;
  if (!deck || !deck.LineLayer) return null;
  if (!_kfDwellCount || !_kfPersonDwell || !_kfPersonIndi) return null;
  // Threshold lowered from 4 to 2 because MapLibre's default zoom 1.5 maps
  // to zoomTransform.k ≈ 2.83 — at the previous threshold no kin lines ever
  // rendered without explicit zoom-in.
  if (zoomTransform.k < 2) return null;
  // Use the alive-at-curYear person set so kin lines connect currently-shown
  // persons, deduped and consistent with what the user actually sees on the map.
  const visibleByIndi = new Map();
  for (let m = 0; m < _kfDwellCount; m++) {
    visibleByIndi.set(_kfPersonIndi[m], _kfPersonDwell[m]);
  }
  const segments = [];
  const drawn = new Set();
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
      const c = colorForFinal(dwellSide[dwellI], 0, dwellIndi[dwellI]);
      segments.push({
        s: [dwellLon[dwellI], dwellLat[dwellI]],
        t: [dwellLon[otherDwell], dwellLat[otherDwell]],
        c: [c[0], c[1], c[2], 100],
      });
    }
  }
  if (!segments.length) return null;
  return new deck.LineLayer({
    id: "kf-kin",
    data: segments,
    getSourcePosition: d => d.s,
    getTargetPosition: d => d.t,
    getColor: d => d.c,
    getWidth: 1,
    widthUnits: "pixels",
    pickable: false,
  });
}

function makeFlowLayer() {
  if (!flowFromLat || !flowFromLat.length) return null;
  if (typeof deck === "undefined" || !deck.ScatterplotLayer) return null;
  // Same cluster-mode hide as dwells.
  const useDispersion = clusterMode === "dispersion" && zoomTransform.k < 2;
  const replaceMode = clusterMode === "aggregate" || clusterMode === "pie"
                    || clusterMode === "parents"   || clusterMode === "gender"
                    || clusterMode === "tree"      || clusterMode === "state"
                    || useDispersion
                    || !!_kfActiveLens;   // active lens replaces dwells too
  if (replaceMode) return null;
  if (migrationViz === "observations") return makeFlowObservationArcLayer();
  // Animated particle flow: each in-flight migration emits a head dot at the
  // current great-circle position plus a TRAIL of older dots at decreasing
  // opacity. The trail spacing is in t-units (fraction of trip), so a
  // Long evidence gaps animate only near the destination year so we do not
  // imply the person was physically traveling for the entire undocumented gap.
  const F = flowFromLat.length;
  const y = curYear;
  const TRAIL_N = (typeof _kfIsMobileLayout === "function" && _kfIsMobileLayout()) ? 3 : 6;
  const TRAIL_STEP = 0.07; // t-spacing between successive trail particles
  _kfEnsureFlowParticleCapacity(F * TRAIL_N);
  let count = 0;
  for (let i = 0; i < F; i++) {
    const win = _kfFlowAnimationWindow(i);
    if (!win || y < win.start || y > win.end) continue;
    const fs = flowSide[i];
    if (curFilter === "ancestors" && !_kfIsDirectAncestorIndiIdx(flowIndi[i])) continue;
    if (curFilter === "blood" && !flowBlood[i]) continue;
    const span = Math.max(0.1, win.end - win.start);
    const t = Math.max(0, Math.min(1, (y - win.start) / span));
    const interp = _kfFlowInterpolators?.[i] || d3.geoInterpolate(
      [flowFromLon[i], flowFromLat[i]],
      [flowToLon[i],   flowToLat[i]],
    );
    const c = colorForFinal(fs, flowSrc[i], flowIndi[i]);
    for (let k = 0; k < TRAIL_N; k++) {
      const tk = t - k * TRAIL_STEP;
      if (tk < 0) break;
      const pt = interp(tk);
      if (!pt || !Number.isFinite(pt[0])) continue;
      _kfFlowParticlePositions[count * 2] = pt[0];
      _kfFlowParticlePositions[count * 2 + 1] = pt[1];
      // Head fully opaque, fading to ~0 at tail end.
      const alpha = Math.round(235 * (1 - k / TRAIL_N));
      _kfFlowParticleColors[count * 4] = c[0];
      _kfFlowParticleColors[count * 4 + 1] = c[1];
      _kfFlowParticleColors[count * 4 + 2] = c[2];
      _kfFlowParticleColors[count * 4 + 3] = alpha;
      count++;
    }
  }
  if (!count) return null;
  // Half the radius of landed person markers (which are 3-4px). Particles
  // are smaller so the trail reads as motion rather than a string of dots.
  return new deck.ScatterplotLayer({
    id: "kf-flow-particles",
    data: { length: count, attributes: {
      getPosition:  { value: _kfFlowParticlePositions, size: 2 },
      getFillColor: { value: _kfFlowParticleColors,    size: 4 },
    }},
    dataComparator: _kfDeckDataAlwaysDirty,
    getRadius: 1.8,
    radiusUnits: "pixels",
    stroked: false,
    pickable: false,
  });
}

const FLOW_AMBIGUOUS_GAP_YEARS = 5;

function _kfFlowPassesFilter(i) {
  if (curFilter === "ancestors" && !_kfIsDirectAncestorIndiIdx(flowIndi[i])) return false;
  if (curFilter === "blood" && !flowBlood[i]) return false;
  return true;
}

const FLOW_LONG_GAP_ANIMATION_YEARS = 5;

function _kfFlowAnimationWindow(i) {
  const fromY = flowFromY[i], toY = flowToY[i];
  if (!Number.isFinite(fromY) || !Number.isFinite(toY) || toY <= fromY) return null;
  const gap = toY - fromY;
  const start = gap > FLOW_LONG_GAP_ANIMATION_YEARS
    ? toY - FLOW_LONG_GAP_ANIMATION_YEARS
    : fromY;
  return { start, end: toY, gap };
}

function _kfObservationPulse(i, y = curYear) {
  const fromY = flowFromY[i], toY = flowToY[i];
  const gap = Math.max(0, toY - fromY);
  const ambiguous = gap > FLOW_AMBIGUOUS_GAP_YEARS;
  const lead = ambiguous ? 3.0 : 1.2;
  const tail = ambiguous ? 0.9 : 0.5;
  const start = toY - lead;
  const end = toY + tail;
  if (y < start || y > end) return null;
  const strength = y <= toY
    ? 0.35 + 0.65 * ((y - start) / Math.max(lead, 0.1))
    : Math.max(0.2, 1 - ((y - toY) / Math.max(tail, 0.1)));
  return { gap, ambiguous, strength: Math.max(0, Math.min(1, strength)) };
}

function makeFlowObservationArcLayer() {
  if (!deck || !deck.ArcLayer) return null;
  const F = flowFromLat.length;
  _kfEnsureFlowArcCapacity(F);
  let count = 0;
  for (let i = 0; i < flowFromLat.length; i++) {
    if (!_kfFlowPassesFilter(i)) continue;
    const pulse = _kfObservationPulse(i);
    if (!pulse) continue;
    if (flowFromLon[i] === flowToLon[i] && flowFromLat[i] === flowToLat[i]) continue;
    const c = colorForFinal(flowSide[i], flowSrc[i], flowIndi[i]);
    const alpha = pulse.ambiguous
      ? Math.round(38 + 78 * pulse.strength)
      : Math.round(105 + 120 * pulse.strength);
    _kfFlowArcSourcePositions[count * 2] = flowFromLon[i];
    _kfFlowArcSourcePositions[count * 2 + 1] = flowFromLat[i];
    _kfFlowArcTargetPositions[count * 2] = flowToLon[i];
    _kfFlowArcTargetPositions[count * 2 + 1] = flowToLat[i];
    _kfFlowArcSourceColors[count * 4] = c[0];
    _kfFlowArcSourceColors[count * 4 + 1] = c[1];
    _kfFlowArcSourceColors[count * 4 + 2] = c[2];
    _kfFlowArcSourceColors[count * 4 + 3] = Math.round(alpha * 0.12);
    _kfFlowArcTargetColors[count * 4] = c[0];
    _kfFlowArcTargetColors[count * 4 + 1] = c[1];
    _kfFlowArcTargetColors[count * 4 + 2] = c[2];
    _kfFlowArcTargetColors[count * 4 + 3] = alpha;
    _kfFlowArcWidths[count] = pulse.ambiguous ? 0.9 : 1.7;
    count++;
  }
  if (!count) return null;
  return new deck.ArcLayer({
    id: "kf-flow-observation-arcs",
    data: { length: count, attributes: {
      getSourcePosition: { value: _kfFlowArcSourcePositions, size: 2 },
      getTargetPosition: { value: _kfFlowArcTargetPositions, size: 2 },
      getSourceColor:    { value: _kfFlowArcSourceColors,    size: 4 },
      getTargetColor:    { value: _kfFlowArcTargetColors,    size: 4 },
      getWidth:          { value: _kfFlowArcWidths,          size: 1 },
    }},
    dataComparator: _kfDeckDataAlwaysDirty,
    widthUnits: "pixels",
    greatCircle: true,
    pickable: false,
  });
}

// Hollow destination rings drawn at the END of every in-flight migration.
// Without this, the user sees the trail moving but no visible "X marks the
// spot" — and if the destination dwell year is the same year the person dies,
// the landed marker only appears for one frame. The ring stays visible the
// entire time the migration is in flight, so the user always sees where each
// trail is heading.
function makeFlowDestLayer() {
  if (!flowFromLat || !flowFromLat.length) return null;
  if (typeof deck === "undefined" || !deck.ScatterplotLayer) return null;
  const useDispersion = clusterMode === "dispersion" && zoomTransform.k < 2;
  const replaceMode = clusterMode === "aggregate" || clusterMode === "pie"
                    || clusterMode === "parents"   || clusterMode === "gender"
                    || clusterMode === "tree"      || clusterMode === "state"
                    || useDispersion
                    || !!_kfActiveLens;
  if (replaceMode) return null;
  const F = flowFromLat.length;
  const y = curYear;
  _kfEnsureFlowDestCapacity(F);
  let count = 0;
  for (let i = 0; i < F; i++) {
    let pulse = null;
    if (migrationViz === "observations") {
      pulse = _kfObservationPulse(i, y);
      if (!pulse) continue;
    } else {
      const win = _kfFlowAnimationWindow(i);
      if (!win || y < win.start || y > win.end) continue;
    }
    if (!_kfFlowPassesFilter(i)) continue;
    const c = colorForFinal(flowSide[i], flowSrc[i], flowIndi[i]);
    _kfFlowDestPositions[count * 2] = flowToLon[i];
    _kfFlowDestPositions[count * 2 + 1] = flowToLat[i];
    const alpha = pulse
      ? (pulse.ambiguous ? Math.round(85 + 65 * pulse.strength) : Math.round(150 + 80 * pulse.strength))
      : 200;
    _kfFlowDestColors[count * 4] = c[0];
    _kfFlowDestColors[count * 4 + 1] = c[1];
    _kfFlowDestColors[count * 4 + 2] = c[2];
    _kfFlowDestColors[count * 4 + 3] = alpha;
    _kfFlowDestRadii[count] = pulse ? (pulse.ambiguous ? 7 + 6 * pulse.strength : 5 + 5 * pulse.strength) : 5;
    _kfFlowDestWidths[count] = pulse?.ambiguous ? 1 : 1.5;
    count++;
  }
  if (!count) return null;
  return new deck.ScatterplotLayer({
    id: "kf-flow-dest",
    data: { length: count, attributes: {
      getPosition:    { value: _kfFlowDestPositions, size: 2 },
      getLineColor:   { value: _kfFlowDestColors,    size: 4 },
      getRadius:      { value: _kfFlowDestRadii,     size: 1 },
      getLineWidth:   { value: _kfFlowDestWidths,    size: 1 },
    }},
    dataComparator: _kfDeckDataAlwaysDirty,
    radiusUnits: "pixels",
    stroked: true,
    filled: false,
    lineWidthUnits: "pixels",
    pickable: false,
  });
}

// Also observe the wrap directly. Window resize doesn't fire when only the
// grid column ratio changes (e.g., chat panel toggling), so the canvases can
// fall out of sync with the viewport. ResizeObserver covers that path and
// also handles dev tools opening, parent layout reflows, etc.
if (typeof ResizeObserver === "function") {
  let _kfRoTick = null;
  const ro = new ResizeObserver(() => {
    // Coalesce multiple entries fired in one layout pass into a single resize.
    if (_kfRoTick != null) return;
    _kfRoTick = requestAnimationFrame(() => { _kfRoTick = null; resize(); });
  });
  ro.observe($("mapWrap"));
}
window.kfDump = () => {
  const i = highlightedDwell;
  if (i < 0) return { error: "no selection" };
  const ind = lastIndividuals[dwellIndi[i]];
  return {
    person: ind?.name,
    dwellLatLon: [dwellLat[i], dwellLon[i]],
    projectedXY: projection([dwellLon[i], dwellLat[i]]),
    dwellSxSy: [dwellSx[i], dwellSy[i]],
    rotation: projection.rotate(),
    zoom: { ...zoomTransform },
    baseTranslate: baseTranslate.slice(),
    canvas: [W, H],
    projectionName,
    side: dwellSide[i],
    place: dwellPlace[i] >= 0 ? placesList[dwellPlace[i]] : null,
  };
};
