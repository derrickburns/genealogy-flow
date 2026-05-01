import type { Env, UserContext } from "../../_middleware";

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const user = (ctx as unknown as { user: UserContext }).user;
  if (user.type === "anon") {
    return new Response(JSON.stringify({ source_id: null }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  const src = await ctx.env.DB.prepare(`SELECT id, name FROM ged_sources WHERE user_id = ?`)
    .bind(user.id)
    .first<{ id: number; name: string }>();
  return new Response(JSON.stringify({ source_id: src?.id ?? null, name: src?.name ?? null }), {
    headers: { "Content-Type": "application/json" },
  });
};
