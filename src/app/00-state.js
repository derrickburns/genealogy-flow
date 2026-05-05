import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import * as topojson from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";
import earcut from "https://cdn.jsdelivr.net/npm/earcut@2.2.4/+esm";

const $ = id => document.getElementById(id);
const baseCanvas = $("base"), fxCanvas = $("fx"), glCanvas = $("gl");
const baseCtx = baseCanvas.getContext("2d"), fxCtx = fxCanvas.getContext("2d");
const playBtn = $("play"), range = $("range");
const yearWatermarkEl = $("yearWatermark");
const yearThumbLabelEl = $("yearThumbLabel");
const speedSel = $("speed"), trailSel = $("trail"), stats = $("stats");
const migrationViewSel = $("migrationView");
const dropEl = $("drop"), welcome = $("welcome"), fileInp = $("fileinp");
const rootwrap = $("rootwrap");
function _kfSetPlayButtonLabel() {
  if (!playBtn) return;
  playBtn.textContent = playing ? "\u275a\u275a" : "\u25b6";
  playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
  playBtn.setAttribute("title", playing ? "Pause" : "Play");
}
// Demo mode: set to a URL of a .ged file to preload it and hide every upload
// path (Upload Tree button, drag-drop). Empty disables.
const DEMO_GED_URL = "/api/demo";
let _chatProxyOk = null; // hoisted early; detectChatProxy() is called before its declaration site
let _clerkToken = null;
let _clerkUserTier = "anon";
let _clerkInstance = null;
let _kfDerivedCacheReady = false;
const _kfClientErrors = [];
function _kfRecordClientError(entry) {
  _kfClientErrors.push({ at: new Date().toISOString(), ...entry });
  if (_kfClientErrors.length > 25) _kfClientErrors.shift();
}
window.addEventListener("error", e => {
  _kfRecordClientError({
    type: "error",
    message: e.message || "",
    source: e.filename || "",
    line: e.lineno || null,
    column: e.colno || null,
    stack: e.error?.stack || "",
  });
});
window.addEventListener("unhandledrejection", e => {
  const reason = e.reason;
  _kfRecordClientError({
    type: "unhandledrejection",
    message: reason?.message || String(reason || ""),
    stack: reason?.stack || "",
  });
});

let W = 0, H = 0;
let mapW = 0, mapTop = 0, mapBottom = 0;
// MapLibre is now the authoritative projection. The `projection` symbol below
// is a callable d3-style adapter that delegates to the map's `project` /
// `unproject` so existing code (frame(), projectAll(), drawHighlight, etc.)
// continues to work without per-callsite changes. Setter methods like
// `.translate()` / `.scale()` / `.rotate()` / `.fitExtent()` are no-op stubs
// since the map owns its own bounds and zoom transform.
let _kfMap = null;
let _kfMapMoving = false;
// deck.gl ScatterplotLayer state for GPU-rendered dwells. When the overlay
// is ready, the fxCanvas dwell-render loop in frame() bails out and lets
// deck.gl draw on the same WebGL context as MapLibre.
let _kfDeckOverlay = null;
let _kfDwellPositions = null;
let _kfDwellColors = null;
let _kfDwellRadii = null;
let _kfDwellHaloPositions = null;
let _kfDwellHaloFillColors = null;
let _kfDwellHaloLineColors = null;
let _kfDwellHaloRadii = null;
let _kfDwellHaloWidths = null;
let _kfDwellYears = null;
let _kfDwellsOnDeck = false;
// Phase 3: flow arcs on deck.gl ArcLayer. Same binary-attribute pattern.
// Source/target are interleaved [lon, lat] pairs; one entry per flow.
let _kfFlowSourcePos = null;
let _kfFlowTargetPos = null;
let _kfFlowColors = null;
let _kfFlowYears = null;
let _kfFlowsOnDeck = false;
function projection(lonlat) {
  if (!_kfMap || !lonlat) return null;
  const lng = lonlat[0], lat = lonlat[1];
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  // MapLibre clamps lat to ~±85 (Mercator); pass-through clamps the input.
  const safeLat = Math.max(-85.0511, Math.min(85.0511, lat));
  const p = _kfMap.project([lng, safeLat]);
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return [p.x, p.y];
}
projection.invert = function(xy) {
  if (!_kfMap || !xy) return null;
  const ll = _kfMap.unproject([xy[0], xy[1]]);
  return ll && Number.isFinite(ll.lng) ? [ll.lng, ll.lat] : null;
};
// d3-projection setter compatibility — all no-ops; MapLibre is the source of truth.
projection.translate = function(_t) { return _t === undefined ? [W / 2, H / 2] : projection; };
projection.scale     = function(_s) { return _s === undefined ? 256 : projection; };
projection.rotate    = function(_r) { return _r === undefined ? [0, 0, 0] : projection; };
projection.fitExtent = function() { return projection; };
projection.clipExtent = function() { return projection; };
// Single projection — Mercator — and a single time-windowed city layer
// (only cities with events visible at the current year). Mercator is the
// universal tile-provider projection (OSM/Mapbox/Google), wraps horizontally
// for continuous pan, and lets us swap in raster basemaps later if desired.
// Cost: high-latitude size distortion (Greenland inflated). Acceptable for
// genealogy data clustered in mid-latitudes.
let projectionName = "mercator";
let baseScale = 1, baseTranslate = [0, 0];
let zoomTransform = { k: 1, x: 0, y: 0 };

