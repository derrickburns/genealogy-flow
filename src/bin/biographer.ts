import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argv, exit } from "node:process";
import Anthropic from "@anthropic-ai/sdk";
import { parseGedcom } from "../gedcom/parser.js";
import type { Event, Gedcom, Individual } from "../gedcom/types.js";

const SYSTEM_BIOGRAPHER = `You are a professional genealogist and biographer writing source-cited prose for a family-history project. Your output is read by descendants, students, and researchers.

You will receive a structured record for one individual: their name, lifespan, parents, marriages and children (with names and birth years), every dated event, and source citations (some with URLs). Produce well-crafted biographical prose.

Style and format:
- Open with the person's full name in **bold** at first mention.
- Write in flowing past tense. Convey dates, places, and life events as a coherent narrative — not a chronological checklist or a dump of facts.
- Refer to spouses, parents, children, and siblings by the names provided in the record. Do not invent any name not in the record.
- Cite sources inline with markdown links: weave them naturally — "the 1900 census recorded the family in Hertford County ([Ancestry source](url))" — or attach them parenthetically — "(see [headstone photograph](url))". Use only URLs that appear in the source data; do not invent URLs.
- When a date is approximate (ABT/EST/CAL), write "by 1865", "around 1865", "in the early 1860s" — do not pretend it is exact.
- When a place is given only at state or country level, do not invent a city or county.
- Hedge gracefully where evidence is thin: "appears in", "is recorded as", "according to the source".
- Do not editorialize ("a fascinating life", "a remarkable man", "tragically"). Do not write conclusions the data doesn't support. Do not assign emotions or motivations.
- Do not invent facts: occupations, religious affiliations, military service, immigration motives, causes of death, family relationships not in the record.
- Do not summarize the record by repeating headings or bullet labels. Translate the data into prose.

Output modes:
- "brief": one paragraph, 3-5 sentences. Focus on lifespan, parents, principal marriage, and place of life.
- "standard" (default): one or two paragraphs, ~120-250 words. Cover lifespan, parents (briefly), each marriage with spouse and major children, principal residences, and any distinctive life event from the record. Cite the most authoritative one or two sources.
- "detailed": two to four paragraphs, ~250-500 words. Build a coherent biographical sketch. Use the events list to show a life trajectory (where they were at each census, when and where children were born, when they moved, when each spouse and each parent died if recorded). Cite sources liberally with inline markdown links - but only where a URL is provided.
- "timeline": a markdown-ordered list of dated entries, each one a single fluent sentence: "**1850** — Born in Norfolk, Virginia, to John and Mary Smith ([Census](url))." Order strictly by year. Inline citations as before.

Output ONLY the prose (or the timeline list for "timeline" mode). No preamble. No headings except when "timeline" mode requires the year prefix in bold. No closing remarks.`;

const EVENT_VERB: Record<string, string> = {
  BIRT: "Born", DEAT: "Died", RESI: "Lived",
  MARR: "Married", EMIG: "Emigrated from", IMMI: "Immigrated to",
  CENS: "Recorded in census", BAPM: "Baptized", BURI: "Buried",
  CHR: "Christened", OCCU: "Worked as", EDUC: "Educated",
  RELI: "Religion", NATU: "Naturalized", WILL: "Will probated",
};

function shortEvent(ev: Event): string {
  const when = ev.date || (ev.year != null ? String(ev.year) : "");
  const where = ev.place;
  const verb = EVENT_VERB[ev.tag] ?? ev.tag;
  let line = verb;
  if (when) {
    line += (ev.tag === "RESI" || ev.tag === "CENS" || ev.tag === "OCCU") ? ` in ${when}` : ` ${when}`;
  }
  if (where) {
    const atTags = new Set(["BIRT", "DEAT", "MARR", "BURI", "BAPM", "CHR"]);
    line += atTags.has(ev.tag) ? ` at ${where}` : `, ${where}`;
  }
  if (ev.note) line += ` (note: ${ev.note.slice(0, 200)})`;
  if (ev.sources.length > 0) {
    const cites: string[] = [];
    for (const s of ev.sources.slice(0, 3)) {
      const chunk = (s.page || s.text || s.src_id).slice(0, 120).trim();
      cites.push(s.url ? `[${chunk}](${s.url})` : chunk);
    }
    if (cites.length > 0) line += " - sources: " + cites.join("; ");
  }
  return line;
}

