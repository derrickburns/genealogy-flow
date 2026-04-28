import { readFileSync, writeFileSync } from "node:fs";
import { argv, exit } from "node:process";

const JITTER_DEG = 0.6;

interface IndividualEvent { year: number; place: string; }
interface IndividualIn { sex?: string; events?: IndividualEvent[]; }
interface IndividualsFile { individuals: IndividualIn[]; }
interface PlaceGeo { lat: number; lon: number; }

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function round3(n: number): number { return Math.round(n * 1000) / 1000; }

function main(): number {
  const src = argv[2];
  const placesPath = argv[3];
  const outPath = argv[4];
  if (!src || !placesPath || !outPath) {
    console.error("usage: build-timeline <individuals.json> <places.json> <timeline.json>");
    return 2;
  }
  const data = JSON.parse(readFileSync(src, "utf8")) as IndividualsFile;
  const places = JSON.parse(readFileSync(placesPath, "utf8")) as Record<string, PlaceGeo>;
  const rand = mulberry32(7);
  const jitter = (lat: number, lon: number): [number, number] => [
    lat + (rand() - 0.5) * JITTER_DEG,
    lon + (rand() - 0.5) * JITTER_DEG,
  ];

  const flows: number[][] = [];
  const dwells: number[][] = [];
  let minYear = 9999;
  let maxYear = 0;
  const sexCode: Record<string, number> = { M: 0, F: 1, U: 2 };

  for (const indi of data.individuals) {
    const events = indi.events ?? [];
    const coded: [number, number, number][] = [];
    for (const e of events) {
      const geo = places[e.place];
      if (!geo) continue;
      const [lat, lon] = jitter(geo.lat, geo.lon);
      coded.push([e.year, lat, lon]);
    }
    if (coded.length === 0) continue;
    const sx = sexCode[indi.sex ?? "U"] ?? 2;
    coded.sort((a, b) => a[0] - b[0]);
    let prev: { y: number; lat: number; lon: number } | null = null;
    for (const c of coded) {
      const y = c[0];
      const lat = c[1];
      const lon = c[2];
      if (y < minYear) minYear = y;
      if (y > maxYear) maxYear = y;
      dwells.push([y, round3(lat), round3(lon), sx]);
      if (prev !== null && (prev.lat !== lat || prev.lon !== lon) && y > prev.y) {
        flows.push([
          prev.y, y,
          round3(prev.lat), round3(prev.lon),
          round3(lat), round3(lon),
          sx,
        ]);
      }
      prev = { y, lat, lon };
    }
  }

  if (minYear > maxYear) { minYear = 1700; maxYear = 2026; }

  const meta = {
    min_year: minYear,
    max_year: maxYear,
    individuals: data.individuals.length,
    dwells: dwells.length,
    flows: flows.length,
  };
  writeFileSync(outPath, JSON.stringify({ meta, dwells, flows }));
  console.log(JSON.stringify(meta, null, 2));
  return 0;
}

exit(main());
