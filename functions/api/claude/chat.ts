import Anthropic from "@anthropic-ai/sdk";
import type { Env, UserContext } from "../../_middleware";

// Wrap Claude's query in scoped CTEs so it never needs to know about
// source_id or the ged_ table prefix. Claude writes bare table names.
function wrapQuery(sql: string, sourceId: number): string {
  const q = sql.trim().replace(/;+$/, "");
  return `WITH
  individuals     AS (SELECT id,name,sex,birth_year,death_year,famc
                        FROM ged_individuals WHERE source_id=${sourceId}),
  events          AS (SELECT individual_id,type,year,place,lat,lon
                        FROM ged_events WHERE source_id=${sourceId}),
  families        AS (SELECT id,husb_id,wife_id
                        FROM ged_families WHERE source_id=${sourceId}),
  family_children AS (SELECT family_id,child_id
                        FROM ged_family_children WHERE source_id=${sourceId})
${q}`;
}

function buildSystemPrompt(sourceId: number | null): string {
  const schemaBlock = sourceId != null ? `
SQLite schema (your tree is already scoped — query these table names directly, no source_id needed):

  individuals(id TEXT, name TEXT, sex TEXT, birth_year INTEGER, death_year INTEGER, famc TEXT)
    -- id is the GEDCOM xref like "@I1234@". sex is M/F/U. famc is the family-as-child id.

  events(individual_id TEXT, type TEXT, year INTEGER, place TEXT, lat REAL, lon REAL)
    -- type in {BIRT,DEAT,RESI,MARR,EMIG,IMMI,CENS,BAPM,BURI,CHR,OCCU}.
    -- place is GEDCOM-style ("City, County, State, Country"). lat/lon are geocoded coordinates.
    -- join to individuals: ON individual_id = individuals.id

  families(id TEXT, husb_id TEXT, wife_id TEXT)
    -- composite with family_children for parent-child links.

  family_children(family_id TEXT, child_id TEXT)
    -- one row per child. To find children of a person: join families ON id=famc, then family_children ON family_id=families.id.

Examples:
  -- everyone born after 1900 in New York
  SELECT name, birth_year FROM individuals WHERE birth_year > 1900
  AND id IN (SELECT individual_id FROM events WHERE type='BIRT' AND place LIKE '%New York%');

  -- direct ancestors (recursive CTE)
  WITH RECURSIVE up(id, gen) AS (
    SELECT id, 0 FROM individuals WHERE name LIKE '%Helen%' LIMIT 1
    UNION ALL
    SELECT CASE WHEN f.husb_id=up.id THEN NULL ELSE f.husb_id END, up.gen+1
    FROM up JOIN individuals i ON i.id=up.id
            JOIN families f ON f.id=i.famc
    WHERE up.gen < 8
  )
  SELECT i.name, i.birth_year, up.gen FROM up JOIN individuals i ON i.id=up.id ORDER BY gen;

  -- migration pattern: most common birth-to-death country moves
  SELECT e1.place AS born_in, e2.place AS died_in, COUNT(*) AS n
  FROM events e1 JOIN events e2 ON e1.individual_id=e2.individual_id
  WHERE e1.type='BIRT' AND e2.type='DEAT'
  GROUP BY 1,2 ORDER BY n DESC LIMIT 20;

Use run_sql for any question about counts, patterns, lineage, or the full dataset.
` : `
No tree data is seeded yet. Answer from the context window only. Suggest the user upload a GEDCOM and save it to their account to enable full SQL queries.
`;

  return `You are the genealogy-data analyst embedded in Kindred Flow, a particle-flow GEDCOM viewer. Your primary job is to help the user understand their genealogical data: migration patterns, family-branch dynamics, lineage paths, surname concentrations, intermarriage, who-was-where-when. You synthesize quantitative findings from SQL into short, narrative answers.

HARD CONSTRAINTS — never violate these:
1. You are NOT a coding assistant. Do not write application code, explore codebases, suggest software architecture, or offer to build features.
2. This is a read-only viewer. You cannot edit records. If asked to make changes, explain that edits must be made in the source GEDCOM file.
3. Never ask clarifying questions about implementation details. Make reasonable choices silently. The audience is family history researchers — never use technical jargon like "D3", "force simulation", "DOT format", or "implementation".
4. Never end a reply with offers to "build/prototype/design this". Produce visualizations immediately via KFCALL — do it, don't offer to do it.
5. You have NO access to design tools, canvas editors, or diagramming software. Do not mention Pencil, Figma, Miro, or any design/canvas tool. Do not offer to create diagrams outside of KFCALL showViz.

SUGGESTION LISTS: When listing visualization or analysis ideas, present EVERY suggestion as a clickable chip: <<KFCHIP:{"label":"...","method":"chat","args":"..."}>> where args is the complete self-contained request. Never list suggestions as plain bullet points.

VISUALIZATION REQUESTS: Produce immediately — run_sql to get data, then showViz with data inlined. For network graphs use type "html" with library from CDN and all data as inline JavaScript. Keep graphs to ≤200 nodes.

Each user message may be preceded by a context block describing what they're currently viewing. Use it to disambiguate. Use run_sql for anything beyond what's visible on screen.

KFCALL markers drive the browser visualization. The browser executes them and feeds results back:
  <<KFCALL:methodName(jsonArgs)>>
  <<KFCHIP:{"label":"...","method":"...","args":...}>>

Available methods: setYear(n), play(), pause(), setRoot(name), selectPerson(name), centerOn(name), traceLineage([a,b]), addPin({lat,lon,label}), clearPins(), playRange([start,end,step]), showViz({type,title,spec}), chain([{method,args},...]).
showViz types: "vega" (Vega-Lite JSON), "mermaid" (DSL string), "dot" (GraphViz), "html" (self-contained fragment), "svg", "markdown".

Formatting: Markdown renders. Offer chip buttons instead of asking "want me to X?".
Audience: family-history researchers. Translate tag codes to plain English. Never show raw SQL or schema names.
${schemaBlock}`;
}

