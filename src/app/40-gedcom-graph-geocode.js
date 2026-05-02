// ---------- GEDCOM parser ----------
const EVENT_TAGS = new Set(["BIRT","DEAT","RESI","MARR","EMIG","IMMI","CENS","BAPM","BURI","CHR"]);
const DATE_RE = /(?:(?:ABT|BEF|AFT|EST|CAL|FROM|TO|BET|AND)\s+)?(?:\d{1,2}\s+)?(?:(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+)?(\d{3,4})/i;

function parseYear(d) {
  if (!d) return null;
  const matches = d.match(/\b(\d{3,4})\b/g);
  if (!matches) return null;
  let best = null;
  for (const s of matches) {
    const y = parseInt(s, 10);
    if (y >= 1000 && y <= 2100 && (best === null || y > best)) best = y;
  }
  return best;
}

const SINGLETON_EVENT_TAGS = new Set(["BIRT", "DEAT", "BURI", "BAPM", "CHR"]);
function placeSpecificity(place) {
  if (!place) return 0;
  return place.split(",").length * 1000 + place.length;
}
function dedupeSingletonEvents(events) {
  const winners = new Map();
  const others = [];
  for (const e of events) {
    if (SINGLETON_EVENT_TAGS.has(e.type)) {
      const score = placeSpecificity(e.place);
      const cur = winners.get(e.type);
      if (!cur || score > cur.score) winners.set(e.type, { ev: e, score });
    } else {
      others.push(e);
    }
  }
  for (const w of winners.values()) others.push(w.ev);
  return others;
}

function parseYearBounds(s) {
  if (!s) return [null, null];
  const matches = String(s).match(/\b\d{3,4}\b/g);
  if (!matches || !matches.length) return [null, null];
  const years = matches
    .map(v => parseInt(v, 10))
    .filter(y => Number.isFinite(y) && y >= 1000 && y <= 2100);
  if (!years.length) return [null, null];
  return [years[0], years[years.length - 1]];
}

function expandRangedEvent(e) {
  const y0 = e.year;
  const y1 = e.year_end ?? e.year ?? null;
  if (!Number.isFinite(y0)) return [];
  const base = { ...e, year: y0 };
  if (!Number.isFinite(y1) || y1 === y0) return [base];
  return [base, { ...e, year: y1 }];
}

function _kfCatalogRecords(value) {
  if (Array.isArray(value)) {
    return value
      .filter(item => item && typeof item === "object")
      .map(item => ({ ...item }));
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, item]) => item && typeof item === "object")
      .map(([id, item]) => ({ id, ...item }));
  }
  return [];
}

