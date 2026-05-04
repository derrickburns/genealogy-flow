// ---------- MapLibre GL basemap ----------
//
// Tile source: Carto's Voyager raster basemap (free; OSM-derived; CORS-safe).
// Replaces the d3-canvas drawBase() that used to draw land/borders/graticule.
// Country and state labels are baked into the tiles. Hover for place names is
// "free" — Carto tiles include text labels at appropriate zoom levels.
function initMapLibre() {
  if (_kfMap) return _kfMap;
  if (typeof maplibregl === "undefined") {
    console.warn("[kf] maplibre-gl not loaded — basemap will be empty");
    return null;
  }
  _kfMap = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        carto: {
          type: "raster",
          tiles: [
            "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
            "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
            "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
            "https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
          ],
          tileSize: 256,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        },
      },
      layers: [{ id: "carto", type: "raster", source: "carto" }],
    },
    center: [0, 20],
    zoom: 1.5,
    attributionControl: { compact: true },
    renderWorldCopies: true,
    preserveDrawingBuffer: true,
    fadeDuration: 0,
  });
  // Re-project all dwells whenever the map moves — fxCanvas dwell rendering
  // depends on screen-space coordinates that the map controls. Keep the
  // legacy zoomTransform.k in sync with MapLibre's zoom (log2) so existing
  // zoom-gated render code (kin lines, dispersion, etc.) keeps working.
  // _kfMapMoving lets frame() know to do a full clear (instead of trail-fade
  // composite) per tick during drag — avoids the blink that comes from
  // clearing on every move event while frame() redraws asynchronously.
  _kfMap.on("movestart", () => { _kfMapMoving = true; });
  _kfMap.on("moveend",   () => { _kfMapMoving = false; updateMapLegend(); });
  _kfMap.on("move", () => {
    const k = Math.pow(2, _kfMap.getZoom());
    zoomTransform = { k, x: 0, y: 0 };
    if (timelineLoaded) projectAll();
    _baseDirty = true;
  });
  _kfMap.on("load", () => {
    if (!_kfDeckOverlay && typeof deck !== "undefined" && deck.MapboxOverlay) {
      _kfDeckOverlay = new deck.MapboxOverlay({ interleaved: false, layers: [] });
      _kfMap.addControl(_kfDeckOverlay);
      _kfDwellsOnDeck = true;
      // Build initial layer if a tree is already loaded.
      if (dwellLat && dwellLat.length) { buildDeckDwellData(); updateDeckDwellLayer(); }
    }
    resize();
    if (timelineLoaded) { projectAll(); fxCtx.clearRect(0, 0, W, H); }
  });
  return _kfMap;
}
initMapLibre();
