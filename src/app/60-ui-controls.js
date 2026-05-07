// The search input doubles as the home indicator. When blurred, it shows
// the current home person's name. When focused, the name selects so the
// next keystroke replaces it with a search query. The ↺ button next to
// the input reverts home to the highest-PCI person; it only appears when
// home has been overridden.
function _kfRefreshHomeBtn() {
  const inp = $("rootSearch");
  const tag = $("rootPciTag");
  const reset = $("resetHomeBtn");
  if (!inp || !tag || !reset) return;
  if (!_kfHomePersonId || !lastIndiById) {
    inp.value = "";
    inp.placeholder = "search person...";
    tag.style.display = "none";
    reset.style.display = "none";
    return;
  }
  const ind = lastIndiById.get(_kfHomePersonId);
  const name = ind?.name || "";
  // Only overwrite the input when it's not actively being typed in.
  if (document.activeElement !== inp) {
    inp.value = name;
    inp.placeholder = "search person...";
  }
  if (_kfHomePCI != null) {
    tag.textContent = `PCI ${Math.round(_kfHomePCI * 100)}%`;
    tag.style.display = "";
  } else {
    tag.style.display = "none";
  }
  // Reset shows only when the user has overridden the default home.
  if (_kfTopPciId && _kfHomePersonId !== _kfTopPciId) {
    const top = lastIndiById.get(_kfTopPciId);
    reset.title = top ? `Reset home to highest-PCI person: ${top.name}` : "Reset home to default";
    reset.style.display = "";
  } else {
    reset.style.display = "none";
  }
}

$("resetHomeBtn").addEventListener("mousedown", e => {
  // mousedown so this fires before the search input's blur cascade.
  e.preventDefault();
  if (!_kfTopPciId) return;
  _kfChooseAsHome(_kfTopPciId);
  $("rootSearch").blur();
});

// Pick a person from the search dropdown -> they become the new home.
// Updates _kfHomePersonId and re-applies root.
function _kfChooseAsHome(id) {
  if (!id || !lastIndiById) return;
  const ind = lastIndiById.get(id);
  if (!ind) return;
  if (id !== lastRootId) pushHistory();
  _kfHomePersonId = id;
  if (ind.source_name && ind.raw_id) {
    _kfActiveTreeName = ind.source_name;
    _kfPreferredRootBySourceName.set(ind.source_name, ind.raw_id);
  }
  // Recompute PCI for the new home (used for the inline PCI tag).
  if (id === _kfTopPciId) {
    _kfHomePCI = _kfTopPCI;
  } else if (lastParentsOf && lastIndiById) {
    const ROOT_MAX_DEPTH = 6;
    let expected = 0;
    for (let d = 1; d <= ROOT_MAX_DEPTH; d++) expected += 1 << d;
    const { found } = ancestorScore(id, lastParentsOf, lastIndiById, ROOT_MAX_DEPTH);
    _kfHomePCI = expected > 0 ? found / expected : null;
  } else {
    _kfHomePCI = null;
  }
  _kfHideRootSuggest();
  $("rootSearch").blur();
  applyRoot(id);
}

function _kfCookieValue(name) {
  const prefix = `${name}=`;
  return document.cookie.split(";").map(s => s.trim()).find(s => s.startsWith(prefix))?.slice(prefix.length) || "";
}

function _kfSetCookie(name, value, days = 365) {
  const maxAge = Math.max(1, days) * 86400;
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
}

function _kfSetDialogOpen(el, open) {
  if (!el) return;
  el.hidden = !open;
  el.classList.toggle("hidden", !open);
  el.setAttribute("aria-hidden", open ? "false" : "true");
}

function _kfOpenTreesPanelAfterSplashIfNeeded() {
  requestAnimationFrame(() => {
    if (typeof _kfMaybeOpenTreesPanelForEmptySelection === "function") {
      _kfMaybeOpenTreesPanelForEmptySelection();
      return;
    }
    if (
      typeof _kfHasSelectedVisualizationTree === "function" &&
      typeof _kfHasAvailableNonDemoRemoteTree === "function" &&
      !_kfHasSelectedVisualizationTree() &&
      _kfHasAvailableNonDemoRemoteTree() &&
      typeof _kfSetSideTab === "function"
    ) {
      _kfSetSideTab("trees");
    }
  });
}

const KF_TERMS_VERSION = "2026-05-03";
function _kfInitTermsAgreement() {
  const modal = $("termsModal");
  const check = $("termsAcceptCheck");
  const btn = $("termsAcceptBtn");
  if (!modal || !check || !btn) {
    _kfSetCookie("kf_terms_accepted", KF_TERMS_VERSION, 3650);
    return;
  }
  if (_kfCookieValue("kf_terms_accepted") === KF_TERMS_VERSION) {
    _kfSetDialogOpen(modal, false);
    return;
  }
  _kfSetDialogOpen(modal, true);
  check.checked = false;
  btn.disabled = true;
  check.addEventListener("change", () => { btn.disabled = !check.checked; });
  btn.addEventListener("click", () => {
    if (!check.checked) return;
    _kfSetCookie("kf_terms_accepted", KF_TERMS_VERSION, 3650);
    _kfSetDialogOpen(modal, false);
  });
}

