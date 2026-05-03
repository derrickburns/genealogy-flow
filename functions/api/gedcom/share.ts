import type { Env, UserContext } from "../../_middleware";
import { CATALOG_TREES, isCatalogOwner } from "../catalog/_lib";
import { ensureGedcomMultiSourceSchema, normalizeEmail } from "./_lib";

type ShareRow = {
  tree_kind: string;
  tree_key: string;
  shared_with_email: string;
  created_at: number;
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

function validShareEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

async function ownedGedcomTrees(env: Env, user: UserContext) {
  const rows = await env.DB.prepare(`
    SELECT id, name, owner_email
    FROM ged_sources
    WHERE user_id = ? OR owner_user_id = ? OR lower(COALESCE(owner_email, '')) = ?
    ORDER BY loaded_at ASC, id ASC
  `).bind(user.id, user.id, normalizeEmail(user.email)).all<{ id: number; name: string; owner_email: string | null }>();
  return (rows.results ?? []).map(row => ({
    kind: "gedcom",
    key: String(row.id),
    name: row.name,
    owner_email: row.owner_email ?? user.email ?? "",
  }));
}

async function ownedShareableTrees(env: Env, user: UserContext) {
  const ownedCatalog = CATALOG_TREES
    .filter(tree => !tree.publicDemo && isCatalogOwner(tree, user.email))
    .map(tree => ({
      kind: "catalog",
      key: tree.key,
      name: tree.name,
      owner_email: tree.ownerEmail,
    }));
  return [...ownedCatalog, ...(await ownedGedcomTrees(env, user))];
}

async function sharesForOwned(env: Env, owned: Array<{ kind: string; key: string }>) {
  if (!owned.length) return new Map<string, ShareRow[]>();
  const clauses = owned.map(() => `(tree_kind = ? AND tree_key = ?)`).join(" OR ");
  const params = owned.flatMap(tree => [tree.kind, tree.key]);
  const rows = await env.DB.prepare(`
    SELECT tree_kind, tree_key, shared_with_email, created_at
    FROM tree_shares
    WHERE ${clauses}
    ORDER BY shared_with_email ASC
  `).bind(...params).all<ShareRow>();
  const out = new Map<string, ShareRow[]>();
  for (const row of rows.results ?? []) {
    const key = `${row.tree_kind}:${row.tree_key}`;
    const arr = out.get(key) ?? [];
    arr.push(row);
    out.set(key, arr);
  }
  return out;
}

async function responseState(env: Env, user: UserContext) {
  const owned = await ownedShareableTrees(env, user);
  const shares = await sharesForOwned(env, owned);
  return {
    trees: owned.map(tree => ({
      ...tree,
      shares: (shares.get(`${tree.kind}:${tree.key}`) ?? []).map(row => ({
        email: row.shared_with_email,
        created_at: row.created_at,
      })),
    })),
  };
}

async function canManageTree(env: Env, user: UserContext, kind: string, key: string): Promise<boolean> {
  if (kind === "catalog") {
    const tree = CATALOG_TREES.find(t => t.key === key);
    return !!tree && !tree.publicDemo && isCatalogOwner(tree, user.email);
  }
  if (kind !== "gedcom") return false;
  const row = await env.DB.prepare(`
    SELECT id FROM ged_sources
    WHERE id = ? AND (user_id = ? OR owner_user_id = ? OR lower(COALESCE(owner_email, '')) = ?)
  `).bind(Number(key), user.id, user.id, normalizeEmail(user.email)).first<{ id: number }>();
  return !!row;
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  if (user.type === "anon") return json({ trees: [] }, { status: 401 });
  await ensureGedcomMultiSourceSchema(ctx.env);
  return json(await responseState(ctx.env, user));
};

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  if (user.type === "anon") return json({ error: "Sign in required" }, { status: 401 });
  await ensureGedcomMultiSourceSchema(ctx.env);

  let body: { action?: string; kind?: string; key?: string; email?: string };
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }
  const kind = String(body.kind || "").trim();
  const key = String(body.key || "").trim();
  const email = normalizeEmail(body.email);
  const action = body.action === "remove" ? "remove" : "add";
  if (!kind || !key || !email) return json({ error: "kind, key, and email required" }, { status: 422 });
  if (!validShareEmail(email)) return json({ error: "Enter a valid email address" }, { status: 422 });
  if (!(await canManageTree(ctx.env, user, kind, key))) return json({ error: "Only the tree owner can manage sharing" }, { status: 403 });

  if (action === "remove") {
    await ctx.env.DB.prepare(`
      DELETE FROM tree_shares
      WHERE tree_kind = ? AND tree_key = ? AND shared_with_email = ?
    `).bind(kind, key, email).run();
  } else {
    await ctx.env.DB.prepare(`
      INSERT OR IGNORE INTO tree_shares (tree_kind, tree_key, owner_email, shared_with_email, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(kind, key, user.email ?? user.id, email, Math.floor(Date.now() / 1000)).run();
  }
  return json(await responseState(ctx.env, user));
};
