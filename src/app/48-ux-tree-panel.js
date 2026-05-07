import { h, render as preactRender } from "https://cdn.jsdelivr.net/npm/preact@10.29.1/+esm";

// ---------- Trees panel component ----------
let _kfTreeInventoryContainer = null;
let _kfLastTreeInventoryModel = null;

function _kfTreeInventoryNameCounts(rows) {
  const nameCounts = new Map();
  for (const row of rows || []) {
    const key = _kfFamiliarTreeName(_kfTreeInventoryItem(row)).toLowerCase();
    if (key) nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }
  return nameCounts;
}

function _kfCreateTreeInventoryModel(loaded, remoteTrees, inventory) {
  const rows = inventory || [];
  const remoteCount = (remoteTrees || [])
    .filter(t => t && t.available !== false && !_kfIsPublicDemoSourceName(t.name || t.key))
    .length;
  const hasSelection = (loaded || []).some(s => s.selected);
  const startup = _kfReadUxState().startup;
  const emptyMessage = startup.message && startup.message !== "starting..."
    ? startup.message
    : "Loading tree list...";
  return {
    rows,
    nameCounts: _kfTreeInventoryNameCounts(rows),
    loadedCount: (loaded || []).length,
    remoteCount,
    hasSelection,
    emptyTitle: remoteCount ? "Trees" : "No trees loaded",
    emptyMessage,
  };
}

function _kfTreeRowKey(row) {
  const item = _kfTreeInventoryItem(row);
  return [
    row.loaded ? `loaded:${row.loaded.id || row.loaded.source_id || row.loaded.name}` : "",
    row.remote ? `remote:${row.remote.kind || ""}:${row.remote.tree_uuid || row.remote.key || row.remote.source_id || row.remote.name}` : "",
    row.share ? `share:${row.share.kind || ""}:${row.share.key || row.share.tree_uuid || row.share.name}` : "",
    item?.content_hash || "",
  ].filter(Boolean).join("|") || _kfFamiliarTreeName(item);
}

function _kfTreeBadges(row) {
  const loaded = row.loaded;
  const remote = row.remote;
  const share = row.share;
  const item = _kfTreeInventoryItem(row);
  const badges = [];
  if (loaded) badges.push(loaded.selected ? "Visualized" : "Loaded");
  else badges.push("Available");
  if (share || remote?.relation === "owned") badges.push("Saved");
  if (item?.relation === "public" || item?.public) badges.push("Public");
  if (share?.shares?.length) badges.push(`Shared with ${share.shares.length}`);
  else if (remote?.relation === "shared") badges.push("Shared with you");
  return badges;
}

function _kfTreeMeta(row, badges) {
  const loaded = row.loaded;
  const item = _kfTreeInventoryItem(row);
  const n = loaded?.n_individuals ? `${loaded.n_individuals.toLocaleString()} people` : "";
  return [
    n,
    item.owner_email ? `Owner: ${item.owner_email}` : "",
    item.content_changed_at ? `Changed: ${_kfFormatTreeTimestamp(item.content_changed_at)}` : "",
    item.top_pci_name ? `Top PCI: ${item.top_pci_name}${item.top_pci_score != null ? ` (${Math.round(item.top_pci_score * 100)}%)` : ""}` : "",
  ].filter(Boolean).join(" | ") || badges.join(" | ");
}

function _kfTreeLoadSpec(remote) {
  if (!remote) return null;
  if (remote.kind === "cloud") {
    return {
      kind: "cloud",
      key: remote.tree_uuid || remote.key || remote.source_id,
      text: `Load${remote.relation ? ` (${remote.relation})` : ""}`,
    };
  }
  return {
    kind: "catalog",
    key: remote.key,
    text: `Load${remote.relation ? ` (${remote.relation})` : ""}`,
  };
}

function _kfTreeBusyKey(kind, key) {
  return `${kind}:${key}`;
}