function _kfInitSplash() {
  const splash = $("splash");
  const btn = $("splashDismiss");
  if (!splash || !btn) return;
  if (_kfCookieValue("kf_splash_seen") === "1") {
    _kfSetDialogOpen(splash, false);
    return;
  }
  _kfSetDialogOpen(splash, true);
  btn.addEventListener("click", () => {
    _kfSetCookie("kf_splash_seen", "1");
    _kfSetDialogOpen(splash, false);
    _kfOpenTreesPanelAfterSplashIfNeeded();
  });
}

function _kfConfirmUploadPolicy() {
  if (_kfCookieValue("kf_upload_policy_seen") === "1") return Promise.resolve(true);
  const modal = $("uploadPolicyModal");
  const cancel = $("uploadPolicyCancel");
  const cont = $("uploadPolicyContinue");
  if (!modal || !cancel || !cont) {
    _kfSetCookie("kf_upload_policy_seen", "1");
    return Promise.resolve(true);
  }
  _kfSetDialogOpen(modal, true);
  return new Promise(resolve => {
    const close = accepted => {
      _kfSetDialogOpen(modal, false);
      modal.removeEventListener("click", onBackdrop);
      cancel.removeEventListener("click", onCancel);
      cont.removeEventListener("click", onContinue);
      if (accepted) _kfSetCookie("kf_upload_policy_seen", "1");
      resolve(accepted);
    };
    const onBackdrop = e => { if (e.target === modal) close(false); };
    const onCancel = () => close(false);
    const onContinue = () => close(true);
    modal.addEventListener("click", onBackdrop);
    cancel.addEventListener("click", onCancel);
    cont.addEventListener("click", onContinue);
    cont.focus();
  });
}

async function _kfSelectUploadTreeFile() {
  if (await _kfConfirmUploadPolicy()) fileInp.click();
}

function _kfSetDataQualityVisibility(enabled, opts = {}) {
  _kfShowDataQualityConcerns = !!enabled;
  localStorage.setItem("kf-show-data-quality", _kfShowDataQualityConcerns ? "1" : "0");
  document.querySelectorAll('[data-intent="weak"]').forEach(el => {
    el.style.display = _kfShowDataQualityConcerns ? "" : "none";
  });
  if (opts.skipRefresh) return;
  if (highlightedDwell >= 0 && typeof _kfShowPersonCard === "function") _kfShowPersonCard(highlightedDwell);
  if (typeof _kfRefreshViewChrome === "function") _kfRefreshViewChrome(true);
}

function _kfInitDataQualityToggle() {
  const toggle = $("dataQualityToggle");
  if (!toggle) return;
  toggle.checked = !!_kfShowDataQualityConcerns;
  toggle.addEventListener("change", () => _kfSetDataQualityVisibility(toggle.checked));
  _kfSetDataQualityVisibility(toggle.checked, { skipRefresh: true });
}

_kfInitTermsAgreement();
_kfInitSplash();
_kfInitDataQualityToggle();

// --- Person autocomplete search -----------------------------------------
// Match-aware ranking: prefix match on full name > prefix match on any token >
// substring match. Year suffix and event count tie-break.
function _kfRankPersonMatches(query, max) {
  if (!lastIndividuals || !lastIndividuals.length) return [];
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const ind of lastIndividuals) {
    const name = ind.name || "";
    const lname = name.toLowerCase();
    let rank;
    if (lname.startsWith(q)) rank = 0;
    else {
      const tokens = lname.split(/\s+/);
      if (tokens.some(t => t.startsWith(q))) rank = 1;
      else if (lname.includes(q)) rank = 2;
      else continue;
    }
    out.push({ ind, rank, ev: ind.events?.length ?? 0 });
    if (out.length > 200) break; // hard cap to keep sort cheap
  }
  out.sort((a, b) => (a.rank - b.rank) || (b.ev - a.ev));
  return out.slice(0, max);
}

function _kfBuildSuggestRows(rows) {
  return rows.map(ind => {
    const yrs = `${ind.birth_year ?? "?"}-${ind.death_year ?? "?"}`;
    const isHome = ind.id === _kfHomePersonId;
    const isTop  = ind.id === _kfTopPciId;
    const isCur  = ind.id === lastRootId;
    const tags = [];
    if (isHome) tags.push(`<span style="font-size:9px;color:#a07b1a;margin-left:4px;">&#127968; home</span>`);
    if (isTop && !isHome) tags.push(`<span style="font-size:9px;color:#a07b1a;margin-left:4px;">&#11088; top PCI</span>`);
    if (isCur && !isHome) tags.push(`<span style="font-size:9px;color:#2a4a8c;margin-left:4px;">current</span>`);
    return `<div class="rootSuggestItem" data-id="${escHtml(ind.id)}" style="padding:5px 10px;cursor:pointer;border-bottom:1px solid #eef1f6;font-size:12px;">
      <span style="font-weight:600;">${escHtml(ind.name || "")}</span>
      <span style="color:#7a8aa0;font-size:11px;margin-left:6px;">${yrs}</span>${tags.join("")}
      ${ind.source_name ? `<span style="color:#9aa6bc;font-size:10px;margin-left:6px;">${escHtml(ind.source_name)}</span>` : ""}
    </div>`;
  }).join("");
}

function _kfWireSuggestClicks(box) {
  box.querySelectorAll(".rootSuggestItem").forEach(el => {
    el.addEventListener("mouseenter", () => { el.style.background = "#eef3fa"; });
    el.addEventListener("mouseleave", () => { el.style.background = ""; });
    // Use mousedown so the input's blur (which hides the suggest) doesn't
    // race with the click — blur fires before click on some browsers.
    el.addEventListener("mousedown", e => {
      e.preventDefault();
      _kfChooseAsHome(el.dataset.id);
    });
  });
}

