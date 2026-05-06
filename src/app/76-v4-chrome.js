// ---------- v4 design chrome ----------
const _KF_V4_TAB_COPY = {
  map: {
    title: "Map",
    sub: "Timeline and place canvas for the checked-tree scope.",
    lens: "Lens · Playback",
  },
  person: {
    title: "People",
    sub: "Select one person, then follow their recorded places and kinship.",
    lens: "Lens · Lineage",
  },
  cluster: {
    title: "Patterns",
    sub: "Turn dense markers into readable family, place, and branch patterns.",
    lens: "Lens · Patterns",
  },
  trees: {
    title: "Tree scope",
    sub: "Checked trees control the map, context, and live exploration.",
    lens: "Scope · Selected trees",
  },
  tour: {
    title: "Story",
    sub: "Current year, visible people, uncertainty, and movement context.",
    lens: "Story",
  },
  chat: {
    title: "Explore this branch",
    sub: "Ask, inspect routes, and verify evidence before conclusions.",
    lens: "Lens · Migration patterns",
  },
};

function _kfV4CleanName(name) {
  return String(name || "?").replace(/\//g, "").replace(/\s+/g, " ").trim() || "?";
}

function _kfV4Initials(name) {
  const parts = _kfV4CleanName(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  return (parts.map(p => p[0]).join("") || "KF").toUpperCase();
}

function _kfV4LifeSpan(ind) {
  if (!ind) return "";
  const birth = Number.isFinite(Number(ind.birth_year)) ? Number(ind.birth_year) : null;
  const death = Number.isFinite(Number(ind.death_year)) ? Number(ind.death_year) : null;
  if (birth && death) return `${birth}-${death}`;
  if (birth) return `b. ${birth}`;
  if (death) return `d. ${death}`;
  return "";
}

function _kfV4SelectedPerson() {
  if (highlightedDwell >= 0 && lastIndividuals && dwellIndi) {
    const selected = lastIndividuals[dwellIndi[highlightedDwell]];
    if (selected) return selected;
  }
  if (lastRootId && lastIndiById) {
    const root = lastIndiById.get(lastRootId);
    if (root) return root;
  }
  return lastIndividuals?.[0] || null;
}

function _kfV4EventYear(ev) {
  const y = Number(ev?.year);
  if (Number.isFinite(y)) return y;
  const match = String(ev?.date || "").match(/\b\d{3,4}\b/);
  return match ? Number(match[0]) : null;
}

function _kfV4PlacedEvents(ind) {
  const facts = typeof _kfFactsForInd === "function" ? _kfFactsForInd(ind) : null;
  const events = (facts?.events || ind?.events || [])
    .filter(ev => ev && ev.place && Number.isFinite(_kfV4EventYear(ev)))
    .slice()
    .sort((a, b) => _kfV4EventYear(a) - _kfV4EventYear(b));
  return events;
}

function _kfV4ShortPlace(place) {
  if (typeof _kfShortPlace === "function") return _kfShortPlace(place, 2);
  return String(place || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 2).join(", ");
}

function _kfV4RouteText(ind) {
  if (!ind) return "Load a tree, then select a person to see the recorded path through time.";
  const events = _kfV4PlacedEvents(ind);
  if (!events.length) return "This person has no placed events in the selected trees yet.";
  const first = events[0];
  const last = events[events.length - 1];
  const firstYear = _kfV4EventYear(first);
  const lastYear = _kfV4EventYear(last);
  const firstPlace = _kfV4ShortPlace(first.place) || "unknown place";
  const lastPlace = _kfV4ShortPlace(last.place) || "unknown place";
  if (events.length === 1 || firstPlace === lastPlace) {
    return `${firstYear || "Recorded"} · ${firstPlace}. One placed record is enough to locate the life, not enough to infer a migration.`;
  }
  return `${firstYear || "?"} ${firstPlace} → ${lastYear || "?"} ${lastPlace}. Recorded places show the span; unknown gaps stay unknown.`;
}

function _kfV4RelationLabel(ind) {
  if (!ind) return "evidence-backed movement";
  if (ind.id === lastRootId) return "home person";
  const rel = relationCache?.get(ind.id);
  if (rel) return rel;
  return highlightedDwell >= 0 ? "selected person" : "visible person";
}

function _kfV4SourceScopeText() {
  const sources = typeof _kfSelectedVizSourceList === "function" ? _kfSelectedVizSourceList() : [];
  const names = sources
    .map(src => String(src.common_name || src.name || "").replace(/\.ged$/i, "").trim())
    .filter(Boolean);
  const treeCount = sources.length || _kfLoadedSources?.size || 0;
  const treeText = treeCount ? `${treeCount} ${treeCount === 1 ? "tree" : "trees"}` : "no trees";
  const nameText = names.length
    ? names.slice(0, 2).join(" + ") + (names.length > 2 ? ` +${names.length - 2}` : "")
    : "select trees";
  const people = lastIndividuals?.length ? `${lastIndividuals.length.toLocaleString()} people` : "no people loaded";
  const visible = timelineLoaded && typeof _kfVisibleMarkerData === "function"
    ? ` · ${_kfVisibleMarkerData().count.toLocaleString()} visible in ${Math.floor(curYear)}`
    : "";
  return `Tree scope · ${nameText} · ${treeText} · ${people}${visible} · halos approximate`;
}

function _kfV4VisibleData() {
  if (timelineLoaded && typeof _kfVisibleMarkerData === "function") return _kfVisibleMarkerData();
  return { count: 0, exact: 0, weak: 0 };
}

function _kfV4SourceNames() {
  const sources = typeof _kfSelectedVizSourceList === "function" ? _kfSelectedVizSourceList() : [];
  return sources
    .map(src => String(src.common_name || src.name || "").replace(/\.(ged|gedcom|json)$/i, "").trim())
    .filter(Boolean);
}

function _kfV4SheetHtml(kind) {
  if (kind === "people") {
    return `<section id="v4PeopleStory" class="sheetStoryCard sheetStoryPeople">` +
      `<div class="sheetEyebrow">Person connection</div>` +
      `<h3 id="v4PeopleStoryTitle">Choose who the map is about</h3>` +
      `<p id="v4PeopleStoryBody">The People sheet turns dots into kin: home person, selected person, relationship filter, surname focus, and visible relationship lines.</p>` +
      `<div class="sheetStatGrid">` +
        `<div><b id="v4PeopleVisible">0</b><span>visible now</span></div>` +
        `<div><b id="v4PeopleHome">None</b><span>home person</span></div>` +
        `<div><b id="v4PeopleRelation">None</b><span>connection</span></div>` +
      `</div>` +
      `<div class="sheetActionRail">` +
        `<button type="button" id="v4PeopleAll">Everyone</button>` +
        `<button type="button" id="v4PeopleBlood">Blood relatives</button>` +
        `<button type="button" id="v4PeopleAncestors">Ancestors</button>` +
        `<button type="button" id="v4PeopleKin">Show kin lines</button>` +
      `</div>` +
    `</section>`;
  }
  if (kind === "cluster") {
    return `<section id="v4ClusterStory" class="sheetStoryCard sheetStoryCluster">` +
      `<div class="sheetEyebrow">Patterns</div>` +
      `<h3 id="v4ClusterStoryTitle">Find the family pattern in the crowd</h3>` +
      `<p id="v4ClusterStoryBody">Pattern mode changes the question: places reveal migration regions, lineage reveals family sides, and tree scope compares sources.</p>` +
      `<div class="sheetStatGrid">` +
        `<div><b id="v4ClusterMode">Off</b><span>grouping</span></div>` +
        `<div><b id="v4ClusterVisible">0</b><span>people in play</span></div>` +
        `<div><b id="v4ClusterRadius">30</b><span>cluster size</span></div>` +
      `</div>` +
      `<div class="truthMini clusterLensNote"><b>One lens at a time.</b><span>Places, lineage, sources, data quality, and decluttering each answer a different pattern question.</span></div>` +
    `</section>`;
  }
  if (kind === "trees") {
    return `<section id="v4TreesStory" class="sheetStoryCard sheetStoryTrees">` +
      `<div class="sheetEyebrow">Evidence universe</div>` +
      `<h3 id="v4TreesStoryTitle">Checked trees decide what the app can know</h3>` +
      `<p id="v4TreesStoryBody">Every map marker, Story card, Pattern view, and Explore answer is scoped to the trees selected here.</p>` +
      `<div class="sheetStatGrid">` +
        `<div><b id="v4TreesSelected">0</b><span>selected</span></div>` +
        `<div><b id="v4TreesLoaded">0</b><span>loaded</span></div>` +
        `<div><b id="v4TreesPeople">0</b><span>people</span></div>` +
      `</div>` +
      `<div class="truthMini"><b>I don't know is allowed.</b><span>If a tree is unchecked or missing evidence, Explore must say so instead of filling gaps.</span></div>` +
    `</section>`;
  }
  return "";
}

function _kfInstallV4PhoneContextActions() {
  const ribbon = $("mapStoryRibbon");
  if (!ribbon || $("mapStoryActions")) return;
  const actions = document.createElement("div");
  actions.id = "mapStoryActions";
  actions.className = "mapStoryActions";
  actions.innerHTML =
    `<button type="button" id="mapStoryPatterns">Patterns</button>` +
    `<button type="button" id="mapStoryStory">Story</button>`;
  ribbon.appendChild(actions);

  const bind = (id, tab) => {
    const el = $(id);
    if (!el || el.dataset.v4Bound) return;
    el.dataset.v4Bound = "1";
    const openTab = () => {
      if (typeof _kfSetSideTab === "function") _kfSetSideTab(tab);
    };
    if (typeof _kfBindTapOrClick === "function") _kfBindTapOrClick(el, openTab);
    else el.addEventListener("click", openTab);
  };
  bind("mapStoryPatterns", "cluster");
  bind("mapStoryStory", "tour");
}

function _kfInstallV4SheetCards() {
  _kfInstallV4PhoneContextActions();
  if (!$("v4PeopleStory")) $("personPane")?.insertAdjacentHTML("afterbegin", _kfV4SheetHtml("people"));
  if (!$("v4ClusterStory")) $("clusterPane")?.insertAdjacentHTML("afterbegin", _kfV4SheetHtml("cluster"));
  if (!$("v4TreesStory")) $("treesPane")?.insertAdjacentHTML("afterbegin", _kfV4SheetHtml("trees"));

  const bind = (id, fn) => {
    const el = $(id);
    if (!el || el.dataset.v4Bound) return;
    el.dataset.v4Bound = "1";
    el.addEventListener("click", fn);
  };
  bind("v4PeopleAll", () => window.kfApi?.setShowFilter?.("all"));
  bind("v4PeopleBlood", () => window.kfApi?.setShowFilter?.("blood"));
  bind("v4PeopleAncestors", () => window.kfApi?.setShowFilter?.("ancestors"));
  bind("v4PeopleKin", () => window.kfApi?.setKinLines?.(kinLinesN ? 0 : 5));
}

function _kfSetText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function _kfRefreshV4SheetCards() {
  const visible = _kfV4VisibleData();
  const selected = highlightedDwell >= 0 && lastIndividuals ? lastIndividuals[dwellIndi[highlightedDwell]] : null;
  const home = lastRootId && lastIndiById ? lastIndiById.get(lastRootId) : null;
  const storyPerson = selected || home || null;
  const relation = _kfV4RelationLabel(storyPerson);
  const homeName = home ? _kfV4CleanName(home.name).split(/\s+/).slice(0, 2).join(" ") : "None";

  _kfSetText("v4PeopleStoryTitle", storyPerson ? `${_kfV4CleanName(storyPerson.name)} is the current thread` : "Choose who the map is about");
  _kfSetText("v4PeopleStoryBody", storyPerson
    ? _kfV4RouteText(storyPerson)
    : "Select a marker or home person to turn the map into a relationship and movement story.");
  _kfSetText("v4PeopleVisible", visible.count.toLocaleString());
  _kfSetText("v4PeopleHome", homeName);
  _kfSetText("v4PeopleRelation", relation);

  const clusterLabel = typeof _kfClusterModeLabel === "function" ? _kfClusterModeLabel(clusterMode) : (clusterMode || "Off");
  _kfSetText("v4ClusterMode", clusterLabel);
  _kfSetText("v4ClusterVisible", visible.count.toLocaleString());
  _kfSetText("v4ClusterRadius", String(clusterRadius || 30));
  _kfSetText("v4ClusterStoryBody", clusterMode === "none"
    ? "Turn on grouping to see migration regions, family sides, source differences, or dense marker crowds."
    : `${clusterLabel} grouping is active. Click a cluster to see ranked people and the evidence behind the pattern.`);

  const sources = typeof _kfSelectedVizSourceList === "function" ? _kfSelectedVizSourceList() : [];
  const loaded = _kfLoadedSources?.size || sources.length || 0;
  const selectedCount = sources.length || 0;
  const sourceNames = _kfV4SourceNames();
  _kfSetText("v4TreesSelected", String(selectedCount || loaded || 0));
  _kfSetText("v4TreesLoaded", String(loaded));
  _kfSetText("v4TreesPeople", lastIndividuals?.length ? lastIndividuals.length.toLocaleString() : "0");
  _kfSetText("v4TreesStoryBody", sourceNames.length
    ? `${sourceNames.join(" + ")} defines the visible markers, Story explanations, Pattern views, and Explore answers.`
    : "Select or load trees here before trusting any map pattern or Explore answer.");
}

function _kfRefreshV4Chrome() {
  _kfInstallV4SheetCards();
  const scopeEl = $("topScopeText");
  if (scopeEl) scopeEl.textContent = _kfV4SourceScopeText();

  const tab = _kfActiveSideTab || "chat";
  const copy = _KF_V4_TAB_COPY[tab] || _KF_V4_TAB_COPY.chat;
  const titleEl = $("v4PanelTitle");
  const subEl = $("v4PanelSub");
  const lensEl = $("v4LensChip");
  if (titleEl) titleEl.textContent = copy.title;
  if (subEl) subEl.textContent = copy.sub;
  if (lensEl) lensEl.textContent = copy.lens;

  const ind = _kfV4SelectedPerson();
  const nameEl = $("mapStoryName");
  const relEl = $("mapStoryRelation");
  const routeEl = $("mapStoryRoute");
  const avatarEl = $("mapStoryAvatar");
  document.body?.classList.toggle("kf-has-selected-person", !!ind);
  if (avatarEl) avatarEl.textContent = _kfV4Initials(ind?.name);
  if (nameEl) {
    const life = _kfV4LifeSpan(ind);
    nameEl.textContent = ind ? `${_kfV4CleanName(ind.name)}${life ? ` · ${life}` : ""}` : "Select a person to feel the path";
  }
  if (relEl) relEl.textContent = _kfV4RelationLabel(ind);
  if (routeEl) routeEl.textContent = _kfV4RouteText(ind);
  _kfRefreshV4SheetCards();
  if (typeof _kfIsSideTabActive === "function" &&
      _kfIsSideTabActive("chat") &&
      typeof _kfRefreshChatInsightHeader === "function") {
    _kfRefreshChatInsightHeader();
  }
}

function _kfV4FollowSelectedPath() {
  const ind = _kfV4SelectedPerson();
  if (!ind) {
    if (typeof _kfSetSideTab === "function") _kfSetSideTab("tour");
    return;
  }
  const name = _kfV4CleanName(ind.name);
  const events = _kfV4PlacedEvents(ind);
  const years = events.map(_kfV4EventYear).filter(Number.isFinite);
  const moves = window.kfApi?.getMigrations?.(ind.id);
  if (typeof _kfSetFocusedPersonFilter === "function") _kfSetFocusedPersonFilter(ind.id);
  if (moves?.ok && moves.moves?.length && window.kfApi?.addRoute) {
    const points = [];
    const first = moves.moves[0].from;
    if (Number.isFinite(first.lat) && Number.isFinite(first.lon)) {
      points.push({ lat: first.lat, lon: first.lon, label: _kfV4ShortPlace(first.place) || `${first.year}` });
    }
    for (const move of moves.moves) {
      const p = move.to;
      if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
        points.push({ lat: p.lat, lon: p.lon, label: _kfV4ShortPlace(p.place) || `${p.year}` });
      }
    }
    if (points.length >= 2) window.kfApi.addRoute({ points, label: `${name} recorded path`, color: [37, 99, 235] });
  }
  if (years.length >= 2 && window.kfApi?.playRange) {
    window.kfApi.playRange(Math.min(...years), Math.max(...years), 8);
  }
  if (typeof _kfSetSideTab === "function") _kfSetSideTab("chat");
  if (chatInputEl) {
    chatInputEl.value = `Tell me the evidence-grounded migration story for ${name}. Use only selected-tree evidence. If the tree does not support a claim, say "I don't know from the selected trees."`;
    chatInputEl.focus();
  }
}

const _kfV4BaseRefreshViewChrome = typeof _kfRefreshViewChrome === "function" ? _kfRefreshViewChrome : null;
if (_kfV4BaseRefreshViewChrome) {
  _kfRefreshViewChrome = function(force = false) {
    const ret = _kfV4BaseRefreshViewChrome(force);
    _kfRefreshV4Chrome();
    return ret;
  };
}

const _kfV4BaseSyncSideTabChrome = typeof _kfSyncSideTabChrome === "function" ? _kfSyncSideTabChrome : null;
if (_kfV4BaseSyncSideTabChrome) {
  _kfSyncSideTabChrome = function(tab) {
    const ret = _kfV4BaseSyncSideTabChrome(tab);
    _kfRefreshV4Chrome();
    return ret;
  };
}

$("mapStoryAction")?.addEventListener("click", _kfV4FollowSelectedPath);
$("reportIssueTop")?.addEventListener("click", () => $("reportIssue")?.click());
$("helpBtn")?.addEventListener("click", () => {
  const splash = $("splash");
  if (!splash) return;
  splash.hidden = false;
  splash.classList.remove("hidden");
});
window.addEventListener("resize", () => _kfRefreshV4Chrome());
_kfRefreshV4Chrome();
