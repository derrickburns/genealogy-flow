import type { Env, UserContext } from "../../_middleware";
import { accessibleGedSourceIds, ensureGedcomMultiSourceSchema } from "./_lib";

type SourceRow = {
  id: number;
  tree_uuid: string | null;
  name: string;
  is_default: number;
  loaded_at: string;
  n_individuals: number;
  n_events: number;
  n_families: number;
  owner_email: string | null;
  owner_uuid: string | null;
  relation: string;
};

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  if (user.type === "anon") {
    return new Response(JSON.stringify({ trees: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  await ensureGedcomMultiSourceSchema(ctx.env);
  const ids = await accessibleGedSourceIds(ctx.env, user.id, user.email);
  if (!ids.length) {
    return new Response(JSON.stringify({ trees: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  const placeholders = ids.map(() => "?").join(",");
  const rows = await ctx.env.DB.prepare(`
    SELECT id, tree_uuid, name, is_default, loaded_at, n_individuals, n_events, n_families, owner_email, owner_uuid,
           CASE WHEN user_id = ? OR owner_user_id = ? OR lower(COALESCE(owner_email, '')) = ? THEN 'owned' ELSE 'shared' END AS relation
    FROM ged_sources
    WHERE id IN (${placeholders})
    ORDER BY relation ASC, is_default DESC, loaded_at ASC, id ASC
  `).bind(user.id, user.id, String(user.email || "").toLowerCase(), ...ids).all<SourceRow>();

  const trees = (rows.results ?? []).map(row => ({
    kind: "cloud",
    key: row.tree_uuid || String(row.id),
    tree_uuid: row.tree_uuid,
    source_id: row.id,
    name: row.name,
    is_default: !!row.is_default,
    loaded_at: row.loaded_at,
    n_individuals: row.n_individuals,
    n_events: row.n_events,
    n_families: row.n_families,
    owner_email: row.owner_email,
    owner_uuid: row.owner_uuid,
    relation: row.relation,
    available: true,
  }));
  return new Response(JSON.stringify({ trees }), {
    headers: { "Content-Type": "application/json" },
  });
};