function _kfRenderRootSuggest(query) {
  const box = $("rootSuggest");
  if (!box) return;
  const matches = _kfRankPersonMatches(query, 12);
  if (!matches.length) { _kfHideRootSuggest(); return; }
  box.innerHTML = _kfBuildSuggestRows(matches.map(m => m.ind));
  box.style.display = "block";
  _kfWireSuggestClicks(box);
}


function _kfHideRootSuggest() {
  const box = $("rootSuggest");
  if (box) box.style.display = "none";
}

$("rootSearch").addEventListener("input", e => {
  const v = e.target.value;
  if (!v.trim()) { _kfHideRootSuggest(); return; }
  _kfRenderRootSuggest(v);
});
$("rootSearch").addEventListener("focus", e => {
  // Select the displayed home name so typing replaces it immediately.
  // No dropdown shown until the user actually types.
  e.target.select();
});
$("rootSearch").addEventListener("blur", () => {
  // Defer so a mousedown on a suggestion item registers before we hide,
  // then restore the home name display.
  setTimeout(() => {
    _kfHideRootSuggest();
    _kfRefreshHomeBtn();
  }, 150);
});
$("rootSearch").addEventListener("keydown", e => {
  if (e.key === "Escape") {
    e.target.value = "";
    _kfHideRootSuggest();
    e.target.blur();
  }
});
// Subtle focus ring on the wrapper so the whole control reads as one element.
$("rootSearch").addEventListener("focus", () => {
  const box = $("rootSearchBox");
  if (box) {
    box.style.borderColor = "#2a4a8c";
    box.style.boxShadow = "0 0 0 2px rgba(42,74,140,0.18)";
  }
});
$("rootSearch").addEventListener("blur", () => {
  const box = $("rootSearchBox");
  if (box) {
    box.style.borderColor = "#c0ccd8";
    box.style.boxShadow = "";
  }
});

$("rootSel").addEventListener("change", e => {
  if (e.target.value && e.target.value !== lastRootId) {
    pushHistory();
    const ind = lastIndiById?.get(e.target.value);
    if (ind?.source_name && ind.raw_id) {
      _kfActiveTreeName = ind.source_name;
      _kfPreferredRootBySourceName.set(ind.source_name, ind.raw_id);
    }
    applyRoot(e.target.value);
  }
});
$("filt").addEventListener("change", e => {
  curFilter = e.target.value;
  if (curFilter !== "person") _kfFocusedPersonId = null;
  fxCtx.clearRect(0, 0, W, H);
  if (_kfDeckOverlay) updateDeckDwellLayer();
  if (typeof _kfSyncOptionSelectors === "function") _kfSyncOptionSelectors();
  _kfRefreshViewChrome(true);
});
$("borderLayer").addEventListener("change", e => {
  borderLayer = e.target.value;
  drawBase();
});
$("colorMode").addEventListener("change", e => {
  colorMode = e.target.value;
  fxCtx.clearRect(0, 0, W, H);
  if (_kfDwellsOnDeck) refreshDeckDwellColors();
  if (_kfFlowsOnDeck)  refreshDeckFlowColors();
  if (_kfDwellsOnDeck || _kfFlowsOnDeck) updateDeckDwellLayer();
  updateMapLegend();
  _kfRefreshViewChrome(true);
});
if (migrationViewSel) {
  migrationViewSel.addEventListener("change", e => {
    migrationViz = e.target.value === "observations" ? "observations" : "continuous";
    fxCtx.clearRect(0, 0, W, H);
    if (_kfDeckOverlay) updateDeckDwellLayer();
    updateMapLegend();
  });
}

// Lens dropdown — selecting a lens activates it (replaces cluster mode in
// effect: dwells/flows hide, the lens-supplied SQL drives a polygon /
// scatter visualization). "none" deactivates.
$("lensSel").addEventListener("change", e => {
  _kfActiveLens = e.target.value || null;
  _kfLensCacheKey = "";  // force fetch
  _kfLensCaption = null;
  _kfRenderLensCaption();
  $("lensDelete").disabled = !_kfActiveLens;
  $("lensFork").disabled = !_kfActiveLens;
  if (_kfActiveLens) _kfFetchLensData();
  else { _kfLensData = null; if (_kfDeckOverlay) updateDeckDwellLayer(); }
  // Update info text
  const info = document.getElementById("lensInfo");
  const lens = _kfLenses.find(l => l.name === _kfActiveLens);
  if (info) info.textContent = lens ? `${lens.shape}` : `${_kfLenses.length} saved`;
});
$("lensDelete").addEventListener("click", () => {
  if (!_kfActiveLens) return;
  if (!confirm(`Delete lens "${_kfActiveLens}"?`)) return;
  _kfLenses = _kfLenses.filter(l => l.name !== _kfActiveLens);
  _kfPersistLenses();
  _kfActiveLens = null;
  _kfLensData = null;
  _kfLensCaption = null;
  _kfRenderLensCaption();
  _kfRenderLensDropdown();
  if (_kfDeckOverlay) updateDeckDwellLayer();
});
// Fork — duplicate the active lens with a new name, then prompt the user
// (or Claude, via chat) to refine it. Quick way to riff on a lens.
$("lensFork").addEventListener("click", () => {
  const cur = _kfLenses.find(l => l.name === _kfActiveLens);
  if (!cur) return;
  const newName = prompt(`Fork "${cur.name}" — name the new lens:`, `${cur.name} (variant)`);
  if (!newName) return;
  if (_kfLenses.some(l => l.name === newName)) { alert(`Lens "${newName}" already exists.`); return; }
  _kfLenses.push({ ...cur, name: newName, created_at: new Date().toISOString() });
  _kfPersistLenses();
  _kfActiveLens = newName;
  _kfLensCacheKey = "";
  _kfRenderLensDropdown();
  _kfFetchLensData();
  // Drop a chat message inviting refinement.
  if (typeof chatHistory !== "undefined") {
    chatHistory.push({
      role: "bot",
      content: `Forked "${cur.name}" → "${newName}". Tell me how to refine it (e.g., "show only women", "filter to before 1900", "add a count column").`,
    });
    if (typeof renderChat === "function") renderChat();
  }
});
// Render dropdown on startup (in case localStorage had saved lenses).
_kfRenderLensDropdown();

