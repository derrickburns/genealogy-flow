import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  KF_STARTUP_ACTION,
  _kfChooseStartupAction,
} from "../src/app/45-ux-state.js";

test("startup defaults to DEMO when nothing is selected, even with shared trees", () => {
  assert.equal(
    _kfChooseStartupAction({
      hasSelectedVisualizationTree: false,
      hasAvailableNonDemoRemoteTree: true,
    }),
    KF_STARTUP_ACTION.LOAD_DEMO,
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
      isCompactLayout: true,
      hasSelectedVisualizationTree: false,
      hasAvailableNonDemoRemoteTree: true,
    }),
    KF_STARTUP_ACTION.LOAD_DEMO,
  );
});

test("startup loads demo when no tree is selected", () => {
  assert.equal(
    _kfChooseStartupAction({
      hasSelectedVisualizationTree: false,
      hasAvailableNonDemoRemoteTree: false,
    }),
    KF_STARTUP_ACTION.LOAD_DEMO,
  );
});

test("startup state no longer has viewport-only data-selection actions", () => {
  const uxState = readFileSync("src/app/45-ux-state.js", "utf8");
  const services = readFileSync("src/app/95-services-auth-db-cloud.js", "utf8");
  const source = uxState + "\n" + services;
  assert.doesNotMatch(source, new RegExp("mob" + "ile", "i"));
});

test("new users get a persisted DEMO default instead of an empty tree prompt", () => {
  const services = readFileSync("src/app/95-services-auth-db-cloud.js", "utf8");
  const sources = readFileSync("src/app/50-pipeline-sources-review.js", "utf8");
  const timeline = readFileSync("src/app/77-v4-timeline.js", "utf8");
  const chrome = readFileSync("src/app/76-v4-chrome.js", "utf8");
  assert.match(sources, /function\s+_kfDefaultDemoTreeSelectionRefs\s*\(/);
  assert.match(services, /defaulted:\s*"demo"/);
  assert.match(services, /_kfPersistSelectedTreesToServer\(defaultPayload\)/);
  assert.match(timeline, /function\s+_kfPendingTimelineCaption\s*\(/);
  assert.match(timeline, /restoring selected trees/);
  assert.match(chrome, /function\s+_kfV4PendingTreeText\s*\(/);
  assert.match(chrome, /Restoring selected tree evidence/);
  assert.doesNotMatch(timeline, /Load a tree to begin/);
  assert.doesNotMatch(chrome, /Load a tree, then select/);
});
