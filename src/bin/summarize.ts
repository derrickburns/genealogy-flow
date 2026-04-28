#!/usr/bin/env -S npx tsx
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { argv, exit } from "node:process";
import Anthropic from "@anthropic-ai/sdk";

const SYSTEM_PROMPT = `You are summarizing a single person's life from a GEDCOM record. Output ONLY the summary text; no preamble, no closing remarks, no headings.

Constraints:
- 1 to 3 sentences, factual, no speculation.
- Markdown allowed: **bold** for the person's full name on first mention, *italics* sparingly, and [link text](url) for any URLs that appear in source citations within the GEDCOM (e.g. PAGE/URL fields in SOUR blocks).
- Lead with the person's name in bold, then their lifespan in parentheses if dates are known (e.g. "(b. 1850 in Norfolk, VA - d. 1922 in Richmond, VA)" or "(1850-1922)" if places aren't given), then a brief life summary drawn from the record's events.
- Preserve at most two source URLs as markdown links if they appear in the record.
- Do NOT invent facts, occupations, relationships, or events not present in the record.

Format examples:
- **Mary Smith** (b. 1850 in Norfolk, VA - d. 1922 in Richmond, VA) married John Doe in 1875 and lived in Hertford County for the 1900 census.
- **Unknown Reid** (no dates recorded) appears as a child in family F1234; no further events on file.
- **John Abner Collins** (b. abt. 1852 in Hertford Co, NC - d. 1931) is recorded with wife Bettie in the 1900 and 1910 censuses; his father is unknown per the [death record](https://www.ancestry.com/...).`;

const USER_TEMPLATE = (gedcom: string): string =>
  `GEDCOM record for one individual:\n\n\`\`\`\n${gedcom}\n\`\`\`\n\nWrite the summary now.`;

const INDI_RE = /^0 (@[^@]+@)\s+INDI\s*$/;
const TOPLEVEL_RE = /^0 /;

function* parseIndiBlocks(path: string): Generator<[string, string]> {
  const text = readFileSync(path, "utf8");
  let curId: string | null = null;
  let buf: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw) continue;
    const m = INDI_RE.exec(raw);
    if (m) {
      if (curId !== null) yield [curId, buf.join("\n")];
      curId = m[1]!;
      buf = [raw];
      continue;
    }
    if (TOPLEVEL_RE.test(raw)) {
      if (curId !== null) yield [curId, buf.join("\n")];
      curId = null;
      buf = [];
      continue;
    }
    if (curId !== null) buf.push(raw);
  }
  if (curId !== null) yield [curId, buf.join("\n")];
}

interface Args {
  ged: string | undefined;
  model: string;
  limit: number | null;
  out: string | undefined;
  maxTokens: number;
}

function parseArgs(): Args {
  const a: Args = {
    ged: undefined, model: "claude-opus-4-7", limit: null,
    out: undefined, maxTokens: 400,
  };
  const positional: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--model") a.model = argv[++i] ?? a.model;
    else if (arg === "--limit") a.limit = Number.parseInt(argv[++i] ?? "0", 10);
    else if (arg === "--out") a.out = argv[++i];
    else if (arg === "--max-tokens") a.maxTokens = Number.parseInt(argv[++i] ?? "400", 10);
    else positional.push(arg);
  }
  a.ged = positional[0];
  return a;
}

async function main(): Promise<number> {
  const args = parseArgs();
  if (!args.ged) {
    console.error("usage: summarize-gedcom <PATH.ged> [--model claude-opus-4-7] [--limit N] [--out path.json] [--max-tokens N]");
    return 2;
  }
  const outPath = args.out ?? `${args.ged}.summaries.json`;
  let existing: Record<string, string> = {};
  if (existsSync(outPath)) {
    try { existing = JSON.parse(readFileSync(outPath, "utf8")); }
    catch { console.error(`Warning: existing ${outPath} is malformed; starting fresh`); existing = {}; }
  }

  console.log(`Reading ${args.ged}`);
  const blocks: [string, string][] = [];
  for (const [id, blk] of parseIndiBlocks(args.ged)) {
    if (blk.includes("2 DATE")) blocks.push([id, blk]);
  }
  let pending = blocks.filter(([id]) => !(id in existing));
  console.log(`Total individuals with dated events: ${blocks.length}`);
  console.log(`Already summarized: ${Object.keys(existing).length}`);
  console.log(`Pending: ${pending.length}`);
  if (args.limit !== null) {
    pending = pending.slice(0, args.limit);
    console.log(`Limiting this run to ${pending.length}`);
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
  let cacheReads = 0, cacheWrites = 0, inputTokens = 0, outputTokens = 0;
  let writtenSinceSave = 0;
  const saveEvery = 25;

  for (let i = 0; i < pending.length; i++) {
    if (interrupted.flag) break;
    const [iid, block] = pending[i]!;
    let resp: Awaited<ReturnType<typeof client.messages.create>>;
    try {
      resp = await client.messages.create({
        model: args.model,
        max_tokens: args.maxTokens,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: USER_TEMPLATE(block) }],
      });
    } catch (e) {
      const err = e as { status?: number; message?: string };
      console.error(`[${iid}] API error ${err.status ?? "?"}: ${err.message ?? String(e)} - skipping`);
      continue;
    }
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map(b => b.text)
      .join("")
      .trim();
    if (text) { existing[iid] = text; writtenSinceSave += 1; }

    const u = resp.usage;
    cacheReads += u.cache_read_input_tokens ?? 0;
    cacheWrites += u.cache_creation_input_tokens ?? 0;
    inputTokens += u.input_tokens ?? 0;
    outputTokens += u.output_tokens ?? 0;

    if ((i + 1) % 10 === 0) {
      const elapsed = (Date.now() - start) / 1000;
      const rate = elapsed > 0 ? (i + 1) / elapsed : 0;
      console.log(
        `[${i + 1}/${pending.length}] ${iid.padEnd(30)} | ` +
        `cache_r ${cacheReads.toLocaleString()} cache_w ${cacheWrites.toLocaleString()} ` +
        `in ${inputTokens.toLocaleString()} out ${outputTokens.toLocaleString()} | ${rate.toFixed(1)}/s`,
      );
    }
    if (writtenSinceSave >= saveEvery) { persist(); writtenSinceSave = 0; }
  }

  persist();
  process.off("SIGINT", onSig);
  console.log(
    `\nSaved ${Object.keys(existing).length} summaries to ${outPath}\n` +
    `Cache reads:  ${cacheReads.toLocaleString()}\n` +
    `Cache writes: ${cacheWrites.toLocaleString()}\n` +
    `Input tokens: ${inputTokens.toLocaleString()}\n` +
    `Output tokens:${outputTokens.toLocaleString()}`,
  );
  return 0;
}

exit(await main());