// ---------- Year histogram drawn behind the slider track ----------
// Per-year event count, normalized to canvas height. Drawn on tree load
// and on resize. Visual cue for "where the data is dense" — playback feels
// less aimless when you can see the dense decades coming.
function _kfRenderYearHistogram() {
  const canvas = document.getElementById("yearHist");
  if (!canvas || !dwellY || !dwellY.length) return;
  const wrap = canvas.parentElement;
  const cw = wrap.clientWidth || 600;
  const ch = 18;
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.floor(cw * dpr); canvas.height = Math.floor(ch * dpr);
  canvas.style.width = cw + "px"; canvas.style.height = ch + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  // One bin per pixel of canvas width, mapping years [minYear, maxYear].
  const span = Math.max(1, maxYear - minYear);
  const bins = new Uint32Array(cw);
  let maxBin = 0;
  for (let i = 0; i < dwellY.length; i++) {
    const y = dwellY[i];
    if (y < minYear || y > maxYear) continue;
    const b = Math.min(cw - 1, Math.max(0, Math.floor(((y - minYear) / span) * cw)));
    bins[b]++;
    if (bins[b] > maxBin) maxBin = bins[b];
  }
  if (!maxBin) return;
  ctx.fillStyle = "#2a4a8c";
  for (let x = 0; x < cw; x++) {
    if (!bins[x]) continue;
    const h = Math.max(1, Math.round((bins[x] / maxBin) * (ch - 2)));
    ctx.fillRect(x, ch - h, 1, h);
  }
}
window.addEventListener("resize", () => _kfRenderYearHistogram());

// ---------- Quick-chip row above the year slider (Tableau-style filters) ----------

function _kfBuildSurnameTopN(n = 12) {
  if (!lastIndividuals) { _kfSurnamesTop = null; return; }
  const counts = new Map();
  for (const ind of lastIndividuals) {
    const sn = _kfSurnameOf(ind.name);
    if (!sn) continue;
    counts.set(sn, (counts.get(sn) || 0) + 1);
  }
  _kfSurnamesTop = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([surname, count]) => ({ surname, count }));
}

function _kfRenderSurnameChips() {
  if (!_kfSurnamesTop || !_kfSurnamesTop.length) {
    _kfSurnameFilter = null;
  }
  if (typeof _kfRenderPeopleControls === "function") _kfRenderPeopleControls();
}

function _kfSetSelectValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  const v = String(value);
  if ([...el.options].some(opt => opt.value === v)) el.value = v;
}

function _kfSyncOptionSelectors() {
  _kfSetSelectValue("clusterModeChoice", clusterMode);
  _kfSetSelectValue("sexFilterChoice", _kfSexFilter || "all");
  const clusterRadiusMain = document.getElementById("clusterRadiusMain");
  const clusterRadiusMainLabel = document.getElementById("clusterRadiusMainLabel");
  if (clusterRadiusMain) clusterRadiusMain.value = String(clusterRadius);
  if (clusterRadiusMainLabel) clusterRadiusMainLabel.textContent = String(clusterRadius);
  const kinValue = kinLinesN >= 20 ? 20 : kinLinesN >= 10 ? 10 : kinLinesN >= 5 ? 5 : kinLinesN >= 3 ? 3 : 0;
  _kfSetSelectValue("kinLinesChoice", kinValue);
  if (typeof _kfRenderClusterControls === "function") _kfRenderClusterControls();
  if (typeof _kfRenderPeopleControls === "function") _kfRenderPeopleControls();
}

function _kfRefreshQuickChips() {
  _kfSyncOptionSelectors();
}

function _kfSetClusterRadius(n) {
  clusterRadius = parseInt(n, 10) || 30;
  $("clusterRadius").value = clusterRadius;
  $("clusterRadiusLabel").textContent = clusterRadius;
  const main = document.getElementById("clusterRadiusMain");
  const mainLabel = document.getElementById("clusterRadiusMainLabel");
  if (main) main.value = clusterRadius;
  if (mainLabel) mainLabel.textContent = clusterRadius;
  fxCtx.clearRect(0, 0, W, H);
  if (_kfDeckOverlay) updateDeckDwellLayer();
  if (typeof _kfRefreshViewChrome === "function") _kfRefreshViewChrome(true);
  if (typeof _kfRenderClusterControls === "function") _kfRenderClusterControls();
}