function _kfCatalogId(record, keys = ["id"]) {
  for (const key of keys) {
    const value = record?.[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function _kfCatalogChildIds(value) {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return rows
    .map(child => {
      if (child == null) return "";
      if (typeof child === "object") return _kfCatalogId(child, ["id", "child_id", "child", "xref"]);
      return String(child).trim();
    })
    .filter(Boolean);
}

const _KF_PUBLIC_DEMO_MAX_AGE = 115;
function _kfDemoNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function _kfDemoNameLooksPrivate(value) {
  return /\b(living|private|redacted|withheld)\b/i.test(String(value ?? ""));
}
function _kfDemoHasExplicitDeathEvidence(ind) {
  if (_kfDemoNumberOrNull(ind?.death_year ?? ind?.deathYear) != null) return true;
  return _kfCatalogRecords(ind?.events).some(event => {
    const type = String(event.tag ?? event.type ?? "").toUpperCase();
    return type === "DEAT" && (event.year != null || event.date != null || event.place != null);
  });
}
function _kfDemoIsPrivatePerson(ind, currentYear = new Date().getUTCFullYear()) {
  if (_kfDemoNameLooksPrivate(ind?.name)) return true;
  if (_kfDemoHasExplicitDeathEvidence(ind)) return false;
  const birth = _kfDemoNumberOrNull(ind?.birth_year ?? ind?.birthYear);
  if (birth == null) return true;
  return currentYear - birth < _KF_PUBLIC_DEMO_MAX_AGE;
}
function _kfSanitizePublicDemoJson(json) {
  const currentYear = new Date().getUTCFullYear();
  const livingIds = new Set();
  const labels = new Map();
  let livingCount = 0;
  const individuals = _kfCatalogRecords(json?.individuals).map(ind => {
    const id = _kfCatalogId(ind, ["id", "xref", "individual_id"]);
    const isPrivate = _kfDemoIsPrivatePerson(ind, currentYear);
    if (isPrivate) {
      livingCount++;
      labels.set(id, `Living person ${livingCount}`);
      if (id) livingIds.add(id);
    }
    return {
      id,
      name: isPrivate ? (labels.get(id) || "Living person") : (ind.name || id),
      sex: isPrivate ? "U" : (ind.sex || "U"),
      birth_year: isPrivate ? null : _kfDemoNumberOrNull(ind.birth_year ?? ind.birthYear),
      death_year: isPrivate ? null : _kfDemoNumberOrNull(ind.death_year ?? ind.deathYear),
      famc: isPrivate ? null : (ind.famc || ind.family_child || null),
      fams: isPrivate ? [] : (Array.isArray(ind.fams) ? ind.fams : []),
      events: isPrivate ? [] : _kfCatalogRecords(ind.events).map(e => ({
        ...e,
        sources: [],
      })),
      notes: [],
      sources: [],
    };
  });
  const families = _kfCatalogRecords(json?.families).map(fam => {
    const husb = _kfCatalogId(fam, ["husb", "husb_id", "husband", "husband_id"]) || null;
    const wife = _kfCatalogId(fam, ["wife", "wife_id"]) || null;
    const chil = _kfCatalogChildIds(fam.chil ?? fam.children ?? fam.child_ids);
    const hasPrivateMember = [husb, wife, ...chil].some(id => id && livingIds.has(id));
    return {
      id: _kfCatalogId(fam, ["id", "xref", "family_id"]),
      husb: husb && livingIds.has(husb) ? null : husb,
      wife: wife && livingIds.has(wife) ? null : wife,
      chil: chil.filter(id => !livingIds.has(id)),
      marr: hasPrivateMember ? null : (fam.marr || null),
      div: hasPrivateMember ? null : (fam.div || null),
    };
  }).filter(fam => fam.husb || fam.wife || fam.chil.length);
  return {
    individuals,
    families,
    sources: [],
    privacy: {
      tier: "public-demo",
      living_people: "anonymized",
      living_details: "removed",
    },
  };
}

function parseGedcomFromJson(json) {
  const individuals = _kfCatalogRecords(json?.individuals)
    .map(ind => {
      const id = _kfCatalogId(ind, ["id", "xref", "individual_id"]);
      if (!id) return null;
      const birthYear = ind.birth_year ?? ind.birthYear ?? null;
      const deathYear = ind.death_year ?? ind.deathYear ?? null;
      return {
        id,
        name: ind.name || id,
        sex: ind.sex || "U",
        famc: ind.famc || ind.family_child || null,
        raw: "",
        birth_year: birthYear,
        death_year: deathYear,
        events: _kfCatalogRecords(ind.events)
          .flatMap(e => expandRangedEvent({
            type: e.tag || e.type || "",
            date: e.date || "",
            year: e.year,
            year_end: e.year_end ?? e.yearEnd ?? e.year ?? null,
            place: e.place || "",
          }))
          .filter(e => e.year != null),
      };
    })
    .filter(Boolean);
  const families = new Map();
  for (const fam of _kfCatalogRecords(json?.families)) {
    const id = _kfCatalogId(fam, ["id", "xref", "family_id"]);
    if (!id) continue;
    families.set(id, {
      id,
      husb: _kfCatalogId(fam, ["husb", "husb_id", "husband", "husband_id"]) || null,
      wife: _kfCatalogId(fam, ["wife", "wife_id"]) || null,
      chil: _kfCatalogChildIds(fam.chil ?? fam.children ?? fam.child_ids),
    });
  }
  return { individuals, families };
}

function parseGedcom(text) {
  const lines = text.split(/\r?\n/);
  const individuals = [];
  const families = new Map();
  let mode = null;
  let cur = null;
  let curEvent = null, curDate = null, curPlace = null;
  let curName = null, curSex = null, curBirth = null, curDeath = null, curFamc = null;
  let curRaw = [];

  function flushEvent() {
    if (cur && mode === "INDI" && curEvent) {
      const [y0, y1] = parseYearBounds(curDate);
      if (y0 !== null && curPlace) {
        cur.events.push(...expandRangedEvent({
          type: curEvent,
          date: curDate || "",
          year: y0,
          year_end: y1 ?? y0,
          place: curPlace.trim(),
        }));
      }
      if (curEvent === "BIRT" && y0 !== null && curBirth === null) curBirth = y0;
      if (curEvent === "DEAT" && y0 !== null && curDeath === null) curDeath = y0;
    }
    curEvent = null; curDate = null; curPlace = null;
  }
  function flushRecord() {
    flushEvent();
    if (cur && mode === "INDI") {
      cur.events = dedupeSingletonEvents(cur.events);
      cur.name = curName || cur.id;
      cur.sex = curSex || "U";
      cur.famc = curFamc;
      cur.raw = curRaw.join("\n");
      cur.events.sort((a, b) => a.year - b.year);
      cur.birth_year = (cur.events.find(e => e.type === "BIRT")?.year) ?? null;
      cur.death_year = (cur.events.find(e => e.type === "DEAT")?.year) ?? null;
      individuals.push(cur);
    } else if (cur && mode === "FAM") {
      families.set(cur.id, cur);
    }
    cur = null; mode = null;
    curName = null; curSex = null; curBirth = null; curDeath = null; curFamc = null;
    curRaw = [];
  }

  for (const raw of lines) {
    if (!raw) continue;
    const sp = raw.indexOf(" "); if (sp < 0) continue;
    const lvl = parseInt(raw.slice(0, sp), 10);
    if (Number.isNaN(lvl)) continue;
    const rest = raw.slice(sp + 1);
    if (lvl === 0) {
      flushRecord();
      const mi = rest.match(/^(@[^@]+@)\s+INDI/);
      const mf = rest.match(/^(@[^@]+@)\s+FAM/);
      if (mi) { cur = { id: mi[1], events: [] }; mode = "INDI"; curRaw = [raw]; }
      else if (mf) { cur = { id: mf[1], husb: null, wife: null, chil: [] }; mode = "FAM"; }
      continue;
    }
    if (!cur) continue;
    if (mode === "INDI") curRaw.push(raw);
    const sp2 = rest.indexOf(" ");
    const tag = sp2 >= 0 ? rest.slice(0, sp2) : rest;
    const value = sp2 >= 0 ? rest.slice(sp2 + 1) : "";
    if (lvl === 1) {
      flushEvent();
      if (mode === "INDI") {
        if (EVENT_TAGS.has(tag)) curEvent = tag;
        else if (tag === "NAME" && curName === null) curName = value.replace(/\//g, "").trim();
        else if (tag === "SEX" && curSex === null) curSex = (value.trim()[0] || "U").toUpperCase();
        else if (tag === "FAMC" && curFamc === null) curFamc = value.trim();
      } else if (mode === "FAM") {
        if (tag === "HUSB") cur.husb = value.trim();
        else if (tag === "WIFE") cur.wife = value.trim();
        else if (tag === "CHIL") cur.chil.push(value.trim());
      }
    } else if (lvl === 2 && mode === "INDI" && curEvent) {
      if (tag === "DATE") curDate = value;
      else if (tag === "PLAC") curPlace = value;
    }
  }
  flushRecord();
  return { individuals, families };
}

function computeRelations(individuals, families) {
  const indiById = new Map();
  const indiIdxById = new Map();
  for (let i = 0; i < individuals.length; i++) { indiById.set(individuals[i].id, individuals[i]); indiIdxById.set(individuals[i].id, i); }
  const parentsOf = new Map();
  for (const ind of individuals) {
    if (ind.famc && families.has(ind.famc)) {
      const f = families.get(ind.famc);
      parentsOf.set(ind.id, [f.husb, f.wife]);
    }
  }
  const isParent = new Set();
  const childrenOf = new Map();
  for (const f of families.values()) {
    if (!f.chil || !f.chil.length) continue;
    for (const parent of [f.husb, f.wife]) {
      if (!parent) continue;
      isParent.add(parent);
      let arr = childrenOf.get(parent);
      if (!arr) { arr = []; childrenOf.set(parent, arr); }
      for (const c of f.chil) arr.push(c);
    }
  }
  return { indiById, indiIdxById, parentsOf, isParent, childrenOf };
}

// Memoized top-K nearest relatives per individual. The DAG result only depends
// on the family graph; year, zoom, and slider value don't invalidate it.
// Cache stores up to NEAREST_REL_MAX entries; callers slice to whatever N
// they need. Cleared when a fresh GEDCOM is parsed.
const NEAREST_REL_MAX = 20;
let _nearestRelCache = new Map();
let _nearestRelCacheKey = null;
// Background cache pre-warmer: walks every individual and primes the BFS
// cache during browser idle time, so the first time the user moves the
// kin-lines slider above 0 there's no startup cost.
function prewarmKinCache() {
  if (!lastIndividuals) return;
  const arr = lastIndividuals;
  let i = 0;
  const schedule = window.requestIdleCallback
    ? (fn) => window.requestIdleCallback(fn, { timeout: 1000 })
    : (fn) => setTimeout(() => fn({ timeRemaining: () => 5 }), 16);
  function step(deadline) {
    while (i < arr.length && (deadline.timeRemaining ? deadline.timeRemaining() > 1 : true)) {
      nearestRelativesByDag(arr[i].id);
      i++;
    }
    if (i < arr.length) schedule(step);
  }
  schedule(step);
}

function nearestRelativesByDag(indId) {
  if (!lastParentsOf || !lastChildrenOf) return [];
  if (_nearestRelCacheKey !== lastParentsOf) {
    _nearestRelCache = new Map();
    _nearestRelCacheKey = lastParentsOf;
  }
  let cached = _nearestRelCache.get(indId);
  if (!cached) {
    const visited = new Set([indId]);
    const queue = [[indId, 0]];
    let head = 0;
    cached = [];
    while (head < queue.length && cached.length < NEAREST_REL_MAX) {
      const [id, dist] = queue[head++];
      if (id !== indId) cached.push({ id, dist });
      const par = lastParentsOf.get(id);
      if (par) for (const p of par) {
        if (p && !visited.has(p)) { visited.add(p); queue.push([p, dist + 1]); }
      }
      const kids = lastChildrenOf.get(id);
      if (kids) for (const k of kids) {
        if (!visited.has(k)) { visited.add(k); queue.push([k, dist + 1]); }
      }
    }
    _nearestRelCache.set(indId, cached);
  }
  return cached;
}

function ancestorSet(rootId, parentsOf) {
  const set = new Set();
  if (!rootId) return set;
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (set.has(id)) continue;
    set.add(id);
    const p = parentsOf.get(id);
    if (p) { if (p[0]) stack.push(p[0]); if (p[1]) stack.push(p[1]); }
  }
  return set;
}

function directAncestorSet(rootId, parentsOf) {
  const set = ancestorSet(rootId, parentsOf);
  set.delete(rootId);
  return set;
}

function _kfIsDirectAncestorIndiIdx(idx) {
  const ind = lastIndividuals && lastIndividuals[idx];
  return !!(ind && lastAncestorSet && lastAncestorSet.has(ind.id));
}

function ancestorsWithDepth(id, parentsOf, maxDepth = 30) {
  const out = new Map();
  const stack = [[id, 0]];
  while (stack.length) {
    const [cur, d] = stack.pop();
    if (d > maxDepth) continue;
    if (out.has(cur) && out.get(cur) <= d) continue;
    out.set(cur, d);
    const p = parentsOf.get(cur);
    if (p) { if (p[0]) stack.push([p[0], d + 1]); if (p[1]) stack.push([p[1], d + 1]); }
  }
  return out;
}

function formatRelation(m, n, rootId, otherId, parentsOf) {
  if (m === 0 && n === 0) return "self";
  if (m === 0) return n === 1 ? "Ch" : n === 2 ? "GC" : (n - 2) + "GGC";
  if (n === 0) return m === 1 ? "P" : m === 2 ? "GP" : (m - 2) + "GGP";
  if (m === 1 && n === 1) {
    const rp = parentsOf.get(rootId), op = parentsOf.get(otherId);
    if (rp && op) {
      let shared = 0;
      if (rp[0] && (rp[0] === op[0] || rp[0] === op[1])) shared++;
      if (rp[1] && (rp[1] === op[0] || rp[1] === op[1])) shared++;
      if (shared === 1) return "HSib";
    }
    return "Sib";
  }
  if (n === 1 && m > 1) return m === 2 ? "AU" : (m - 2) + "GAU";
  if (m === 1 && n > 1) return n === 2 ? "Nb" : (n - 2) + "GNb";
  const cn = Math.min(m, n) - 1;
  const removed = Math.abs(m - n);
  return cn + "C" + (removed ? removed + "R" : "");
}

function pathFromRoot(otherId) {
  if (!lastRootId || !lastParentsOf || !lastChildrenOf) return null;
  if (otherId === lastRootId) return [];
  const visited = new Set([lastRootId]);
  const prev = new Map();
  const queue = [lastRootId];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === otherId) break;
    const par = lastParentsOf.get(cur);
    if (par) {
      const candidates = [];
      if (par[0]) candidates.push([par[0], "father"]);
      if (par[1]) candidates.push([par[1], "mother"]);
      for (const [nid, label] of candidates) {
        if (visited.has(nid)) continue;
        visited.add(nid); prev.set(nid, [cur, label]);
        queue.push(nid);
      }
    }
    const kids = lastChildrenOf.get(cur);
    if (kids) {
      for (const k of kids) {
        if (visited.has(k)) continue;
        const ksex = lastIndiById.get(k)?.sex;
        const label = ksex === "M" ? "son" : ksex === "F" ? "daughter" : "child";
        visited.add(k); prev.set(k, [cur, label]);
        queue.push(k);
      }
    }
  }
  if (!prev.has(otherId) && otherId !== lastRootId) return null;
  const path = [];
  let cur = otherId;
  while (cur !== lastRootId) {
    const step = prev.get(cur);
    if (!step) return null;
    path.unshift({ id: cur, label: step[0] === lastRootId ? step[1] : step[1] });
    cur = step[0];
  }
  return path;
}

let relationCache = new Map();
let relDistCache = new Map(); // id -> m + n (total generation steps from root)
function recomputeRelationships() {
  // Single BFS through the consanguinity DAG from root, recording (m, n)
  // — generations up to MRCA, then generations down — for every reachable
  // individual. m = up-steps, n = down-steps. Going up is only allowed
  // before any down step (you can't be your own grandparent's nephew).
  // O(N + E) time, vs the prior O(N * A) ancestorsWithDepth-per-individual.
  relationCache = new Map();
  if (!lastRootId || !lastIndividuals || !lastParentsOf || !lastChildrenOf) return;
  const t0 = performance.now();
  const mn = new Map(); // id -> [m, n]
  mn.set(lastRootId, [0, 0]);
  const queue = [[lastRootId, 0, 0]];
  let head = 0;
  while (head < queue.length) {
    const [cur, m, n] = queue[head++];
    if (n === 0) {
      const par = lastParentsOf.get(cur);
      if (par) {
        for (let i = 0; i < 2; i++) {
          const p = par[i];
          if (!p || mn.has(p)) continue;
          mn.set(p, [m + 1, 0]);
          queue.push([p, m + 1, 0]);
        }
      }
    }
    const kids = lastChildrenOf.get(cur);
    if (kids) {
      for (const ch of kids) {
        if (mn.has(ch)) continue;
        mn.set(ch, [m, n + 1]);
        queue.push([ch, m, n + 1]);
      }
    }
  }
  relDistCache = new Map();
  for (const ind of lastIndividuals) {
    const r = mn.get(ind.id);
    if (!r) { relationCache.set(ind.id, ""); relDistCache.set(ind.id, Infinity); continue; }
    if (ind.id === lastRootId) { relationCache.set(ind.id, "self"); relDistCache.set(ind.id, 0); continue; }
    relDistCache.set(ind.id, r[0] + r[1]);
    relationCache.set(ind.id, formatRelation(r[0], r[1], lastRootId, ind.id, lastParentsOf));
  }
  const elapsed = performance.now() - t0;
  if (elapsed > 50) console.log(`recomputeRelationships: ${mn.size} reachable, ${elapsed.toFixed(1)}ms`);
}

function descendantSet(rootId, childrenOf) {
  const set = new Set();
  if (!rootId) return set;
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (set.has(id)) continue;
    set.add(id);
    const kids = childrenOf.get(id);
    if (kids) for (const k of kids) stack.push(k);
  }
  return set;
}