let world = null, worldHi = null, worldHiLoading = false, usStates = null, majorCities = null, eventCities = null, gazetteer = null, geocoder = null, timelineLoaded = false;
// LOD basemap helpers (ensureHiResWorld, activeWorld, cachedLand /
// cachedBordersMesh / cachedStatesMesh, _featCache) all removed — MapLibre
// renders the basemap from vector tiles. The world/usStates topojson is
// only kept for the Export feature.
// Locked to "events" — the only city layer we still draw is event-tied.
let cityLayer = "events";
let borderLayer = "historical";
let historicalBasemaps = new Map(); // year -> { world, name } loaded snapshots
let currentHistoricalWorld = null;

const GEO_LEVEL_CITY = 0;
const GEO_LEVEL_COUNTY = 1;
const GEO_LEVEL_ADMIN1 = 2;
const GEO_LEVEL_COUNTRY = 3;

function _kfGeoLevelCode(level) {
  const v = String(level || "").toLowerCase();
  if (v === "city") return GEO_LEVEL_CITY;
  if (v === "county") return GEO_LEVEL_COUNTY;
  if (v === "admin1" || v === "state" || v === "province" || v === "region") return GEO_LEVEL_ADMIN1;
  return GEO_LEVEL_COUNTRY;
}

function _kfGeoLevelName(code) {
  const n = Number(code);
  if (n === GEO_LEVEL_CITY) return "city";
  if (n === GEO_LEVEL_COUNTY) return "county/region";
  if (n === GEO_LEVEL_ADMIN1) return "state/province";
  return "country";
}

function _kfGeoIsImprecise(code) {
  return Number(code) > GEO_LEVEL_CITY;
}

function _kfGeoMarkerRadiusPx(code) {
  const n = Number(code);
  if (n === GEO_LEVEL_CITY) return 4;
  if (n === GEO_LEVEL_COUNTY) return 8;
  if (n === GEO_LEVEL_ADMIN1) return 14;
  return 22;
}

function _kfGeoCenterMarkerRadiusPx(code) {
  return Number(code) === GEO_LEVEL_CITY ? 4 : 3.4;
}

function _kfGeoMarkerAlpha(code) {
  const n = Number(code);
  if (n === GEO_LEVEL_CITY) return 220;
  if (n === GEO_LEVEL_COUNTY) return 212;
  if (n === GEO_LEVEL_ADMIN1) return 198;
  return 186;
}

function _kfGeoHaloFillAlpha(code) {
  const n = Number(code);
  if (n === GEO_LEVEL_COUNTY) return 34;
  if (n === GEO_LEVEL_ADMIN1) return 24;
  if (n === GEO_LEVEL_COUNTRY) return 18;
  return 0;
}

function _kfGeoHaloLineAlpha(code) {
  const n = Number(code);
  if (n === GEO_LEVEL_COUNTY) return 132;
  if (n === GEO_LEVEL_ADMIN1) return 104;
  if (n === GEO_LEVEL_COUNTRY) return 88;
  return 0;
}

function _kfGeoHaloLineWidthPx(code) {
  return Number(code) === GEO_LEVEL_COUNTRY ? 1.5 : 1.2;
}

