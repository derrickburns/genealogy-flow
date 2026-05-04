import type { Env, UserContext } from "../../_middleware";
import { CATALOG_TREES, catalogTreeByShareKey, isCatalogOwner } from "../catalog/_lib";
import { cleanTreeName, ensureGedcomMultiSourceSchema, normalizeEmail } from "./_lib";

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

type ShareableTree = {
  kind: string;
  key: string;
  source_id?: number;
  tree_uuid?: string | null;
  name: string;
  owner_email?: string | null;
  owner_uuid?: string | null;
  content_hash?: string | null;
  uploaded_at?: number | null;
  content_changed_at?: number | null;
  top_pci_id?: string | null;
  top_pci_name?: string | null;
  top_pci_score?: number | null;
};

function treeDisplayName(tree: ShareableTree | null): string {
  return cleanTreeName(tree?.name || tree?.key || "a family tree");
}

function inviteAppUrl(env: Env): string {
  const origin = typeof env.APP_ORIGIN === "string" && env.APP_ORIGIN.trim()
    ? env.APP_ORIGIN.trim()
    : "https://flow.kindredsearch.com";
  return origin.replace(/\/+$/, "");
}

async function sendShareInviteEmail(env: Env, params: {
  to: string;
  ownerEmail: string;
  treeName: string;
}): Promise<{ sent: boolean; skipped?: string; error?: string }> {
  const apiKey = typeof env.RESEND_API_KEY === "string" ? env.RESEND_API_KEY.trim() : "";
  if (!apiKey) return { sent: false, skipped: "RESEND_API_KEY is not configured" };
  const from = typeof env.INVITE_FROM_EMAIL === "string" && env.INVITE_FROM_EMAIL.trim()
    ? env.INVITE_FROM_EMAIL.trim()
    : typeof env.REPORT_FROM_EMAIL === "string" && env.REPORT_FROM_EMAIL.trim()
      ? env.REPORT_FROM_EMAIL.trim()
      : "";
  if (!from) {
    return {
      sent: false,
      error: "Email sender is not configured. Set INVITE_FROM_EMAIL or REPORT_FROM_EMAIL to a Resend-verified sender address.",
    };
  }
  const appUrl = inviteAppUrl(env);
  const subject = `${params.ownerEmail} shared a Kindred Flow tree with you`;
  const text = [
    `${params.ownerEmail} shared "${params.treeName}" with you in Kindred Flow.`,
    "",
    "Kindred Flow maps family history through time, showing where people lived, how families moved, and how branches cluster by place, tree, and relationship.",
    "",
    `Open Kindred Flow and sign in with this email address to see the shared tree: ${appUrl}`,
  ].join("\n");
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#142033">
      <h2 style="margin:0 0 12px">A Kindred Flow tree was shared with you</h2>
      <p><strong>${params.ownerEmail}</strong> shared <strong>${params.treeName}</strong> with you.</p>
      <p>Kindred Flow maps family history through time, showing where people lived, how families moved, and how branches cluster by place, tree, and relationship.</p>
      <p><a href="${appUrl}" style="display:inline-block;background:#183b7a;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px;font-weight:700">Open Kindred Flow</a></p>
      <p style="color:#64748b;font-size:13px">Sign in with ${params.to} to access the shared tree.</p>
    </div>`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: params.to, subject, text, html }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { sent: false, error: `Resend ${r.status}${body ? `: ${body.slice(0, 300)}` : ""}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function ownedGedcomTrees(env: Env, user: UserContext) {
  const rows = await env.DB.prepare(`
    SELECT id, tree_uuid, name, owner_email, owner_uuid, content_hash, uploaded_at, content_changed_at,
           top_pci_id, top_pci_name, top_pci_score
    FROM ged_sources
    WHERE user_id = ? OR owner_user_id = ? OR lower(COALESCE(owner_email, '')) = ?
    ORDER BY loaded_at ASC, id ASC
  `).bind(user.id, user.id, normalizeEmail(user.email)).all<{
    id: number; tree_uuid: string | null; name: string; owner_email: string | null; owner_uuid: string | null;
    content_hash: string | null; uploaded_at: number | null; content_changed_at: number | null; top_pci_id: string | null; top_pci_name: string | null; top_pci_score: number | null;
  }>();
  return (rows.results ?? []).map(row => ({
    kind: "gedcom",
    key: String(row.id),
    source_id: row.id,
    tree_uuid: row.tree_uuid,
    name: row.name,
    owner_email: row.owner_email ?? user.email ?? "",
    owner_uuid: row.owner_uuid,
    content_hash: row.content_hash,
    uploaded_at: row.uploaded_at,
    content_changed_at: row.content_changed_at,
    top_pci_id: row.top_pci_id,
    top_pci_name: row.top_pci_name,
    top_pci_score: row.top_pci_score,
  }));
}

async function ownedShareableTrees(env: Env, user: UserContext) {
  const ownedCatalog = CATALOG_TREES
    .filter(tree => !tree.publicDemo && isCatalogOwner(tree, user.email))
    .map(tree => ({
      kind: "catalog",
      key: tree.key,
      catalog_key: tree.key,
      tree_uuid: tree.uuid,
      name: tree.name,
      owner_email: tree.ownerEmail,
    }));
  return [...ownedCatalog, ...(await ownedGedcomTrees(env, user))];
}

async function shareableTreeByKey(env: Env, user: UserContext, kind: string, key: string): Promise<ShareableTree | null> {
  const owned = await ownedShareableTrees(env, user);
  return owned.find(tree => tree.kind === kind && (tree.key === key || (tree.kind === "gedcom" && tree.tree_uuid === key))) ?? null;
}

async function sharesForOwned(env: Env, owned: Array<{ kind: string; key: string; tree_uuid?: string | null }>) {
  if (!owned.length) return new Map<string, ShareRow[]>();
  const clauses = owned.map(tree => tree.kind === "gedcom" && tree.tree_uuid
    ? `(tree_kind = ? AND (tree_key = ? OR tree_key = ?))`
    : `(tree_kind = ? AND tree_key = ?)`).join(" OR ");
  const params = owned.flatMap(tree => tree.kind === "gedcom" && tree.tree_uuid
    ? [tree.kind, tree.key, tree.tree_uuid]
    : [tree.kind, tree.key]);
  const rows = await env.DB.prepare(`
    SELECT tree_kind, tree_key, shared_with_email, created_at
    FROM tree_shares
    WHERE ${clauses}
    ORDER BY shared_with_email ASC
  `).bind(...params).all<ShareRow>();
  const out = new Map<string, ShareRow[]>();
  for (const row of rows.results ?? []) {
    const ownedTree = owned.find(tree =>
      tree.kind === row.tree_kind &&
      (tree.key === row.tree_key || (tree.kind === "gedcom" && tree.tree_uuid && tree.tree_uuid === row.tree_key))
    );
    const key = `${row.tree_kind}:${ownedTree?.key || row.tree_key}`;
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
    const tree = catalogTreeByShareKey(key);
    return !!tree && !tree.publicDemo && isCatalogOwner(tree, user.email);
  }
  if (kind !== "gedcom") return false;
  const row = await env.DB.prepare(`
    SELECT id FROM ged_sources
    WHERE id = ?
      AND (user_id = ? OR owner_user_id = ? OR lower(COALESCE(owner_email, '')) = ?)
  `).bind(Number(key) || -1, user.id, user.id, normalizeEmail(user.email)).first<{ id: number }>();
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

  let body: { action?: string; kind?: string; key?: string; email?: string; name?: string };
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }
  const kind = String(body.kind || "").trim();
  let key = String(body.key || "").trim();
  const email = normalizeEmail(body.email);
  const action = body.action === "remove" ? "remove" : body.action === "rename" ? "rename" : "add";
  if (!kind || !key) return json({ error: "kind and key required" }, { status: 422 });
  if (kind === "catalog") {
    const tree = catalogTreeByShareKey(key);
    if (tree) key = tree.key;
  }
  if (!(await canManageTree(ctx.env, user, kind, key))) return json({ error: "Only the tree owner can manage sharing" }, { status: 403 });

  if (action === "rename") {
    if (kind !== "gedcom") return json({ error: "Only saved trees can be renamed" }, { status: 422 });
    const name = cleanTreeName(body.name);
    if (!name) return json({ error: "Tree name is required" }, { status: 422 });
    try {
      await ctx.env.DB.prepare(`UPDATE ged_sources SET name = ? WHERE id = ?`)
        .bind(name, Number(key) || -1)
        .run();
    } catch {
      return json({ error: "A tree with that name already exists for this account" }, { status: 409 });
    }
  } else if (action === "remove") {
    if (!email) return json({ error: "email required" }, { status: 422 });
    if (!validShareEmail(email)) return json({ error: "Enter a valid email address" }, { status: 422 });
    await ctx.env.DB.prepare(`
      DELETE FROM tree_shares
      WHERE tree_kind = ? AND tree_key = ? AND shared_with_email = ?
    `).bind(kind, key, email).run();
  } else {
    if (!email) return json({ error: "email required" }, { status: 422 });
    if (!validShareEmail(email)) return json({ error: "Enter a valid email address" }, { status: 422 });
    const result = await ctx.env.DB.prepare(`
      INSERT OR IGNORE INTO tree_shares (tree_kind, tree_key, owner_email, shared_with_email, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(kind, key, user.email ?? user.id, email, Math.floor(Date.now() / 1000)).run();
    const changed = Number(result.meta?.changes ?? 0) > 0;
    const tree = await shareableTreeByKey(ctx.env, user, kind, key);
    const emailResult = changed
      ? await sendShareInviteEmail(ctx.env, {
        to: email,
        ownerEmail: user.email ?? user.id,
        treeName: treeDisplayName(tree),
      })
      : { sent: false, skipped: "share already existed" };
    const state = await responseState(ctx.env, user);
    return json({ ...state, invite_email: emailResult });
  }
  return json(await responseState(ctx.env, user));
};