$("clusterMode").addEventListener("change", e => {
  clusterMode = e.target.value;
  if (clusterMode === "none") _kfSetActiveClusterLabel("");
  fxCtx.clearRect(0, 0, W, H);
  if (_kfDeckOverlay) updateDeckDwellLayer();
  if (typeof _kfRefreshQuickChips === "function") _kfRefreshQuickChips();
  updateMapLegend();
  _kfRefreshViewChrome(true);
});
$("clusterRadius").addEventListener("input", e => {
  _kfSetClusterRadius(e.target.value);
});
function _kfSetKinLines(n) {
  kinLinesN = n;
  $("kinN").value = n;
  $("kinNLabel").textContent = n;
  $("kinNMain").value = n;
  $("kinNMainLabel").textContent = n;
  _kfSyncOptionSelectors();
  fxCtx.clearRect(0, 0, W, H);
  updateMapLegend();
}
$("kinN").addEventListener("input", e => _kfSetKinLines(parseInt(e.target.value, 10) || 0));
$("kinNMain").addEventListener("input", e => _kfSetKinLines(parseInt(e.target.value, 10) || 0));

function escHtml(s) { return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

function updateSliderMarkers() {
  const mb = $("markBlood"), ma = $("markAncestor");
  if (!mb || !ma) return;
  mb.classList.remove("ancestor");
  if (!lastIndividuals || !lastRootId || !lastBloodSet) {
    mb.style.display = "none"; ma.style.display = "none"; return;
  }
  let bloodMin = Infinity, ancMin = Infinity;
  const ancestors = lastAncestorSet || new Set();
  for (const ind of lastIndividuals) {
    if (ind.id === lastRootId) continue;
    const by = ind.birth_year;
    if (by == null) continue;
    if (lastBloodSet.has(ind.id) && by < bloodMin) bloodMin = by;
    if (ancestors.has(ind.id) && by < ancMin) ancMin = by;
  }
  const lo = parseFloat(range.min), hi = parseFloat(range.max);
  const span = hi - lo;
  const pct = (y) => `${((y - lo) / span) * 100}%`;
  if (bloodMin < Infinity) {
    mb.textContent = `eldest blood ${bloodMin}`;
    mb.style.left = pct(bloodMin);
    mb.style.display = "";
  } else {
    mb.style.display = "none";
  }
  if (ancMin < Infinity && ancMin !== bloodMin) {
    ma.textContent = `1st ancestor ${ancMin}`;
    ma.style.left = pct(ancMin);
    ma.style.display = "";
  } else if (ancMin < Infinity && ancMin === bloodMin) {
    mb.textContent = `eldest blood / 1st ancestor ${bloodMin}`;
    mb.classList.add("ancestor");
    ma.style.display = "none";
  } else {
    ma.style.display = "none";
  }
}

async function handleFiles(files, opts = {}) {
  const arr = Array.from(files || []);
  const geds = arr.filter(f => /\.(ged|gedcom)$/i.test(f.name));
  const jsons = arr.filter(f => /\.json$/i.test(f.name));
  const persistSelection = opts.persistSelection !== false;
  for (const j of jsons) {
    try {
      const txt = await j.text();
      const obj = JSON.parse(txt);
      if (obj && Array.isArray(obj.patterns) && Array.isArray(obj.migrations)) {
        migrationsData = obj;
        const matched = obj.patterns.filter(p => p.match_count).length;
        stats.textContent = `migrations: ${obj.migrations.length.toLocaleString()} moves, ${matched} historical patterns matched`;
        renderMigBar();
      } else {
        stats.textContent = `unsupported JSON file: ${j.name}`;
      }
    } catch (e) {
      stats.textContent = `error reading ${j.name}: ${e.message}`;
    }
  }
  if (persistSelection && geds.length && typeof _kfMarkTreeSelectionTouched === "function") {
    _kfMarkTreeSelectionTouched();
  }
  let loadedGed = false;
  for (const ged of geds) {
    try { await processFile(ged); }
    catch (e) { stats.textContent = "error: " + e.message; console.error(e); continue; }
    loadedGed = true;
  }
  if (persistSelection && loadedGed && typeof _kfPersistSelectedTrees === "function") {
    _kfPersistSelectedTrees();
  }
}

function renderMigBar() {
  const bar = $("migBar");
  if (!bar) return;
  if (!migrationsData || !Array.isArray(migrationsData.patterns)) {
    bar.classList.add("empty"); return;
  }
  bar.classList.remove("empty");
  const sliderRect = range.getBoundingClientRect();
  const barRect = bar.getBoundingClientRect();
  if (barRect.width <= 10) return;
  const sliderLeft = sliderRect.left - barRect.left;
  const sliderW = sliderRect.width;
  const yMin = parseFloat(range.min) || 1700;
  const yMax = parseFloat(range.max) || 2026;
  const yearToPx = y => sliderLeft + (Math.max(yMin, Math.min(yMax, y)) - yMin) / (yMax - yMin) * sliderW;
  const matched = migrationsData.patterns.filter(p => p.match_count > 0);
  // Pack into rows so labels don't overlap
  const rows = [];
  for (const p of matched) {
    let placed = false;
    for (const r of rows) {
      if (r.every(q => q.years[1] < p.years[0] || p.years[1] < q.years[0])) {
        r.push(p); placed = true; break;
      }
    }
    if (!placed) rows.push([p]);
  }
  bar.style.height = (18 + rows.length * 14 + 4) + "px";
  bar.innerHTML = "";
  rows.forEach((row, ri) => {
    for (const p of row) {
      const x0 = yearToPx(p.years[0]);
      const x1 = yearToPx(p.years[1]);
      const w = Math.max(2, x1 - x0);
      const top = 18 + ri * 14;
      const div = document.createElement("div");
      div.className = "pat";
      div.style.left = x0 + "px";
      div.style.width = w + "px";
      div.style.top = top + "px";
      div.style.background = p.color || "#999";
      div.title = `${p.name} (${p.years[0]}-${p.years[1]})\n${p.match_count} migrations match\n\n${p.description || ""}`;
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.style.left = x0 + "px";
      lbl.style.top = (top - 12) + "px";
      lbl.style.maxWidth = Math.max(80, w) + "px";
      lbl.textContent = `${p.name} · ${p.match_count}`;
      bar.appendChild(div);
      bar.appendChild(lbl);
    }
  });
  const now = document.createElement("div");
  now.className = "now";
  bar.appendChild(now);
  updateNowMarker();
}

function updateNowMarker() {
  const bar = $("migBar");
  if (!bar || bar.classList.contains("empty")) return;
  const now = bar.querySelector(".now");
  if (!now) return;
  const sliderRect = range.getBoundingClientRect();
  const barRect = bar.getBoundingClientRect();
  const sliderLeft = sliderRect.left - barRect.left;
  const sliderW = sliderRect.width;
  const yMin = parseFloat(range.min) || 1700;
  const yMax = parseFloat(range.max) || 2026;
  const x = sliderLeft + (curYear - yMin) / (yMax - yMin) * sliderW;
  now.style.left = x + "px";
}

function _kfNormalizeLoopYear(year) {
  const y = Math.floor(Number(year));
  if (!Number.isFinite(y)) return null;
  return Math.max(minYear, Math.min(maxYear, y));
}

function _kfPlaybackLoopBounds() {
  const beginSet = Number.isFinite(_kfLoopBegin);
  const endSet = Number.isFinite(_kfLoopEnd);
  const begin = beginSet ? Math.max(minYear, Math.min(maxYear, _kfLoopBegin)) : minYear;
  const end = endSet ? Math.max(minYear, Math.min(maxYear, _kfLoopEnd)) : maxYear;
  return {
    active: (beginSet || endSet) && end > begin,
    begin,
    end,
    beginSet,
    endSet,
  };
}

function _kfLoopMarkerPct(year) {
  const yMin = parseFloat(range.min) || minYear;
  const yMax = parseFloat(range.max) || maxYear;
  if (yMax <= yMin) return 0;
  const y = Math.max(yMin, Math.min(yMax, Number(year)));
  return (y - yMin) / (yMax - yMin) * 100;
}

function _kfRefreshLoopControls() {
  const beginBtn = $("loopBeginBtn");
  const endBtn = $("loopEndBtn");
  const clearBtn = $("loopClearBtn");
  const label = $("loopRangeLabel");
  const beginMark = $("markLoopBegin");
  const endMark = $("markLoopEnd");
  const loaded = !!timelineLoaded;
  const hasAnyLoopMark = Number.isFinite(_kfLoopBegin) || Number.isFinite(_kfLoopEnd);
  if (beginBtn) beginBtn.disabled = !loaded;
  if (endBtn) endBtn.disabled = !loaded;
  if (clearBtn) clearBtn.disabled = !loaded || !hasAnyLoopMark;
  const loop = _kfPlaybackLoopBounds();
  if (label) label.textContent = loop.active ? `${Math.floor(loop.begin)}-${Math.floor(loop.end)}` : "full";
  if (beginMark) {
    if (loaded) {
      beginMark.classList.toggle("active", loop.beginSet);
      beginMark.style.display = "";
      beginMark.style.left = `${_kfLoopMarkerPct(loop.begin)}%`;
      beginMark.title = `Drag loop start (${Math.floor(loop.begin)})`;
      beginMark.setAttribute("role", "slider");
      beginMark.setAttribute("tabindex", "0");
      beginMark.setAttribute("aria-label", "Loop start");
      beginMark.setAttribute("aria-valuemin", String(minYear));
      beginMark.setAttribute("aria-valuemax", String(Math.max(minYear, loop.end - 1)));
      beginMark.setAttribute("aria-valuenow", String(Math.floor(loop.begin)));
    } else {
      beginMark.style.display = "none";
    }
  }
  if (endMark) {
    if (loaded) {
      endMark.classList.toggle("active", loop.endSet);
      endMark.style.display = "";
      endMark.style.left = `${_kfLoopMarkerPct(loop.end)}%`;
      endMark.title = `Drag loop end (${Math.floor(loop.end)})`;
      endMark.setAttribute("role", "slider");
      endMark.setAttribute("tabindex", "0");
      endMark.setAttribute("aria-label", "Loop end");
      endMark.setAttribute("aria-valuemin", String(Math.min(maxYear, loop.begin + 1)));
      endMark.setAttribute("aria-valuemax", String(maxYear));
      endMark.setAttribute("aria-valuenow", String(Math.floor(loop.end)));
    } else {
      endMark.style.display = "none";
    }
  }
}

function _kfClampLoopMarkersToTimeline() {
  if (Number.isFinite(_kfLoopBegin)) _kfLoopBegin = _kfNormalizeLoopYear(_kfLoopBegin);
  if (Number.isFinite(_kfLoopEnd)) _kfLoopEnd = _kfNormalizeLoopYear(_kfLoopEnd);
  if (Number.isFinite(_kfLoopBegin) && _kfLoopBegin >= maxYear) _kfLoopBegin = null;
  if (Number.isFinite(_kfLoopEnd) && _kfLoopEnd <= minYear) _kfLoopEnd = null;
  if (Number.isFinite(_kfLoopBegin) && Number.isFinite(_kfLoopEnd) && _kfLoopEnd <= _kfLoopBegin) {
    _kfLoopBegin = null;
    _kfLoopEnd = null;
  }
  _kfRefreshLoopControls();
}

function _kfSetLoopBegin(year = curYear) {
  const y = _kfNormalizeLoopYear(year);
  if (y == null) return { error: "loop begin year is not valid" };
  if (y >= maxYear) return { error: "loop begin must be before the last timeline year" };
  _kfLoopBegin = y;
  if (Number.isFinite(_kfLoopEnd) && _kfLoopEnd <= _kfLoopBegin) _kfLoopEnd = null;
  _kfPlayStopAt = null;
  _kfRefreshLoopControls();
  return { ok: true, loop: _kfPlaybackLoopBounds() };
}

function _kfSetLoopEnd(year = curYear) {
  const y = _kfNormalizeLoopYear(year);
  if (y == null) return { error: "loop end year is not valid" };
  if (y <= minYear) return { error: "loop end must be after the first timeline year" };
  _kfLoopEnd = y;
  if (Number.isFinite(_kfLoopBegin) && _kfLoopBegin >= _kfLoopEnd) _kfLoopBegin = null;
  _kfPlayStopAt = null;
  _kfRefreshLoopControls();
  return { ok: true, loop: _kfPlaybackLoopBounds() };
}

function _kfSetLoopRange(beginYear, endYear) {
  const begin = _kfNormalizeLoopYear(beginYear);
  const end = _kfNormalizeLoopYear(endYear);
  if (begin == null || end == null || end <= begin) return { error: "invalid loop; need end year > begin year within data range" };
  _kfLoopBegin = begin;
  _kfLoopEnd = end;
  _kfPlayStopAt = null;
  _kfRefreshLoopControls();
  return { ok: true, loop: _kfPlaybackLoopBounds() };
}

function _kfTimelineYearFromClientX(clientX) {
  if (!range) return null;
  const rect = range.getBoundingClientRect();
  if (!rect.width) return null;
  const yMin = parseFloat(range.min) || minYear;
  const yMax = parseFloat(range.max) || maxYear;
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return yMin + pct * (yMax - yMin);
}

function _kfSetLoopAnchor(which, year) {
  let y = _kfNormalizeLoopYear(year);
  if (y == null) return { error: "loop year is not valid" };
  if (which === "begin") {
    const end = Number.isFinite(_kfLoopEnd) ? _kfLoopEnd : maxYear;
    y = Math.max(minYear, Math.min(y, end - 1));
    _kfLoopBegin = y <= minYear ? null : y;
  } else if (which === "end") {
    const begin = Number.isFinite(_kfLoopBegin) ? _kfLoopBegin : minYear;
    y = Math.min(maxYear, Math.max(y, begin + 1));
    _kfLoopEnd = y >= maxYear ? null : y;
  } else {
    return { error: "unknown loop anchor" };
  }
  _kfPlayStopAt = null;
  _kfRefreshLoopControls();
  return { ok: true, loop: _kfPlaybackLoopBounds() };
}

function _kfClearLoopRange() {
  const hadLoop = Number.isFinite(_kfLoopBegin) || Number.isFinite(_kfLoopEnd);
  _kfLoopBegin = null;
  _kfLoopEnd = null;
  _kfPlayStopAt = null;
  _kfRefreshLoopControls();
  return { ok: true, cleared: hadLoop };
}

$("loopBeginBtn")?.addEventListener("click", () => {
  pushHistory();
  _kfSetLoopBegin(curYear);
});
$("loopEndBtn")?.addEventListener("click", () => {
  pushHistory();
  _kfSetLoopEnd(curYear);
});
$("loopClearBtn")?.addEventListener("click", () => {
  pushHistory();
  _kfClearLoopRange();
});

function _kfInstallLoopAnchorDrag(which, el) {
  if (!el) return;
  let dragging = false;
  const updateFromEvent = e => {
    const y = _kfTimelineYearFromClientX(e.clientX);
    if (y == null) return;
    _kfSetLoopAnchor(which, y);
  };
  el.addEventListener("pointerdown", e => {
    if (!timelineLoaded) return;
    e.preventDefault();
    e.stopPropagation();
    pushHistory();
    dragging = true;
    el.setPointerCapture?.(e.pointerId);
    el.classList.add("dragging");
    updateFromEvent(e);
  });
  el.addEventListener("pointermove", e => {
    if (!dragging) return;
    e.preventDefault();
    updateFromEvent(e);
  });
  el.addEventListener("pointerup", e => {
    if (!dragging) return;
    e.preventDefault();
    dragging = false;
    el.classList.remove("dragging");
    el.releasePointerCapture?.(e.pointerId);
    updateFromEvent(e);
  });
  el.addEventListener("pointercancel", e => {
    dragging = false;
    el.classList.remove("dragging");
    el.releasePointerCapture?.(e.pointerId);
  });
  el.addEventListener("keydown", e => {
    if (!timelineLoaded) return;
    const step = e.shiftKey ? 10 : 1;
    const loop = _kfPlaybackLoopBounds();
    const current = which === "begin" ? loop.begin : loop.end;
    let next = current;
    if (e.key === "ArrowLeft") next -= step;
    else if (e.key === "ArrowRight") next += step;
    else if (e.key === "Home") next = minYear;
    else if (e.key === "End") next = maxYear;
    else return;
    e.preventDefault();
    pushHistory();
    _kfSetLoopAnchor(which, next);
  });
}
_kfInstallLoopAnchorDrag("begin", $("markLoopBegin"));
_kfInstallLoopAnchorDrag("end", $("markLoopEnd"));
_kfRefreshLoopControls();
$("pick").addEventListener("click", _kfSelectUploadTreeFile);
const pick2 = $("pick2"); if (pick2) pick2.addEventListener("click", _kfSelectUploadTreeFile);
fileInp.addEventListener("change", () => handleFiles(fileInp.files));
window._kfLoadFiles = handleFiles;
  let dropDragDepth = 0;
  let dropStaleTimer = 0;
  function isFileDrag(e) {
    return Array.from(e.dataTransfer?.types || []).includes("Files");
  }
  function hideDropOverlay() {
    dropDragDepth = 0;
    clearTimeout(dropStaleTimer);
    dropStaleTimer = 0;
    dropEl.classList.remove("on");
  }
  function showDropOverlay() {
    dropEl.classList.add("on");
    clearTimeout(dropStaleTimer);
    dropStaleTimer = setTimeout(hideDropOverlay, 1500);
  }
  window.addEventListener("dragenter", e => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dropDragDepth++;
    showDropOverlay();
  });
  window.addEventListener("dragover", e => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    showDropOverlay();
  });
  window.addEventListener("dragleave", e => {
    if (!isFileDrag(e)) return;
    dropDragDepth = Math.max(0, dropDragDepth - 1);
    if (dropDragDepth === 0 || !e.relatedTarget) hideDropOverlay();
  });
  window.addEventListener("drop", e => {
    const files = e.dataTransfer?.files;
    if (isFileDrag(e)) e.preventDefault();
    hideDropOverlay();
    if (files?.length) handleFiles(files);
  });
  window.addEventListener("dragend", hideDropOverlay);
  window.addEventListener("blur", hideDropOverlay);
  document.addEventListener("visibilitychange", () => { if (document.hidden) hideDropOverlay(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") hideDropOverlay(); });

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`status ${r.status}`);
  return r.json();
}

async function bootBasemap() {
  // usStates supports state cluster mode. World land/country topology for
  // marker placement is loaded inside the jitter worker off the main thread.
  stats.textContent = "loading basemap...";
  usStates = await fetchJson("https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json").catch(() => null);
  world = null;
  _kfResetJitterIndexes();
  resize();
  stats.textContent = "ready";
  // Welcome screen stays hidden until auth resolves:
  // - Signed-in users: autoLoadCloudGedcom shows it only if no GEDCOM in R2
  // - Anon returning users: welcome shown after a short delay (below)
  // - Anon new users: welcome shown after auth check completes
  setTimeout(() => {
    if (!_clerkToken && !localStorage.getItem("kf_returning") && !lastIndividuals) {
      welcome.classList.remove("hidden");
    }
  }, 3000); // wait for Clerk to resolve before showing welcome
  requestAnimationFrame(tick);
}

const HISTORICAL_SNAPSHOTS = [1000, 1279, 1492, 1530, 1600, 1650, 1700, 1715, 1783, 1815, 1880, 1914, 1920, 1938, 1945, 1960, 1994, 2000];
let activeHistoricalYear = -1;

function pickSnapshotYear(year) {
  let pick = HISTORICAL_SNAPSHOTS[0];
  for (const s of HISTORICAL_SNAPSHOTS) if (s <= year) pick = s;
  return pick;
}

async function fetchHistoricalBasemap(snapYear) {
  if (historicalBasemaps.has(snapYear)) return historicalBasemaps.get(snapYear);
  const url = `https://cdn.jsdelivr.net/gh/aourednik/historical-basemaps/geojson/world_${snapYear}.geojson`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error("status " + r.status);
    const j = await r.json();
    historicalBasemaps.set(snapYear, j);
    return j;
  } catch (e) {
    console.warn("historical basemap fetch failed", snapYear, e);
    historicalBasemaps.set(snapYear, null);
    return null;
  }
}

function maybeUpdateHistoricalBasemap() {
  if (borderLayer !== "historical") {
    if (activeHistoricalYear !== -1) { activeHistoricalYear = -1; currentHistoricalWorld = null; drawBase(); }
    return;
  }
  const snap = pickSnapshotYear(curYear);
  if (snap === activeHistoricalYear) return;
  activeHistoricalYear = snap;
  const cached = historicalBasemaps.get(snap);
  if (cached) { currentHistoricalWorld = cached; drawBase(); return; }
  fetchHistoricalBasemap(snap).then(j => {
    if (activeHistoricalYear === snap) {
      currentHistoricalWorld = j;
      drawBase();
    }
  });
}
bootBasemap().catch(e => { stats.textContent = "boot error: " + e.message; });
_ensureSqlJs(); // pre-load sql.js WASM in background so it's ready when a GEDCOM is dropped
