let _kfHtml2CanvasReady = null;
function _kfShortText(value, max = 1200) {
  const s = String(value ?? "");
  return s.length > max ? s.slice(0, max) + "...[truncated]" : s;
}

function _kfBuildIssueContext() {
  const selected = highlightedDwell >= 0 && lastIndividuals ? lastIndividuals[dwellIndi[highlightedDwell]] : null;
  const root = lastRootId ? lastIndiById?.get(lastRootId) : null;
  const selectedPlace = highlightedDwell >= 0 && dwellPlace?.[highlightedDwell] >= 0 ? placesList[dwellPlace[highlightedDwell]] : null;
  const email = _clerkInstance?.user?.primaryEmailAddress?.emailAddress || "";
  return {
    page: {
      url: location.href,
      title: document.title,
      commit: $("buildVersion")?.textContent?.trim() || "",
      reported_at: new Date().toISOString(),
      user_agent: navigator.userAgent,
      viewport: { width: innerWidth, height: innerHeight, device_pixel_ratio: devicePixelRatio },
    },
    auth_client: {
      tier: _clerkUserTier,
      clerk_user_id: _clerkInstance?.user?.id || null,
      email: email || null,
    },
    app_state: {
      stats: stats?.textContent || "",
      active_tree: _kfActiveTreeName,
      loaded_trees: typeof _kfGetLoadedSourcesList === "function" ? _kfGetLoadedSourcesList() : [],
      selected_source_ids: [...(_kfSelectedSourceIds || [])],
      vip_catalog: _kfCatalogTrees,
      year: Math.floor(curYear),
      min_year: minYear,
      max_year: maxYear,
      playing,
      cluster_mode: clusterMode,
      kin_lines: kinLinesN,
      filter: curFilter,
      sex_filter: _kfSexFilter,
      surname_filter: _kfSurnameFilter ? [..._kfSurnameFilter] : null,
      root: root ? { id: root.id, name: root.name, birth: root.birth_year, death: root.death_year } : null,
      selected_person: selected ? {
        id: selected.id,
        name: selected.name,
        birth: selected.birth_year,
        death: selected.death_year,
        dwell_year: dwellY?.[highlightedDwell] ?? null,
        dwell_place: selectedPlace,
      } : null,
    },
    recent_chat: chatHistory.slice(-12).map(m => ({
      role: m.role,
      kind: m.kind || null,
      content: _kfShortText(m.content, 1500),
    })),
    recent_client_errors: _kfClientErrors,
  };
}

function _kfLoadHtml2Canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  if (_kfHtml2CanvasReady) return _kfHtml2CanvasReady;
  _kfHtml2CanvasReady = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
    s.async = true;
    s.onload = () => window.html2canvas ? resolve(window.html2canvas) : reject(new Error("html2canvas did not initialize"));
    s.onerror = () => reject(new Error("html2canvas failed to load"));
    document.head.appendChild(s);
  });
  return _kfHtml2CanvasReady;
}

async function _kfCaptureIssueSnapshot() {
  try {
    const html2canvas = await _kfLoadHtml2Canvas();
    const canvas = await html2canvas(document.body, {
      backgroundColor: "#ffffff",
      logging: false,
      useCORS: true,
      allowTaint: false,
      scale: Math.min(1.5, window.devicePixelRatio || 1),
    });
    return { kind: "window", dataUrl: canvas.toDataURL("image/jpeg", 0.72) };
  } catch (e) {
    try {
      const map = window.kfApi?.capturePng?.();
      if (map?.dataUrl) return { kind: "map-fallback", dataUrl: map.dataUrl, error: e?.message || String(e) };
    } catch (_) {}
    return { kind: "none", dataUrl: "", error: e?.message || String(e) };
  }
}

