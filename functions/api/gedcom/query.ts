import type { Env, UserContext } from "../../_middleware";
import { accessibleGedSourceIds, ensureGedcomMultiSourceSchema } from "./_lib";

function wrapQuery(sql: string, sourceIds: number[]): string {
  const q = sql.trim().replace(/;+$/, "");
  const ids = sourceIds.join(",");
  return `WITH
  sources         AS (SELECT id,name,loaded_at,n_individuals,n_events,n_families FROM ged_sources WHERE id IN (${ids})),
  individuals     AS (SELECT source_id,id,name,sex,birth_year,NULL AS birth_place,death_year,famc FROM ged_individuals WHERE source_id IN (${ids})),
  events          AS (SELECT source_id,individual_id,type,year,place,lat,lon,NULL AS geo_level,NULL AS geo_cc,NULL AS geo_st FROM ged_events WHERE source_id IN (${ids})),
  families        AS (SELECT source_id,id,husb_id,wife_id FROM ged_families WHERE source_id IN (${ids})),
  family_children AS (SELECT source_id,family_id,child_id FROM ged_family_children WHERE source_id IN (${ids}))
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

  let body: { sql?: string; source_ids?: number[] };
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

  await ensureGedcomMultiSourceSchema(ctx.env);
  const allowed = new Set(await accessibleGedSourceIds(ctx.env, user.id, user.email));
  if (!allowed.size) {
    return new Response(JSON.stringify({ rows: [], note: "No tree data available. Upload a GEDCOM and save it to your account first." }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  let sourceIds = Array.isArray(body.source_ids)
    ? body.source_ids.map(Number).filter(id => Number.isFinite(id) && allowed.has(id))
    : [...allowed];
  if (!sourceIds.length) sourceIds = [...allowed];

  try {
    const wrapped = wrapQuery(sql, sourceIds);
    const result = await ctx.env.DB.prepare(wrapped).all();
    const rows = result.results ?? [];
    return new Response(JSON.stringify({ rows: rows.slice(0, 200), truncated: rows.length > 200, total: rows.length, source_ids: sourceIds }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
};
