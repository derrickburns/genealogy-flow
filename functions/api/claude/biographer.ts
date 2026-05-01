import Anthropic from "@anthropic-ai/sdk";
import type { Env, UserContext } from "../../_middleware";

const SYSTEM_BIOGRAPHER = `You are a professional genealogist and biographer writing source-cited prose for a family-history project. Your output is read by descendants, students, and researchers.

You will receive a structured record for one individual: their name, lifespan, parents, marriages and children (with names and birth years), every dated event, and source citations (some with URLs). Produce well-crafted biographical prose.

Style and format:
- Open with the person's full name in **bold** at first mention.
- Write in flowing past tense. Convey dates, places, and life events as a coherent narrative - not a chronological checklist or a dump of facts.
- Refer to spouses, parents, children, and siblings by the names provided in the record. Do not invent any name not in the record.
- Cite sources inline with markdown links: weave them naturally - "the 1900 census recorded the family in Hertford County ([Ancestry source](url))" - or attach them parenthetically - "(see [headstone photograph](url))". Use only URLs that appear in the source data; do not invent URLs.
- When a date is approximate (ABT/EST/CAL), write "by 1865", "around 1865", "in the early 1860s" - do not pretend it is exact.
- When a place is given only at state or country level, do not invent a city or county.
- Hedge gracefully where evidence is thin: "appears in", "is recorded as", "according to the source".
- Do not editorialize. Do not write conclusions the data doesn't support. Do not assign emotions or motivations.
- Do not invent facts: occupations, religious affiliations, military service, immigration motives, causes of death, family relationships not in the record.
- Do not summarize the record by repeating headings or bullet labels. Translate the data into prose.

Output modes:
- "brief": one paragraph, 3-5 sentences. Focus on lifespan, parents, principal marriage, and place of life.
- "standard" (default): one or two paragraphs, ~120-250 words. Cover lifespan, parents (briefly), each marriage with spouse and major children, principal residences, and any distinctive life event from the record. Cite the most authoritative one or two sources.
- "detailed": two to four paragraphs, ~250-500 words. Build a coherent biographical sketch. Use the events list to show a life trajectory. Cite sources liberally with inline markdown links - but only where a URL is provided.
- "timeline": a markdown-ordered list of dated entries, each one a single fluent sentence: "**1850** - Born in Norfolk, Virginia, to John and Mary Smith ([Census](url))." Order strictly by year.

Output ONLY the prose (or the timeline list for "timeline" mode). No preamble. No headings except the year prefix in "timeline" mode. No closing remarks.`;

const EVENT_VERB: Record<string, string> = {
  BIRT: "Born", DEAT: "Died", RESI: "Lived",
  MARR: "Married", EMIG: "Emigrated from", IMMI: "Immigrated to",
  CENS: "Recorded in census", BAPM: "Baptized", BURI: "Buried",
  CHR: "Christened", OCCU: "Worked as", EDUC: "Educated",
  RELI: "Religion", NATU: "Naturalized", WILL: "Will probated",
};

interface SourceRef { src_id: string; page?: string; text?: string; url?: string }
interface GEvent { tag: string; date?: string; year?: number; place?: string; note?: string; sources: SourceRef[] }
interface Individual {
  id: string; name?: string; sex?: string;
  famc?: string; fams: string[];
  events: GEvent[]; notes: string[]; sources: SourceRef[];
}
interface Family {
  id: string; husb?: string; wife?: string; chil: string[];
  marr?: { year?: number; place?: string };
  div?: { year?: number };
}

interface RequestBody {
  individual: Individual;
  individuals: Record<string, Individual>;
  families: Record<string, Family>;
  mode?: "brief" | "standard" | "detailed" | "timeline";
  effort?: "low" | "medium" | "high" | "max";
  model?: string;
  max_tokens?: number;
}

function shortEvent(ev: GEvent): string {
  const when = ev.date ?? (ev.year != null ? String(ev.year) : "");
  const where = ev.place;
  const verb = EVENT_VERB[ev.tag] ?? ev.tag;
  let line = verb;
  if (when) {
    line += (ev.tag === "RESI" || ev.tag === "CENS" || ev.tag === "OCCU")
      ? ` in ${when}` : ` ${when}`;
  }
  if (where) {
    const atTags = new Set(["BIRT", "DEAT", "MARR", "BURI", "BAPM", "CHR"]);
    line += atTags.has(ev.tag) ? ` at ${where}` : `, ${where}`;
  }
  if (ev.note) line += ` (note: ${ev.note.slice(0, 200)})`;
  for (const s of ev.sources.slice(0, 3)) {
    const chunk = (s.page ?? s.text ?? s.src_id).slice(0, 120).trim();
    line += " - " + (s.url ? `[${chunk}](${s.url})` : chunk);
  }
  return line;
}