function buildContext(g: Gedcom, indi: Individual): string {
  const name = indi.name || indi.id;
  const sex = indi.sex === "M" ? "male" : indi.sex === "F" ? "female" : "unknown sex";
  const birth = indi.events.find(e => e.tag === "BIRT") ?? null;
  const death = indi.events.find(e => e.tag === "DEAT") ?? null;
  const by = birth?.year ?? null;
  const dy = death?.year ?? null;
  let lifespan = "";
  if (by != null && dy != null) lifespan = `, ${by}-${dy}`;
  else if (by != null) lifespan = `, b. ${by}`;
  else if (dy != null) lifespan = `, d. ${dy}`;

  const out: string[] = [];
  out.push(`# ${name} (${indi.id}${lifespan}, ${sex})`);
  out.push("");

  if (indi.famc && g.families.has(indi.famc)) {
    const f = g.families.get(indi.famc)!;
    const father = f.husb && g.individuals.has(f.husb) ? g.individuals.get(f.husb)!.name : null;
    const mother = f.wife && g.individuals.has(f.wife) ? g.individuals.get(f.wife)!.name : null;
    if (father || mother) {
      out.push("## Parents");
      if (father) out.push(`- Father: ${father}`);
      if (mother) out.push(`- Mother: ${mother}`);
      out.push("");
    }
  }

  if (indi.fams.length > 0) {
    out.push("## Marriages and children");
    for (const fid of indi.fams) {
      const f = g.families.get(fid);
      if (!f) continue;
      const spouseId = indi.id === f.husb ? f.wife : f.husb;
      const spouse = spouseId && g.individuals.has(spouseId)
        ? g.individuals.get(spouseId)!.name
        : "(unrecorded spouse)";
      let line = `- Married ${spouse}`;
      if (f.marr) {
        if (f.marr.year != null) line += ` in ${f.marr.year}`;
        if (f.marr.place) line += ` at ${f.marr.place}`;
      }
      out.push(line);
      if (f.div?.year != null) out.push(`  - Divorced in ${f.div.year}`);
      for (const cid of f.chil) {
        const c = g.individuals.get(cid);
        if (!c) continue;
        const cname = c.name || cid;
        const cby = c.events.find(e => e.tag === "BIRT")?.year ?? null;
        const cdy = c.events.find(e => e.tag === "DEAT")?.year ?? null;
        let suffix = "";
        if (cby != null && cdy != null) suffix = ` (${cby}-${cdy})`;
        else if (cby != null) suffix = ` (b. ${cby})`;
        out.push(`  - Child: ${cname}${suffix}`);
      }
    }
    out.push("");
  }

  const events = [...indi.events].sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999));
  if (events.length > 0) {
    out.push("## Events");
    for (const ev of events) out.push(`- ${shortEvent(ev)}`);
    out.push("");
  }

  if (indi.notes.length > 0) {
    out.push("## Notes");
    for (const nt of indi.notes.slice(0, 5)) out.push(`- ${nt.slice(0, 600)}`);
    out.push("");
  }

  const topCites = indi.sources.filter(s => s.url);
  if (topCites.length > 0) {
    out.push("## Source URLs (top-level)");
    for (const s of topCites.slice(0, 8)) {
      const label = (s.page || s.text || s.src_id).slice(0, 100).trim();
      out.push(`- [${label}](${s.url})`);
    }
    out.push("");
  }

  return out.join("\n").trim();
}

interface Args {
  ged: string | undefined;
  mode: "brief" | "standard" | "detailed" | "timeline";
  model: string;
  effort: "low" | "medium" | "high" | "max";
  limit: number | null;
  out: string | undefined;
  mdDir: string | undefined;
  maxTokens: number;
  minEvents: number;
  ids: string[] | null;
}

function parseArgs(): Args {
  const a: Args = {
    ged: undefined, mode: "standard", model: "claude-opus-4-7", effort: "high",
    limit: null, out: undefined, mdDir: undefined, maxTokens: 2000,
    minEvents: 1, ids: null,
  };
  const positional: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--mode": a.mode = (argv[++i] ?? "standard") as Args["mode"]; break;
      case "--model": a.model = argv[++i] ?? a.model; break;
      case "--effort": a.effort = (argv[++i] ?? "high") as Args["effort"]; break;
      case "--limit": a.limit = Number.parseInt(argv[++i] ?? "0", 10); break;
      case "--out": a.out = argv[++i]; break;
      case "--md-dir": a.mdDir = argv[++i]; break;
      case "--max-tokens": a.maxTokens = Number.parseInt(argv[++i] ?? "2000", 10); break;
      case "--min-events": a.minEvents = Number.parseInt(argv[++i] ?? "1", 10); break;
      case "--ids": a.ids = (argv[++i] ?? "").split(",").map(s => s.trim()).filter(Boolean); break;
      default: positional.push(arg);
    }
  }
  a.ged = positional[0];
  return a;
}

function buildUserMessage(contextMd: string, mode: string): string {
  return `Mode: ${mode}\n\nStructured record:\n\n${contextMd}\n\nWrite the ${mode} biography now.`;
}

async function writeBio(
  client: Anthropic,
  args: Args,
  contextMd: string,
): Promise<{ text: string; usage: Anthropic.Usage }> {
  const adaptive = args.model.startsWith("claude-opus-4-7")
    || args.model.startsWith("claude-opus-4-6")
    || args.model.startsWith("claude-sonnet-4-6");
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: args.model,
    max_tokens: args.maxTokens,
    system: [{ type: "text", text: SYSTEM_BIOGRAPHER, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildUserMessage(contextMd, args.mode) }],
    ...(adaptive
      ? {
          thinking: { type: "adaptive" },
          output_config: { effort: args.effort },
        }
      : {}),
  };
  const stream = client.messages.stream(params);
  const final = await stream.finalMessage();
  const text = final.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map(b => b.text)
    .join("")
    .trim();
  return { text, usage: final.usage };
}

