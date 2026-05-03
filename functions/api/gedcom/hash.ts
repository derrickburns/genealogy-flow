import type { Env, UserContext } from "../../_middleware";
import { canAccessCatalogTree, CATALOG_TREES } from "../catalog/_lib";
import { accessibleGedSourceIds, computeGedcomContentHash, ensureGedcomMultiSourceSchema, normalizeEmail } from "./_lib";

type SourceHashRow = {
  id: number;
  tree_uuid: string | null;
  name: string;
  user_id: string;
  owner_user_id: string | null;
  owner_email: string | null;
  owner_uuid: string | null;
  content_hash: string | null;
  uploaded_at: number | null;
  top_pci_id: string | null;
  top_pci_name: string | null;
  top_pci_score: number | null;
  is_default: number;
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

function validHash(value: string): string {
  const hash = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : "";
}

async function catalogMatches(env: Env, user: UserContext, hash: string) {
  const out = [];
  for (const tree of CATALOG_TREES) {
    if (!(await canAccessCatalogTree(env, user, tree))) continue;
    const obj = await env.STORAGE.get(tree.storageKey);
    if (!obj) continue;
    let parsed: { individuals?: unknown; families?: unknown };
    try {
      parsed = JSON.parse(await obj.text());
    } catch {
      continue;
    }
    const treeHash = await computeGedcomContentHash(
      Array.isArray(parsed.individuals) ? parsed.individuals as never[] : [],
      Array.isArray(parsed.families) ? parsed.families as never[] : [],
    );
    if (treeHash !== hash) continue;
    out.push({
      kind: "catalog",
      key: tree.key,
      tree_uuid: tree.uuid,
      content_hash: treeHash,
      name: tree.name,
      owner_email: tree.ownerEmail,
      owner_uuid: null,
      relation: tree.access === "public" ? "public" : "shared",
      public: tree.access === "public",
      available: true,
    });
  }
  return out;
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  if (user.type === "anon") return json({ error: "Sign in required" }, { status: 401 });

  const hash = validHash(new URL(ctx.request.url).searchParams.get("hash") || "");
  if (!hash) return json({ error: "Valid content hash required" }, { status: 422 });

  await ensureGedcomMultiSourceSchema(ctx.env);
  const allowedIds = new Set(await accessibleGedSourceIds(ctx.env, user.id, user.email));
  const rows = await ctx.env.DB.prepare(`
    SELECT id, tree_uuid, name, user_id, owner_user_id, owner_email, owner_uuid, content_hash,
           uploaded_at, top_pci_id, top_pci_name, top_pci_score, is_default
    FROM ged_sources
    WHERE content_hash = ?
    ORDER BY uploaded_at DESC, loaded_at DESC, id ASC
  `).bind(hash).all<SourceHashRow>();
  const email = normalizeEmail(user.email);
  const cloudMatches = (rows.results ?? [])
    .filter(row => allowedIds.has(row.id))
    .map(row => {
      const owned = row.user_id === user.id || row.owner_user_id === user.id || normalizeEmail(row.owner_email) === email;
      return {
        kind: "cloud",
        key: String(row.id),
        source_id: row.id,
        tree_uuid: row.tree_uuid,
        content_hash: row.content_hash,
        name: row.name,
        owner_email: row.owner_email,
        owner_uuid: row.owner_uuid,
        uploaded_at: row.uploaded_at,
        top_pci_id: row.top_pci_id,
        top_pci_name: row.top_pci_name,
        top_pci_score: row.top_pci_score,
        is_default: !!row.is_default,
        relation: owned ? "owned" : "shared",
        available: true,
      };
    });
  const catalog = await catalogMatches(ctx.env, user, hash);
  return json({
    ok: true,
    content_hash: hash,
    exists: cloudMatches.length > 0 || catalog.length > 0,
    trees: [...catalog, ...cloudMatches],
  });
};
