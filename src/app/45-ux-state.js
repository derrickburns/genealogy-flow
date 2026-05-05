// ---------- UX state and startup decisions ----------
export const KF_STARTUP_PHASE = Object.freeze({
  BOOTING: "booting",
  ANONYMOUS_DEMO: "anonymous-demo",
  SIGNED_IN_INVENTORY: "signed-in-inventory",
  TREE_PICKER: "tree-picker",
  DEMO_FALLBACK: "demo-fallback",
  AUTO_LOAD: "auto-load",
  READY: "ready",
  ERROR: "error",
});

export const KF_STARTUP_ACTION = Object.freeze({
  SHOW_TREE_PICKER: "show-tree-picker",
  LOAD_DEMO: "load-demo",
  READY: "ready",
});

export function _kfChooseStartupAction(input = {}) {
  const hasSelectedVisualizationTree = !!input.hasSelectedVisualizationTree;
  const hasAvailableNonDemoRemoteTree = !!input.hasAvailableNonDemoRemoteTree;
  if (hasSelectedVisualizationTree) return KF_STARTUP_ACTION.READY;
  if (hasAvailableNonDemoRemoteTree) return KF_STARTUP_ACTION.SHOW_TREE_PICKER;
  return KF_STARTUP_ACTION.LOAD_DEMO;
}

const _kfUxState = {
  auth: {
    status: "unknown",
    tier: "anon",
    email: "",
  },
  startup: {
    phase: KF_STARTUP_PHASE.BOOTING,
    message: "starting...",
  },
  layout: {
    tab: "map",
    sheet: "peek",
  },
  people: {
    controlsCollapsed: false,
  },
  trees: {
    status: "idle",
    rows: [],
    loadedCount: 0,
    remoteCount: 0,
    hasSelection: false,
    busyKey: "",
    emptyTitle: "Trees",
    emptyMessage: "Loading tree list...",
  },
};

const _kfUxListeners = new Set();

function _kfReadUxState() {
  return _kfUxState;
}

function _kfPatchUxSection(section, patch) {
  _kfUxState[section] = { ..._kfUxState[section], ...(patch || {}) };
}

function _kfSetUxState(patch = {}) {
  if (patch.auth) _kfPatchUxSection("auth", patch.auth);
  if (patch.startup) _kfPatchUxSection("startup", patch.startup);
  if (patch.layout) _kfPatchUxSection("layout", patch.layout);
  if (patch.people) _kfPatchUxSection("people", patch.people);
  if (patch.trees) _kfPatchUxSection("trees", patch.trees);
  for (const listener of _kfUxListeners) listener(_kfUxState);
}

function _kfSubscribeUxState(listener) {
  if (typeof listener !== "function") return () => {};
  _kfUxListeners.add(listener);
  return () => _kfUxListeners.delete(listener);
}

function _kfSetAuthUxState(status, opts = {}) {
  const tier = typeof _clerkUserTier !== "undefined" ? _clerkUserTier : "anon";
  const currentEmail = typeof _kfCurrentAuthEmail === "function" ? _kfCurrentAuthEmail() : "";
  _kfSetUxState({
    auth: {
      status,
      tier: opts.tier || tier || "anon",
      email: opts.email || currentEmail || "",
    },
  });
}

function _kfSetStartupPhase(phase, message = "") {
  _kfSetUxState({
    startup: {
      phase,
      message: message || _kfUxState.startup.message,
    },
  });
}

function _kfSetTreeInventoryUxState(patch = {}) {
  _kfSetUxState({ trees: patch });
}

function _kfSetLayoutUxState(patch = {}) {
  _kfSetUxState({ layout: patch });
}

function _kfSetPeopleUxState(patch = {}) {
  _kfSetUxState({ people: patch });
}

function _kfSetTreeInventoryBusyKey(key = "") {
  _kfSetTreeInventoryUxState({ busyKey: key });
  if (typeof _kfRerenderTreeInventory === "function") _kfRerenderTreeInventory();
}
