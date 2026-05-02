import type { AuthDiagnostics, Env, UserContext } from "../../_middleware";

const TREE_CATALOG = new Map([
  ["golden-rosenberg", { name: "Golden-Rosenberg.ged", storageKey: "demo/golden-rosenberg.json" }],
  ["gregory-henry", { name: "Gregory-Henry.ged", storageKey: "demo/gregory-henry.json" }],
  ["archer", { name: "Archer.ged", storageKey: "demo/archer.json" }],
]);

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  const auth = ctx.data.auth as AuthDiagnostics | undefined;
  if (user.type !== "vip") {
    return new Response(JSON.stringify({
      error: "VIP access required",
      user: {
        type: user.type,
        email: user.email ?? null,
      },
      auth: auth ?? null,
    }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const key = new URL(ctx.request.url).searchParams.get("key") || "";
  const tree = TREE_CATALOG.get(key);
  if (!tree) {
    return new Response(JSON.stringify({ error: "Unknown catalog tree" }), {
      status: 404,
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
