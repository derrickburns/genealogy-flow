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
  for (const id of ["peopleControlsMount", "livingPeopleList", "clusterControlsMount", "sourcesList"]) {
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
  const treePanel = readFileSync("src/app/48-ux-tree-panel.js", "utf8");
  const treeSelectionApi = readFileSync("functions/api/user/tree-selection.ts", "utf8");

  assert.match(controls, /function\s+_kfOpenTreesPanelAfterSplashIfNeeded\s*\(/);
  assert.match(controls, /_kfMaybeOpenTreesPanelForEmptySelection\(\)/);
  const splashOpener = controls.match(/function _kfOpenTreesPanelAfterSplashIfNeeded[\s\S]*?\n}/)?.[0] || "";
  assert.ok(splashOpener, "_kfOpenTreesPanelAfterSplashIfNeeded should exist");
  assert.doesNotMatch(splashOpener, /_kfIsCompactLayout/);
  assert.doesNotMatch(sources, /wrap\.classList\.toggle\("hidden",\s*!_kfIsCompactLayout\(\)\)/);

  const persistFn = services.match(/async function _kfMaybePersistLoadedTreeByHash[\s\S]*?\n}/)?.[0] || "";
  assert.ok(persistFn, "_kfMaybePersistLoadedTreeByHash should exist");
  assert.doesNotMatch(persistFn, /_kfIsCompactLayout/);
  assert.match(sources, /const KF_SELECTED_TREES_LS = "kf-selected-trees-v1"/);
  assert.match(sources, /function\s+_kfTreeSelectionRefForSource\s*\(/);
  assert.match(sources, /function\s+_kfTreeSelectionRefMatchesSource\s*\(/);
  assert.match(sources, /function\s+_kfApplyPersistedSelectedTrees\s*\(/);
  assert.match(sources, /function\s+_kfPersistSelectedTrees\s*\(/);
  assert.match(sources, /function\s+_kfSetPersistedSelectedTreeRefs\s*\(/);
  assert.match(sources, /fetch\("\/api\/user\/tree-selection"/);
  assert.match(sources, /method:\s*"PUT"/);
  assert.match(sources, /headers:\s*_kfJsonHeaders\(\)/);
  assert.match(sources, /if \(!_kfTreeSelectionTouchedThisSession && _kfApplyPersistedSelectedTrees\(\)\) return/);
  assert.match(treePanel, /function _kfSetLoadedTreeSelected[\s\S]*_kfMarkTreeSelectionTouched\(\)[\s\S]*_kfEnsureSelectedSources\(\)/);
  assert.match(services, /async function _kfLoadServerSelectedTrees\s*\(/);
  assert.match(services, /fetch\("\/api\/user\/tree-selection",\s*\{\s*headers:\s*_kfAuthHeaders\(\)/s);
  assert.match(services, /async function autoLoadStartupTrees\(\)\s*\{[\s\S]*await _kfLoadServerSelectedTrees\(\);[\s\S]*await autoLoadCloudGedcom\(\);/);
  assert.match(services, /_kfHasPersistedSelectedTreeRefs/);
  assert.match(treeSelectionApi, /CREATE TABLE IF NOT EXISTS user_tree_selection/);
  assert.match(treeSelectionApi, /export const onRequestGet/);
  assert.match(treeSelectionApi, /export const onRequestPut/);
  assert.match(treeSelectionApi, /visibleCatalogTrees/);
  assert.match(treeSelectionApi, /accessibleGedSourceIds/);
  assert.match(treeSelectionApi, /ON CONFLICT\(user_id\) DO UPDATE/);
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
  assert.match(smoke, /Emulation\.setUserAgentOverride/);
  assert.match(smoke, /maxTouchPoints:\s*5/);
  assert.match(smoke, /matchMedia\("\(pointer: coarse\)"\)/);
  assert.match(smoke, /iphone-real/);
  assert.match(smoke, /window\.kfDebug\.treeSnapshot/);
  assert.match(smoke, /window\.kfDebug\.clientErrors/);
  assert.match(smoke, /value => !!value\?\.ok/);
});

test("AI rendering regression smoke covers suggestions and visual outputs", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const smoke = readFileSync("scripts/smoke-ai-regression.mjs", "utf8");
  const services = readFileSync("src/app/95-services-auth-db-cloud.js", "utf8");
  const panels = readFileSync("src/app/70-chat-panels.js", "utf8");
  const runtime = readFileSync("src/app/90-chat-runtime.js", "utf8");
  const renderer = readFileSync("src/app/20-render-layers.js", "utf8");

  assert.equal(pkg.scripts["smoke:ai"], "node scripts/smoke-ai-regression.mjs");
  assert.match(smoke, /collectAllSuggestedQuestions/);
  assert.match(smoke, /clickEverySuggestedQuestion/);
  assert.match(smoke, /assertShowVizTypes/);
  assert.match(smoke, /\["vega"/);
  assert.match(smoke, /\["mermaid"/);
  assert.match(smoke, /\["dot"/);
  assert.match(smoke, /\["svg"/);
  assert.match(smoke, /\["html"/);
  assert.match(smoke, /\["markdown"/);
  assert.match(smoke, /assertLensShapes/);
  assert.match(smoke, /\["state"/);
  assert.match(smoke, /\["country"/);
  assert.match(smoke, /\["latlon"/);
  assert.match(smoke, /\["line"/);
  assert.match(smoke, /\["arc"/);
  assert.match(smoke, /assertKfCallParser/);
  assert.match(services, /runKfCallText:/);
  assert.match(services, /dispatchChip:/);
  assert.match(services, /suggestedQuestionTexts:/);
  assert.match(panels, /window\._kfAiRegressionSuggestedQuestions\.push\(text\)/);
  assert.match(runtime, /No matching immigration signals/);
  assert.doesNotMatch(renderer, /No rows were returned/);
  assert.match(renderer, /No matching data is available for this visualization/);
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

test("tree inventory loading does not auto-switch from Trees to People", () => {
  const trees = readFileSync("src/app/48-ux-tree-panel.js", "utf8");
  const panels = readFileSync("src/app/70-chat-panels.js", "utf8");
  const sources = readFileSync("src/app/50-pipeline-sources-review.js", "utf8");
  const api = readFileSync("src/app/80-kf-api.js", "utf8");

  assert.match(panels, /function\s+_kfShowPersonCard\s*\(\s*di,\s*opts\s*=\s*\{\}\s*\)/);
  assert.match(panels, /const shouldReveal = opts\.reveal === "person"/);
  assert.match(panels, /if \(shouldReveal\) _kfSetSideTab\("person"\)/);
  assert.match(trees, /loadCloudTree\(key,\s*\{\s*suppressAutosave:\s*true,\s*revealPersonCard:\s*false\s*\}\)/);
  assert.match(trees, /loadCatalogTree\(key,\s*\{\s*suppressAutosave:\s*true,\s*revealPersonCard:\s*false\s*\}\)/);
  assert.match(sources, /const revealPersonCard = sourceMeta\.revealPersonCard !== false/);
  assert.match(sources, /reveal:\s*revealPersonCard && !\(typeof _kfUsesResponsiveShell === "function" && _kfUsesResponsiveShell\(\)\)/);
  assert.match(sources, /revealPersonCard,\s*\n\s*\}\)/);
  assert.match(api, /const revealPersonCard = opts\.revealPersonCard !== false/);
  assert.match(api, /_kfShowPersonCard\(highlightedDwell,\s*\{\s*reveal:\s*revealPersonCard\s*\}\)/);
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

test("people panel includes a compact scrolling living-people list after selected person", () => {
  const html = readFileSync("index.html", "utf8");
  const panels = readFileSync("src/app/70-chat-panels.js", "utf8");
  const sources = readFileSync("src/app/50-pipeline-sources-review.js", "utf8");
  const mapLibre = readFileSync("src/app/10-maplibre.js", "utf8");
  const renderLayers = readFileSync("src/app/20-render-layers.js", "utf8");
  const styles = readFileSync("styles/app.css", "utf8");

  assert.match(html, /id="selectedPerson" hidden><\/div>\s*<div id="livingPeopleList"/);
  assert.match(panels, /function\s+_kfLivingPeopleRows\s*\(/);
  assert.match(panels, /function\s+_kfRenderLivingPeopleList\s*\(/);
  assert.match(panels, /_kfVisibleMarkerData\(\)/);
  assert.match(panels, /function\s+_kfVisibleMapRowInViewport\s*\(/);
  assert.match(panels, /function\s+_kfMapViewportSignature\s*\(/);
  assert.match(panels, /function\s+_kfSelectedMapPersonId\s*\(/);
  assert.match(panels, /if \(a\.selected !== b\.selected\) return a\.selected \? -1 : 1/);
  assert.match(panels, /_kfReadableRelationship\(rel\)/);
  assert.match(panels, /People in map view/);
  assert.match(panels, /class="livingPersonItem/);
  assert.match(panels, /data-di="\$\{row\.di\}"/);
  assert.match(panels, /class="livingPersonDetail personDetailCard"/);
  assert.match(panels, /function\s+_kfPersonDetailHtml\s*\(/);
  assert.match(panels, /function\s+_kfBindPersonDetailControls\s*\(/);
  assert.match(panels, /function\s+_kfSelectLivingPersonFromList\s*\(/);
  assert.match(panels, /highlightedDwell = di/);
  assert.match(panels, /_kfShowPersonCard\(di\)/);
  assert.match(panels, /if \(opts\.expandList !== false\) _kfExpandedMapPersonId = ind\.id/);
  assert.match(sources, /_kfRenderLivingPeopleList\(true\)/);
  assert.match(mapLibre, /_kfRenderLivingPeopleList\(true\)/);
  assert.match(renderLayers, /_kfIsSideTabActive\("person"\)/);
  assert.match(styles, /\.livingPeopleRows\s*\{[^}]*overflow-y:auto/s);
  assert.match(styles, /\.livingPersonItem\.selected/);
  assert.match(styles, /\.livingPersonRow\s*\{[^}]*grid-template-columns/s);
  assert.match(styles, /\.personDetailCard \.sp-name/);
  assert.match(styles, /@media \(max-width:720px\)\s*\{[\s\S]*\.livingPersonRow\s*\{[^}]*grid-template-areas/s);
});

test("Explore panel uses one branch heading and a separate scope strip", () => {
  const html = readFileSync("index.html", "utf8");
  const styles = readFileSync("styles/app.css", "utf8");
  const matches = html.match(/Explore this branch/g) || [];

  assert.equal(matches.length, 1, "Explore should not repeat its branch heading inside the scope strip");
  assert.match(html, /<div id="chatInsightHeader">\s*<div id="chatInsightScope">Selected trees and year appear here\.<\/div>\s*<div id="chatInsightMode">Evidence first<\/div>\s*<\/div>/);
  assert.match(styles, /@media \(min-width: 721px\) and \(hover:hover\)[\s\S]*#chatInsightScope\s*\{[^}]*font-weight:800/s);
});

test("suggested Explore questions use mobile-safe taps and dedupe active repeats", () => {
  const panels = readFileSync("src/app/70-chat-panels.js", "utf8");
  const derived = readFileSync("src/app/75-derived-cache.js", "utf8");
  const runtime = readFileSync("src/app/90-chat-runtime.js", "utf8");
  const styles = readFileSync("styles/app.css", "utf8");
  const smoke = readFileSync("scripts/smoke-ai-regression.mjs", "utf8");

  assert.match(panels, /function\s+_kfDispatchChatScopeQuestion\s*\(/);
  assert.match(panels, /function\s+_kfBindChatScopeQuestions\s*\(/);
  assert.match(panels, /_kfBindTapOrClick\(btn,\s*ask\)/);
  assert.doesNotMatch(panels, /window\.addEventListener\("pointerup"[\s\S]*data-chat-scope-question/);
  assert.match(panels, /let _kfChatScopeLastDispatchedSignature = ""/);
  assert.match(panels, /Date\.now\(\) - _kfChatScopeLastHandledAt < 1200/);
  assert.match(panels, /let _kfActiveChatQuestionSignature = ""/);
  assert.match(panels, /function\s+_kfChatQuestionKey\s*\(/);
  assert.match(panels, /function\s+_kfChatQuestionContextKey\s*\(/);
  assert.match(panels, /function\s+_kfChatQuestionContextLabel\s*\(/);
  assert.match(panels, /Answered in: \$\{turn\.context\}/);
  assert.match(panels, /<small>Answered in \$\{escChat\(turn\.context\)\}<\/small>/);
  assert.match(derived, /signature === _kfActiveChatQuestionSignature/);
  assert.match(derived, /return \{ queued: false, duplicate: true \}/);
  assert.match(derived, /questionContextLabel/);
  assert.match(derived, /context_signature: questionSignature/);
  assert.match(derived, /_kfActiveChatQuestionSignature = questionSignature/);
  assert.match(derived, /_kfActiveChatQuestionSignature = ""/);
  assert.match(styles, /\.chatQuestionChip em\s*\{/);
  assert.match(styles, /\.chatActiveQuestion small\s*\{/);
  assert.match(styles, /\.chat-scope-question\s*\{[^}]*touch-action:manipulation/s);
  assert.match(runtime, /function\s+_kfTryAnswerSuggestedQuestion\s*\(/);
  for (const method of [
    "getImmigrationWaves",
    "getSurnameMigrationDistances",
    "getUrbanizationShift",
    "getFamilyCrossroads",
    "getStableBranches",
    "getCoMigratingFamilies",
    "getHistoricalOverlaps",
    "getDistantBranchMarriages",
    "getDeepestAncestryBranches",
    "getMigrationJumps",
  ]) {
    assert.match(runtime, new RegExp(method));
  }
  assert.match(runtime, /window\.kfApi\.showViz\(\{\s*type: "vega"/s);
  assert.match(runtime, /const suggested = await _kfTryAnswerSuggestedQuestion\(userText\)/);
  assert.match(smoke, /function\s+assertMobileImmigrationQuestionTap\s*\(/);
  assert.match(smoke, /function\s+assertAllSuggestedQuestionsTextAndViz\s*\(/);
  assert.match(smoke, /function\s+emulateRealMobile\s*\(/);
  assert.match(smoke, /function\s+assertMobileExploreAnswerAndVisualizationLayout\s*\(/);
  assert.match(smoke, /Emulation\.setUserAgentOverride/);
  assert.match(smoke, /maxTouchPoints:\s*5/);
  assert.match(smoke, /desktop.*text and visualization/s);
  assert.match(smoke, /mobile.*text and visualization/s);
  assert.match(smoke, /Inspect/i);
  assert.match(smoke, /!\/No rows were returned\/i\.test/);
  assert.match(smoke, /double-tapping Immigration waves should dispatch one question/);
});

test("VIP chat calls retry with fresh server-verified auth before surfacing access errors", () => {
  const state = readFileSync("src/app/00-state.js", "utf8");
  const auth = readFileSync("src/app/95-services-auth-db-cloud.js", "utf8");
  const runtime = readFileSync("src/app/90-chat-runtime.js", "utf8");

  assert.match(state, /let _kfServerAuthContext = null/);
  assert.match(state, /let _kfServerVerifiedVip = false/);
  assert.match(auth, /function\s+_kfGetClerkToken\s*\(/);
  assert.match(auth, /getToken\(\{ skipCache: true \}\)/);
  assert.match(auth, /function\s+_kfVerifyServerVipForChat\s*\(/);
  assert.match(auth, /_kfServerVerifiedVip = serverUser\?\.type === "vip"/);
  assert.match(auth, /server_verified_vip: !!_kfServerVerifiedVip/);
  assert.match(runtime, /function\s+_kfFetchVipClaudeChat\s*\(/);
  assert.match(runtime, /_kfVerifyServerVipForChat\(\{ forceRefresh: true \}\)/);
  assert.match(runtime, /Your sign-in\$\{who\} did not verify as VIP on the server/);
  assert.match(runtime, /resp = await _kfFetchVipClaudeChat\(requestBody, controller\.signal\)/);
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
  const smoke = readFileSync("scripts/smoke-responsive-layout.mjs", "utf8");

  assert.match(styles, /#panel\[data-sheet="open"\]\s+#chatPanel\s+\.sidePane\.on,\s*#panel\[data-sheet="full"\]\s+#chatPanel\s+\.sidePane\.on\s*\{[^}]*overflow-y:auto/s);
  assert.match(styles, /#panel\[data-sheet="open"\]\s+#chatPanel\s+\.sidePane\.on,\s*#panel\[data-sheet="full"\]\s+#chatPanel\s+\.sidePane\.on\s*\{[^}]*-webkit-overflow-scrolling:touch/s);
  assert.match(styles, /#panel\[data-sheet="open"\]\s+#chatPanel\s+\.sidePane\.on,\s*#panel\[data-sheet="full"\]\s+#chatPanel\s+\.sidePane\.on\s*\{[^}]*touch-action:pan-y/s);
  assert.match(smoke, /insideHorizontalScroller/);
  assert.match(smoke, /overflowX/);
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
  const panels = readFileSync("src/app/70-chat-panels.js", "utf8");
  const chrome = readFileSync("src/app/76-v4-chrome.js", "utf8");
  const smoke = readFileSync("scripts/smoke-responsive-layout.mjs", "utf8");

  assert.match(styles, /Pencil v5 mobile map-first shell/);
  assert.match(styles, /@media \(max-width: 720px\) and \(max-height: 760px\)/);
  assert.match(styles, /#authBar\s*\{[^}]*position:fixed/s);
  assert.match(styles, /body:has\(#panel\[data-active-tab="map"\]\[data-sheet="peek"\]\):not\(\.kf-has-selected-person\) \.mapStoryRibbon\s*\{[^}]*display:none\s*!important/s);
  assert.match(styles, /--kf-mobile-ui-height:78px/);
  assert.match(styles, /--kf-mobile-story-gap:20px/);
  assert.match(styles, /--kf-mobile-story-bottom:calc\(var\(--kf-mobile-ui-bottom\) \+ var\(--kf-mobile-ui-height\) \+ var\(--kf-mobile-story-gap\)\)/);
  assert.match(styles, /body\.kf-has-selected-person:has\(#panel\[data-active-tab="map"\]\[data-sheet="peek"\]\) \.mapStoryRibbon\s*\{[^}]*bottom:var\(--kf-mobile-story-bottom\)/s);
  assert.match(styles, /body:has\(#panel\[data-active-tab="map"\]\[data-sheet="peek"\]\) #ui\s*\{[^}]*height:var\(--kf-mobile-ui-height\)/s);
  assert.match(styles, /body:has\(#panel\[data-active-tab="map"\]\[data-sheet="peek"\]\) #ui\s*\{[^}]*min-height:var\(--kf-mobile-ui-height\) !important;[^}]*box-sizing:border-box/s);
  assert.match(styles, /--kf-mobile-tabs-height:46px/);
  assert.match(styles, /body:has\(#panel\[data-active-tab="map"\]\[data-sheet="peek"\]\) #sideTabs\s*\{[^}]*height:var\(--kf-mobile-tabs-height\)/s);
  assert.match(styles, /#panel\[data-active-tab="person"\]\[data-sheet="open"\]\s*\{[^}]*height:min\(34dvh, 300px\)/s);
  assert.match(styles, /#panel\[data-active-tab="person"\]\[data-sheet="open"\] #selectedPerson,[^}]*\{[^}]*display:none\s*!important/s);
  assert.match(panels, /const shouldReveal = opts\.reveal === "person"/);
  assert.match(chrome, /classList\.toggle\("kf-has-selected-person", !!ind\)/);
  assert.match(smoke, /function\s+assertCompactMapVisible\s*\(/);
  assert.match(smoke, /function\s+assertDetailDrawerLeavesMapContext\s*\(/);
  assert.match(smoke, /minimumStoryTimelineGap = 16/);
  assert.match(smoke, /storyTimelineGap >= \$\{minimumStoryTimelineGap\}/);
  assert.match(smoke, /\["map", \/Recorded years\|Patterns\|Story\|Tree scope\/i\]/);
  assert.match(smoke, /maxRun >= 320/);
  assert.match(smoke, /visibleMapHeight >= minimum/);
  assert.match(smoke, /iphone-short-real/);
  assert.match(smoke, /compact-short/);
});

test("mobile visualization tabs collapse the timeline into a short scrub rail", () => {
  const styles = readFileSync("styles/app.css", "utf8");
  const smoke = readFileSync("scripts/smoke-responsive-layout.mjs", "utf8");

  assert.match(styles, /#vizArea:has\(#vizPane\.on\) #ui\s*\{[^}]*height:44px/s);
  assert.match(styles, /body:has\(#vizPane\.on\) #authBar\s*\{[^}]*display:none\s*!important/s);
  assert.match(styles, /body:has\(#vizPane\.on\) #chatPane:has\(#chatAnswer \.chatActiveAnswer\) #chatScope,[\s\S]*#chatArtifacts\s*\{[^}]*display:none\s*!important/s);
  assert.match(styles, /#vizArea:has\(#vizPane\.on\) #ui \.timelineDeck\s*\{[^}]*grid-template-columns:30px minmax\(0, 1fr\)/s);
  assert.match(styles, /#vizArea:has\(#vizPane\.on\) #ui \.timelineOptions,[\s\S]*display:none\s*!important/s);
  assert.match(styles, /#vizArea:has\(#vizPane\.on\) #ui #yearHist,[\s\S]*display:none\s*!important/s);
  assert.match(styles, /#vizArea:has\(#vizPane\.on\) #timelineCurrentYear\s*\{[^}]*font-size:16px/s);
  assert.match(styles, /max-height: 760px[\s\S]*#vizArea:has\(#vizPane\.on\) #ui\s*\{[^}]*height:40px/s);
  assert.match(smoke, /function\s+assertMobileVizTimelineRail\s*\(/);
  assert.match(smoke, /uiRect\.height <= 50/);
  assert.match(smoke, /authVisible:\s*visible\(auth\)/);
  assert.match(smoke, /clearVizHeight >= minimumClear/);
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

test("Explore map actions tolerate model call syntax variants", () => {
  const chat = readFileSync("src/app/90-chat-runtime.js", "utf8");

  assert.match(chat, /function\s+_kfParseKfCallArgs\s*\(/);
  assert.match(chat, /JSON\.parse\(`\[\$\{raw\}\]`\)/);
  assert.match(chat, /Array\.isArray\(c\.args\)\s*&&\s*c\.method !== "chain"/);
  assert.match(chat, /chain\(\{"steps":\[/);
  assert.match(chat, /Pass an OBJECT with a steps array/);
  assert.match(chat, /verify the route with sql\(\) or a bounded helper before narrating counts/);
});