let dwellY, dwellLat, dwellLon, dwellSide, dwellSrc, dwellIndi, dwellBlood, dwellCity, dwellExact, dwellLevel, dwellType, dwellPlace, dwellSx, dwellSy, dwellOrder;
let placesList = [];
let migrationsData = null;
let highlightedDwell = -1;
let highlightInferredYear = -1, highlightInferredSrcYear = -1;
let indiDwells = new Map();
// Person markers now stay on the map for the entire lifespan of each
// individual, so the per-event "window" and "inference" controls were
// removed from the UI. Both still exist as constants so legacy fxCanvas
// code (the fallback when deck.gl isn't available) doesn't crash; the
// large dwellWindow effectively turns the per-event window off.
const inferenceYears = 0;
const dwellWindow = 1000;
let typeFilter = new Set([0,1,2,3,4,5,6,7,8,9,10]);
// Sex filter — null means no filter; "M"/"F" restrict person markers to that
// sex. Set by the quick-chip row above the year slider.
let _kfSexFilter = null;
// Surname filter — null means no filter; otherwise a Set of allowed surnames.
let _kfSurnameFilter = null;
// Top surnames by frequency in the current tree, rendered as colored chips.
let _kfSurnamesTop = null;

// Strip generational suffixes when extracting surname so "Smith Jr" matches "Smith".
const _KF_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v", "esq", "md", "phd"]);
function _kfSurnameOf(name) {
  if (!name) return null;
  const tokens = String(name).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  let i = tokens.length - 1;
  while (i > 0 && _KF_SUFFIXES.has(tokens[i].toLowerCase().replace(/[.,]/g, ""))) i--;
  return tokens[i];
}
let flowFromY, flowToY, flowFromLat, flowFromLon, flowToLat, flowToLon, flowSide, flowSrc, flowIndi, flowBlood, flowExact, flowFromLevel, flowToLevel;
let flowFromSx, flowFromSy, flowToSx, flowToSy, flowFromOrder;
let curFilter = "all";
let migrationViz = "continuous";
let clusterMode = "none";
let clusterRadius = 30;
let kinLinesN = 0;
let lastBloodSet = null;
// kfApi-driven overlays. Each call to addPin / traceLineage adds an entry;
// frame() renders them every tick. Cleared explicitly via clearPins / clearLineage.
let _kfOverlayPins = [];     // {lat, lon, label, color}
let _kfOverlayPaths = [];    // {points: [{lat,lon,label?}], color, label}
let _kfSubtreeFilter = null; // Set<string> of indi ids; if non-null, render restricts to these
let _kfActiveTreeName = null;
const _kfTreeCache = new Map(); // sourceName -> raw GEDCOM/JSON text
const KF_RAW_TREE_CACHE_MAX_CHARS = 2_500_000;
const KF_RAW_TREE_CACHE_LOW_MEMORY_MAX_CHARS = 800_000;
const _kfLoadedSources = new Map(); // sourceName -> parsed source snapshot for browser SQL
const _kfSourceIdByName = new Map(); // sourceName -> stable browser source_id
const _kfPreferredRootBySourceName = new Map(); // sourceName -> raw source individual id
let _kfNextBrowserSourceId = 1;
let _kfSelectedSourceIds = new Set();
let _kfCatalogTrees = [];
let _kfPlayStopAt = null;    // when playing, year at which to auto-pause
let _kfLoopBegin = null;     // optional playback loop start year
let _kfLoopEnd = null;       // optional playback loop end year
let _kfSkipNextProxyLoad = false; // setActiveTree → processFile path skips the upload
let _kfHighlightSet = null;       // Set<string> indi ids; rings drawn over their latest dwell
let _kfHighlightColor = [80, 200, 255];
// The map/animation layer renders the selected source set, not just the last
// file that was parsed. Individuals and families are cloned with source-
// prefixed IDs so overlapping GEDCOM xrefs never collide.
let _kfVizSources = [];
let _kfVizSourceNameByIndi = [];
let _kfVizSourceIdByIndi = [];
let _kfVizRawIdByIndi = [];
let _kfVizIsComposite = false;

function _kfHaversineMiles(la1, lo1, la2, lo2) {
  const r = Math.PI / 180;
  const dl = (la2 - la1) * r, dm = (lo2 - lo1) * r;
  const a = Math.sin(dl / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dm / 2) ** 2;
  return 2 * 3960 * Math.asin(Math.sqrt(a));
}
let minYear = 1700, maxYear = 2026, curYear = 1700, playing = false;
let isDraggingSlider = false;
const KF_RESPONSIVE_SHELL_MEDIA = "(max-width: 900px), (pointer: coarse) and (max-width: 980px)";

function _kfUsesResponsiveShell() {
  return typeof window !== "undefined" &&
    window.matchMedia(KF_RESPONSIVE_SHELL_MEDIA).matches;
}

function _kfIsCompactLayout() {
  return _kfUsesResponsiveShell();
}

