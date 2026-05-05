import test from "node:test";
import assert from "node:assert/strict";
import {
  KF_STARTUP_ACTION,
  _kfChooseStartupAction,
} from "../src/app/45-ux-state.js";

test("desktop startup keeps existing restore behavior", () => {
  assert.equal(
    _kfChooseStartupAction({
      isMobile: false,
      hasSelectedVisualizationTree: false,
      hasAvailableNonDemoRemoteTree: true,
    }),
    KF_STARTUP_ACTION.DESKTOP_AUTO_LOAD,
  );
});

test("mobile with shared trees opens the tree picker instead of eager loading", () => {
  assert.equal(
    _kfChooseStartupAction({
      isMobile: true,
      hasSelectedVisualizationTree: false,
      hasAvailableNonDemoRemoteTree: true,
    }),
    KF_STARTUP_ACTION.SHOW_MOBILE_TREE_PICKER,
  );
});

test("mobile with an existing selected tree stays ready", () => {
  assert.equal(
    _kfChooseStartupAction({
      isMobile: true,
      hasSelectedVisualizationTree: true,
      hasAvailableNonDemoRemoteTree: true,
    }),
    KF_STARTUP_ACTION.READY,
  );
});

test("mobile falls back to demo only when no shared tree is available", () => {
  assert.equal(
    _kfChooseStartupAction({
      isMobile: true,
      hasSelectedVisualizationTree: false,
      hasAvailableNonDemoRemoteTree: false,
    }),
    KF_STARTUP_ACTION.LOAD_MOBILE_DEMO,
  );
});
