import type { AuthDiagnostics, Env, UserContext } from "../../_middleware";
import { visibleCatalogTrees } from "./_lib";

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  const auth = ctx.data.auth as AuthDiagnostics | undefined;

  const visibleCatalog = await visibleCatalogTrees(ctx.env, user);
  const trees = await Promise.all(visibleCatalog.map(async (tree) => {
    const head = tree.publicDemo
      ? await ctx.env.STORAGE.head(tree.storageKey) ?? await ctx.env.STORAGE.head("demo/golden-rosenberg.json")
      : await ctx.env.STORAGE.head(tree.storageKey);
    const uploaded = head?.uploaded ? new Date(head.uploaded).getTime() : NaN;
    return {
      kind: "catalog",
      key: tree.key,
      tree_uuid: tree.uuid,
      name: tree.name,
      owner_email: tree.ownerEmail,
      relation: tree.relation,
      public: tree.access === "public",
      content_etag: head?.httpEtag || head?.etag || null,
      content_changed_at: Number.isFinite(uploaded) ? Math.floor(uploaded / 1000) : null,
      available: !!head,
    };
  }));

  return new Response(JSON.stringify({ trees, user: { type: user.type, email: user.email ?? null }, auth: auth ?? null }), {
    headers: { "Content-Type": "application/json" },
  });
};
