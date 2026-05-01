import type { Env, UserContext } from "../../_middleware";

function gedcomKey(user: UserContext): string {
  return user.type === "anon"
    ? `gedcom/anon/${user.id}`
    : `gedcom/user/${user.id}`;
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const user = (ctx as unknown as { user: UserContext }).user;
  const obj = await ctx.env.STORAGE.get(gedcomKey(user));
  if (!obj) {
    return new Response(null, { status: 404 });
  }
  return new Response(obj.body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};

export const onRequestDelete: PagesFunction<Env> = async (ctx) => {
  const user = (ctx as unknown as { user: UserContext }).user;
  await ctx.env.STORAGE.delete(gedcomKey(user));

  if (user.type === "anon") {
    await ctx.env.DB.prepare(`DELETE FROM sessions WHERE session_id = ?`)
      .bind(user.id)
      .run();
  } else {
    await ctx.env.DB.prepare(
      `UPDATE users SET gedcom_expires_at = NULL WHERE user_id = ?`
    )
      .bind(user.id)
      .run();
  }

  return new Response(null, { status: 204 });
};
