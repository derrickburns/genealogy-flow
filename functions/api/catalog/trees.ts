import type { Env, UserContext } from "../../_middleware";

const TREE_CATALOG = [
  { key: "golden-rosenberg", name: "Golden-Rosenberg.ged", storageKey: "demo/golden-rosenberg.json" },
  { key: "gregory-henry", name: "Gregory-Henry.ged", storageKey: "demo/gregory-henry.json" },
];

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  if (user.type !== "vip") {
    return new Response(JSON.stringify({ error: "VIP access required" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const trees = await Promise.all(TREE_CATALOG.map(async (tree) => {
    const head = await ctx.env.STORAGE.head(tree.storageKey);
    return {
      key: tree.key,
      name: tree.name,
      available: !!head,
    };
  }));

  return new Response(JSON.stringify({ trees }), {
    headers: { "Content-Type": "application/json" },
  });
};
