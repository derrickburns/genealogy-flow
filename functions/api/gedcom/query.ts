import type { Env, UserContext } from "../../_middleware";

// Wrap the user's query in CTEs that scope all tables to their source_id.
// Claude writes queries against bare table names (individuals, events, etc.)
// and never needs to know about source_id or the ged_ prefix.
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

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  if (user.type === "anon") {
    return new Response(JSON.stringify({ error: "Sign in required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { sql?: string };
  try {
    body = await ctx.request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { sql } = body;
  if (!sql || typeof sql !== "string") {
    return new Response(JSON.stringify({ error: "sql required" }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!/^\s*SELECT\b/i.test(sql)) {
    return new Response(JSON.stringify({ error: "Only SELECT queries are permitted" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const src = await ctx.env.DB.prepare(`SELECT id FROM ged_sources WHERE user_id = ?`)
    .bind(user.id)
    .first<{ id: number }>();

  if (!src) {
    return new Response(
      JSON.stringify({ rows: [], note: "No tree data available. Upload a GEDCOM and save to your account first." }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const wrapped = wrapQuery(sql, src.id);
    const result = await ctx.env.DB.prepare(wrapped).all();
    const rows = result.results ?? [];
    return new Response(
      JSON.stringify({ rows: rows.slice(0, 200), truncated: rows.length > 200, total: rows.length }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
};
