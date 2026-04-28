import { writeFileSync } from "node:fs";
import { argv, exit } from "node:process";
import { parseGedcom } from "../gedcom/parser.js";

const TIMELINE_EVENT_TAGS = new Set([
  "BIRT", "DEAT", "RESI", "MARR", "EMIG", "IMMI", "CENS", "BAPM", "BURI", "CHR",
]);

interface OutEvent { type: string; year: number; place: string; }
interface OutIndi {
  id: string;
  events: OutEvent[];
  name: string;
  sex: string;
  birth_year: number | null;
  death_year: number | null;
}

function main(): number {
  const gedPath = argv[2];
  const outPath = argv[3];
  if (!gedPath || !outPath) {
    console.error("usage: parse-gedcom <PATH.ged> <OUT.json>");
    return 2;
  }
  const g = parseGedcom(gedPath);
  const out: OutIndi[] = [];
  for (const ind of g.individuals.values()) {
    const evs: OutEvent[] = [];
    let by: number | null = null;
    let dy: number | null = null;
    for (const e of ind.events) {
      if (!TIMELINE_EVENT_TAGS.has(e.tag)) continue;
      if (e.tag === "BIRT" && e.year != null && by === null) by = e.year;
      if (e.tag === "DEAT" && e.year != null && dy === null) dy = e.year;
      if (e.year != null && e.place) {
        evs.push({ type: e.tag, year: e.year, place: e.place });
      }
    }
    if (evs.length === 0) continue;
    evs.sort((a, b) => a.year - b.year);
    out.push({
      id: ind.id,
      events: evs,
      name: ind.name || ind.id,
      sex: ind.sex || "U",
      birth_year: by,
      death_year: dy,
    });
  }
  writeFileSync(outPath, JSON.stringify({ individuals: out }));
  const totalEvents = out.reduce((s, p) => s + p.events.length, 0);
  const places = new Set<string>();
  for (const p of out) for (const e of p.events) places.add(e.place);
  console.log(`Wrote ${out.length} individuals with events to ${outPath}`);
  console.log(`Total events: ${totalEvents}`);
  console.log(`Unique places: ${places.size}`);
  return 0;
}

exit(main());
