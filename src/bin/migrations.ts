#!/usr/bin/env -S npx tsx
import { readFileSync, writeFileSync } from "node:fs";
import { argv, exit } from "node:process";
import { parseGedcom } from "../gedcom/parser.js";
import { COUNTRY_ALIASES, STATE_TO_REGION, US_NAME_TO_ABBR, US_STATE_ABBR } from "../geo/aliases.js";

const TIMELINE_EVENT_TAGS = new Set([
  "BIRT", "DEAT", "RESI", "MARR", "EMIG", "IMMI", "CENS", "BAPM", "BURI", "CHR",
]);

interface PatternDef {
  name: string;
  years: [number, number];
  color: string;
  description: string;
  match(fc: string | null, fs: string | null, tc: string | null, ts: string | null, year: number): boolean;
}

const PATTERNS: PatternDef[] = [
  {
    name: "European Immigration (Old Wave)",
    years: [1820, 1880],
    color: "#9bc4e2",
    description: "Migration from Western/Northern Europe (Ireland, Germany, Britain, Scandinavia) to the United States. Driven by the Irish Potato Famine, German revolutions of 1848, and economic opportunity.",
    match: (fc, _fs, tc, _ts, year) => {
      const set = new Set(["IE", "DE", "GB", "NO", "SE", "DK", "NL", "FR"]);
      return fc !== null && set.has(fc) && tc === "US" && year >= 1820 && year <= 1880;
    },
  },
  {
    name: "Westward Expansion",
    years: [1840, 1900],
    color: "#d8a26b",
    description: "Movement from the Northeast and South to the Plains, Midwest, and Pacific Coast. Drove the displacement of Indigenous peoples and the establishment of new states.",
    match: (fc, fs, tc, ts, year) => {
      if (tc !== "US" || fc !== "US" || !fs || !ts) return false;
      const fr = STATE_TO_REGION[fs];
      return (fr === "Northeast" || fr === "South" || fr === "Midwest")
        && STATE_TO_REGION[ts] === "West" && year >= 1840 && year <= 1900;
    },
  },
  {
    name: "European Immigration (New Wave)",
    years: [1880, 1924],
    color: "#c799d6",
    description: "Mass immigration from Southern and Eastern Europe — Italy, Poland, Russia, Ukraine, Austria-Hungary, Greece, the Balkans. Often included Jewish refugees fleeing pogroms. Ended with the National Origins Act of 1924.",
    match: (fc, _fs, tc, _ts, year) => {
      const set = new Set(["IT", "PL", "RU", "UA", "AT", "HU", "GR", "RS", "RO", "CZ", "LT", "LV", "EE"]);
      return fc !== null && set.has(fc) && tc === "US" && year >= 1880 && year <= 1924;
    },
  },
  {
    name: "Great Migration (First Wave)",
    years: [1910, 1940],
    color: "#e07b67",
    description: "Black Americans leaving the rural South for industrial Northern cities (New York, Chicago, Detroit, Philadelphia). Driven by Jim Crow, lynchings, sharecropping, and demand for labor in WWI-era factories.",
    match: (fc, fs, tc, ts, year) => {
      if (fc !== "US" || tc !== "US" || !fs || !ts) return false;
      const tr = STATE_TO_REGION[ts];
      return STATE_TO_REGION[fs] === "South"
        && (tr === "Northeast" || tr === "Midwest")
        && year >= 1910 && year <= 1940;
    },
  },
  {
    name: "Dust Bowl Migration",
    years: [1930, 1940],
    color: "#a89968",
    description: "Plains farmers (Oklahoma, Texas, Kansas, Arkansas) displaced to California during the Dust Bowl and Great Depression. The 'Okies' of Steinbeck's Grapes of Wrath.",
    match: (fc, fs, tc, ts, year) => {
      const set = new Set(["OK", "TX", "KS", "AR", "NM", "CO"]);
      return fc === "US" && tc === "US" && fs !== null && set.has(fs)
        && ts === "CA" && year >= 1930 && year <= 1940;
    },
  },
  {
    name: "Great Migration (Second Wave)",
    years: [1940, 1970],
    color: "#dc6e58",
    description: "Continuation of the Great Migration into the West Coast (especially California) plus continued movement North. Tied to wartime defense industry and postwar manufacturing.",
    match: (fc, fs, tc, ts, year) => {
      if (fc !== "US" || tc !== "US" || !fs || !ts) return false;
      const tr = STATE_TO_REGION[ts];
      return STATE_TO_REGION[fs] === "South"
        && (tr === "Northeast" || tr === "Midwest" || tr === "West")
        && year >= 1940 && year <= 1970;
    },
  },
  {
    name: "Sun Belt Migration",
    years: [1970, 2010],
    color: "#f0c75e",
    description: "Reversal: Northeast and Midwest residents moving to the South and Southwest (Florida, Texas, Arizona, Georgia, North Carolina). Driven by air conditioning, deindustrialization in the Rust Belt, and lower cost of living.",
    match: (fc, fs, tc, ts, year) => {
      if (fc !== "US" || tc !== "US" || !fs || !ts) return false;
      const fr = STATE_TO_REGION[fs];
      const tr = STATE_TO_REGION[ts];
      const tsSet = new Set(["FL", "TX", "GA", "NC", "AZ", "CA", "NV", "SC", "TN"]);
      return (fr === "Northeast" || fr === "Midwest")
        && (tr === "South" || tr === "West") && tsSet.has(ts)
        && year >= 1970 && year <= 2010;
    },
  },
  {
    name: "Reverse Great Migration",
    years: [1990, 2025],
    color: "#7eb87e",
    description: "Black Americans returning to the South — particularly Atlanta, Charlotte, Houston, and the Carolinas — reversing a century-long northward flow. Driven by job markets, family ties, and the decline of legalized segregation.",
    match: (fc, fs, tc, ts, year) => {
      if (fc !== "US" || tc !== "US" || !fs || !ts) return false;
      const fr = STATE_TO_REGION[fs];
      return (fr === "Northeast" || fr === "Midwest" || fr === "West")
        && STATE_TO_REGION[ts] === "South"
        && year >= 1990 && year <= 2025;
    },
  },
];