function expandDescendants(seedSet, childrenOf, excludeId) {
  // Returns the set of `seedSet` plus everyone reachable from any seed by walking children.
  const out = new Set(seedSet);
  const queue = [...seedSet];
  while (queue.length) {
    const id = queue.shift();
    const kids = childrenOf.get(id);
    if (!kids) continue;
    for (const k of kids) {
      if (out.has(k) || k === excludeId) continue;
      out.add(k);
      queue.push(k);
    }
  }
  return out;
}

function classifySides(rootId, parentsOf, childrenOf, individuals) {
  // 0 = paternal blood (paternal ancestors + their descendants — siblings, cousins on father's side, etc.)
  // 1 = maternal blood (excluding anyone already in paternal)
  // 2 = other = NOT blood-related to root (in-laws, unrelated entries; root itself stays here too)
  const sideById = new Map();
  for (const ind of individuals) sideById.set(ind.id, 2);
  if (!rootId || !parentsOf.has(rootId)) return sideById;
  const [fa, mo] = parentsOf.get(rootId);
  const pat = ancestorSet(fa, parentsOf);
  const mat = ancestorSet(mo, parentsOf);
  const patBlood = expandDescendants(pat, childrenOf, rootId);
  const matBlood = expandDescendants(mat, childrenOf, rootId);
  for (const id of patBlood) sideById.set(id, 0);
  for (const id of matBlood) if (!patBlood.has(id)) sideById.set(id, 1);
  // Root is special — remains as "other" so the legend isn't confusing,
  // but it's the focus and rendered with the highlight rings, not the side color.
  sideById.set(rootId, 2);
  return sideById;
}