async function _kfReportIssue() {
  const description = prompt("Describe the issue. Include what you expected and what happened.");
  if (!description || !description.trim()) return;
  const btn = $("reportIssue");
  const oldText = btn?.textContent || "Report issue";
  if (btn) {
    btn.disabled = true;
    btn.classList.add("busy");
    btn.textContent = "Reporting...";
  }
  try {
    const snapshot = await _kfCaptureIssueSnapshot();
    const headers = { "Content-Type": "application/json" };
    if (_clerkToken) headers["Authorization"] = "Bearer " + _clerkToken;
    const resp = await fetch("/api/issues/report", {
      method: "POST",
      headers,
      body: JSON.stringify({
        description: description.trim(),
        commit: $("buildVersion")?.textContent?.trim() || "",
        snapshotDataUrl: snapshot.dataUrl || "",
        snapshotKind: snapshot.kind,
        context: _kfBuildIssueContext(),
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) throw new Error(data.error || `Issue report failed (${resp.status})`);
    stats.textContent = `created issue #${data.number}`;
    if (data.url && confirm(`Created GitHub issue #${data.number}. Open it now?`)) {
      window.open(data.url, "_blank", "noopener,noreferrer");
    }
  } catch (e) {
    alert(`Could not create issue: ${e.message || e}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("busy");
      btn.textContent = oldText;
    }
  }
}
$("reportIssue")?.addEventListener("click", _kfReportIssue);

// Default to locked state; Clerk will unlock once it resolves auth
applyChatAccess("anon");
// Fire the auto-intro after first paint so the page lays out before the
// network call. Stays silent if neither proxy nor API key is reachable.
// For returning users, autoIntroOnce runs after the cloud GEDCOM loads (in autoLoadCloudGedcom).
// For new/anonymous users with chat access, fire it now.
requestAnimationFrame(() => {
  if (!localStorage.getItem("kf_returning")) autoIntroOnce();
  if (!DEMO_GED_URL) refreshSources();
});

// ---- Clerk auth integration ----
let _kfAuthTokenRetryCount = 0;
let _kfAuthTokenRetryTimer = 0;

const VIP_EMAILS = new Set([
  "ginagregoryburns@gmail.com","mayasylvia.burns@gmail.com",
  "jamil.burns@gmail.com","derrickrburns@gmail.com","derrickburns@gmail.com",
  "derrick.burns@gmail.com","derrick@kindredsearch.com","derrickburns@kindredsearch.com",
  "paigeunterberg@gmail.com",
  "james.raby@gmail.com"
]);

let _clerkReady = false;

function _kfSyncUploadCloudVisibility() {
  const uploadCloudBtn = document.getElementById("uploadCloud");
  if (!uploadCloudBtn) return;
  uploadCloudBtn.style.display = "none";
}
window.addEventListener("resize", _kfSyncUploadCloudVisibility);
window.addEventListener("orientationchange", _kfSyncUploadCloudVisibility);

function _kfSetAccountMenuOpen(open) {
  const menu = document.getElementById("accountMenu");
  const btn = document.getElementById("accountBtn");
  if (!menu || !btn) return;
  menu.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}

function _kfUpdateAccountChrome() {
  const btn = document.getElementById("accountBtn");
  const icon = document.getElementById("accountIcon");
  const label = document.getElementById("accountLabel");
  if (!btn || !icon || !label) return;
  const signedIn = !!_clerkInstance?.user;
  const email = _kfCurrentAuthEmail();
  btn.classList.toggle("signedIn", signedIn);
  icon.textContent = "";
  label.textContent = signedIn ? (email || "Account") : "Sign in";
  btn.title = signedIn ? "Account" : "Sign in";
}

function _kfHasSelectedVisualizationTree() {
  if (!_kfLoadedSources || !_kfSelectedSourceIds) return false;
  return [..._kfLoadedSources.values()].some(src => _kfSelectedSourceIds.has(src.source_id));
}

function _kfMaybeOpenTreesPanelForEmptySelection() {
  if (!_kfIsMobileLayout() || _kfHasSelectedVisualizationTree()) return;
  if (typeof _kfSetSideTab === "function") _kfSetSideTab("trees");
}

function _kfScheduleAuthTokenRetry() {
  if (!_clerkInstance?.user || _kfAuthTokenRetryCount >= 12) return;
  clearTimeout(_kfAuthTokenRetryTimer);
  _kfAuthTokenRetryCount++;
  const delay = Math.min(2500, 250 * _kfAuthTokenRetryCount);
  _kfAuthTokenRetryTimer = setTimeout(() => {
    updateAuthUI(_clerkInstance.user);
  }, delay);
}

async function fetchServerAuthContext() {
  if (!_clerkToken) return null;
  try {
    const r = await fetch("/api/auth/me", {
      headers: { "Authorization": "Bearer " + _clerkToken },
    });
    const j = await r.json();
    if (!r.ok) return { user: null, auth: j?.auth || null, error: j?.error || `auth ${r.status}` };
    return { user: j?.user || null, auth: j?.auth || null, error: null };
  } catch (e) {
    console.warn("[kf] fetchServerAuthContext:", e?.message || e);
    return null;
  }
}

async function initClerk() {
  try {
    // clerk.browser.js auto-initializes via data-clerk-publishable-key attribute.
    // Wait up to 10s for window.Clerk to be ready.
    let attempts = 0;
    while (!window.Clerk && attempts++ < 100) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (!window.Clerk) throw new Error("Clerk did not load");
    _clerkInstance = window.Clerk;
    await _clerkInstance.load();
    _clerkReady = true;
    _clerkInstance.addListener(({ user }) => updateAuthUI(user));
    updateAuthUI(_clerkInstance.user);
  } catch (e) {
    console.error("Clerk init failed:", e);
    _clerkReady = false;
    autoLoadPublicDemoTree().catch(err => console.warn("[kf] autoLoadPublicDemoTree:", err?.message || err));
  }
}

function applyChatAccess(tier) {
  const lockEl = document.getElementById("chatLock");
  const histEl = document.getElementById("chatHistory");
  const formEl = document.getElementById("chatForm");
  const scopeEl = document.getElementById("chatScope");
  const hasAccess = tier === "vip" || !!localStorage.getItem(CHAT_KEY_LS);
  if (lockEl) lockEl.classList.toggle("hidden", hasAccess);
  if (scopeEl) scopeEl.style.display = hasAccess ? "" : "none";
  if (histEl) histEl.style.display = hasAccess ? "" : "none";
  if (formEl) formEl.style.display = hasAccess ? "" : "none";
}

async function updateAuthUI(user) {
  const statusEl = document.getElementById("authStatus");
  const emailEl = document.getElementById("authEmail");
  const btnEl = document.getElementById("authBtn");
  const apiKeyRowEl = document.getElementById("apiKeyRow");

  if (!user) {
    _clerkToken = null;
    _clerkUserTier = "anon";
    statusEl.textContent = "not signed in";
    statusEl.className = "authTier anon";
    emailEl.style.display = "none";
    btnEl.textContent = "Sign in";
    apiKeyRowEl.style.display = "flex";
    _kfSyncUploadCloudVisibility();
    applyChatAccess("anon");
    _kfCatalogTrees = [];
    _kfStartupLoadUserKey = "";
    _kfVipCatalogAutoLoadUserKey = "";
    refreshSources();
    autoLoadPublicDemoTree().catch(e => console.warn("[kf] autoLoadPublicDemoTree:", e?.message || e));
    _kfUpdateAccountChrome();
    return;
  }

  let email = user.primaryEmailAddress?.emailAddress ?? "";
  try {
    _clerkToken = await _clerkInstance.session.getToken();
  } catch (_) { _clerkToken = null; }

  if (!_clerkToken) {
    _clerkUserTier = VIP_EMAILS.has(email.toLowerCase()) ? "vip" : "regular";
    statusEl.textContent = _clerkUserTier === "vip" ? "VIP" : "member";
    statusEl.className = "authTier " + _clerkUserTier;
    emailEl.textContent = email;
    emailEl.style.display = "inline";
    btnEl.textContent = "Sign out";
    apiKeyRowEl.style.display = _clerkUserTier === "vip" ? "none" : "flex";
    _kfSyncUploadCloudVisibility();
    applyChatAccess(_clerkUserTier);
    _kfRemovePublicDemoSourcesForSignedIn();
    _kfRemoveRestrictedVipSources();
    refreshSources();
    _kfScheduleAuthTokenRetry();
    _kfUpdateAccountChrome();
    _kfMaybeOpenTreesPanelForEmptySelection();
    return;
  }

  _kfAuthTokenRetryCount = 0;
  clearTimeout(_kfAuthTokenRetryTimer);
  const serverAuthContext = await fetchServerAuthContext();
  const serverUser = serverAuthContext?.user || null;
  if (_clerkToken && serverAuthContext?.auth && serverAuthContext.auth.status !== "signed-in") {
    console.warn("[kf] server auth did not verify Clerk session:", serverAuthContext.auth);
  }
  if (serverUser?.email) email = serverUser.email;
  _clerkUserTier = serverUser?.type === "vip"
    ? "vip"
    : serverUser?.type === "regular"
      ? "regular"
      : VIP_EMAILS.has(email.toLowerCase()) ? "vip" : "regular";

  statusEl.textContent = _clerkUserTier === "vip" ? "VIP" : "member";
  statusEl.className = "authTier " + _clerkUserTier;
  emailEl.textContent = email;
  emailEl.style.display = "inline";
  btnEl.textContent = "Sign out";
  apiKeyRowEl.style.display = _clerkUserTier === "vip" ? "none" : "flex";
  _kfSyncUploadCloudVisibility();
  applyChatAccess(_clerkUserTier);
  _kfRemovePublicDemoSourcesForSignedIn();
  _kfRemoveRestrictedVipSources();
  await refreshSources();
  _kfUpdateAccountChrome();
  _kfMaybeOpenTreesPanelForEmptySelection();

  const startupUserKey = user.id || email || "signed-in";
  if (_kfStartupLoadUserKey !== startupUserKey) {
    _kfStartupLoadUserKey = startupUserKey;
    autoLoadStartupTrees().catch(e => console.warn("[kf] autoLoadStartupTrees:", e?.message || e));
  }
}

async function autoLoadStartupTrees() {
  if (_kfIsMobileLayout()) {
    await refreshSources();
    if (!_kfHasSelectedVisualizationTree()) await autoLoadPublicDemoTree();
    _kfMaybeOpenTreesPanelForEmptySelection();
    autoIntroOnce();
    return;
  }
  await autoLoadCloudGedcom();
  await autoLoadVipCatalogTrees();
  if (!_kfHasSelectedVisualizationTree()) await autoLoadPublicDemoTree();
  autoIntroOnce();
}

async function autoLoadCloudGedcom() {
  if (!_clerkToken) return;
  const restoring = { role: "bot", content: "Restoring your trees..." };
  if (typeof chatHistory !== "undefined" && chatHistory.length === 0) {
    chatHistory.push(restoring);
    if (typeof renderChat === "function") renderChat();
  }
  try {
    const resp = await fetch("/api/gedcom", {
      headers: { "Authorization": "Bearer " + _clerkToken }
    });
    if (!resp.ok) {
      if (typeof chatHistory !== "undefined") {
        const idx = chatHistory.indexOf(restoring);
        if (idx !== -1) chatHistory.splice(idx, 1);
        if (typeof renderChat === "function") renderChat();
      }
      // Authenticated users with no cloud GEDCOM: show upload prompt, not the drop zone
      stats.textContent = "ready - open a .ged file or drag one in";
      return;
    }
    const payload = await resp.json();
    const trees = Array.isArray(payload?.trees) ? payload.trees : [];
    const restorableTrees = trees.filter(t => !_kfIsPublicDemoSourceName(t?.name));
    if (!restorableTrees.length) {
      if (typeof chatHistory !== "undefined") {
        const idx = chatHistory.indexOf(restoring);
        if (idx !== -1) chatHistory.splice(idx, 1);
        if (typeof renderChat === "function") renderChat();
      }
      stats.textContent = "ready - open a .ged file or drag one in";
      return;
    }
    const defaultTree = restorableTrees.find(t => t.is_default) || null;
    const ordered = restorableTrees.slice().sort((a, b) => Number(!!a.is_default) - Number(!!b.is_default));
    _kfSkipNextSeedCount = ordered.length;
    for (const tree of ordered) {
      const jsonText = JSON.stringify(tree.data || {});
      const file = new File([jsonText], (tree.name || "saved") + ".ged", { type: "text/plain" });
      file._kfTreeMeta = {
        tree_uuid: tree.tree_uuid || null,
        content_hash: tree.content_hash || null,
        content_changed_at: tree.content_changed_at || null,
        owner_uuid: tree.owner_uuid || null,
        owner_email: tree.owner_email || null,
        relation: tree.relation || null,
        top_pci_id: tree.top_pci_id || null,
        top_pci_name: tree.top_pci_name || null,
        top_pci_score: tree.top_pci_score ?? null,
        common_name: _kfSourceNameFromFileName(tree.name || "saved"),
      };
      if (window._kfLoadFiles) await window._kfLoadFiles([file]);
    }
    if (defaultTree?.name && window.kfApi?.setActiveTree) {
      window.kfApi.setActiveTree(defaultTree.name);
    }
    // Replace restoring message with the auto-intro once the tree is loaded
    if (typeof chatHistory !== "undefined") {
      const idx = chatHistory.indexOf(restoring);
      if (idx !== -1) chatHistory.splice(idx, 1);
      if (typeof renderChat === "function") renderChat();
    }
    autoIntroOnce();
  } catch (_) {
    if (typeof chatHistory !== "undefined") {
      const idx = chatHistory.indexOf(restoring);
      if (idx !== -1) chatHistory.splice(idx, 1);
      if (typeof renderChat === "function") renderChat();
    }
    stats.textContent = "ready - open a .ged file or drag one in";
  }
}

// --------------- Browser SQLite (sql.js WASM) ---------------

function _ensureSqlJs() {
  if (_sqlJsReady) return _sqlJsReady;
  _sqlJsReady = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/sql-wasm.js";
    s.onload = () => {
      window.initSqlJs({ locateFile: f => `https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/${f}` })
        .then(SQL => { window._sqlJs = SQL; resolve(); })
        .catch(reject);
    };
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return _sqlJsReady;
}

async function buildBrowserDb() {
  if (_kfLoadedSources.size === 0) {
    if (_kfBrowserDb) { _kfBrowserDb.close(); _kfBrowserDb = null; }
    return;
  }
  try {
    await _ensureSqlJs();
    if (_kfBrowserDb) { _kfBrowserDb.close(); _kfBrowserDb = null; }
    const db = new window._sqlJs.Database();
    db.run(`CREATE TABLE base_sources (id INTEGER PRIMARY KEY, name TEXT, loaded_at TEXT, n_individuals INTEGER, n_events INTEGER, n_families INTEGER)`);
    db.run(`CREATE TABLE base_individuals (source_id INTEGER, id TEXT, name TEXT, sex TEXT, birth_year INTEGER, birth_place TEXT, death_year INTEGER, famc TEXT, PRIMARY KEY (source_id, id))`);
    db.run(`CREATE TABLE base_events (source_id INTEGER, individual_id TEXT, type TEXT, year INTEGER, place TEXT, lat REAL, lon REAL, geo_level TEXT, geo_cc TEXT, geo_st TEXT)`);
    db.run(`CREATE TABLE base_families (source_id INTEGER, id TEXT, husb_id TEXT, wife_id TEXT, PRIMARY KEY (source_id, id))`);
    db.run(`CREATE TABLE base_family_children (source_id INTEGER, family_id TEXT, child_id TEXT, PRIMARY KEY (source_id, family_id, child_id))`);
    db.run("BEGIN");
    const ss = db.prepare("INSERT INTO base_sources VALUES (?,?,?,?,?,?)");
    const si = db.prepare("INSERT OR REPLACE INTO base_individuals VALUES (?,?,?,?,?,?,?,?)");
    const se = db.prepare("INSERT INTO base_events VALUES (?,?,?,?,?,?,?,?,?,?)");
    const sf = db.prepare("INSERT OR REPLACE INTO base_families VALUES (?,?,?,?)");
    const sc = db.prepare("INSERT OR REPLACE INTO base_family_children VALUES (?,?,?)");
    for (const src of _kfLoadedSources.values()) {
      ss.run([
        src.source_id,
        src.name,
        src.loaded_at,
        src.n_individuals,
        src.n_events,
        src.n_families,
      ]);
      for (const ind of src.individuals) {
        si.run([src.source_id, ind.id, ind.name || null, ind.sex || null, ind.birth_year ?? null, ind.birth_place || null, ind.death_year ?? null, ind.famc ?? null]);
        for (const e of (ind.events || [])) {
          const g = geocoder ? geocoder(e.place) : null;
          se.run([
            src.source_id,
            ind.id,
            e.type,
            e.year ?? null,
            e.place || null,
            g ? g.lat : null,
            g ? g.lon : null,
            g ? g.level : null,
            g ? g.cc : null,
            g ? g.st : null,
          ]);
        }
      }
      for (const [, f] of src.families) {
        sf.run([src.source_id, f.id, f.husb || null, f.wife || null]);
        for (const c of (f.chil || [])) sc.run([src.source_id, f.id, c]);
      }
    }
    ss.free();
    si.free();
    se.free();
    sf.free(); sc.free();
    db.run("COMMIT");
    _kfBrowserDb = db;
    _kfEnsureSelectedSources();
    _kfRefreshBrowserViews();
  } catch (e) {
    console.warn("[kf] buildBrowserDb:", e.message || e);
  }
}

function queryBrowserDb(query, maxRows = 200) {
  try {
    const results = _kfBrowserDb.exec(query);
    if (!results.length) return { ok: true, rows: [], truncated: false, totalRows: 0 };
    const { columns, values } = results[0];
    const rows = values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
    const limit = Math.max(1, Math.min(5000, parseInt(maxRows, 10) || 200));
    return { ok: true, rows: rows.slice(0, limit), truncated: rows.length > limit, totalRows: rows.length };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// --------------- Cloud persistence (signed-in users) ---------------

async function seedCloudDb(source = null) {
  const src = source || (_kfActiveTreeName ? _kfLoadedSources.get(_kfActiveTreeName) : null);
  const sourceIndividuals = src?.individuals || lastIndividuals;
  const sourceFamilies = src?.families || lastFamilies;
  const sourceName = src?.name || lastFileName || "My Tree";
  if (!_clerkToken || !sourceIndividuals || !sourceFamilies) return;
  const individuals = sourceIndividuals.map(ind => ({
    id: ind.id,
    name: ind.name || null,
    sex: ind.sex || null,
    birth_year: ind.birth_year ?? null,
    death_year: ind.death_year ?? null,
    famc: ind.famc ?? null,
  }));
  const events = [];
  for (const ind of sourceIndividuals) {
    for (const e of (ind.events || [])) {
      const g = geocoder ? geocoder(e.place) : null;
      events.push({
        individual_id: ind.id,
        type: e.type,
        year: e.year ?? null,
        place: e.place || null,
        lat: g ? g.lat : null,
        lon: g ? g.lon : null,
      });
    }
  }
  const families = Array.from(sourceFamilies.values()).map(f => ({
    id: f.id,
    husb: f.husb || null,
    wife: f.wife || null,
    chil: f.chil || [],
  }));
  try {
    const resp = await fetch("/api/gedcom/seed", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + _clerkToken },
      body: JSON.stringify({
        name: _kfSourceNameFromFileName(src?.common_name || sourceName),
        content_hash: src?.content_hash || null,
        content_changed_at: src?.content_changed_at || null,
        top_pci_id: src?.top_pci_id || null,
        top_pci_name: src?.top_pci_name || null,
        top_pci_score: src?.top_pci_score ?? null,
        is_default: _kfActiveTreeName === sourceName,
        individuals,
        events,
        families,
      }),
    });
    if (resp.ok) {
      const data = await resp.json();
      _kfSourceId = data.source_id ?? null;
      if (src && data.tree_uuid) src.tree_uuid = data.tree_uuid;
      if (src && data.content_hash) src.content_hash = data.content_hash;
      if (src && data.content_changed_at) src.content_changed_at = data.content_changed_at;
      if (src) {
        src.top_pci_id = data.top_pci_id ?? src.top_pci_id ?? null;
        src.top_pci_name = data.top_pci_name ?? src.top_pci_name ?? null;
        src.top_pci_score = data.top_pci_score ?? src.top_pci_score ?? null;
      }
    }
  } catch (e) {
    console.warn("[kf] seedCloudDb:", e.message || e);
  }
}

function _kfCloudTreesPayload() {
  const activeName = _kfActiveTreeName;
  return [..._kfLoadedSources.values()].map(src => _kfCloudTreePayloadForSource(src, _kfSourceNameFromFileName(src.common_name || src.name), activeName));
}

function _kfCloudTreePayloadForSource(src, name, activeName = _kfActiveTreeName) {
  return {
    name: _kfSourceNameFromFileName(name),
    content_hash: src.content_hash || null,
    content_changed_at: src.content_changed_at || null,
    top_pci_id: src.top_pci_id || null,
    top_pci_name: src.top_pci_name || null,
    top_pci_score: src.top_pci_score ?? null,
    is_default: src.name === activeName,
    individuals: src.individuals.map(ind => ({
      id: ind.id,
      name: ind.name || null,
      sex: ind.sex || null,
      birth_year: ind.birth_year ?? null,
      death_year: ind.death_year ?? null,
      famc: ind.famc ?? null,
      events: (ind.events || []).map(e => ({ tag: e.type, year: e.year ?? null, place: e.place || null })),
    })),
    families: Array.from(src.families.values()).map(f => ({
      id: f.id,
      husb: f.husb || null,
      wife: f.wife || null,
      chil: f.chil || [],
    })),
  };
}

function _kfDefaultTreeBaseName() {
  const email = _kfCurrentAuthEmail();
  const local = String(email || "family").split("@")[0].trim() || "family";
  return `${local}'s Tree`;
}

function _kfNextDefaultTreeName(hash) {
  const base = _kfDefaultTreeBaseName();
  const used = new Map();
  for (const tree of [...(_kfCloudTrees || []), ...(_kfShareState?.trees || [])]) {
    const name = String(tree?.name || "").trim();
    if (!name) continue;
    used.set(name.toLowerCase(), String(tree?.content_hash || ""));
  }
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase()) && used.get(candidate.toLowerCase()) !== hash) {
    candidate = `${base} ${n++}`;
  }
  return candidate;
}

async function _kfLookupServerTreeByHash(hash) {
  if (!_clerkToken || !hash) return null;
  const resp = await fetch("/api/gedcom/hash?hash=" + encodeURIComponent(hash), {
    headers: _kfAuthHeaders(),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error || `hash lookup ${resp.status}`);
  return data;
}

function _kfSourceCameFromServer(sourceMeta) {
  return !!(
    sourceMeta?.tree_uuid ||
    sourceMeta?.owner_email ||
    sourceMeta?.owner_uuid ||
    sourceMeta?.relation
  );
}

async function _kfMaybePersistLoadedTreeByHash(src, sourceMeta = {}) {
  if (!_clerkToken || !src?.content_hash || _kfIsMobileLayout() || _kfSourceCameFromServer(sourceMeta)) return null;
  const lookup = await _kfLookupServerTreeByHash(src.content_hash);
  if (lookup?.exists && Array.isArray(lookup.trees) && lookup.trees.length) {
    const existing = lookup.trees.find(t => t.kind === "cloud") || lookup.trees[0];
    if (existing?.name) src.common_name = _kfSourceNameFromFileName(existing.name);
    src.owner_email = existing?.owner_email || src.owner_email || null;
    src.owner_uuid = existing?.owner_uuid || src.owner_uuid || null;
    src.relation = existing?.relation || src.relation || null;
    src.content_changed_at = existing?.content_changed_at || src.content_changed_at || null;
    src.server_source_id = existing?.source_id || null;
    refreshSources();
    return { ok: true, exists: true, tree: existing };
  }
  const name = _kfNextDefaultTreeName(src.content_hash);
  src.common_name = name;
  const result = await _kfSaveLoadedTreesToCloud([src], { skipPrompt: true });
  refreshSources();
  return result;
}

async function _kfSaveLoadedTreesToCloud(sources = null, opts = {}) {
  if (!_clerkToken) return null;
  const rawTrees = sources
    ? sources.map(src => _kfCloudTreePayloadForSource(src, _kfSourceNameFromFileName(src.common_name || src.name)))
    : _kfCloudTreesPayload();
  const trees = _kfRequireNamesForUpload(rawTrees, opts);
  if (!trees) return null;
  if (!trees.length) { alert("No GEDCOM loaded. Open a .ged file first."); return null; }
  const resp = await fetch("/api/gedcom/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + _clerkToken },
    body: JSON.stringify({ trees })
  });
  if (!resp.ok) {
    const j = await resp.json().catch(() => ({}));
    throw new Error(j?.error || `Save failed: ${resp.status}`);
  }
  const result = await resp.json();
  await refreshSources();
  return result;
}

function _kfRequireNamesForUpload(trees, opts = {}) {
  const named = [];
  for (const tree of trees) {
    let name = _kfSourceNameFromFileName(tree.name || "");
    if (!name || name === "untitled" || name === "saved") {
      name = opts.skipPrompt
        ? _kfNextDefaultTreeName(tree.content_hash || "")
        : prompt("Name this tree before saving it to Kindred servers:", name && name !== "untitled" ? name : "") || "";
      name = _kfSourceNameFromFileName(name);
    }
    if (!name) {
      alert("Tree save cancelled. Every uploaded tree must have a name.");
      return null;
    }
    named.push({ ...tree, name });
    const src = [..._kfLoadedSources.values()].find(s =>
      _kfSourceNameFromFileName(s.common_name || s.name) === _kfSourceNameFromFileName(tree.name) ||
      _kfSourceNameFromFileName(s.name) === _kfSourceNameFromFileName(tree.name)
    );
    if (src) src.common_name = name;
  }
  return named;
}

async function _kfBeginClerkSignIn() {
  if (!_clerkReady) {
    alert("Authentication is not available. Check the browser console for errors.");
    return;
  }
  if (!_clerkInstance) {
    alert("Authentication is still loading. Try again in a moment.");
    return;
  }
  const returnUrl = window.location.href;
  const opts = {
    redirectUrl: returnUrl,
    afterSignInUrl: returnUrl,
    afterSignUpUrl: returnUrl,
    fallbackRedirectUrl: returnUrl,
  };
  try {
    if (typeof _clerkInstance.openSignIn === "function") {
      await _clerkInstance.openSignIn(opts);
      return;
    }
    if (typeof _clerkInstance.redirectToSignIn === "function") {
      await _clerkInstance.redirectToSignIn(opts);
      return;
    }
    throw new Error("Clerk sign-in method is unavailable");
  } catch (e) {
    console.error("[kf] Clerk sign-in failed:", e);
    alert(`Could not start sign-in: ${e?.message || e}`);
  }
}

document.getElementById("authBtn").addEventListener("click", async () => {
  if (!_clerkReady) {
    alert("Authentication is not available. Check the browser console for errors.");
    return;
  }
  if (_clerkInstance.user) {
    _kfSetAccountMenuOpen(false);
    await _clerkInstance.signOut();
  } else {
    await _kfBeginClerkSignIn();
  }
});

document.getElementById("accountBtn")?.addEventListener("click", async () => {
  if (!_clerkInstance?.user) {
    await _kfBeginClerkSignIn();
    return;
  }
  const menu = document.getElementById("accountMenu");
  _kfSetAccountMenuOpen(!!menu?.hidden);
});
document.addEventListener("click", e => {
  const menu = document.getElementById("accountMenu");
  const btn = document.getElementById("accountBtn");
  if (!menu || menu.hidden || btn?.contains(e.target) || menu.contains(e.target)) return;
  _kfSetAccountMenuOpen(false);
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") _kfSetAccountMenuOpen(false);
});

// Save Anthropic API key to localStorage (stays in browser, never sent to server)
document.getElementById("apiKeySave").addEventListener("click", () => {
  const key = document.getElementById("apiKeyInput").value.trim();
  if (!key) return;
  localStorage.setItem(CHAT_KEY_LS, key);
  document.getElementById("apiKeyInput").value = "";
  const status = document.getElementById("apiKeyStatus");
  if (status) {
    status.textContent = "saved";
    setTimeout(() => {
      if (status.textContent === "saved") status.textContent = "";
    }, 2500);
  }
  applyChatAccess(_clerkUserTier);
});

document.getElementById("uploadCloud")?.addEventListener("click", async () => {
  try {
    const j = await _kfSaveLoadedTreesToCloud();
    if (!j) return;
    const d = new Date(j.expires_at * 1000).toLocaleDateString();
    alert(`Saved ${j.trees} tree(s) on Kindred servers free of charge until ${d}. You may delete or update this data at any time.`);
  } catch (e) {
    alert(e?.message || "Save failed");
  }
});

initClerk();