async function main(): Promise<number> {
  const args = parseArgs();
  if (!args.ged) {
    console.error(
      "usage: biographer <PATH.ged> [--mode brief|standard|detailed|timeline] " +
      "[--model claude-opus-4-7] [--effort low|medium|high|max] [--limit N] " +
      "[--out path.json] [--md-dir path/] [--max-tokens N] [--min-events N] [--ids @I1@,@I2@]",
    );
    return 2;
  }
  const outPath = args.out ?? `${args.ged}.summaries.json`;
  if (args.mdDir) mkdirSync(args.mdDir, { recursive: true });

  let existing: Record<string, string> = {};
  if (existsSync(outPath)) {
    try { existing = JSON.parse(readFileSync(outPath, "utf8")); }
    catch { console.error(`Warning: existing ${outPath} is malformed; starting fresh`); }
  }

  console.log(`Parsing ${args.ged}`);
  const g = parseGedcom(args.ged);
  console.log(`  ${g.individuals.size.toLocaleString()} individuals, ${g.families.size.toLocaleString()} families, ${g.sources.size.toLocaleString()} sources`);

  let wanted: string[];
  if (args.ids) {
    wanted = args.ids;
  } else {
    wanted = [];
    for (const [iid, ind] of g.individuals) {
      const dated = ind.events.filter(e => e.year != null).length;
      if (dated >= args.minEvents) wanted.push(iid);
    }
  }
  let pending = wanted.filter(iid => !(iid in existing));
  console.log(`  candidates: ${wanted.length.toLocaleString()}, already done: ${Object.keys(existing).length.toLocaleString()}, pending: ${pending.length.toLocaleString()}`);
  if (args.limit !== null) {
    pending = pending.slice(0, args.limit);
    console.log(`  limiting this run to ${pending.length.toLocaleString()}`);
  }
  if (pending.length === 0) { console.log("Nothing to do."); return 0; }

  const client = new Anthropic();
  const interrupted = { flag: false };
  const onSig = () => {
    interrupted.flag = true;
    console.error("\nInterrupt received; finishing current request and saving...");
  };
  process.on("SIGINT", onSig);

  const persist = () => writeFileSync(outPath, JSON.stringify(existing, null, 2));
  const start = Date.now();
  let written = 0;
  let cacheReads = 0, cacheWrites = 0, inputTokens = 0, outputTokens = 0;
  const saveEvery = 10;

  for (let i = 0; i < pending.length; i++) {
    if (interrupted.flag) break;
    const iid = pending[i]!;
    const ind = g.individuals.get(iid);
    if (!ind) continue;
    const ctx = buildContext(g, ind);
    let text = "";
    let usage: Anthropic.Usage | null = null;
    try {
      const result = await writeBio(client, args, ctx);
      text = result.text;
      usage = result.usage;
    } catch (e) {
      const err = e as { status?: number; message?: string };
      console.error(`[${iid}] error ${err.status ?? "?"}: ${err.message ?? String(e)} - skipping`);
      continue;
    }
    if (!text) continue;
    existing[iid] = text;
    written += 1;
    if (args.mdDir) {
      const safeId = iid.replace(/^@|@$/g, "").replace(/[^A-Za-z0-9_.-]+/g, "_");
      writeFileSync(join(args.mdDir, `${safeId}.md`), text);
    }
    if (usage) {
      cacheReads += usage.cache_read_input_tokens ?? 0;
      cacheWrites += usage.cache_creation_input_tokens ?? 0;
      inputTokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
    }
    if ((i + 1) % 5 === 0) {
      const elapsed = (Date.now() - start) / 1000;
      const rate = elapsed > 0 ? (i + 1) / elapsed : 0;
      console.log(
        `[${i + 1}/${pending.length}] ${iid.padEnd(30)} | ` +
        `cache_r ${cacheReads.toLocaleString()} cache_w ${cacheWrites.toLocaleString()} ` +
        `in ${inputTokens.toLocaleString()} out ${outputTokens.toLocaleString()} | ${rate.toFixed(2)}/s`,
      );
    }
    if (written % saveEvery === 0) persist();
  }

  persist();
  process.off("SIGINT", onSig);
  console.log(
    `\nWrote ${Object.keys(existing).length} biographies to ${outPath}\n` +
    `Cache reads:  ${cacheReads.toLocaleString()}\n` +
    `Cache writes: ${cacheWrites.toLocaleString()}\n` +
    `Input tokens: ${inputTokens.toLocaleString()}\n` +
    `Output tokens:${outputTokens.toLocaleString()}`,
  );
  return 0;
}

exit(await main());
