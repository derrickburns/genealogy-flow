const _KF_IRISH_REGION_TERMS = [
  "Ireland",
  "Northern Ireland",
  "Ulster",
  "Leinster",
  "Munster",
  "Connacht",
  "Connaught",
];

function _kfNormalizeRegionKey(region) {
  return String(region || "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
}

export function _kfAncestryRegionFromQuestion(text) {
  const q = String(text || "").toLowerCase();
  if (/\b(irish|ireland|northern ireland|ulster)\b/.test(q)) return "ireland";
  return "";
}

function _kfIsAncestryRegionQuestion(text) {
  const q = String(text || "").toLowerCase();
  return !!_kfAncestryRegionFromQuestion(q) &&
    /\b(ancestor|ancestors|ancestry|roots|family|families|branch|branches|people|persons)\b/.test(q);
}

function _kfPreviousAncestryRegionQuestion(currentText) {
  const q = String(currentText || "").toLowerCase().trim();
  if (!/\b(try again|retry|redo|again)\b/.test(q)) return currentText;
  if (typeof chatHistory === "undefined" || !Array.isArray(chatHistory)) return currentText;
  for (let i = chatHistory.length - 2; i >= 0; i--) {
    const msg = chatHistory[i];
    if (msg?.role !== "user") continue;
    const prior = String(msg.content || "").trim();
    if (_kfIsAncestryRegionQuestion(prior)) return prior;
  }
  return currentText;
}

function _kfPlaceParts(place) {
  return String(place || "")
    .toLowerCase()
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function _kfIsUsPlaceAfterIreland(parts) {
  const idx = parts.indexOf("ireland");
  if (idx < 0) return false;
  const tail = parts.slice(idx + 1).join(" ");
  return /\b(usa|u s a|united states|united states of america|kentucky|ohio|new york|pennsylvania|virginia)\b/.test(tail);
}

function _kfPlaceMatchesIreland(place, geo = null) {
  const raw = String(place || "").trim();
  if (!raw) return false;
  const hay = raw.toLowerCase();
  if (/\b(northern\s+ireland|ulster)\b/.test(hay)) return true;
  const parts = _kfPlaceParts(raw);
  if (parts[parts.length - 1] === "ireland") return true;
  if (parts.includes("ireland") && !_kfIsUsPlaceAfterIreland(parts)) return true;
  if (geo?.cc === "IE") return true;
  if (geo?.cc === "GB" && /\b(northern\s+ireland|ulster)\b/.test(hay)) return true;
  return false;
}

export function _kfPlaceMatchesAncestryRegion(place, region = "ireland", geo = null) {
  const key = _kfNormalizeRegionKey(region);
  if (key === "ireland" || key === "irish") return _kfPlaceMatchesIreland(place, geo);
  const hay = String(place || "").toLowerCase();
  return !!key && hay.includes(key);
}

function _kfRegionDisplayName(region) {
  const key = _kfNormalizeRegionKey(region);
  if (key === "ireland" || key === "irish") return "Ireland/Northern Ireland/Ulster";
  return String(region || "the requested region").trim();
}

function _kfEventLabelForRegion(ev) {
  if (typeof _kfEventPlainLabel === "function") return _kfEventPlainLabel(ev.type || ev.tag, { noun: true });
  return String(ev.type || ev.tag || "event").toLowerCase();
}

function _kfRegionEvidenceForPerson(ind, region) {
  const seen = new Set();
  const rows = [];
  for (const ev of ind?.events || []) {
    const place = String(ev?.place || "").trim();
    if (!_kfPlaceMatchesAncestryRegion(place, region)) continue;
    const year = Number(ev?.year);
    const row = {
      event: _kfEventLabelForRegion(ev),
      year: Number.isFinite(year) ? year : null,
      place,
    };
    const key = `${row.event}|${row.year ?? ""}|${row.place}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  rows.sort((a, b) => (a.year ?? 999999) - (b.year ?? 999999) || a.event.localeCompare(b.event) || a.place.localeCompare(b.place));
  return rows;
}

function _kfAncestryRootFromInput(input = {}) {
  const query = input.root || input.person || input.query || "";
  if (query && typeof _kfFindIndi === "function") return _kfFindIndi(query);
  return (lastRootId && lastIndiById?.get(lastRootId)) ||
    (_kfHomePersonId && lastIndiById?.get(_kfHomePersonId)) ||
    (_kfTopPciId && lastIndiById?.get(_kfTopPciId)) ||
    lastIndividuals?.[0] ||
    null;
}

function _kfRelationshipForAncestorGeneration(gen) {
  const n = Math.max(1, parseInt(gen, 10) || 1);
  if (typeof _kfKinshipLabel === "function") return _kfKinshipLabel(n, 0);
  if (n === 1) return "parent";
  if (n === 2) return "grandparent";
  return `${"great-".repeat(n - 2)}grandparent`;
}

export function _kfCollectAncestryByRegion(input = {}) {
  if (!lastParentsOf || !lastIndiById || !lastIndividuals) return _kfTreeDataLoadingError();
  const region = input.region || "ireland";
  const root = _kfAncestryRootFromInput(input);
  if (!root) return { error: "no root person is selected" };
  const maxGen = Math.max(1, Math.min(30, parseInt(input.maxGen, 10) || 20));
  const limit = Math.max(1, Math.min(100, parseInt(input.limit, 10) || 30));
  const ancestors = _kfAncestorsByGen(root.id, lastParentsOf, maxGen);
  const rows = [];
  const surnameCounts = new Map();
  for (const [id, generation] of ancestors) {
    if (id === root.id) continue;
    const ind = lastIndiById.get(id);
    if (!ind) continue;
    const evidence = _kfRegionEvidenceForPerson(ind, region);
    if (!evidence.length) continue;
    const surname = typeof _kfSurnameOf === "function" ? _kfSurnameOf(ind.name || "") : "";
    if (surname) _kfAddCount(surnameCounts, surname);
    const idx = lastIndiIdxById?.get(id);
    rows.push({
      id,
      name: ind.name || "?",
      surname: surname || "(unknown)",
      birth: ind.birth_year ?? null,
      death: ind.death_year ?? null,
      generation,
      relationship: _kfRelationshipForAncestorGeneration(generation),
      tree: idx != null && typeof _kfSourceNameForIndiIdx === "function" ? _kfSourceNameForIndiIdx(idx) : _kfActiveTreeName || lastFileName || "",
      evidence,
    });
  }
  rows.sort((a, b) => a.generation - b.generation || (a.birth ?? 9999) - (b.birth ?? 9999) || a.name.localeCompare(b.name));
  return {
    ok: true,
    region: _kfRegionDisplayName(region),
    searchedTerms: region === "ireland" ? _KF_IRISH_REGION_TERMS : [String(region || "")],
    root: { id: root.id, name: root.name || "?", birth: root.birth_year ?? null, death: root.death_year ?? null },
    maxGen,
    total: rows.length,
    truncated: rows.length > limit,
    ancestors: rows.slice(0, limit),
    topSurnames: _kfTopCountsFromMap(surnameCounts, 8),
    notes: [
      "Northern Ireland and Ulster are included in the Ireland-region search.",
      "US places named Ireland, such as Ireland, Taylor, Kentucky, USA, are not counted as Irish-region evidence.",
    ],
  };
}

function _kfFormatRegionEvidence(row) {
  return row.evidence.slice(0, 3)
    .map(ev => `${ev.event}${ev.year != null ? ` ${ev.year}` : ""} in ${ev.place}`)
    .join("; ");
}

function _kfFormatAncestryByRegionAnswer(result) {
  if (!result?.ok) return `*[error]* ${result?.error || "Could not search the selected tree data."}`;
  const rootLife = [result.root.birth != null ? `b. ${result.root.birth}` : "", result.root.death != null ? `d. ${result.root.death}` : ""].filter(Boolean).join(", ");
  const rootLabel = `**${result.root.name}**${rootLife ? ` (${rootLife})` : ""}`;
  if (!result.total) {
    return [
      `**In the tree**`,
      `I do not see direct ancestors of ${rootLabel} with place evidence in ${result.region}.`,
      "",
      `I searched ${result.searchedTerms.join(", ")} and did not count US places named Ireland as Irish-region evidence.`,
    ].join("\n");
  }
  const lines = [
    `**In the tree**`,
    `I found ${result.total} direct ancestor${result.total === 1 ? "" : "s"} of ${rootLabel} with place evidence in ${result.region}${result.truncated ? `; showing ${result.ancestors.length}` : ""}.`,
  ];
  if (result.topSurnames.length) {
    lines.push(`Top surnames: ${result.topSurnames.map(s => `${s.name} (${s.count})`).join(", ")}.`);
  }
  lines.push("");
  for (const row of result.ancestors.slice(0, 10)) {
    const life = [row.birth != null ? `b. ${row.birth}` : "", row.death != null ? `d. ${row.death}` : ""].filter(Boolean).join(", ");
    lines.push(`- **${row.name}**${life ? ` (${life})` : ""}, ${row.relationship}: ${_kfFormatRegionEvidence(row)}.`);
  }
  lines.push("");
  lines.push("I treated Northern Ireland and Ulster as Irish-region evidence. I did not count US places named Ireland, such as Ireland, Kentucky.");
  return lines.join("\n");
}

function _kfTryAnswerAncestryByRegionQuestion(userText) {
  const resolved = _kfPreviousAncestryRegionQuestion(userText);
  if (!_kfIsAncestryRegionQuestion(resolved)) return null;
  const region = _kfAncestryRegionFromQuestion(resolved);
  const result = _kfCollectAncestryByRegion({ region, maxGen: 24, limit: 40 });
  return {
    role: "bot",
    content: _kfFormatAncestryByRegionAnswer(result),
  };
}

if (typeof window !== "undefined") {
  window.kfApi = window.kfApi || {};
  window.kfApi.getAncestryByRegion = _kfCollectAncestryByRegion;
}
