import { writeFileSync } from "node:fs";
import { argv, exit } from "node:process";
import { parseGedcom } from "../gedcom/parser.js";
import type { Gedcom, Individual } from "../gedcom/types.js";

interface Args {
  ged: string | undefined;
  out: string | undefined;
  top: number;
  maxDepth: number;
  livingOnly: boolean;
  leavesOnly: boolean;
  asOf: number;
  format: "table" | "json" | "csv";
}

function parseArgs(): Args {
  const a: Args = {
    ged: undefined, out: undefined, top: 50, maxDepth: 6,
    livingOnly: false, leavesOnly: false,
    asOf: new Date().getFullYear(), format: "table",
  };
  const positional: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--out": a.out = argv[++i]; break;
      case "--top": a.top = Number.parseInt(argv[++i] ?? "50", 10); break;
      case "--max-depth": a.maxDepth = Number.parseInt(argv[++i] ?? "6", 10); break;
      case "--living-only": a.livingOnly = true; break;
      case "--leaves-only": a.leavesOnly = true; break;
      case "--as-of": a.asOf = Number.parseInt(argv[++i] ?? String(a.asOf), 10); break;
      case "--format": a.format = (argv[++i] ?? "table") as Args["format"]; break;
      default: positional.push(arg);
    }
  }
  a.ged = positional[0];
  return a;
}

function richness(ind: Individual): number {
  let r = 0;
  for (const e of ind.events) if (e.year !== null) r += 1;
  r += ind.sources.length;
  return r;
}

interface Score {
  id: string;
  name: string;
  birth: number | null;
  death: number | null;
  score: number;
  ancestorsFound: number;
  expectedAtDepth: number;
  pci: number;
}

function ancestorScore(rootId: string, g: Gedcom, maxDepth: number): Score {
  const root = g.individuals.get(rootId);
  if (!root) {
    return {
      id: rootId, name: rootId, birth: null, death: null,
      score: 0, ancestorsFound: 0, expectedAtDepth: 0, pci: 0,
    };
  }
  const queue: { id: string; gen: number }[] = [{ id: rootId, gen: 0 }];
  const visited = new Set<string>([rootId]);
  let total = 0;
  let ancestorsFound = 0;
  const ancestorsByGen = new Array<number>(maxDepth + 1).fill(0);

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.gen > maxDepth) continue;
    const ind = g.individuals.get(node.id);
    if (!ind) continue;
    if (node.gen > 0) {
      ancestorsFound += 1;
      ancestorsByGen[node.gen] = (ancestorsByGen[node.gen] ?? 0) + 1;
    }
    const weight = 1 / (1 << node.gen);
    total += weight * richness(ind);
    if (!ind.famc) continue;
    const fam = g.families.get(ind.famc);
    if (!fam) continue;
    if (fam.husb && !visited.has(fam.husb)) {
      visited.add(fam.husb);
      queue.push({ id: fam.husb, gen: node.gen + 1 });
    }
    if (fam.wife && !visited.has(fam.wife)) {
      visited.add(fam.wife);
      queue.push({ id: fam.wife, gen: node.gen + 1 });
    }
  }

  let expected = 0;
  for (let d = 1; d <= maxDepth; d++) expected += 1 << d;

  const birth = root.events.find(e => e.tag === "BIRT")?.year ?? null;
  const death = root.events.find(e => e.tag === "DEAT")?.year ?? null;
  return {
    id: root.id,
    name: root.name || root.id,
    birth,
    death,
    score: total,
    ancestorsFound,
    expectedAtDepth: expected,
    pci: expected > 0 ? ancestorsFound / expected : 0,
  };
}

function isCandidate(ind: Individual, args: Args): boolean {
  const death = ind.events.find(e => e.tag === "DEAT")?.year ?? null;
  const birth = ind.events.find(e => e.tag === "BIRT")?.year ?? null;
  if (args.livingOnly) {
    if (death !== null) return false;
    if (birth === null || birth < args.asOf - 110) return false;
  }
  if (args.leavesOnly) {
    if (ind.fams.length > 0) return false;
  }
  return true;
}

function fmtLifespan(b: number | null, d: number | null): string {
  if (b !== null && d !== null) return `${b}-${d}`;
  if (b !== null) return `b. ${b}`;
  if (d !== null) return `d. ${d}`;
  return "unknown";
}

function renderTable(rows: Score[]): string {
  const lines: string[] = [];
  lines.push("| Rank | ID | Name | Lifespan | Score | Ancestors | PCI |");
  lines.push("|------|----|------|----------|-------|-----------|-----|");
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    lines.push(
      `| ${i + 1} | \`${r.id}\` | ${r.name} | ${fmtLifespan(r.birth, r.death)} | ` +
      `${r.score.toFixed(1)} | ${r.ancestorsFound}/${r.expectedAtDepth} | ${(r.pci * 100).toFixed(0)}% |`,
    );
  }
  return lines.join("\n");
}

function renderCsv(rows: Score[]): string {
  const lines: string[] = [];
  lines.push("rank,id,name,birth,death,score,ancestors_found,expected_at_depth,pci");
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const safeName = r.name.includes(",") || r.name.includes("\"")
      ? `"${r.name.replace(/"/g, "\"\"")}"` : r.name;
    lines.push(
      `${i + 1},${r.id},${safeName},${r.birth ?? ""},${r.death ?? ""},` +
      `${r.score.toFixed(3)},${r.ancestorsFound},${r.expectedAtDepth},${r.pci.toFixed(4)}`,
    );
  }
  return lines.join("\n");
}

function main(): number {
  const args = parseArgs();
  if (!args.ged) {
    console.error(
      "usage: audience <PATH.ged> [--top N=50] [--max-depth N=6] " +
      "[--living-only] [--leaves-only] [--as-of YEAR] " +
      "[--format table|json|csv] [--out FILE]",
    );
    return 2;
  }
  console.error(`Parsing ${args.ged}`);
  const g = parseGedcom(args.ged);
  console.error(`  ${g.individuals.size.toLocaleString()} individuals, ${g.families.size.toLocaleString()} families`);

  const candidates: Individual[] = [];
  for (const ind of g.individuals.values()) {
    if (isCandidate(ind, args)) candidates.push(ind);
  }
  console.error(`  ${candidates.length.toLocaleString()} candidates after filter (living-only=${args.livingOnly} leaves-only=${args.leavesOnly})`);

  const scored = candidates
    .map(ind => ancestorScore(ind.id, g, args.maxDepth))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = scored.slice(0, args.top);
  let out: string;
  if (args.format === "json") out = JSON.stringify(top, null, 2);
  else if (args.format === "csv") out = renderCsv(top);
  else out = renderTable(top);

  if (args.out) {
    writeFileSync(args.out, out);
    console.error(`Wrote ${top.length} ranked candidates to ${args.out}`);
  } else {
    process.stdout.write(out + "\n");
  }
  return 0;
}

exit(main());