function _kfShouldCacheRawTreeText(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  const deviceMemory = Number(globalThis.navigator?.deviceMemory);
  const lowMemoryDevice = Number.isFinite(deviceMemory) && deviceMemory > 0 && deviceMemory <= 4;
  const limit = lowMemoryDevice ? KF_RAW_TREE_CACHE_LOW_MEMORY_MAX_CHARS : KF_RAW_TREE_CACHE_MAX_CHARS;
  return text.length <= limit;
}

let lastIndividuals = null, lastParentsOf = null, lastIsParent = null, lastChildrenOf = null, lastIndiById = null, lastIndiIdxById = null, lastFamilies = null;
let lastSideById = null, lastAncestorSet = null, lastRootId = null;
let lastTimeline = null, lastFileName = "genealogy";
let _kfSourceId = null;      // D1 source_id for VIP server-side queries
let _kfSkipNextSeed = false; // autoLoadCloudGedcom path skips re-seeding (data already in D1)
let _kfSkipNextSeedCount = 0; // suppress VIP autosave for N upcoming processFile() calls
let _kfStartupLoadUserKey = "";
let _kfVipCatalogAutoLoadUserKey = "";
let _kfPublicDemoLoadPromise = null;
const VIP_CATALOG_TREES = [
  { kind: "catalog", key: "demo", tree_uuid: "8b7a6f25-2712-42a3-a487-af4844686886", name: "DEMO", available: true, relation: "public", public: true },
];
let _kfCloudTrees = [];
let _kfShareState = { trees: [] };
let _kfShowDataQualityConcerns = localStorage.getItem("kf-show-data-quality") === "1";
function _kfVisibleCatalogTreesForViewer(trees) {
  return (trees || []).map(t => ({ kind: "catalog", ...t }));
}
function _kfCatalogFallbackTrees() {
  return _kfVisibleCatalogTreesForViewer(
    VIP_CATALOG_TREES
  );
}
function _kfCurrentAuthEmail() {
  return _clerkInstance?.user?.primaryEmailAddress?.emailAddress ||
    document.getElementById("authEmail")?.textContent?.trim() ||
    "";
}
function _kfIsRestrictedUnsharedSourceName(name) {
  const normalized = String(name || "").replace(/(\.(ged|gedcom|json))+$/i, "").trim().toLowerCase();
  return normalized === "archer";
}
function _kfIsPublicDemoSourceName(name) {
  const normalized = String(name || "").replace(/(\.(ged|gedcom|json))+$/i, "").trim().toLowerCase();
  return normalized === "demo";
}
function _kfTreeLoadedByName(name) {
  const sourceName = _kfSourceNameFromFileName(name || "");
  return _kfTreeCache.has(sourceName) || _kfLoadedSources.has(sourceName);
}
function _kfAuthHeaders() {
  return _clerkToken ? { "Authorization": "Bearer " + _clerkToken } : {};
}
function _kfJsonHeaders() {
  return _clerkToken
    ? { "Content-Type": "application/json", "Authorization": "Bearer " + _clerkToken }
    : { "Content-Type": "application/json" };
}
let _kfBrowserDb = null;     // sql.js in-memory SQLite DB built from the loaded GEDCOM
let _kfBrowserDbBuildPromise = null;
let _kfBrowserDbBuildSeq = 0;
let _sqlJsReady = null;      // Promise — resolves when sql.js WASM is loaded
const CHAT_PROXY_LS = "kf-chat-proxy";
const CHAT_PROXY_DEFAULT = "http://localhost:8789";

// applyProjectionFromZoom removed — projection state lives on MapLibre now.

// WebGL globe code removed — MapLibre GL renders the basemap now. The
// (orthographic-only) shader pipeline that used to draw land here was used
// only when projectionName === "ortho", which is no longer reachable.

function resize() {
  const wrap = $("mapWrap");
  if (!wrap) return;
  const r = wrap.getBoundingClientRect();
  W = Math.max(50, Math.floor(r.width));
  H = Math.max(50, Math.floor(r.height));
  for (const c of [baseCanvas, fxCanvas]) {
    c.width = Math.floor(W * devicePixelRatio); c.height = Math.floor(H * devicePixelRatio);
    c.style.width = W + "px"; c.style.height = H + "px";
    c.getContext("2d").setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }
  mapW = W; mapTop = 0; mapBottom = H;
  if (_kfMap) _kfMap.resize();
  if (timelineLoaded) {
    projectAll();
    fxCtx.clearRect(0, 0, W, H);
    if (typeof _kfRefreshViewChrome === "function") _kfRefreshViewChrome(true);
    if (typeof updateMapLegend === "function") updateMapLegend();
  }
}
window.addEventListener("resize", resize);
