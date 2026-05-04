import * as Comlink from "https://unpkg.com/comlink@4.4.2/dist/esm/comlink.mjs";

const TITLE_RE = /\b(Sir|Dame|Lady|Lord|King|Queen|Prince|Princess|Duke|Duchess|Earl|Count|Countess|Baron|Baroness|Rev\.?|Dr\.?|Capt\.?|Captain|Col\.?|Colonel|Maj\.?|Major|Gen\.?|General)\b/i;
const HISTORY_WINDOWS = [
  { name: "slavery era in the United States", start: 1619, end: 1865 },
  { name: "American Revolution", start: 1775, end: 1783 },
  { name: "Civil War", start: 1861, end: 1865 },
  { name: "Reconstruction", start: 1865, end: 1877 },
  { name: "Great Migration", start: 1916, end: 1970 },
  { name: "Great Depression", start: 1929, end: 1939 },
  { name: "World War I", start: 1914, end: 1918 },
  { name: "World War II", start: 1939, end: 1945 },
  { name: "Civil Rights era", start: 1954, end: 1968 },
];

function addCount(map, key, n = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + n);
}

function topCounts(map, limit = 8) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function haversineMiles(la1, lo1, la2, lo2) {
  const R = 3958.8;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(la2 - la1);
  const dLon = toRad(lo2 - lo1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function normalize(payload = {}) {
  const persons = payload.persons || [];
  const facts = payload.facts || [];
  const families = payload.families || [];
  const factsByPerson = new Map();
  for (const fact of facts) {
    const key = fact.key;
    if (!factsByPerson.has(key)) factsByPerson.set(key, []);
    factsByPerson.get(key).push(fact);
  }
  for (const rows of factsByPerson.values()) {
    rows.sort((a, b) => a.year - b.year || String(a.event || "").localeCompare(String(b.event || "")));
  }
  return {
    sources: payload.sources || [],
    persons,
    facts,
    families,
    factsByPerson,
    personByKey: new Map(persons.map(p => [p.key, p])),
  };
}

function limitFrom(opts, fallback = 12) {
  return Math.max(5, Math.min(30, parseInt(opts?.limit, 10) || fallback));
}

function moveRows(data, opts = {}) {
  const minMiles = Number.isFinite(Number(opts.minMiles)) ? Number(opts.minMiles) : 25;
  const moves = [];
  for (const [personKey, rows] of data.factsByPerson.entries()) {
    let prev = null;
    for (const row of rows) {
      if (row.lat == null || row.lon == null) continue;
      if (prev) {
        const miles = haversineMiles(prev.lat, prev.lon, row.lat, row.lon);
        if (miles >= minMiles && row.year >= prev.year) {
          moves.push({
            personKey,
            tree: row.tree,
            person: row.name,
            surname: row.surname,
            birth: row.birth,
            death: row.death,
            fromYear: prev.year,
            toYear: row.year,
            yearsElapsed: row.year - prev.year,
            from: prev.normalizedPlace || prev.place,
            to: row.normalizedPlace || row.place,
            fromRegion: prev.region,
            toRegion: row.region,
            fromCountry: prev.country,
            toCountry: row.country,
            miles: Math.round(miles * 10) / 10,
          });
        }
      }
      prev = row;
    }
  }
  return moves;
}

function examplePerson(row) {
  return {
    person: row.person || row.name,
    birth: row.birth ?? null,
    death: row.death ?? null,
    tree: row.tree,
  };
}

function immigrationWaves(payload, opts = {}) {
  const data = normalize(payload);
  const limit = limitFrom(opts, 18);
  const signals = [];
  const seen = new Set();
  const titleMarkedPeople = [];
  for (const person of data.persons) {
    if (TITLE_RE.test(person.name || "") && titleMarkedPeople.length < 40) {
      titleMarkedPeople.push({ tree: person.tree, name: person.name, birth: person.birth, death: person.death });
    }
    let prev = null;
    for (const ev of data.factsByPerson.get(person.key) || []) {
      if (prev && prev.country && ev.country && prev.country !== ev.country) {
        const sig = {
          kind: "cross-country transition",
          tree: ev.tree,
          person: ev.name,
          birth: ev.birth,
          death: ev.death,
          surname: ev.surname,
          year: ev.year,
          fromCountry: prev.country,
          toCountry: ev.country,
          fromPlace: prev.normalizedPlace || prev.place,
          place: ev.normalizedPlace || ev.place,
        };
        const key = [sig.tree, sig.person, sig.year, sig.kind, sig.fromCountry, sig.toCountry, sig.place].join("|");
        if (!seen.has(key)) { seen.add(key); signals.push(sig); }
      }
      if (ev.type === "IMMI" || ev.type === "EMIG") {
        const sig = {
          kind: ev.type === "IMMI" ? "immigration record" : "emigration record",
          tree: ev.tree,
          person: ev.name,
          birth: ev.birth,
          death: ev.death,
          surname: ev.surname,
          year: ev.year,
          fromCountry: ev.type === "EMIG" ? ev.country : "",
          toCountry: ev.type === "IMMI" ? ev.country : "",
          place: ev.normalizedPlace || ev.place,
        };
        const key = [sig.tree, sig.person, sig.year, sig.kind, sig.fromCountry, sig.toCountry, sig.place].join("|");
        if (!seen.has(key)) { seen.add(key); signals.push(sig); }
      }
      if (ev.country) prev = ev;
    }
  }
  const surnameCounts = new Map();
  const routeCounts = new Map();
  const byWave = new Map();
  for (const sig of signals) {
    const decade = Math.floor(sig.year / 10) * 10;
    const route = `${sig.fromCountry || "unknown"} -> ${sig.toCountry || "unknown"}`;
    const key = `${decade}|${route}`;
    let wave = byWave.get(key);
    if (!wave) {
      wave = { period: `${decade}s`, decade, route, count: 0, firstYear: sig.year, lastYear: sig.year, surnames: new Map(), kinds: new Map(), examples: [] };
      byWave.set(key, wave);
    }
    wave.count++;
    wave.firstYear = Math.min(wave.firstYear, sig.year);
    wave.lastYear = Math.max(wave.lastYear, sig.year);
    addCount(wave.surnames, sig.surname || "(unknown)");
    addCount(wave.kinds, sig.kind);
    if (wave.examples.length < 6) {
      wave.examples.push({ person: sig.person, birth: sig.birth, death: sig.death, year: sig.year, from: sig.fromPlace || sig.fromCountry || null, to: sig.place || sig.toCountry || null, tree: sig.tree });
    }
    addCount(surnameCounts, sig.surname || "(unknown)");
    addCount(routeCounts, route);
  }
  const waves = [...byWave.values()]
    .sort((a, b) => b.count - a.count || a.decade - b.decade || a.route.localeCompare(b.route))
    .slice(0, limit)
    .map(w => ({
      period: w.period,
      yearRange: w.firstYear === w.lastYear ? String(w.firstYear) : `${w.firstYear}-${w.lastYear}`,
      route: w.route,
      count: w.count,
      surnames: topCounts(w.surnames, 6),
      evidenceTypes: topCounts(w.kinds, 3),
      examples: w.examples,
    }));
  return {
    ok: true,
    scope: { selectedTrees: data.sources, treeCount: data.sources.length },
    totals: { signals: signals.length, waves: byWave.size },
    waves,
    importantSurnames: topCounts(surnameCounts, 12),
    commonRoutes: topCounts(routeCounts, 12),
    titleMarkedPeople: titleMarkedPeople.slice(0, 25),
    notes: [
      "Signals include explicit immigration/emigration records and inferred cross-country transitions between consecutive placed events.",
      "Title-marked people are candidates for historical significance because the source name includes a title or role; do not claim external fame without corroboration.",
    ],
  };
}

function surnameMigrationDistances(payload, opts = {}) {
  const data = normalize(payload);
  const moves = moveRows(data, { minMiles: 50 });
  const bySurname = new Map();
  for (const m of moves) {
    let row = bySurname.get(m.surname);
    if (!row) {
      row = { surname: m.surname, moveCount: 0, totalMiles: 0, maxMiles: 0, people: new Set(), examples: [] };
      bySurname.set(m.surname, row);
    }
    row.moveCount++;
    row.totalMiles += m.miles;
    row.maxMiles = Math.max(row.maxMiles, m.miles);
    row.people.add(`${m.tree}:${m.person}`);
    if (row.examples.length < 5) row.examples.push(m);
  }
  const surnames = [...bySurname.values()]
    .map(row => ({
      surname: row.surname,
      people: row.people.size,
      moveCount: row.moveCount,
      totalMiles: Math.round(row.totalMiles),
      maxMiles: Math.round(row.maxMiles),
      examples: row.examples.map(m => ({ person: m.person, years: `${m.fromYear}-${m.toYear}`, from: m.from, to: m.to, miles: Math.round(m.miles), tree: m.tree })),
    }))
    .sort((a, b) => b.totalMiles - a.totalMiles || b.maxMiles - a.maxMiles || a.surname.localeCompare(b.surname))
    .slice(0, limitFrom(opts, 12));
  return { ok: true, scope: { selectedTrees: data.sources }, totals: { moves: moves.length }, surnames };
}

function urbanizationShift(payload, opts = {}) {
  const data = normalize(payload);
  const buckets = new Map();
  for (const fact of data.facts) {
    if (!fact.geoLevel) continue;
    const decade = Math.floor(fact.year / 10) * 10;
    let bucket = buckets.get(decade);
    if (!bucket) {
      bucket = { decade, events: 0, city: 0, surnames: new Map(), examples: [] };
      buckets.set(decade, bucket);
    }
    bucket.events++;
    if (fact.geoLevel === "city") bucket.city++;
    addCount(bucket.surnames, fact.surname);
    if (bucket.examples.length < 5) bucket.examples.push({ person: fact.name, year: fact.year, place: fact.normalizedPlace, tree: fact.tree });
  }
  const series = [...buckets.values()]
    .filter(b => b.events >= 3)
    .sort((a, b) => a.decade - b.decade)
    .map(b => ({ decade: b.decade, events: b.events, cityEvents: b.city, cityShare: Math.round((b.city / Math.max(1, b.events)) * 100), topSurnames: topCounts(b.surnames, 5), examples: b.examples }));
  const transitions = [];
  for (let i = 1; i < series.length; i++) {
    transitions.push({ fromDecade: series[i - 1].decade, toDecade: series[i].decade, cityShareChange: series[i].cityShare - series[i - 1].cityShare, fromCityShare: series[i - 1].cityShare, toCityShare: series[i].cityShare });
  }
  transitions.sort((a, b) => b.cityShareChange - a.cityShareChange);
  return { ok: true, scope: { selectedTrees: data.sources }, series: series.slice(-20), biggestShifts: transitions.filter(t => t.cityShareChange > 0).slice(0, limitFrom(opts, 6)), notes: ["City share means records geocoded to a named city rather than only a county, state, province, or country."] };
}

function familyCrossroads(payload, opts = {}) {
  const data = normalize(payload);
  const byPlace = new Map();
  for (const fact of data.facts) {
    const place = fact.normalizedPlace || fact.place;
    if (!place) continue;
    let row = byPlace.get(place);
    if (!row) {
      row = { place, people: new Set(), surnames: new Map(), firstYear: fact.year, lastYear: fact.year, events: 0, examples: [] };
      byPlace.set(place, row);
    }
    row.events++;
    row.people.add(fact.key);
    addCount(row.surnames, fact.surname);
    row.firstYear = Math.min(row.firstYear, fact.year);
    row.lastYear = Math.max(row.lastYear, fact.year);
    if (row.examples.length < 6) row.examples.push({ person: fact.name, year: fact.year, event: fact.event, tree: fact.tree });
  }
  const crossroads = [...byPlace.values()]
    .map(row => ({
      place: row.place,
      people: row.people.size,
      events: row.events,
      yearRange: row.firstYear === row.lastYear ? String(row.firstYear) : `${row.firstYear}-${row.lastYear}`,
      surnameCount: row.surnames.size,
      topSurnames: topCounts(row.surnames, 8),
      examples: row.examples,
      score: row.people.size + row.surnames.size * 2 + Math.min(8, Math.floor((row.lastYear - row.firstYear) / 25)),
    }))
    .filter(row => row.people >= 2 || row.surnameCount >= 2)
    .sort((a, b) => b.score - a.score || b.people - a.people || a.place.localeCompare(b.place))
    .slice(0, limitFrom(opts, 12))
    .map(({ score, ...row }) => row);
  return { ok: true, scope: { selectedTrees: data.sources }, crossroads };
}

function stableBranches(payload, opts = {}) {
  const data = normalize(payload);
  const bySurname = new Map();
  for (const fact of data.facts) {
    if (!fact.region) continue;
    let row = bySurname.get(fact.surname);
    if (!row) {
      row = { surname: fact.surname, events: 0, people: new Set(), regions: new Map(), firstYear: fact.year, lastYear: fact.year, examples: [] };
      bySurname.set(fact.surname, row);
    }
    row.events++;
    row.people.add(fact.key);
    addCount(row.regions, fact.region);
    row.firstYear = Math.min(row.firstYear, fact.year);
    row.lastYear = Math.max(row.lastYear, fact.year);
    if (row.examples.length < 5) row.examples.push({ person: fact.name, year: fact.year, place: fact.normalizedPlace, tree: fact.tree });
  }
  const rows = [...bySurname.values()]
    .filter(row => row.events >= 5 && row.people.size >= 2)
    .map(row => {
      const top = topCounts(row.regions, 4);
      const dominant = top[0] || { name: "", count: 0 };
      return { surname: row.surname, people: row.people.size, events: row.events, dominantRegion: dominant.name, dominantShare: Math.round((dominant.count / Math.max(1, row.events)) * 100), yearRange: `${row.firstYear}-${row.lastYear}`, topRegions: top, examples: row.examples };
    })
    .sort((a, b) => b.dominantShare - a.dominantShare || b.events - a.events || a.surname.localeCompare(b.surname))
    .slice(0, limitFrom(opts, 12));
  return { ok: true, scope: { selectedTrees: data.sources }, stableBranches: rows };
}

function coMigratingFamilies(payload, opts = {}) {
  const data = normalize(payload);
  const moves = moveRows(data, { minMiles: 50 });
  const groups = new Map();
  for (const m of moves) {
    const decade = Math.floor(m.toYear / 10) * 10;
    const route = `${m.fromRegion || m.fromCountry || "unknown"} -> ${m.toRegion || m.toCountry || "unknown"}`;
    const key = `${decade}|${route}`;
    let group = groups.get(key);
    if (!group) {
      group = { decade, route, moves: 0, people: new Set(), surnames: new Map(), examples: [] };
      groups.set(key, group);
    }
    group.moves++;
    group.people.add(`${m.tree}:${m.person}`);
    addCount(group.surnames, m.surname);
    if (group.examples.length < 8) group.examples.push({ person: m.person, surname: m.surname, years: `${m.fromYear}-${m.toYear}`, from: m.from, to: m.to, miles: Math.round(m.miles), tree: m.tree });
  }
  const coMoves = [...groups.values()]
    .filter(g => g.people.size >= 2 || g.surnames.size >= 2)
    .map(g => ({ decade: g.decade, route: g.route, moves: g.moves, people: g.people.size, surnames: topCounts(g.surnames, 8), examples: g.examples }))
    .sort((a, b) => b.people - a.people || b.moves - a.moves || a.decade - b.decade)
    .slice(0, limitFrom(opts, 12));
  return { ok: true, scope: { selectedTrees: data.sources }, coMigratingGroups: coMoves };
}

function personKnownSpan(person, facts) {
  let start = Number.isFinite(person.birth) ? person.birth : Infinity;
  let end = Number.isFinite(person.death) ? person.death : -Infinity;
  for (const fact of facts || []) {
    start = Math.min(start, fact.year);
    end = Math.max(end, fact.year);
  }
  if (start === Infinity || end === -Infinity) return null;
  if (end < start) end = start;
  return { start, end };
}

function historicalOverlaps(payload, opts = {}) {
  const data = normalize(payload);
  const rows = [];
  for (const person of data.persons) {
    const facts = data.factsByPerson.get(person.key) || [];
    const span = personKnownSpan(person, facts);
    if (!span) continue;
    for (const w of HISTORY_WINDOWS) {
      if (span.start <= w.end && span.end >= w.start) {
        rows.push({ period: w.name, years: `${w.start}-${w.end}`, person: person.name, surname: person.surname, birth: person.birth, death: person.death, tree: person.tree, knownSpan: `${span.start}-${span.end}`, examplePlace: facts.find(f => f.year >= w.start && f.year <= w.end)?.normalizedPlace || facts[0]?.normalizedPlace || null });
      }
    }
  }
  const byPeriod = new Map();
  for (const row of rows) {
    let p = byPeriod.get(row.period);
    if (!p) {
      p = { period: row.period, years: row.years, people: 0, surnames: new Map(), examples: [] };
      byPeriod.set(row.period, p);
    }
    p.people++;
    addCount(p.surnames, row.surname);
    if (p.examples.length < 8) p.examples.push(row);
  }
  const periods = [...byPeriod.values()]
    .map(p => ({ period: p.period, years: p.years, people: p.people, topSurnames: topCounts(p.surnames, 8), examples: p.examples }))
    .sort((a, b) => b.people - a.people || a.period.localeCompare(b.period))
    .slice(0, Math.max(5, Math.min(20, parseInt(opts?.limit, 10) || 9)));
  return { ok: true, scope: { selectedTrees: data.sources }, periods, notes: ["Overlap means the person's known life or record span intersects the historical period; it does not prove direct participation."] };
}

function distantBranchMarriages(payload, opts = {}) {
  const data = normalize(payload);
  const rows = [];
  for (const fam of data.families) {
    const a = fam.husbKey ? data.personByKey.get(fam.husbKey) : null;
    const b = fam.wifeKey ? data.personByKey.get(fam.wifeKey) : null;
    if (!a || !b) continue;
    const aEvent = (data.factsByPerson.get(fam.husbKey) || []).find(f => f.lat != null && f.lon != null);
    const bEvent = (data.factsByPerson.get(fam.wifeKey) || []).find(f => f.lat != null && f.lon != null);
    if (!aEvent || !bEvent) continue;
    const miles = haversineMiles(aEvent.lat, aEvent.lon, bEvent.lat, bEvent.lon);
    if (miles < 100 && aEvent.country === bEvent.country) continue;
    rows.push({ tree: fam.tree, spouseA: { name: a.name, birth: a.birth, death: a.death }, spouseB: { name: b.name, birth: b.birth, death: b.death }, surnameA: a.surname, surnameB: b.surname, placeA: aEvent.normalizedPlace || aEvent.place, placeB: bEvent.normalizedPlace || bEvent.place, yearA: aEvent.year, yearB: bEvent.year, miles: Math.round(miles), countryA: aEvent.country, countryB: bEvent.country });
  }
  rows.sort((a, b) => b.miles - a.miles || a.spouseA.name.localeCompare(b.spouseA.name));
  return { ok: true, distantMarriages: rows.slice(0, limitFrom(opts, 12)) };
}

function parentsFromFamilies(families) {
  const parents = new Map();
  for (const fam of families || []) {
    for (const child of (fam.childKeys || [])) parents.set(child, [fam.husbKey || null, fam.wifeKey || null]);
  }
  return parents;
}

function deepestAncestryBranches(payload, opts = {}) {
  const data = normalize(payload);
  const rows = [];
  const parents = parentsFromFamilies(data.families);
  for (const sourceName of data.sources) {
    const memo = new Map();
    const depthFor = (id, seen = new Set()) => {
      if (!id || seen.has(id)) return 0;
      if (memo.has(id)) return memo.get(id);
      seen.add(id);
      const ps = parents.get(id) || [];
      let best = 0;
      for (const p of ps) if (p && data.personByKey.has(p)) best = Math.max(best, 1 + depthFor(p, seen));
      seen.delete(id);
      memo.set(id, best);
      return best;
    };
    for (const person of data.persons.filter(p => p.tree === sourceName)) {
      const depth = depthFor(person.key);
      if (depth > 0) rows.push({ tree: person.tree, person: person.name, birth: person.birth, death: person.death, surname: person.surname, generations: depth });
    }
  }
  const deepestPeople = rows.sort((a, b) => b.generations - a.generations || (a.birth ?? 9999) - (b.birth ?? 9999) || a.person.localeCompare(b.person)).slice(0, limitFrom(opts, 12));
  const bySurname = new Map();
  for (const row of rows) {
    const cur = bySurname.get(row.surname);
    if (!cur || row.generations > cur.maxGenerations) bySurname.set(row.surname, { surname: row.surname, maxGenerations: row.generations, example: row });
  }
  const deepestBranches = [...bySurname.values()].sort((a, b) => b.maxGenerations - a.maxGenerations || a.surname.localeCompare(b.surname)).slice(0, limitFrom(opts, 12));
  return { ok: true, deepestPeople, deepestBranches };
}

function migrationJumps(payload, opts = {}) {
  const data = normalize(payload);
  const moves = moveRows(data, { minMiles: Number(opts?.minMiles) || 100 });
  const jumps = moves
    .map(m => ({ ...m, milesPerYear: m.yearsElapsed > 0 ? Math.round((m.miles / Math.max(1, m.yearsElapsed)) * 10) / 10 : null, ambiguity: m.yearsElapsed > 10 ? "large time gap between records" : "tight record sequence" }))
    .sort((a, b) => b.miles - a.miles || b.yearsElapsed - a.yearsElapsed)
    .slice(0, limitFrom(opts, 15));
  return { ok: true, scope: { selectedTrees: data.sources }, jumps };
}

const DISPATCH = {
  immigrationWaves,
  surnameMigrationDistances,
  urbanizationShift,
  familyCrossroads,
  stableBranches,
  coMigratingFamilies,
  historicalOverlaps,
  distantBranchMarriages,
  deepestAncestryBranches,
  migrationJumps,
};

Comlink.expose({
  ping() {
    return true;
  },
  run(kind, payload, opts = {}) {
    const fn = DISPATCH[kind];
    if (!fn) return { ok: false, error: `unknown analysis: ${kind}` };
    const result = fn(payload, opts || {});
    return { ...result, computedIn: "worker" };
  },
});
