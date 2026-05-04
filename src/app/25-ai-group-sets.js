// ---------- AI Group Sets ----------
// Claude can identify meaningful groups of people and hand them back as a
// reusable "group set". Group sets are temporary by default; explicit save
// stores them locally and ties them to the selected tree content hashes.

const KF_GROUP_SETS_LS = "kf-ai-group-sets-v1";
const KF_GROUP_COLORS = [
  [42, 74, 140],
  [221, 132, 66],
  [66, 145, 95],
  [184, 80, 125],
  [112, 88, 174],
  [65, 156, 169],
  [172, 145, 55],
  [93, 112, 148],
  [203, 80, 73],
  [82, 132, 190],
];

let _kfGroupSets = [];
let _kfActiveGroupSetId = null;
let _kfActiveGroupRuntime = null;

function _kfGroupColor(idx) {
  return KF_GROUP_COLORS[Math.abs(Number(idx) || 0) % KF_GROUP_COLORS.length];
}

function _kfGroupSetId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function _kfCurrentGroupTreeKey() {
  if (typeof _kfSelectedSourceSnapshots !== "function") return "";
  const refs = _kfSelectedSourceSnapshots()
    .map(src => String(src.content_hash || src.tree_uuid || src.name || "").trim().toLowerCase())
    .filter(Boolean)
    .sort();
  return refs.join("|");
}

function _kfLoadGroupSetsFromLocal() {
  try {
    const raw = localStorage.getItem(KF_GROUP_SETS_LS);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    _kfGroupSets = Array.isArray(parsed?.sets)
      ? parsed.sets.filter(s => s && s.id && Array.isArray(s.groups)).map(s => ({ ...s, saved: true }))
      : [];
  } catch (e) {
    console.warn("[kf] group sets load:", e?.message || e);
    _kfGroupSets = [];
  }
}

function _kfPersistGroupSetsToLocal() {
  const sets = _kfGroupSets
    .filter(s => s?.saved)
    .map(s => ({
      id: s.id,
      name: s.name,
      question: s.question || "",
      tree_key: s.tree_key || "",
      created_at: s.created_at,
      saved_at: s.saved_at || null,
      groups: s.groups || [],
      saved: true,
    }));
  localStorage.setItem(KF_GROUP_SETS_LS, JSON.stringify({ version: 1, sets }));
}

function _kfSourceMatchesPersonRef(idx, ref) {
  const sourceId = Number(ref.source_id ?? ref.sourceId ?? NaN);
  if (Number.isFinite(sourceId) && _kfSourceIdForIndiIdx(idx) !== sourceId) return false;
  const sourceName = String(ref.source_name || ref.sourceName || ref.tree || ref.source || "").trim().toLowerCase();
  if (sourceName && _kfSourceNameForIndiIdx(idx).toLowerCase() !== sourceName) return false;
  return true;
}

function _kfPersonRefFromInd(ind) {
  const idx = lastIndiIdxById?.get(ind?.id);
  return {
    id: ind?.id || "",
    name: ind?.name || "",
    raw_id: idx == null ? (ind?.raw_id || null) : (_kfVizRawIdByIndi?.[idx] || ind?.raw_id || null),
    source_id: idx == null ? (ind?.source_id || null) : _kfSourceIdForIndiIdx(idx),
    source_name: idx == null ? (ind?.source_name || "") : _kfSourceNameForIndiIdx(idx),
  };
}

