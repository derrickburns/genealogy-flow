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
let _clerkToken = null;
let _clerkUserTier = "anon";
let _clerkInstance = null;
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
  const uploadCloudBtn = document.getElementById("uploadCloud");

  const versionEl = document.getElementById("buildVersion");

  if (!user) {
    _clerkToken = null;
    _clerkUserTier = "anon";
    statusEl.textContent = "not signed in";
    statusEl.className = "authTier anon";
    emailEl.style.display = "none";
    btnEl.textContent = "Sign in";
    apiKeyRowEl.style.display = "flex";
    if (uploadCloudBtn) uploadCloudBtn.style.display = "none";
    if (versionEl) versionEl.style.display = "none";
    applyChatAccess("anon");
    _kfCatalogTrees = [];
    _kfStartupLoadUserKey = "";
    _kfVipCatalogAutoLoadUserKey = "";
    refreshSources();
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
    if (uploadCloudBtn) uploadCloudBtn.style.display = "inline-block";
    if (versionEl) versionEl.style.display = "inline";
    applyChatAccess(_clerkUserTier);
    _kfRemoveRestrictedVipSources();
    refreshSources();
    _kfScheduleAuthTokenRetry();
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
  if (uploadCloudBtn) uploadCloudBtn.style.display = "inline-block";
  if (versionEl) versionEl.style.display = "inline";
  applyChatAccess(_clerkUserTier);
  _kfRemoveRestrictedVipSources();
  refreshSources();

  const startupUserKey = user.id || email || "signed-in";
  if (_kfStartupLoadUserKey !== startupUserKey) {
    _kfStartupLoadUserKey = startupUserKey;
    autoLoadStartupTrees().catch(e => console.warn("[kf] autoLoadStartupTrees:", e?.message || e));
  }
}

async function autoLoadStartupTrees() {
  if (_kfIsMobileLayout()) {
    await refreshSources();
    autoIntroOnce();
    return;
  }
  await autoLoadCloudGedcom();
  if (_clerkUserTier === "vip") await autoLoadVipCatalogTrees();
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
    if (!trees.length) {
      if (typeof chatHistory !== "undefined") {
        const idx = chatHistory.indexOf(restoring);
        if (idx !== -1) chatHistory.splice(idx, 1);
        if (typeof renderChat === "function") renderChat();
      }
      stats.textContent = "ready - open a .ged file or drag one in";
      return;
    }
    const defaultTree = trees.find(t => t.is_default) || null;
    const ordered = trees.slice().sort((a, b) => Number(!!a.is_default) - Number(!!b.is_default));
    _kfSkipNextSeedCount = ordered.length;
    for (const tree of ordered) {
      const jsonText = JSON.stringify(tree.data || {});
      const file = new File([jsonText], (tree.name || "saved") + ".ged", { type: "text/plain" });
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
    db.run(`CREATE TABLE base_individuals (source_id INTEGER, id TEXT, name TEXT, sex TEXT, birth_year INTEGER, death_year INTEGER, famc TEXT, PRIMARY KEY (source_id, id))`);
    db.run(`CREATE TABLE base_events (source_id INTEGER, individual_id TEXT, type TEXT, year INTEGER, place TEXT, lat REAL, lon REAL, geo_level TEXT, geo_cc TEXT, geo_st TEXT)`);
    db.run(`CREATE TABLE base_families (source_id INTEGER, id TEXT, husb_id TEXT, wife_id TEXT, PRIMARY KEY (source_id, id))`);
    db.run(`CREATE TABLE base_family_children (source_id INTEGER, family_id TEXT, child_id TEXT, PRIMARY KEY (source_id, family_id, child_id))`);
    db.run("BEGIN");
    const ss = db.prepare("INSERT INTO base_sources VALUES (?,?,?,?,?,?)");
    const si = db.prepare("INSERT OR REPLACE INTO base_individuals VALUES (?,?,?,?,?,?,?)");
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
        si.run([src.source_id, ind.id, ind.name || null, ind.sex || null, ind.birth_year ?? null, ind.death_year ?? null, ind.famc ?? null]);
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
      body: JSON.stringify({ name: sourceName, is_default: _kfActiveTreeName === sourceName, individuals, events, families }),
    });
    if (resp.ok) {
      const data = await resp.json();
      _kfSourceId = data.source_id ?? null;
    }
  } catch (e) {
    console.warn("[kf] seedCloudDb:", e.message || e);
  }
}

function _kfCloudTreesPayload() {
  const activeName = _kfActiveTreeName;
  return [..._kfLoadedSources.values()].map(src => ({
    name: src.name,
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
  }));
}

document.getElementById("authBtn").addEventListener("click", async () => {
  if (!_clerkReady) {
    alert("Authentication is not available. Check the browser console for errors.");
    return;
  }
  if (_clerkInstance.user) {
    await _clerkInstance.signOut();
  } else {
    _clerkInstance.redirectToSignIn({ redirectUrl: window.location.href });
  }
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

// Upload all loaded trees to cloud persistence
document.getElementById("uploadCloud").addEventListener("click", async () => {
  if (!_clerkToken) return;
  const trees = _kfCloudTreesPayload();
  if (!trees.length) { alert("No GEDCOM loaded. Open a .ged file first."); return; }
  const resp = await fetch("/api/gedcom/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + _clerkToken },
    body: JSON.stringify({ trees })
  });
  if (resp.ok) {
    const j = await resp.json();
    const d = new Date(j.expires_at * 1000).toLocaleDateString();
    alert(`Uploaded ${j.trees} tree(s). Expires ${d}.`);
  } else {
    alert("Upload failed: " + resp.status);
  }
});

initClerk();
