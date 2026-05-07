import type { Env, UserContext } from "../../_middleware";
import { visibleCatalogTrees } from "../catalog/_lib";
import { accessibleGedSourceIds, cleanTreeName, ensureGedcomMultiSourceSchema, normalizeEmail } from "../gedcom/_lib";

type TreeSelectionRef = {
  source_kind: string | null;
  catalog_key: string | null;
  tree_uuid: string | null;
  content_hash: string | null;
  owner_email: string | null;
  name: string;
  canonical_name: string;
};

type AccessibleTreeRef = TreeSelectionRef & {
  source_kind: "catalog" | "cloud";
};

type StoredSelectionRow = {
  refs_json: string;
  updated_at: number;
};

type SourceRefRow = {
  tree_uuid: string | null;
  content_hash: string | null;
  name: string | null;
  owner_email: string | null;
};

function json(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

async function ensureTreeSelectionSchema(env: Env): Promise<void> {
  await ensureGedcomMultiSourceSchema(env);
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS user_tree_selection (
      user_id TEXT PRIMARY KEY,
      refs_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `).run();
}

function normalizedHash(value: unknown): string | null {
  const hash = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : null;
}

function cleanString(value: unknown, max = 180): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim().slice(0, max);
}

function canonicalTreeName(value: unknown): string {
  return cleanTreeName(cleanString(value, 180)).toLowerCase().replace(/\s+/g, " ");
}

function normalizeTreeRef(value: unknown): TreeSelectionRef | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const name = cleanString(row.name, 180);
  const canonicalName = canonicalTreeName(row.canonical_name || name);
  const ref = {
    source_kind: cleanString(row.source_kind, 32).toLowerCase() || null,
    catalog_key: cleanString(row.catalog_key, 100) || null,
    tree_uuid: cleanString(row.tree_uuid, 100).toLowerCase() || null,
    content_hash: normalizedHash(row.content_hash),
    owner_email: normalizeEmail(cleanString(row.owner_email, 180)) || null,
    name,
    canonical_name: canonicalName,
  };
  return ref.tree_uuid || ref.catalog_key || ref.content_hash || ref.canonical_name ? ref : null;
}

function normalizeTreeRefs(values: unknown): TreeSelectionRef[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const refs: TreeSelectionRef[] = [];
  for (const item of values.slice(0, 50)) {
    const ref = normalizeTreeRef(item);
    if (!ref) continue;
    const key = [ref.tree_uuid, ref.catalog_key, ref.content_hash, ref.owner_email, ref.canonical_name].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

function parseStoredRefs(raw: string | null): TreeSelectionRef[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return normalizeTreeRefs(Array.isArray(parsed) ? parsed : parsed?.refs);
  } catch {
    return [];
  }
}

function accessibleRefMatches(input: TreeSelectionRef, allowed: AccessibleTreeRef): boolean {
  if (input.tree_uuid && allowed.tree_uuid && input.tree_uuid === allowed.tree_uuid) return true;
  if (input.catalog_key && allowed.catalog_key && input.catalog_key === allowed.catalog_key) return true;
  if (input.content_hash && allowed.content_hash && input.content_hash === allowed.content_hash) return true;
  if (!input.canonical_name || !allowed.canonical_name || input.canonical_name !== allowed.canonical_name) return false;
  if (input.owner_email && allowed.owner_email) return input.owner_email === allowed.owner_email;
  return true;
}

function stableRef(input: TreeSelectionRef, allowed: AccessibleTreeRef): TreeSelectionRef {
  return {
    source_kind: allowed.source_kind,
    catalog_key: allowed.catalog_key || input.catalog_key,
    tree_uuid: allowed.tree_uuid || input.tree_uuid,
    content_hash: allowed.content_hash || input.content_hash,
    owner_email: allowed.owner_email || input.owner_email,
    name: allowed.name || input.name,
    canonical_name: allowed.canonical_name || input.canonical_name,
  };
}

async function accessibleTreeRefs(env: Env, user: UserContext): Promise<AccessibleTreeRef[]> {
  const refs: AccessibleTreeRef[] = [];
  const catalog = await visibleCatalogTrees(env, user);
  for (const tree of catalog) {
    refs.push({
      source_kind: "catalog",
      catalog_key: tree.key,
      tree_uuid: tree.uuid.toLowerCase(),
      content_hash: null,
      owner_email: normalizeEmail(tree.ownerEmail) || null,
      name: tree.name,
      canonical_name: canonicalTreeName(tree.name),
    });
  }

  const ids = await accessibleGedSourceIds(env, user.id, user.email);
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    const rows = await env.DB.prepare(`
      SELECT tree_uuid, content_hash, name, owner_email
      FROM ged_sources
      WHERE id IN (${placeholders})
    `).bind(...ids).all<SourceRefRow>();
    for (const row of rows.results ?? []) {
      refs.push({
        source_kind: "cloud",
        catalog_key: null,
        tree_uuid: cleanString(row.tree_uuid, 100).toLowerCase() || null,
        content_hash: normalizedHash(row.content_hash),
        owner_email: normalizeEmail(row.owner_email) || null,
        name: cleanTreeName(row.name || ""),
        canonical_name: canonicalTreeName(row.name || ""),
      });
    }
  }
  return refs;
}

async function filterAccessibleRefs(env: Env, user: UserContext, refs: TreeSelectionRef[]): Promise<TreeSelectionRef[]> {
  const allowed = await accessibleTreeRefs(env, user);
  const filtered: TreeSelectionRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const match = allowed.find(candidate => accessibleRefMatches(ref, candidate));
    if (!match) continue;
    const stable = stableRef(ref, match);
    const key = [stable.tree_uuid, stable.catalog_key, stable.content_hash, stable.owner_email, stable.canonical_name].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    filtered.push(stable);
  }
  return filtered;
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  if (user.type === "anon") return json({ error: "Sign in required" }, { status: 401 });

  await ensureTreeSelectionSchema(ctx.env);
  const row = await ctx.env.DB.prepare(`
    SELECT refs_json, updated_at FROM user_tree_selection WHERE user_id = ?
  `).bind(user.id).first<StoredSelectionRow>();
  if (!row) return json({ ok: true, has_selection: false, refs: [] });

  const refs = await filterAccessibleRefs(ctx.env, user, parseStoredRefs(row.refs_json));
  return json({ ok: true, has_selection: true, refs, updated_at: row.updated_at });
};

export const onRequestPut: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  if (user.type === "anon") return json({ error: "Sign in required" }, { status: 401 });

  const body = await ctx.request.json().catch(() => ({}));
  const requested = normalizeTreeRefs((body as Record<string, unknown>)?.refs);
  await ensureTreeSelectionSchema(ctx.env);
  const refs = await filterAccessibleRefs(ctx.env, user, requested);
  const now = Math.floor(Date.now() / 1000);
  await ctx.env.DB.prepare(`
    INSERT INTO user_tree_selection (user_id, refs_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      refs_json = excluded.refs_json,
      updated_at = excluded.updated_at
  `).bind(user.id, JSON.stringify({ version: 1, refs }), now).run();
  return json({ ok: true, refs, ignored: requested.length - refs.length, updated_at: now });
};
