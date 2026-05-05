import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  KF_STARTUP_ACTION,
  _kfChooseStartupAction,
} from "../src/app/45-ux-state.js";

test("startup with shared trees opens the tree picker when nothing is selected", () => {
  assert.equal(
    _kfChooseStartupAction({
      hasSelectedVisualizationTree: false,
      hasAvailableNonDemoRemoteTree: true,
    }),
    KF_STARTUP_ACTION.SHOW_TREE_PICKER,
  );
});

test("startup with an existing selected tree stays ready", () => {
  assert.equal(
    _kfChooseStartupAction({
      hasSelectedVisualizationTree: true,
      hasAvailableNonDemoRemoteTree: true,
    }),
    KF_STARTUP_ACTION.READY,
  );
});

test("startup ignores viewport-specific flags", () => {
  assert.equal(
    _kfChooseStartupAction({
      isMobile: true,
      hasSelectedVisualizationTree: false,
      hasAvailableNonDemoRemoteTree: true,
    }),
    KF_STARTUP_ACTION.SHOW_TREE_PICKER,
  );
});

test("startup falls back to demo only when no shared tree is available", () => {
  assert.equal(
    _kfChooseStartupAction({
      hasSelectedVisualizationTree: false,
      hasAvailableNonDemoRemoteTree: false,
    }),
    KF_STARTUP_ACTION.LOAD_DEMO,
  );
});

test("startup state no longer has mobile-only data-selection actions", () => {
  const uxState = readFileSync("src/app/45-ux-state.js", "utf8");
  const services = readFileSync("src/app/95-services-auth-db-cloud.js", "utf8");
  const source = uxState + "\n" + services;
  for (const staleName of [
    "MOBILE_TREE_PICKER",
    "MOBILE_DEMO_FALLBACK",
    "SHOW_MOBILE_TREE_PICKER",
    "LOAD_MOBILE_DEMO",
    "_kfOpenMobileTreesPanel",
  ]) {
    assert.doesNotMatch(source, new RegExp(staleName));
  }
});