function classifyPlace(place: string): { state: string | null; country: string | null } {
  const parts = place.split(",").map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return { state: null, country: null };
  const last = parts[parts.length - 1]!.toLowerCase();
  const lastClean = last.replace(/\.+$/, "");
  let country: string | null = COUNTRY_ALIASES[lastClean] ?? COUNTRY_ALIASES[last] ?? null;
  if (!country && parts.length >= 2) {
    const last2 = (parts[parts.length - 2]!.toLowerCase() + " " + parts[parts.length - 1]!.toLowerCase()).trim();
    country = COUNTRY_ALIASES[last2] ?? null;
  }
  if (!country) {
    for (const p of parts) {
      const sl = p.toLowerCase().replace(/\.+$/, "");
      if (US_NAME_TO_ABBR[sl]) { country = "US"; break; }
    }
  }
  if (!country) {
    for (const p of parts) {
      const up = p.toUpperCase().replace(/\.+$/, "");
      if (US_STATE_ABBR[up]) { country = "US"; break; }
    }
  }
  let state: string | null = null;
  if (country === "US") {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]!;
      const up = p.toUpperCase().replace(/\.+$/, "");
      if (US_STATE_ABBR[up]) { state = up; break; }
      const sl = p.toLowerCase().replace(/\.+$/, "");
      if (US_NAME_TO_ABBR[sl]) { state = US_NAME_TO_ABBR[sl]!; break; }
    }
  }
  return { state, country };
}

interface IndiEvent { year: number; place: string; }
interface IndiRecord { id: string; name: string; events: IndiEvent[]; }

interface Migration {
  year: number;
  from_year: number;
  indi: string;
  indi_name: string;
  from_place: string;
  to_place: string;
  from_state: string | null;
  from_country: string | null;
  to_state: string | null;
  to_country: string | null;
  pattern: string | null;
}

function extractMigrations(individuals: IndiRecord[]): Migration[] {
  const out: Migration[] = [];
  for (const ind of individuals) {
    const seen = new Map<string, [number, string]>();
    for (const e of ind.events) {
      const key = `${e.year}|${e.place}`;
      if (!seen.has(key)) seen.set(key, [e.year, e.place]);
    }
    const evs = [...seen.values()].sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
    let prev: { year: number; place: string; state: string | null; country: string | null } | null = null;
    for (const [year, place] of evs) {
      const { state: fs, country: fc } = classifyPlace(place);
      if (prev && prev.place !== place) {
        out.push({
          year,
          from_year: prev.year,
          indi: ind.id,
          indi_name: ind.name,
          from_place: prev.place,
          to_place: place,
          from_state: prev.state,
          from_country: prev.country,
          to_state: fs,
          to_country: fc,
          pattern: null,
        });
      }
      prev = { year, place, state: fs, country: fc };
    }
  }
  return out;
}

function classify(m: Migration): string | null {
  for (const p of PATTERNS) {
    try {
      if (p.match(m.from_country, m.from_state, m.to_country, m.to_state, m.year)) return p.name;
    } catch { /* skip */ }
  }
  return null;
}

interface Cluster {
  from_region: string;
  to_region: string;
  decade: number;
  count: number;
  indis: string[];
  sample_names: string[];
}