function _kfResolveGroupPersonRef(ref) {
  if (!lastIndividuals || !lastIndiById) return null;
  if (ref == null) return null;
  if (typeof ref === "string" || typeof ref === "number") {
    const text = String(ref).trim();
    if (!text) return null;
    if (lastIndiById.has(text)) return lastIndiById.get(text);
    return typeof _kfFindIndi === "function" ? _kfFindIndi(text) : null;
  }
  if (typeof ref !== "object") return null;
  const idCandidates = [ref.id, ref.person_id, ref.personId, ref.indi_id, ref.indiId].filter(Boolean);
  const hasSourceHint = ref.source_id != null || ref.sourceId != null || ref.source_name || ref.sourceName || ref.tree || ref.source;
  for (const id of idCandidates) {
    const text = String(id).trim();
    if (hasSourceHint) {
      for (let idx = 0; idx < lastIndividuals.length; idx++) {
        const ind = lastIndividuals[idx];
        if (ind?.id === text && _kfSourceMatchesPersonRef(idx, ref)) return ind;
      }
    } else if (lastIndiById.has(text)) {
      return lastIndiById.get(text);
    }
  }
  const raw = String(ref.raw_id || ref.rawId || ref.xref || "").trim().toLowerCase();
  if (raw) {
    for (let idx = 0; idx < lastIndividuals.length; idx++) {
      const ind = lastIndividuals[idx];
      const indRaw = String(ind?.raw_id || _kfVizRawIdByIndi?.[idx] || "").trim().toLowerCase();
      if (indRaw === raw && _kfSourceMatchesPersonRef(idx, ref)) return ind;
    }
  }
  const name = String(ref.name || ref.label || "").trim();
  if (name && hasSourceHint) {
    const key = name.toLowerCase();
    for (let idx = 0; idx < lastIndividuals.length; idx++) {
      const ind = lastIndividuals[idx];
      if (String(ind?.name || "").toLowerCase() === key && _kfSourceMatchesPersonRef(idx, ref)) return ind;
    }
  }
  return name && typeof _kfFindIndi === "function" ? _kfFindIndi(name) : null;
}

