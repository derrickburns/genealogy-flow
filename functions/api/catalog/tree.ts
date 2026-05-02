import type { Env, UserContext } from "../../_middleware";

const TREE_CATALOG = new Map([
  ["golden-rosenberg", { name: "Golden-Rosenberg.ged", storageKey: "demo/golden-rosenberg.json" }],
  ["gregory-henry", { name: "Gregory-Henry.ged", storageKey: "demo/gregory-henry.json" }],
]);

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  if (user.type !== "vip") {
    return new Response(JSON.stringify({ error: "VIP access required" }), {
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

  const text = await obj.text();
  return new Response(JSON.stringify({ key, name: tree.name, text }), {
    headers: { "Content-Type": "application/json" },
  });
};