function buildContext(
  indi: Individual,
  individualsMap: Map<string, Individual>,
  familiesMap: Map<string, Family>
): string {
  const name = indi.name ?? indi.id;
  const sex = indi.sex === "M" ? "male" : indi.sex === "F" ? "female" : "unknown sex";
  const birth = indi.events.find((e) => e.tag === "BIRT") ?? null;
  const death = indi.events.find((e) => e.tag === "DEAT") ?? null;
  const by = birth?.year ?? null;
  const dy = death?.year ?? null;
  let lifespan = "";
  if (by != null && dy != null) lifespan = `, ${by}-${dy}`;
  else if (by != null) lifespan = `, b. ${by}`;
  else if (dy != null) lifespan = `, d. ${dy}`;

  const out: string[] = [];
  out.push(`# ${name} (${indi.id}${lifespan}, ${sex})`);
  out.push("");

  if (indi.famc) {
    const f = familiesMap.get(indi.famc);
    if (f) {
      const father = f.husb ? individualsMap.get(f.husb)?.name : null;
      const mother = f.wife ? individualsMap.get(f.wife)?.name : null;
      if (father || mother) {
        out.push("## Parents");
        if (father) out.push(`- Father: ${father}`);
        if (mother) out.push(`- Mother: ${mother}`);
        out.push("");
      }
    }
  }

  if (indi.fams.length > 0) {
    out.push("## Marriages and children");
    for (const fid of indi.fams) {
      const f = familiesMap.get(fid);
      if (!f) continue;
      const spouseId = indi.id === f.husb ? f.wife : f.husb;
      const spouse = spouseId
        ? (individualsMap.get(spouseId)?.name ?? "(unrecorded spouse)")
        : "(unrecorded spouse)";
      let line = `- Married ${spouse}`;
      if (f.marr) {
        if (f.marr.year != null) line += ` in ${f.marr.year}`;
        if (f.marr.place) line += ` at ${f.marr.place}`;
      }
      out.push(line);
      if (f.div?.year != null) out.push(`  - Divorced in ${f.div.year}`);
      for (const cid of f.chil) {
        const c = individualsMap.get(cid);
        if (!c) continue;
        const cname = c.name ?? cid;
        const cby = c.events.find((e) => e.tag === "BIRT")?.year ?? null;
        const cdy = c.events.find((e) => e.tag === "DEAT")?.year ?? null;
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

  const topCites = indi.sources.filter((s) => s.url);
  if (topCites.length > 0) {
    out.push("## Source URLs");
    for (const s of topCites.slice(0, 8)) {
      const label = (s.page ?? s.text ?? s.src_id).slice(0, 100).trim();
      out.push(`- [${label}](${s.url})`);
    }
    out.push("");
  }

  return out.join("\n").trim();
}

async function decryptKey(encrypted: string, secretHex: string): Promise<string> {
  const [ivHex, cipherHex] = encrypted.split(":");
  if (!ivHex || !cipherHex) throw new Error("Invalid encrypted key format");
  const keyBytes = hexToBytes(secretHex);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: hexToBytes(ivHex) },
    cryptoKey,
    hexToBytes(cipherHex)
  );
  return new TextDecoder().decode(plain);
}

function hexToBytes(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

async function resolveApiKey(user: UserContext, env: Env): Promise<string | null> {
  if (user.type === "vip") return env.ANTHROPIC_API_KEY;
  if (user.type === "regular") {
    const row = await env.DB.prepare(
      `SELECT api_key FROM users WHERE user_id = ?`
    ).bind(user.id).first<{ api_key: string | null }>();
    if (!row?.api_key) return null;
    return decryptKey(row.api_key, env.KEY_ENCRYPTION_SECRET);
  }
  return null;
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const user = (ctx as unknown as { user: UserContext }).user;
  if (user.type === "anon") {
    return new Response(JSON.stringify({ error: "Sign in to use AI features" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = await resolveApiKey(user, ctx.env);
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "No Anthropic API key configured. Add one via /api/user/apikey." }),
      { status: 402, headers: { "Content-Type": "application/json" } }
    );
  }

  let body: RequestBody;
  try {
    body = await ctx.request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  if (!body.individual) {
    return new Response(JSON.stringify({ error: "individual required" }), {
      status: 422, headers: { "Content-Type": "application/json" },
    });
  }

  const individualsMap = new Map(Object.entries(body.individuals ?? {}));
  const familiesMap = new Map(Object.entries(body.families ?? {}));
  const contextMd = buildContext(body.individual, individualsMap, familiesMap);

  const mode = body.mode ?? "standard";
  const effort = body.effort ?? "high";
  const model = body.model ?? "claude-opus-4-7";
  const maxTokens = body.max_tokens ?? 2000;

  const client = new Anthropic({ apiKey });
  const adaptive = model.startsWith("claude-opus-4-7") || model.startsWith("claude-sonnet-4-6");

  // Stream SSE back to the browser
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const write = (data: string) => writer.write(enc.encode(`data: ${JSON.stringify({ text: data })}\n\n`));

  ctx.waitUntil(
    (async () => {
      try {
        const params: Anthropic.MessageCreateParamsNonStreaming = {
          model,
          max_tokens: maxTokens,
          system: [{ type: "text", text: SYSTEM_BIOGRAPHER, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: `Mode: ${mode}\n\nStructured record:\n\n${contextMd}\n\nWrite the ${mode} biography now.` }],
          ...(adaptive ? { thinking: { type: "adaptive" }, output_config: { effort } } : {}),
        };
        const stream = client.messages.stream(params);
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            await write(event.delta.text);
          }
        }
        await writer.write(enc.encode("data: [DONE]\n\n"));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await writer.write(enc.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
      } finally {
        await writer.close();
      }
    })()
  );

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
};
