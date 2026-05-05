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
  assert.doesNotMatch(controls, /_kfOpenTreesPanelAfterSplashIfMobile/);
  assert.match(controls, /_kfMaybeOpenTreesPanelForEmptySelection\(\)/);
  assert.doesNotMatch(sources, /wrap\.classList\.toggle\("hidden",\s*!_kfIsMobileLayout\(\)\)/);

  const persistFn = services.match(/async function _kfMaybePersistLoadedTreeByHash[\s\S]*?\n}/)?.[0] || "";
  assert.ok(persistFn, "_kfMaybePersistLoadedTreeByHash should exist");
  assert.doesNotMatch(persistFn, /_kfIsMobileLayout/);
});
