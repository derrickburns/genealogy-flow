import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const appFiles = readdirSync("src/app")
  .filter(name => /^\d{2}-.+\.js$/.test(name))
  .sort();

function appIndex(fileName) {
  const idx = appFiles.indexOf(fileName);
  assert.notEqual(idx, -1, `${fileName} is missing from the app bundle`);
  return idx;
}

test("refactored UI panels load before legacy panel callers", () => {
  const chatPanels = appIndex("70-chat-panels.js");
  assert.ok(appIndex("45-ux-state.js") < chatPanels);
  assert.ok(appIndex("48-ux-tree-panel.js") < chatPanels);
  assert.ok(appIndex("49-ux-cluster-panel.js") < chatPanels);
  assert.ok(appIndex("49-ux-people-panel.js") < chatPanels);
});

test("person-card collapse hook remains defined by the People panel", () => {
  const peoplePanel = readFileSync("src/app/49-ux-people-panel.js", "utf8");
  const chatPanels = readFileSync("src/app/70-chat-panels.js", "utf8");
  assert.match(chatPanels, /_kfSetPeopleControlsCollapsed\(/);
  assert.match(peoplePanel, /function\s+_kfSetPeopleControlsCollapsed\s*\(/);
});

test("refactored panel mount points still exist in the shell", () => {
  const html = readFileSync("index.html", "utf8");
  for (const id of ["peopleControlsMount", "clusterControlsMount", "sourcesList"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test("map legend auto-hides when it cannot fit the viewport", () => {
  const styles = readFileSync("styles/app.css", "utf8");
  const mapRuntime = readFileSync("src/app/30-map-runtime.js", "utf8");
  const state = readFileSync("src/app/00-state.js", "utf8");
  assert.match(styles, /#mapLegend\.legendAutoHidden\s*\{\s*display:none\s*!important;\s*\}/);
  assert.match(mapRuntime, /function\s+_kfUpdateLegendAccommodation\s*\(/);
  assert.match(mapRuntime, /classList\.toggle\("legendAutoHidden"/);
  assert.match(state, /updateMapLegend\(\)/);
});

test("tree inventory and persistence are viewport-neutral product behavior", () => {
  const controls = readFileSync("src/app/60-ui-controls.js", "utf8");
  const sources = readFileSync("src/app/50-pipeline-sources-review.js", "utf8");
  const services = readFileSync("src/app/95-services-auth-db-cloud.js", "utf8");

  assert.match(controls, /function\s+_kfOpenTreesPanelAfterSplashIfNeeded\s*\(/);
  assert.match(controls, /_kfMaybeOpenTreesPanelForEmptySelection\(\)/);
  const splashOpener = controls.match(/function _kfOpenTreesPanelAfterSplashIfNeeded[\s\S]*?\n}/)?.[0] || "";
  assert.ok(splashOpener, "_kfOpenTreesPanelAfterSplashIfNeeded should exist");
  assert.doesNotMatch(splashOpener, /_kfIsCompactLayout/);
  assert.doesNotMatch(sources, /wrap\.classList\.toggle\("hidden",\s*!_kfIsCompactLayout\(\)\)/);

  const persistFn = services.match(/async function _kfMaybePersistLoadedTreeByHash[\s\S]*?\n}/)?.[0] || "";
  assert.ok(persistFn, "_kfMaybePersistLoadedTreeByHash should exist");
  assert.doesNotMatch(persistFn, /_kfIsCompactLayout/);
});

test("tree sharing creates an application auth invitation", () => {
  const shareApi = readFileSync("functions/api/gedcom/share.ts", "utf8");
  const sources = readFileSync("src/app/50-pipeline-sources-review.js", "utf8");

  assert.match(shareApi, /createClerkClient/);
  assert.match(shareApi, /clerk\.invitations\.createInvitation\(\{/);
  assert.match(shareApi, /emailAddress:\s*params\.to/);
  assert.match(shareApi, /redirectUrl:\s*inviteAppUrl\(env\)/);
  assert.match(shareApi, /ignoreExisting:\s*true/);
  assert.match(shareApi, /kindredFlowShare:\s*true/);
  assert.match(shareApi, /clerk_invitation:\s*clerkResult/);
  assert.doesNotMatch(shareApi, /const clerkResult = changed/);
  assert.match(sources, /Clerk invite sent to/);
  assert.match(sources, /Clerk invite failed/);
});

test("raw tree text caching is based on memory budget, not viewport", () => {
  const state = readFileSync("src/app/00-state.js", "utf8");
  const sources = readFileSync("src/app/50-pipeline-sources-review.js", "utf8");

  assert.match(state, /function\s+_kfShouldCacheRawTreeText\s*\(/);
  assert.match(state, /KF_RAW_TREE_CACHE_MAX_CHARS/);
  assert.match(sources, /_kfShouldCacheRawTreeText\(text\)/);

  const processCacheBlock = sources.match(/_kfActiveTreeName = lastFileName;[\s\S]*?let browserSourceId/)?.[0] || "";
  assert.ok(processCacheBlock, "processFile should contain the raw tree cache decision");
  assert.doesNotMatch(processCacheBlock, /_kfIsCompactLayout/);
});

test("issue reports expose a responsive tree debug snapshot", () => {
  const services = readFileSync("src/app/95-services-auth-db-cloud.js", "utf8");

  assert.match(services, /function\s+_kfBuildTreeDebugSnapshot\s*\(/);
  assert.match(services, /tree_debug:\s*_kfBuildTreeDebugSnapshot\(\)/);
  assert.match(services, /const sourceId = tree\.source_id \?\? tree\.id \?\? null/);
  assert.match(services, /src\.source_id \?\? src\.id/);
  assert.doesNotMatch(services, /snapshot:\s*_kfBuildIssueContext/);
  assert.match(services, /window\.kfDebug\s*=/);
  assert.match(services, /treeSnapshot:\s*_kfBuildTreeDebugSnapshot/);
  assert.match(services, /clientErrors:\s*\(\) => _kfClientErrors\.slice\(\)/);
  assert.match(services, /has_available_non_demo_remote_tree/);
});

test("responsive browser smoke coverage is wired into package scripts", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const smoke = readFileSync("scripts/smoke-responsive-layout.mjs", "utf8");

  assert.equal(pkg.scripts["smoke:responsive"], "node scripts/smoke-responsive-layout.mjs");
  assert.match(smoke, /Emulation\.setDeviceMetricsOverride/);
  assert.match(smoke, /window\.kfDebug\.treeSnapshot/);
  assert.match(smoke, /window\.kfDebug\.clientErrors/);
  assert.match(smoke, /value => !!value\?\.ok/);
});

test("responsive shell naming stays presentation-only", () => {
  const html = readFileSync("index.html", "utf8");
  const styles = readFileSync("styles/app.css", "utf8");
  const state = readFileSync("src/app/00-state.js", "utf8");
  const panels = readFileSync("src/app/70-chat-panels.js", "utf8");
  const derived = readFileSync("src/app/75-derived-cache.js", "utf8");
  const services = readFileSync("src/app/95-services-auth-db-cloud.js", "utf8");
  const responsiveShellCode = [html, styles, panels, derived, services].join("\n");

  for (const oldName of [
    "compactSheet",
    "compactContextStrip",
    "compactMapTab",
    "compactConcept",
    "_kfSetCompactSheetState",
    "_kfBumpCompactSheetForTab",
  ]) {
    assert.doesNotMatch(responsiveShellCode, new RegExp(oldName));
  }

  assert.match(html, /id="responsiveSheetHandle"/);
  assert.match(html, /id="responsiveContextStrip"/);
  assert.match(html, /class="responsiveMapTab"/);
  assert.match(styles, /#responsiveSheetHandle/);
  assert.match(styles, /\.responsiveConceptCards/);
  assert.match(state, /function\s+_kfUsesResponsiveShell\s*\(/);
  assert.match(panels, /function\s+_kfSetResponsiveSheetState\s*\(/);
  assert.match(panels, /_kfUsesResponsiveShell\(\)/);
  assert.match(derived, /_kfResponsiveContextStripHtml/);
  assert.match(services, /responsive_shell:/);
});

test("mobile tree loading keeps automatic root detail from taking over the map", () => {
  const panels = readFileSync("src/app/70-chat-panels.js", "utf8");
  const sources = readFileSync("src/app/50-pipeline-sources-review.js", "utf8");
  const api = readFileSync("src/app/80-kf-api.js", "utf8");

  assert.match(panels, /function\s+_kfShowPersonCard\s*\(\s*di,\s*opts\s*=\s*\{\}\s*\)/);
  assert.match(panels, /opts\.reveal\s*!==\s*false\)\s*_kfSetSideTab\("person"\)/);
  assert.match(sources, /_kfShowPersonCard\(latest,\s*\{\s*reveal:\s*!\(typeof _kfUsesResponsiveShell === "function" && _kfUsesResponsiveShell\(\)\)\s*\}\)/);
  assert.match(api, /_kfShowPersonCard\(highlightedDwell,\s*\{\s*reveal:\s*!\(typeof _kfUsesResponsiveShell === "function" && _kfUsesResponsiveShell\(\)\)\s*\}\)/);
});

test("local production Clerk sign-in is handled before invoking Clerk modal", () => {
  const services = readFileSync("src/app/95-services-auth-db-cloud.js", "utf8");
  const styles = readFileSync("styles/app.css", "utf8");

  assert.match(services, /function\s+_kfUsesProductionClerkKeyLocally\s*\(/);
  assert.match(services, /throw new Error\('Production Keys are only allowed for domain "kindredsearch\.com"\.'\)/);
  assert.match(services, /_kfShowAuthNotice\(_kfAuthUnavailableMessage\(\),\s*\{\s*actionHref:\s*_kfLiveSignInUrl\(\)/);
  assert.match(services, /_clerkInstance\?\.loaded === false/);
  assert.doesNotMatch(services, /alert\(`Could not start sign-in:/);
  assert.match(styles, /#authNotice \.authNoticeAction/);
});

test("cluster panel has one clustering command surface", () => {
  const chrome = readFileSync("src/app/76-v4-chrome.js", "utf8");
  const cluster = readFileSync("src/app/49-ux-cluster-panel.js", "utf8");

  assert.match(cluster, /id:\s*"clusterModeChoice"/);
  assert.match(cluster, /onChange:\s*e => _kfApplyClusterMode\(e\.currentTarget\.value\)/);
  assert.match(chrome, /clusterLensNote/);
  assert.doesNotMatch(chrome, /v4Cluster(?:Places|Lineage|Trees|Declutter)/);
});

test("declutter clustering is active at the current zoom", () => {
  const renderLayers = readFileSync("src/app/20-render-layers.js", "utf8");
  const mapRuntime = readFileSync("src/app/30-map-runtime.js", "utf8");
  const cluster = readFileSync("src/app/49-ux-cluster-panel.js", "utf8");

  assert.match(cluster, /value:\s*"dispersion",\s*label:\s*"Declutter",\s*detail:\s*"Group nearby markers"/);
  assert.doesNotMatch(renderLayers, /clusterMode === "dispersion" && zoomTransform\.k < 2/);
  assert.doesNotMatch(mapRuntime, /clusterMode === "dispersion" && zoomTransform\.k < 2/);
  assert.match(mapRuntime, /clusterMode === "group"\s+\|\|\s+clusterMode === "dispersion"/);
});

test("explore tab does not render a static text-only contract card", () => {
  const chrome = readFileSync("src/app/76-v4-chrome.js", "utf8");
  const styles = readFileSync("styles/app.css", "utf8");

  assert.doesNotMatch(chrome, /id="v4ExploreContract"/);
  assert.doesNotMatch(chrome, /_kfV4SheetHtml\("explore"\)/);
  assert.doesNotMatch(chrome, /exploreContractGrid/);
  assert.doesNotMatch(styles, /exploreContractGrid/);
  assert.doesNotMatch(chrome, /Make the data felt without making it up/);
});

test("people panel uses person connection buttons as the relationship control", () => {
  const people = readFileSync("src/app/49-ux-people-panel.js", "utf8");
  const controls = readFileSync("src/app/60-ui-controls.js", "utf8");
  const chrome = readFileSync("src/app/76-v4-chrome.js", "utf8");

  assert.match(chrome, /id="v4PeopleAll"/);
  assert.match(chrome, /id="v4PeopleBlood"/);
  assert.match(chrome, /id="v4PeopleAncestors"/);
  assert.match(people, /onPointerUp:\s*_kfTogglePeopleControlsFromPointer/);
  assert.doesNotMatch(people, /id:\s*"showFilterChoice"/);
  assert.doesNotMatch(people, /label:\s*"People shown"/);
  assert.doesNotMatch(controls, /showFilterChoice/);
});

test("responsive bottom tabs are tap targets, not sheet drag handles", () => {
  const panels = readFileSync("src/app/70-chat-panels.js", "utf8");
  const styles = readFileSync("styles/app.css", "utf8");

  assert.match(panels, /_kfInstallResponsiveSheetDrag\(_responsiveSheetHandleEl\)/);
  assert.doesNotMatch(panels, /_kfInstallResponsiveSheetDrag\(_responsiveSheetTabsEl/);
  assert.match(styles, /#sideTabs\s*\{[^}]*touch-action:pan-x/s);
  assert.match(styles, /#sideTabs button\s*\{[^}]*touch-action:manipulation/s);
});

test("responsive sheet panes remain vertical touch scroll containers", () => {
  const styles = readFileSync("styles/app.css", "utf8");

  assert.match(styles, /#panel\[data-sheet="open"\]\s+#chatPanel\s+\.sidePane\.on,\s*#panel\[data-sheet="full"\]\s+#chatPanel\s+\.sidePane\.on\s*\{[^}]*overflow-y:auto/s);
  assert.match(styles, /#panel\[data-sheet="open"\]\s+#chatPanel\s+\.sidePane\.on,\s*#panel\[data-sheet="full"\]\s+#chatPanel\s+\.sidePane\.on\s*\{[^}]*-webkit-overflow-scrolling:touch/s);
  assert.match(styles, /#panel\[data-sheet="open"\]\s+#chatPanel\s+\.sidePane\.on,\s*#panel\[data-sheet="full"\]\s+#chatPanel\s+\.sidePane\.on\s*\{[^}]*touch-action:pan-y/s);
});

test("phone shell uses primary destinations with contextual patterns and story access", () => {
  const html = readFileSync("index.html", "utf8");
  const panels = readFileSync("src/app/70-chat-panels.js", "utf8");
  const chrome = readFileSync("src/app/76-v4-chrome.js", "utf8");
  const styles = readFileSync("styles/app.css", "utf8");
  const smoke = readFileSync("scripts/smoke-responsive-layout.mjs", "utf8");

  assert.match(html, /data-side-tab="cluster">Patterns</);
  assert.match(html, /data-side-tab="tour">Story</);
  assert.match(panels, /tab === "cluster" \? "Patterns"/);
  assert.match(panels, /tab === "tour" \? "Story"/);
  assert.match(chrome, /function\s+_kfInstallV4PhoneContextActions\s*\(/);
  assert.match(chrome, /id="mapStoryPatterns"/);
  assert.match(chrome, /id="mapStoryStory"/);
  assert.match(chrome, /_kfSetSideTab\(tab\)/);
  assert.match(styles, /#sideTabs\s+\[data-side-tab="cluster"\],\s*#sideTabs\s+\[data-side-tab="tour"\]\s*\{[^}]*display:none\s*!important/s);
  assert.match(styles, /\.mapStoryActions\s+button\s*\{[^}]*min-height:48px/s);
  assert.match(smoke, /#mapStoryPatterns/);
  assert.match(smoke, /#mapStoryStory/);
});

test("phone panels meet the Pencil readability scale", () => {
  const styles = readFileSync("styles/app.css", "utf8");

  assert.match(styles, /#mapStoryName\s*\{[^}]*font-size:18px/s);
  assert.match(styles, /\.sheetStoryCard h3,\s*\.contextHeroCard h3\s*\{[^}]*font-size:22px/s);
  assert.match(styles, /\.sheetStoryCard p,\s*\.contextHeroCard p,[^}]*\{[^}]*font-size:16px/s);
  assert.match(styles, /\.sheetActionRail button\s*\{[^}]*min-height:48px/s);
  assert.match(styles, /\.optionCard select\s*\{[^}]*min-height:48px/s);
  assert.match(styles, /#chatInput\s*\{[^}]*min-height:112px/s);
  assert.match(styles, /#chatLock button\s*\{[^}]*min-height:48px/s);
  assert.match(styles, /#treesPane #sourcesPanel \.treeInventoryRow\s*\{[^}]*padding:14px/s);
  assert.match(styles, /#chatBar button\s*\{[^}]*min-height:48px/s);
});

test("short phone map-first state gives vertical space back to the map", () => {
  const styles = readFileSync("styles/app.css", "utf8");
  const smoke = readFileSync("scripts/smoke-responsive-layout.mjs", "utf8");

  assert.match(styles, /Pencil v6 map-first implementation/);
  assert.match(styles, /@media \(max-width: 720px\) and \(max-height: 760px\)/);
  assert.match(styles, /\.responsiveContextStrip\s*\{[^}]*display:none\s*!important/s);
  assert.match(styles, /#ui\s*\{[^}]*min-height:86px\s*!important/s);
  assert.match(styles, /#ui \.timelineOptions\s*\{[^}]*display:none\s*!important/s);
  assert.match(styles, /body:has\(#panel\[data-active-tab="map"\]\[data-sheet="peek"\]\) #sideTabs\s*\{[^}]*min-height:58px/s);
  assert.match(styles, /body:has\(#panel\[data-active-tab="map"\]\[data-sheet="peek"\]\) \.mapStoryRibbon\s*\{[^}]*bottom:calc\(162px/s);
  assert.match(styles, /body:has\(#panel\[data-active-tab="map"\]\[data-sheet="peek"\]\) #ui\s*\{[^}]*height:64px/s);
  assert.match(styles, /body:has\(#panel\[data-active-tab="map"\]\[data-sheet="peek"\]\) \.mapStoryRibbon\s*\{[^}]*max-height:124px/s);
  assert.match(styles, /body:has\(#panel\[data-active-tab="map"\]\[data-sheet="peek"\]\) \.responsiveContextStrip\s*\{[^}]*display:none\s*!important/s);
  assert.match(styles, /#panel\[data-sheet="open"\]\s*\{[^}]*height:min\(62dvh, 520px\)/s);
  assert.match(smoke, /function\s+assertCompactMapVisible\s*\(/);
  assert.match(smoke, /function\s+assertDetailDrawerLeavesMapContext\s*\(/);
  assert.match(smoke, /\["map", \/Recorded years\|Patterns\|Story\|Tree scope\/i\]/);
  assert.match(smoke, /maxRun >= 320/);
  assert.match(smoke, /visibleMapHeight >= minimum/);
  assert.match(smoke, /compact-short/);
});

test("follow their path narrows the map to the focused person", () => {
  const html = readFileSync("index.html", "utf8");
  const state = readFileSync("src/app/00-state.js", "utf8");
  const graph = readFileSync("src/app/40-gedcom-graph-geocode.js", "utf8");
  const chrome = readFileSync("src/app/76-v4-chrome.js", "utf8");
  const render = readFileSync("src/app/20-render-layers.js", "utf8");
  const derived = readFileSync("src/app/75-derived-cache.js", "utf8");
  const api = readFileSync("src/app/80-kf-api.js", "utf8");
  const smoke = readFileSync("scripts/smoke-responsive-layout.mjs", "utf8");

  assert.match(html, /<option value="person" hidden>focused person only<\/option>/);
  assert.match(state, /let _kfFocusedPersonId = null/);
  assert.match(graph, /function _kfSetFocusedPersonFilter\(id\)/);
  assert.match(graph, /curFilter === "person"[^?]+ind\.id === _kfFocusedPersonId/s);
  assert.match(chrome, /_kfSetFocusedPersonFilter\(ind\.id\)/);
  assert.match(render, /if \(!_kfFilterAllowsIndiIdx\(idx\)\) continue/);
  assert.match(render, /return _kfFilterAllowsIndiIdx\(flowIndi\[i\]\)/);
  assert.match(derived, /\$\{curFilter\}\|\$\{_kfFocusedPersonId \|\| ""\}/);
  assert.match(api, /const valid = \["all", "blood", "ancestors", "person"\]/);
  assert.match(api, /showFilter:\s*curFilter/);
  assert.match(api, /focusedPerson:\s*_kfFocusedPersonId/);
  assert.match(smoke, /function\s+assertFollowPathFocusesPerson\s*\(/);
  assert.match(smoke, /state\.showFilter === "person"/);
  assert.match(smoke, /state\.visiblePeople <= 1/);
});
