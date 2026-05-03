import type { AuthDiagnostics, Env, UserContext } from "../../_middleware";
import { canAccessCatalogTree, catalogTreeByKey } from "./_lib";

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  const auth = ctx.data.auth as AuthDiagnostics | undefined;

  const key = new URL(ctx.request.url).searchParams.get("key") || "";
  const tree = catalogTreeByKey(key);
  if (!tree) {
    return new Response(JSON.stringify({ error: "Unknown catalog tree" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (tree.publicDemo) {
    return new Response(JSON.stringify({ error: "Use /api/demo for the public demo tree" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!(await canAccessCatalogTree(ctx.env, user, tree))) {
    return new Response(JSON.stringify({ error: "Catalog tree not shared with this account", user: { type: user.type, email: user.email ?? null }, auth: auth ?? null }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const obj = await ctx.env.STORAGE.get(tree.storageKey);
  if (!obj) {
    return new Response(JSON.stringify({ error: "Catalog tree not available" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Catalog-Key": key,
    "X-Catalog-Name": tree.name,
  });
  return new Response(obj.body, { headers });
};