async function _kfLoadTreeFromInventory(kind, key) {
  if (!kind || !key) return;
  const busyKey = _kfTreeBusyKey(kind, key);
  _kfSetTreeInventoryBusyKey(busyKey);
  try {
    if (typeof _kfMarkTreeSelectionTouched === "function") _kfMarkTreeSelectionTouched();
    if (kind === "cloud") await loadCloudTree(key, { suppressAutosave: true, revealPersonCard: false });
    else await loadCatalogTree(key, { suppressAutosave: true, revealPersonCard: false });
    if (typeof _kfPersistSelectedTrees === "function") _kfPersistSelectedTrees();
  } catch (e) {
    stats.textContent = `could not load tree: ${e?.message || e}`;
    console.warn("[kf] tree inventory load:", e?.message || e);
  } finally {
    _kfSetTreeInventoryBusyKey("");
    await refreshSources();
  }
}

function _kfSetLoadedTreeSelected(sourceId, selected) {
  const id = Number(sourceId || "");
  if (!id) return;
  if (typeof _kfMarkTreeSelectionTouched === "function") _kfMarkTreeSelectionTouched();
  if (selected) _kfSelectedSourceIds.add(id);
  else _kfSelectedSourceIds.delete(id);
  _kfEnsureSelectedSources();
  if (typeof _kfPersistSelectedTrees === "function") _kfPersistSelectedTrees();
  _kfRefreshBrowserViews();
  _kfRebuildSelectedVisualization({ preserveYear: true });
  if (typeof _kfRefreshViewChrome === "function") _kfRefreshViewChrome(true);
  renderSources(_kfGetLoadedSourcesList());
}

async function _kfRenameLoadedTreeFromInventory(sourceId, value) {
  const id = Number(sourceId || "");
  const src = [..._kfLoadedSources.values()].find(s => s.source_id === id);
  const name = _kfSourceNameFromFileName(value || "");
  if (!src || !name) {
    stats.textContent = "tree name is required";
    return;
  }
  src.common_name = name;
  try {
    if (_clerkToken && _clerkUserTier !== "anon") {
      await _kfSaveLoadedTreesToCloud([src]);
      await refreshSharePanel();
    }
    if (_kfSelectedSourceIds.has(src.source_id) && typeof _kfPersistSelectedTrees === "function") {
      _kfPersistSelectedTrees();
    }
    await refreshSources();
  } catch (e) {
    stats.textContent = `tree rename failed: ${e?.message || e}`;
    console.warn("[kf] tree rename:", e?.message || e);
  }
}

async function _kfShareTreeFromInventory(kind, key, value) {
  const email = String(value || "").trim();
  if (!email) return;
  await _kfUpdateTreeShare(kind, key, email, "add");
}

function KfTreeEmptyState({ model }) {
  return h("div", { class: "treeEmptyState" },
    h("div", { class: "treeEmptyTitle" }, model.emptyTitle || "Trees"),
    h("div", { class: "treeEmptyBody" }, model.emptyMessage || "Loading tree list..."),
  );
}

function KfLoadedTreeName({ loaded }) {
  return h("form", {
    class: "treeLocalRename treeInlineForm",
    onSubmit: e => {
      e.preventDefault();
      const input = e.currentTarget.querySelector("input");
      _kfRenameLoadedTreeFromInventory(loaded.id, input?.value || "");
    },
  },
    h("input", {
      type: "text",
      defaultValue: _kfFamiliarTreeName(loaded),
      "aria-label": "Tree name",
      placeholder: "Tree name required",
    }),
    h("button", { type: "submit" }, _clerkToken && _clerkUserTier !== "anon" ? "Save" : "Rename"),
  );
}

function KfShareControls({ row }) {
  const shareKey = _kfInventoryShareKey(row);
  if (!shareKey) return null;
  const shareRows = row.share?.shares?.length
    ? h("div", { class: "shareEmails" }, row.share.shares.map(s =>
      h("span", { class: "shareEmail", key: s.email },
        `${s.email} `,
        h("button", {
          type: "button",
          title: "Remove share",
          onClick: () => _kfUpdateTreeShare(row.share.kind, row.share.key, s.email, "remove"),
        }, "x"),
      ),
    ))
    : h("div", { class: "shareEmails" }, h("span", { class: "shareNone" }, "Not shared yet"));
  return h("div", { class: "treeShareBlock" },
    shareRows,
    h("form", {
      class: "shareAdd",
      onSubmit: e => {
        e.preventDefault();
        const input = e.currentTarget.querySelector("input");
        _kfShareTreeFromInventory(shareKey.kind, shareKey.key, input?.value || "");
        if (input) input.value = "";
      },
    },
      h("input", {
        type: "email",
        placeholder: "friend@example.com",
        "aria-label": "Email address to share with",
      }),
      h("button", { type: "submit" }, "Share"),
    ),
  );
}