function _kfPeopleRefsFromGroupInput(group) {
  const raw = group?.people || group?.persons || group?.members || group?.personIds || group?.ids || [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") return raw.split(/\n|;/).map(s => s.trim()).filter(Boolean);
  return [];
}

function _kfNormalizeGroupSetInput(input = {}) {
  const obj = (typeof input === "object" && input) || {};
  const groupsIn = Array.isArray(obj.groups) ? obj.groups : [];
  const groups = [];
  const unresolved = [];
  for (let gi = 0; gi < groupsIn.length; gi++) {
    const g = groupsIn[gi] || {};
    const label = String(g.label || g.name || `Group ${gi + 1}`).trim();
    const reason = String(g.reason || g.description || "").trim();
    const seen = new Set();
    const refs = [];
    for (const ref of _kfPeopleRefsFromGroupInput(g)) {
      const ind = _kfResolveGroupPersonRef(ref);
      if (!ind) {
        unresolved.push({ group: label, ref });
        continue;
      }
      if (seen.has(ind.id)) continue;
      seen.add(ind.id);
      refs.push(_kfPersonRefFromInd(ind));
    }
    if (refs.length) groups.push({ label, reason, refs });
  }
  return {
    name: String(obj.name || obj.title || "AI groups").trim(),
    question: String(obj.question || obj.prompt || "").trim(),
    groups,
    unresolved,
    save: !!obj.save,
    activate: obj.activate !== false,
    showTimeline: obj.showTimeline !== false,
  };
}

function _kfFindGroupSet(input) {
  const key = String(input?.id || input?.name || input || "").trim().toLowerCase();
  if (!key) return null;
  return _kfGroupSets.find(s =>
    String(s.id).toLowerCase() === key ||
    String(s.name || "").toLowerCase() === key
  ) || null;
}

function _kfHydrateGroupSet(set) {
  if (!set || !lastIndividuals || !lastIndiById) return null;
  const groups = [];
  const personToGroupIdx = new Map();
  let total = 0;
  for (let gi = 0; gi < (set.groups || []).length; gi++) {
    const src = set.groups[gi];
    const people = [];
    const seen = new Set();
    for (const ref of (src.refs || [])) {
      const ind = _kfResolveGroupPersonRef(ref);
      if (!ind || seen.has(ind.id)) continue;
      seen.add(ind.id);
      people.push({ id: ind.id, name: ind.name || "?", ref: _kfPersonRefFromInd(ind) });
      if (!personToGroupIdx.has(ind.id)) personToGroupIdx.set(ind.id, gi);
    }
    groups.push({
      label: src.label || `Group ${gi + 1}`,
      reason: src.reason || "",
      color: _kfGroupColor(gi),
      people,
    });
    total += people.length;
  }
  return { set, groups, personToGroupIdx, total, individuals: lastIndividuals };
}

function _kfEnsureActiveGroupRuntime() {
  if (!_kfActiveGroupSetId) return null;
  const set = _kfFindGroupSet(_kfActiveGroupSetId);
  if (!set) { _kfActiveGroupSetId = null; _kfActiveGroupRuntime = null; return null; }
  if (!_kfActiveGroupRuntime || _kfActiveGroupRuntime.set !== set || _kfActiveGroupRuntime.individuals !== lastIndividuals) {
    _kfActiveGroupRuntime = _kfHydrateGroupSet(set);
  }
  return _kfActiveGroupRuntime;
}

function _kfActiveGroupSetLabel() {
  return _kfEnsureActiveGroupRuntime()?.set?.name || "AI groups";
}

function _kfGroupIndexForIndiIdx(idx) {
  const ind = lastIndividuals?.[idx];
  if (!ind) return -1;
  const runtime = _kfEnsureActiveGroupRuntime();
  if (!runtime) return -1;
  const gi = runtime.personToGroupIdx.get(ind.id);
  return gi == null ? -1 : gi;
}

function _kfGroupIndexForDwell(di) {
  return di == null || di < 0 ? -1 : _kfGroupIndexForIndiIdx(dwellIndi[di]);
}

function _kfGroupSliceEntries(c) {
  const runtime = _kfEnsureActiveGroupRuntime();
  const counts = c?.groupCounts || c?.groups || [];
  if (!runtime) return [];
  return runtime.groups.map((g, idx) => ({
    label: g.label,
    count: counts[idx] || 0,
    color: g.color || _kfGroupColor(idx),
  }));
}

function _kfActiveGroupLegendEntries(bounds) {
  const runtime = _kfEnsureActiveGroupRuntime();
  if (!runtime) return [];
  const entries = runtime.groups.map((g, idx) => ({
    label: g.label,
    color: g.color || _kfGroupColor(idx),
    total: 0,
    visible: 0,
  }));
  const hasBounds = !!bounds;
  for (let m = 0; m < (_kfDwellCount || 0); m++) {
    const gi = _kfGroupIndexForIndiIdx(_kfPersonIndi[m]);
    if (gi < 0 || !entries[gi]) continue;
    entries[gi].total++;
    if (!hasBounds) {
      entries[gi].visible++;
      continue;
    }
    const lon = _kfDwellPositions[m * 2], lat = _kfDwellPositions[m * 2 + 1];
    if (lon >= bounds.getWest() && lon <= bounds.getEast() && lat >= bounds.getSouth() && lat <= bounds.getNorth()) {
      entries[gi].visible++;
    }
  }
  return entries.filter(e => e.total > 0);
}

function _kfGroupSetTimelineRows(set) {
  const runtime = _kfHydrateGroupSet(set);
  if (!runtime || !runtime.total) return [];
  const span = Math.max(1, maxYear - minYear);
  const step = span > 220 ? 20 : span > 90 ? 10 : span > 45 ? 5 : 1;
  const start = Math.floor(minYear / step) * step;
  const rows = [];
  for (let y = start; y <= maxYear; y += step) {
    for (const g of runtime.groups) {
      let count = 0;
      for (const p of g.people) {
        const ind = lastIndiById?.get(p.id);
        if (ind && _kfPersonMayBeAliveAtYear(ind, y)) count++;
      }
      if (count) rows.push({ year: y, group: g.label, count });
    }
  }
  return rows;
}

function _kfOpenGroupSetTimeline(set) {
  if (!window.kfApi?.showViz) return null;
  const rows = _kfGroupSetTimelineRows(set);
  if (!rows.length) return null;
  const runtime = _kfHydrateGroupSet(set);
  const domain = runtime.groups.map(g => g.label);
  const range = runtime.groups.map(g => _kfRgb(g.color));
  return window.kfApi.showViz({
    type: "vega",
    title: `${set.name || "AI groups"} timeline`,
    spec: {
      "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
      width: "container",
      height: 320,
      data: { values: rows },
      mark: { type: "area", interpolate: "monotone", opacity: 0.86 },
      encoding: {
        x: { field: "year", type: "quantitative", title: "Year" },
        y: { field: "count", type: "quantitative", stack: "zero", title: "People alive or presumed alive" },
        color: { field: "group", type: "nominal", scale: { domain, range }, title: "AI group" },
        tooltip: [
          { field: "year", type: "quantitative" },
          { field: "group", type: "nominal" },
          { field: "count", type: "quantitative" },
        ],
      },
    },
  });
}

function _kfCreateGroupSet(input = {}) {
  if (!lastIndividuals || !lastIndiById) return { error: "no tree data loaded" };
  const normalized = _kfNormalizeGroupSetInput(input);
  if (!normalized.groups.length) {
    return { error: "no group members matched loaded people", unresolved: normalized.unresolved.slice(0, 20) };
  }
  const set = {
    id: _kfGroupSetId(),
    name: normalized.name || "AI groups",
    question: normalized.question,
    tree_key: _kfCurrentGroupTreeKey(),
    created_at: new Date().toISOString(),
    saved: normalized.save,
    groups: normalized.groups,
  };
  _kfGroupSets = [set, ..._kfGroupSets.filter(s => s.id !== set.id)].slice(0, 30);
  if (set.saved) {
    set.saved_at = new Date().toISOString();
    _kfPersistGroupSetsToLocal();
  }
  let active = null;
  let timeline = null;
  if (normalized.activate) active = _kfActivateGroupSetObject(set);
  if (normalized.showTimeline) timeline = _kfOpenGroupSetTimeline(set);
  const total = set.groups.reduce((sum, g) => sum + (g.refs?.length || 0), 0);
  if (typeof _kfRecordAiArtifact === "function") {
    _kfRecordAiArtifact({
      kind: "group",
      title: set.name,
      subtitle: `${set.groups.length} groups, ${total} people`,
      action: "activateGroupSet",
      args: { id: set.id },
      key: `group:${set.id}`,
    });
  }
  return {
    ok: true,
    id: set.id,
    name: set.name,
    groups: set.groups.map((g, idx) => ({ label: g.label, people: g.refs.length, color: _kfRgb(_kfGroupColor(idx)) })),
    people: total,
    active,
    timeline,
    unresolved: normalized.unresolved.slice(0, 20),
    saved: !!set.saved,
  };
}

function _kfActivateGroupSetObject(set) {
  const runtime = _kfHydrateGroupSet(set);
  if (!runtime || !runtime.total) return { error: "group set has no people in the selected trees" };
  _kfActiveGroupSetId = set.id;
  _kfActiveGroupRuntime = runtime;
  _kfClusterCacheKey = "";
  _kfPersonsCacheYear = "";
  const sel = $("clusterMode");
  if (sel) {
    sel.value = "group";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return { ok: true, id: set.id, name: set.name, groups: runtime.groups.length, people: runtime.total };
}

function _kfActivateGroupSet(input) {
  const set = _kfFindGroupSet(input);
  if (!set) return { error: "group set not found" };
  return _kfActivateGroupSetObject(set);
}

function _kfListGroupSets() {
  return {
    ok: true,
    active: _kfActiveGroupSetId,
    groupSets: _kfGroupSets.map(s => ({
      id: s.id,
      name: s.name,
      groups: s.groups?.length || 0,
      people: (s.groups || []).reduce((sum, g) => sum + (g.refs?.length || 0), 0),
      saved: !!s.saved,
      created_at: s.created_at,
      tree_key: s.tree_key || "",
    })),
  };
}

function _kfSaveGroupSet(input) {
  const set = _kfFindGroupSet(input);
  if (!set) return { error: "group set not found" };
  set.saved = true;
  set.saved_at = new Date().toISOString();
  if (!set.tree_key) set.tree_key = _kfCurrentGroupTreeKey();
  _kfPersistGroupSetsToLocal();
  return { ok: true, id: set.id, name: set.name, saved: true };
}

function _kfDeleteGroupSet(input) {
  const set = _kfFindGroupSet(input);
  if (!set) return { error: "group set not found" };
  _kfGroupSets = _kfGroupSets.filter(s => s.id !== set.id);
  if (_kfActiveGroupSetId === set.id) {
    _kfActiveGroupSetId = null;
    _kfActiveGroupRuntime = null;
    if (clusterMode === "group") {
      const sel = $("clusterMode");
      if (sel) { sel.value = "none"; sel.dispatchEvent(new Event("change", { bubbles: true })); }
    }
  }
  _kfPersistGroupSetsToLocal();
  return { ok: true, deleted: set.id };
}

_kfLoadGroupSetsFromLocal();
