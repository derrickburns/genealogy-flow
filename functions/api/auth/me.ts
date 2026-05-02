import type { Env, UserContext } from "../../_middleware";

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  return new Response(JSON.stringify({
    user: {
      type: user.type,
      id: user.id,
      email: user.email ?? null,
    },
  }), {
    headers: { "Content-Type": "application/json" },
  });
};