function bloodRelatives(rootId, parentsOf, childrenOf) {
  // True blood: paternal-line blood ∪ maternal-line blood ∪ root (and root's descendants
  // who descend through both sides, captured via the patBlood traversal).
  const set = new Set();
  if (!rootId || !parentsOf.has(rootId)) {
    if (rootId) set.add(rootId);
    return set;
  }
  const [fa, mo] = parentsOf.get(rootId);
  const pat = ancestorSet(fa, parentsOf);
  const mat = ancestorSet(mo, parentsOf);
  const patBlood = expandDescendants(pat, childrenOf, rootId);
  const matBlood = expandDescendants(mat, childrenOf, rootId);
  for (const id of patBlood) set.add(id);
  for (const id of matBlood) set.add(id);
  set.add(rootId);
  return set;
}

// ---------- Geocoder ----------
const US_STATE_ABBR = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",
  CT:"Connecticut",DE:"Delaware",DC:"District of Columbia",FL:"Florida",GA:"Georgia",
  HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",
  LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",
  MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",
  NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",
  OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",
  SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",
  VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",
};
const CA_PROV = {AB:"Alberta",BC:"British Columbia",MB:"Manitoba",NB:"New Brunswick",NL:"Newfoundland and Labrador",NS:"Nova Scotia",NT:"Northwest Territories",NU:"Nunavut",ON:"Ontario",PE:"Prince Edward Island",QC:"Quebec",SK:"Saskatchewan",YT:"Yukon"};
const COUNTRY_ALIASES = {
  "usa":"US","u s a":"US","u s":"US","united states":"US","united states of america":"US","us":"US","america":"US",
  "uk":"GB","u k":"GB","england":"GB","scotland":"GB","wales":"GB","great britain":"GB","britain":"GB","united kingdom":"GB","northern ireland":"GB",
  "canada":"CA","ireland":"IE","germany":"DE","deutschland":"DE","prussia":"DE","france":"FR","italy":"IT","spain":"ES","portugal":"PT",
  "netherlands":"NL","holland":"NL","belgium":"BE","switzerland":"CH","austria":"AT","poland":"PL","russia":"RU","ukraine":"UA",
  "sweden":"SE","norway":"NO","denmark":"DK","finland":"FI","australia":"AU","new zealand":"NZ","south africa":"ZA",
  "mexico":"MX","brazil":"BR","japan":"JP","china":"CN","india":"IN","czechoslovakia":"CZ","yugoslavia":"RS","bohemia":"CZ","moravia":"CZ",
};
// Common slug-keyed aliases for US states: AP-style abbreviations, dotted abbr,
// and frequent misspellings. Keeps detectState working when source data is messy.
const US_STATE_ALIAS_BY_SLUG = {
  "ala":"AL","ariz":"AZ","ark":"AR","calif":"CA","cal":"CA","colo":"CO","conn":"CT","del":"DE",
  "fla":"FL","ill":"IL","ind":"IN","kan":"KS","kans":"KS","mass":"MA","mich":"MI","minn":"MN",
  "miss":"MS","mont":"MT","neb":"NE","nebr":"NE","nev":"NV","okla":"OK","ore":"OR","oreg":"OR",
  "penn":"PA","penna":"PA","tenn":"TN","tex":"TX","wash":"WA","wis":"WI","wisc":"WI","wyo":"WY",
  "n h":"NH","n j":"NJ","n m":"NM","n mex":"NM","n y":"NY","n c":"NC","n d":"ND","n dak":"ND",
  "r i":"RI","s c":"SC","s d":"SD","s dak":"SD","w va":"WV","d c":"DC",
  "virgina":"VA","virginina":"VA","virgnia":"VA","virginai":"VA",
  "tennesse":"TN","tennesee":"TN",
  "massachusets":"MA","massachussetts":"MA","massachussets":"MA",
  "pennsylvana":"PA","pennsyvania":"PA","pensylvania":"PA",
  "mississipi":"MS","missisipi":"MS",
  "conneticut":"CT","connecticutt":"CT",
  "kentuky":"KY","kentuckey":"KY","georgea":"GA",
  "marylan":"MD","marland":"MD",
  "north carolinia":"NC","south carolinia":"SC",
};
function slug(s) {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
const COUNTY_SUFFIX_RE = /\b(County|Parish|Co\.?|Borough|Census Area)\b/i;

function buildGeocoder(gz) {
  const countryByCC = new Map();
  for (const c of gz.countries) { countryByCC.set(c.cc, c); COUNTRY_ALIASES[slug(c.name)] = c.cc; }
  const adminByCC = new Map(), adminBySlug = new Map();
  for (const a of gz.admin1) {
    if (!adminByCC.has(a.cc)) adminByCC.set(a.cc, new Map());
    adminByCC.get(a.cc).set(a.code, a);
    if (!adminBySlug.has(a.cc)) adminBySlug.set(a.cc, new Map());
    adminBySlug.get(a.cc).set(slug(a.name), a.code);
  }
  const countiesByState = new Map();
  for (const c of gz.us_counties) {
    if (!countiesByState.has(c.st)) countiesByState.set(c.st, new Map());
    const m = countiesByState.get(c.st);
    m.set(c.name, c); m.set(c.name + " county", c);
  }
  const cityByStateSlug = new Map(), cityByCountrySlug = new Map();
  for (const row of gz.cities) {
    const [s, cc, st, lat, lon, pop] = row;
    const k1 = cc + "|" + st;
    let m = cityByStateSlug.get(k1); if (!m) { m = new Map(); cityByStateSlug.set(k1, m); }
    const ex = m.get(s); if (!ex || ex.pop < pop) m.set(s, {lat, lon, pop});
    let m2 = cityByCountrySlug.get(cc); if (!m2) { m2 = new Map(); cityByCountrySlug.set(cc, m2); }
    const ex2 = m2.get(s); if (!ex2 || ex2.pop < pop) m2.set(s, {lat, lon, pop});
  }
  function detectCountry(parts) {
    if (!parts.length) return null;
    const last = slug(parts[parts.length - 1]);
    if (COUNTRY_ALIASES[last]) return COUNTRY_ALIASES[last];
    if (parts.length >= 2) {
      const last2 = slug(parts[parts.length - 1] + " " + parts[parts.length - 2]);
      if (COUNTRY_ALIASES[last2]) return COUNTRY_ALIASES[last2];
    }
    return null;
  }
  function detectState(parts, cc) {
    if (!parts.length) return [null, null];
    const tryUS = tok => {
      const up = tok.toUpperCase().replace(/\.+$/, "");
      if (US_STATE_ABBR[up]) return up;
      const codes = adminBySlug.get("US");
      const sl = slug(tok);
      if (US_STATE_ALIAS_BY_SLUG[sl]) return US_STATE_ALIAS_BY_SLUG[sl];
      if (codes && codes.has(sl)) return codes.get(sl);
      const words = tok.split(/[\s()]+/).filter(Boolean);
      if (words.length > 1) {
        for (const w of words) {
          const wUp = w.toUpperCase().replace(/\.+$/, "");
          if (US_STATE_ABBR[wUp]) return wUp;
          const wSl = slug(w);
          if (US_STATE_ALIAS_BY_SLUG[wSl]) return US_STATE_ALIAS_BY_SLUG[wSl];
          if (codes && codes.has(wSl)) return codes.get(wSl);
        }
        for (let span = 2; span <= Math.min(words.length, 4); span++) {
          for (let s = 0; s + span <= words.length; s++) {
            const phrase = words.slice(s, s + span).join(" ");
            const pSl = slug(phrase);
            if (US_STATE_ALIAS_BY_SLUG[pSl]) return US_STATE_ALIAS_BY_SLUG[pSl];
            if (codes && codes.has(pSl)) return codes.get(pSl);
          }
        }
      }
      return null;
    };
    if (cc === "US") {
      for (let i = parts.length - 1; i >= 0; i--) {
        const hit = tryUS(parts[i].trim());
        if (hit) return [hit, i];
      }
      return [null, null];
    }
    if (cc === "CA") {
      for (let i = parts.length - 1; i >= 0; i--) {
        const tok = parts[i].trim(); const up = tok.toUpperCase().replace(/\.+$/, "");
        if (CA_PROV[up]) return [up, i];
        const sl = slug(tok); const codes = adminBySlug.get("CA");
        if (codes && codes.has(sl)) return [codes.get(sl), i];
        const words = tok.split(/[\s()]+/).filter(Boolean);
        if (words.length > 1) {
          for (const w of words) {
            const wUp = w.toUpperCase().replace(/\.+$/, "");
            if (CA_PROV[wUp]) return [wUp, i];
            const wSl = slug(w);
            if (codes && codes.has(wSl)) return [codes.get(wSl), i];
          }
        }
      }
      return [null, null];
    }
    if (cc) {
      const codes = adminBySlug.get(cc); if (!codes) return [null, null];
      for (let i = parts.length - 1; i >= 0; i--) {
        const tok = parts[i];
        const sl = slug(tok);
        if (codes.has(sl)) return [codes.get(sl), i];
        const words = tok.split(/[\s()]+/).filter(Boolean);
        if (words.length > 1) {
          for (const w of words) {
            const wSl = slug(w);
            if (codes.has(wSl)) return [codes.get(wSl), i];
          }
        }
      }
    }
    return [null, null];
  }
  function findCounty(parts, st) {
    const m = countiesByState.get(st); if (!m) return null;
    for (const tok of parts) {
      const s = slug(tok); const sClean = s.replace(/ county$/, "").replace(/ parish$/, "").trim();
      const hit = m.get(s) || m.get(sClean); if (hit) return hit;
    }
    return null;
  }
  function isAddressOnlyPlace(place) {
    return /^\d+\s+\S+/.test(String(place || "").trim()) && !String(place || "").includes(",");
  }
  function canonicalCountry(cc) {
    if (cc === "US") return "USA";
    const c = countryByCC.get(cc);
    return c ? c.name : cc;
  }
  function canonicalAdmin(cc, st) {
    if (!st) return null;
    if (cc === "US" && US_STATE_ABBR[st]) return US_STATE_ABBR[st];
    if (cc === "CA" && CA_PROV[st]) return CA_PROV[st];
    return adminByCC.get(cc)?.get(st)?.name || st;
  }
  function displayCountyName(countySlug) {
    return String(countySlug || "").replace(/\b\w/g, c => c.toUpperCase());
  }
  function geocode(place) {
    if (isAddressOnlyPlace(place)) return null;
    const parts = place.split(",").map(s => s.trim()).filter(Boolean);
    if (!parts.length) return null;
    const cc = detectCountry(parts) || "US";
    const [st, stIdx] = detectState(parts, cc);
    const hasCountyTok = parts.some(p => COUNTY_SUFFIX_RE.test(p));
    if (cc === "US" && st && hasCountyTok) {
      const cty = findCounty(parts, st);
      if (cty) {
        const upper = stIdx == null ? parts.length : stIdx;
        const map = cityByStateSlug.get(cc + "|" + st);
        if (map) for (let i = 0; i < upper; i++) {
          if (COUNTY_SUFFIX_RE.test(parts[i])) continue;
          const hit = map.get(slug(parts[i]));
          if (hit) return { lat: hit.lat, lon: hit.lon, level: "city", cc, st, county: cty.name };
        }
        return { lat: cty.lat, lon: cty.lon, level: "county", cc, st, county: cty.name };
      }
    }
    if (st) {
      const upper = stIdx == null ? parts.length : stIdx;
      const map = cityByStateSlug.get(cc + "|" + st);
      if (map) for (let i = 0; i < upper; i++) {
        if (COUNTY_SUFFIX_RE.test(parts[i])) continue;
        const hit = map.get(slug(parts[i]));
        if (hit) return { lat: hit.lat, lon: hit.lon, level: "city", cc, st, county: null };
      }
      if (cc === "US") { const cty = findCounty(parts, st); if (cty) return { lat: cty.lat, lon: cty.lon, level: "county", cc, st, county: cty.name }; }
      const ad = adminByCC.get(cc)?.get(st); if (ad) return { lat: ad.lat, lon: ad.lon, level: "admin1", cc, st };
    }
    if (cc === "US" && hasCountyTok && !st) {
      // No explicit state but a county was named. Infer the state from the county
      // before falling back to a country-wide city lookup, which would otherwise
      // pick the highest-population homonym (e.g. Concord, MA -> Concord, CA).
      const ctySlugs = [];
      for (const tok of parts) {
        if (!COUNTY_SUFFIX_RE.test(tok)) continue;
        const s = slug(tok);
        const stripped = s.replace(/ county$/, "").replace(/ parish$/, "").trim();
        if (s) ctySlugs.push(s);
        if (stripped && stripped !== s) ctySlugs.push(stripped);
      }
      const matchingStates = new Set();
      for (const [stCode, ctyMap] of countiesByState) {
        for (const cs of ctySlugs) {
          if (ctyMap.has(cs)) { matchingStates.add(stCode); break; }
        }
      }
      if (matchingStates.size > 0) {
        for (const stCode of matchingStates) {
          const map = cityByStateSlug.get("US|" + stCode);
          if (!map) continue;
          for (const tok of parts) {
            if (COUNTY_SUFFIX_RE.test(tok)) continue;
            const hit = map.get(slug(tok));
            if (hit) return { lat: hit.lat, lon: hit.lon, level: "city", cc: "US", st: stCode, county: null };
          }
        }
        for (const stCode of matchingStates) {
          const cty = findCounty(parts, stCode);
          if (cty) return { lat: cty.lat, lon: cty.lon, level: "county", cc: "US", st: stCode, county: cty.name };
        }
      }
    }
    if (cc) {
      const map = cityByCountrySlug.get(cc);
      if (map) for (const tok of parts) { const hit = map.get(slug(tok)); if (hit) return { lat: hit.lat, lon: hit.lon, level: "city", cc, st: null, county: null }; }
      const c = countryByCC.get(cc); if (c) return { lat: c.lat, lon: c.lon, level: "country", cc, st: null };
    }
    return null;
  }
  geocode.normalizePlace = function normalizePlace(place) {
    const rawPlace = String(place || "").trim();
    if (!rawPlace || isAddressOnlyPlace(rawPlace)) return rawPlace;
    const g = geocode(rawPlace);
    if (!g) return rawPlace;
    const parts = rawPlace.split(",").map(s => s.trim()).filter(Boolean);
    const head = parts[0] || rawPlace;
    const country = canonicalCountry(g.cc);
    const admin = canonicalAdmin(g.cc, g.st);
    if (g.level === "country") return country;
    if (g.level === "admin1") return admin ? `${admin}, ${country}` : rawPlace;
    if (g.level === "county") return g.county && admin ? `${displayCountyName(g.county)}, ${admin}, ${country}` : rawPlace;
    if (g.level === "city" && g.cc === "US" && admin) {
      const explicitCounty = parts.length >= 4 ? parts[1] : null;
      const county = g.county ? displayCountyName(g.county) : explicitCounty;
      return county ? `${head}, ${county}, ${admin}, ${country}` : `${head}, ${admin}, ${country}`;
    }
    if (g.level === "city" && admin) return `${head}, ${admin}, ${country}`;
    return rawPlace;
  };
  return geocode;
}
