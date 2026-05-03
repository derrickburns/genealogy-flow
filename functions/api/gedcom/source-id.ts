import type { Env, UserContext } from "../../_middleware";
import { accessibleGedSourceIds, ensureGedcomMultiSourceSchema } from "./_lib";

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  if (user.type === "anon") {
    return new Response(JSON.stringify({ source_id: null, sources: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  await ensureGedcomMultiSourceSchema(ctx.env);
  const allowedIds = await accessibleGedSourceIds(ctx.env, user.id, user.email);
  if (!allowedIds.length) {
    return new Response(JSON.stringify({ source_id: null, sources: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  const placeholders = allowedIds.map(() => "?").join(",");
  const rows = await ctx.env.DB.prepare(
    `SELECT id, tree_uuid, name, is_default FROM ged_sources WHERE id IN (${placeholders}) ORDER BY is_default DESC, loaded_at ASC, id ASC`
  ).bind(...allowedIds).all<{ id: number; tree_uuid: string | null; name: string; is_default: number }>();
  const sources = rows.results ?? [];
  const active = sources.find(s => s.is_default) ?? sources[0] ?? null;
  return new Response(JSON.stringify({
    source_id: active?.id ?? null,
    tree_uuid: active?.tree_uuid ?? null,
    name: active?.name ?? null,
    sources: sources.map(s => ({ source_id: s.id, tree_uuid: s.tree_uuid, name: s.name, is_default: !!s.is_default })),
  }), {
    headers: { "Content-Type": "application/json" },
  });
};