function KfTreeInventoryRow({ row, nameCounts, busyKey }) {
  const loaded = row.loaded;
  const remote = row.remote;
  const item = _kfTreeInventoryItem(row);
  const label = _kfTreeLabel(item, nameCounts);
  const badges = _kfTreeBadges(row);
  const meta = _kfTreeMeta(row, badges);
  const loadSpec = !loaded ? _kfTreeLoadSpec(remote) : null;
  const rowClass = [
    "treeInventoryRow",
    loaded?.selected ? "on" : "",
    loaded && !loaded.selected ? "excluded" : "",
  ].filter(Boolean).join(" ");
  const loadBusy = loadSpec && busyKey === _kfTreeBusyKey(loadSpec.kind, loadSpec.key);
  return h("div", { class: rowClass, "data-tree-row": label },
    h("div", { class: "treeRowMain" },
      loaded
        ? h("input", {
          class: "sel",
          type: "checkbox",
          checked: !!loaded.selected,
          title: "Include this tree in queries, maps, clusters, and animations",
          onChange: e => _kfSetLoadedTreeSelected(loaded.id, e.currentTarget.checked),
        })
        : h("span", { class: "treeRowSpacer", "aria-hidden": "true" }),
      loaded
        ? h(KfLoadedTreeName, { loaded })
        : h("span", { class: "sourceText" },
          h("span", { class: "name" }, label),
          h("span", { class: "sourceMeta" }, meta),
        ),
      loadSpec
        ? h("button", {
          type: "button",
          class: "srcAction",
          disabled: !!loadBusy,
          title: `Load ${remote.name || remote.key}${remote.owner_email ? `. Owner: ${remote.owner_email}.` : ""}`,
          onClick: () => _kfLoadTreeFromInventory(loadSpec.kind, loadSpec.key),
        }, loadBusy ? "Loading..." : loadSpec.text)
        : null,
    ),
    h("div", { class: "treeBadges" }, badges.map(b => h("span", { key: b }, b))),
    loaded && meta ? h("div", { class: "treeMeta" }, meta) : null,
    h(KfShareControls, { row }),
  );
}

function KfTreeInventory({ model }) {
  const state = _kfReadUxState();
  const rows = model.rows || [];
  if (!rows.length) return h(KfTreeEmptyState, { model });
  return h("div", { class: "treeInventory" },
    rows.map(row => h(KfTreeInventoryRow, {
      key: _kfTreeRowKey(row),
      row,
      nameCounts: model.nameCounts,
      busyKey: state.trees.busyKey,
    })),
  );
}

function _kfRenderTreeInventory(model, container) {
  _kfTreeInventoryContainer = container || _kfTreeInventoryContainer;
  _kfLastTreeInventoryModel = model || _kfLastTreeInventoryModel;
  if (!_kfTreeInventoryContainer || !_kfLastTreeInventoryModel) return;
  _kfSetTreeInventoryUxState({
    rows: _kfLastTreeInventoryModel.rows || [],
    loadedCount: _kfLastTreeInventoryModel.loadedCount || 0,
    remoteCount: _kfLastTreeInventoryModel.remoteCount || 0,
    hasSelection: !!_kfLastTreeInventoryModel.hasSelection,
    emptyTitle: _kfLastTreeInventoryModel.emptyTitle,
    emptyMessage: _kfLastTreeInventoryModel.emptyMessage,
  });
  preactRender(h(KfTreeInventory, { model: _kfLastTreeInventoryModel }), _kfTreeInventoryContainer);
}

function _kfRerenderTreeInventory() {
  if (_kfTreeInventoryContainer && _kfLastTreeInventoryModel) {
    preactRender(h(KfTreeInventory, { model: _kfLastTreeInventoryModel }), _kfTreeInventoryContainer);
  }
}