const RUN_SQL_TOOL: Anthropic.Tool = {
  name: "run_sql",
  description:
    "Execute a read-only SELECT query against the user's GEDCOM database. " +
    "Tables: individuals, events, families, family_children. Returns up to 200 rows.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "A SELECT statement using the schema tables." },
    },
    required: ["query"],
  },
};

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const user = (ctx as unknown as { user: UserContext }).user;

  // Only VIP users use this endpoint. Regular users call Anthropic directly
  // from the browser (their key never touches the server) and use
  // /api/gedcom/query for SQL execution.
  if (user.type !== "vip") {
    return new Response(JSON.stringify({ error: "VIP access required" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: Anthropic.MessageCreateParamsNonStreaming & { stream?: boolean };
  try {
    body = await ctx.request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Look up the user's seeded source_id (may be null if they haven't seeded yet)
  const src = await ctx.env.DB.prepare(`SELECT id FROM ged_sources WHERE user_id = ?`)
    .bind(user.id)
    .first<{ id: number }>();
  const sourceId = src?.id ?? null;

  const client = new Anthropic({ apiKey: ctx.env.ANTHROPIC_API_KEY });
  const systemPrompt = buildSystemPrompt(sourceId);
  const tools: Anthropic.Tool[] = sourceId != null ? [RUN_SQL_TOOL] : [];

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = async (text: string) =>
    writer.write(enc.encode(`data: ${JSON.stringify({ text })}\n\n`));

  ctx.waitUntil(
    (async () => {
      try {
        let messages: Anthropic.MessageParam[] = body.messages ?? [];

        while (true) {
          // Use streaming so text reaches the browser immediately
          const stream = client.messages.stream({
            model: body.model ?? "claude-sonnet-4-6",
            max_tokens: body.max_tokens ?? 8192,
            system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
            tools,
            messages,
          });

          // Track tool-use blocks while streaming text deltas
          const toolBlocks: { id: string; name: string; inputStr: string }[] = [];
          let activeToolIdx = -1;

          for await (const event of stream) {
            if (event.type === "content_block_start") {
              if (event.content_block.type === "tool_use") {
                toolBlocks.push({ id: event.content_block.id, name: event.content_block.name, inputStr: "" });
                activeToolIdx = toolBlocks.length - 1;
              } else {
                activeToolIdx = -1;
              }
            } else if (event.type === "content_block_delta") {
              if (event.delta.type === "text_delta") {
                await send(event.delta.text);
              } else if (event.delta.type === "input_json_delta" && activeToolIdx >= 0) {
                toolBlocks[activeToolIdx].inputStr += event.delta.partial_json;
              }
            }
          }

          const finalMsg = await stream.finalMessage();

          if (finalMsg.stop_reason === "tool_use" && toolBlocks.length > 0) {
            const toolResults: Anthropic.ToolResultBlockParam[] = [];

            for (const tb of toolBlocks) {
              if (tb.name !== "run_sql") continue;
              let result: unknown;
              try {
                const input = JSON.parse(tb.inputStr) as { query: string };
                const query = input.query ?? "";
                if (!/^\s*SELECT\b/i.test(query)) {
                  result = { error: "Only SELECT queries are allowed." };
                } else if (sourceId != null) {
                  const wrapped = wrapQuery(query, sourceId);
                  const r = await ctx.env.DB.prepare(wrapped).all();
                  const rows = r.results ?? [];
                  result = { rows: rows.slice(0, 200), truncated: rows.length > 200, total: rows.length };
                } else {
                  result = { rows: [], note: "No tree data available." };
                }
              } catch (e) {
                result = { error: e instanceof Error ? e.message : String(e) };
              }
              toolResults.push({
                type: "tool_result",
                tool_use_id: tb.id,
                content: JSON.stringify(result),
              });
            }

            messages = [
              ...messages,
              { role: "assistant", content: finalMsg.content },
              { role: "user", content: toolResults },
            ];
            // continue loop
          } else {
            // end_turn or no tools — done
            break;
          }
        }

        await writer.write(enc.encode("data: [DONE]\n\n"));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await writer.write(enc.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
      } finally {
        await writer.close();
      }
    })(),
  );

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
};
