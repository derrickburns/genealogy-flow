import type { AuthDiagnostics, Env, UserContext } from "../../_middleware";

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  const auth = ctx.data.auth as AuthDiagnostics | undefined;
  return new Response(JSON.stringify({
    user: {
      type: user.type,
      id: user.id,
      email: user.email ?? null,
    },
    auth: auth ?? null,
  }), {
    headers: { "Content-Type": "application/json" },
  });
};