function findFamilyClusters(migrations: Migration[], minCount: number): Cluster[] {
  const buckets = new Map<string, Migration[]>();
  for (const m of migrations) {
    const fc = m.from_country, tc = m.to_country, fs = m.from_state, ts = m.to_state;
    if (!fc || !tc) continue;
    const fromLabel = fc === "US" ? (fs ? STATE_TO_REGION[fs] : null) : fc;
    const toLabel = tc === "US" ? (ts ? STATE_TO_REGION[ts] : null) : tc;
    if (!fromLabel || !toLabel) continue;
    if (fromLabel === toLabel && fs === ts) continue;
    const decade = Math.floor(m.year / 10) * 10;
    const key = `${fromLabel}|${toLabel}|${decade}`;
    let group = buckets.get(key);
    if (!group) { group = []; buckets.set(key, group); }
    group.push(m);
  }
  const clusters: Cluster[] = [];
  for (const [key, group] of buckets) {
    const [fromLabel, toLabel, decadeStr] = key.split("|");
    const decade = Number.parseInt(decadeStr!, 10);
    const indis = [...new Set(group.map(m => m.indi))].sort();
    if (indis.length < minCount) continue;
    const names = [...new Set(group.map(m => m.indi_name))].sort().slice(0, 6);
    clusters.push({
      from_region: fromLabel!,
      to_region: toLabel!,
      decade,
      count: indis.length,
      indis: indis.slice(0, 50),
      sample_names: names,
    });
  }
  clusters.sort((a, b) => b.count - a.count || a.decade - b.decade);
  return clusters;
}

function parseArgs() {
  const args: { ged: string | undefined; out: string | undefined; minCluster: number } = {
    ged: undefined, out: undefined, minCluster: 3,
  };
  const positional: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--out") { args.out = argv[++i]; }
    else if (a === "--min-cluster") { args.minCluster = Number.parseInt(argv[++i] ?? "3", 10); }
    else positional.push(a);
  }
  args.ged = positional[0];
  return args;
}

function main(): number {
  const args = parseArgs();
  if (!args.ged) {
    console.error("usage: migrations <PATH.ged> [--out PATH.migrations.json] [--min-cluster N]");
    return 2;
  }
  const out = args.out ?? `${args.ged}.migrations.json`;
  console.log(`Parsing ${args.ged}`);
  const g = parseGedcom(args.ged);
  const indis: IndiRecord[] = [];
  for (const ind of g.individuals.values()) {
    const evs: IndiEvent[] = [];
    for (const e of ind.events) {
      if (!TIMELINE_EVENT_TAGS.has(e.tag)) continue;
      if (e.year !== null && e.place) evs.push({ year: e.year, place: e.place });
    }
    if (evs.length > 0) indis.push({ id: ind.id, name: ind.name || ind.id, events: evs });
  }
  console.log(`  ${indis.length.toLocaleString()} individuals with dated events`);

  const migs = extractMigrations(indis);
  console.log(`  ${migs.length.toLocaleString()} cross-place migrations`);

  const patternCounts = new Map<string, number>();
  const byDecade = new Map<number, { total: number; by_pattern: Record<string, number> }>();
  for (const m of migs) {
    const pat = classify(m);
    m.pattern = pat;
    if (pat) patternCounts.set(pat, (patternCounts.get(pat) ?? 0) + 1);
    const decade = Math.floor(m.year / 10) * 10;
    let rec = byDecade.get(decade);
    if (!rec) { rec = { total: 0, by_pattern: {} }; byDecade.set(decade, rec); }
    rec.total += 1;
    if (pat) rec.by_pattern[pat] = (rec.by_pattern[pat] ?? 0) + 1;
  }

  const patternList = PATTERNS.map(p => ({
    name: p.name,
    years: p.years,
    color: p.color,
    description: p.description,
    match_count: patternCounts.get(p.name) ?? 0,
  }));

  const clusters = findFamilyClusters(migs, args.minCluster);

  const byDecadeObj: Record<string, { total: number; by_pattern: Record<string, number> }> = {};
  for (const k of [...byDecade.keys()].sort((a, b) => a - b)) {
    byDecadeObj[String(k)] = byDecade.get(k)!;
  }

  const outObj = {
    patterns: patternList,
    migrations: migs,
    family_clusters: clusters,
    by_decade: byDecadeObj,
  };
  writeFileSync(out, JSON.stringify(outObj, null, 2));
  console.log(`\nWrote ${out}`);
  console.log("\nMatched patterns (count of migrations):");
  for (const p of patternList) {
    if (p.match_count) {
      console.log(`  ${String(p.match_count).padStart(5)}  ${p.name}  ${p.years[0]}-${p.years[1]}`);
    }
  }
  if (clusters.length > 0) {
    console.log(`\nFamily-specific clusters (>=${args.minCluster} individuals making the same regional move within a decade):`);
    for (const c of clusters.slice(0, 20)) {
      const sample = c.sample_names.slice(0, 3).join(", ");
      console.log(`  ${String(c.count).padStart(3)}  ${c.from_region.padStart(10)} -> ${c.to_region.padEnd(10)} ${c.decade}s  e.g. ${sample}`);
    }
  }
  return 0;
}

exit(main());
