import type { Env, UserContext } from "../../_middleware";
import { canAccessCatalogTree, catalogTreeByShareKey } from "../catalog/_lib";
import { accessibleGedSourceIds, ensureGedcomMultiSourceSchema, normalizeEmail } from "../gedcom/_lib";

type TreeRefIn = {
  kind?: string | null;
  key?: string | null;
  source_id?: number | string | null;
  tree_uuid?: string | null;
  catalog_key?: string | null;
  content_hash?: string | null;
  name?: string | null;
};

type NormalizedTreeRef = {
  kind: "catalog" | "gedcom";
  key: string;
  tree_uuid: string | null;
  content_hash: string;
};

type CacheBody = {
  action?: string;
  tree_refs?: TreeRefIn[];
  tree_hash_key?: string;
  cache_key?: string;
  question?: string;
  answer?: string;
  model?: string;
  prompt_version?: string;
  analysis_version?: string;
  app_commit?: string;
  is_standard?: boolean;
  standard_questions?: string[];
  limit?: number;
};

type CacheRow = {
  cache_key: string;
  question: string;
  answer?: string | null;
  preview: string | null;
  answer_length: number | null;
  model: string | null;
  prompt_version: string | null;
  analysis_version: string | null;
  app_commit: string | null;
  is_standard: number;
  created_at: number;
  updated_at: number;
  hit_count: number;
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

function cleanText(value: unknown, max: number): string {
  return String(value || "").trim().slice(0, max);
}

function validSha256(value: unknown): string {
  const text = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : "";
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function ensureAiCacheSchema(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS ai_answer_cache (
        cache_key TEXT PRIMARY KEY,
        tree_hash_key TEXT NOT NULL,
        tree_refs_json TEXT NOT NULL,
        question_hash TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        preview TEXT,
        answer_length INTEGER NOT NULL,
        model TEXT,
        prompt_version TEXT,
        analysis_version TEXT,
        app_commit TEXT,
        is_standard INTEGER NOT NULL DEFAULT 0,
        created_by_user_id TEXT,
        created_by_email TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0,
        last_hit_at INTEGER
      )
    `),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS ai_answer_cache_tree ON ai_answer_cache(tree_hash_key, updated_at)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS ai_answer_cache_question ON ai_answer_cache(question_hash)`),
  ]);
}

async function normalizeTreeRefs(env: Env, user: UserContext, refs: TreeRefIn[]): Promise<NormalizedTreeRef[]> {
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > 8) {
    throw new Response(JSON.stringify({ error: "tree_refs required" }), { status: 422, headers: { "Content-Type": "application/json" } });
  }
  await ensureGedcomMultiSourceSchema(env);
  const allowedIds = user.type === "anon"
    ? new Set<number>()
    : new Set(await accessibleGedSourceIds(env, user.id, user.email));
  const out: NormalizedTreeRef[] = [];
  for (const raw of refs) {
    const declaredHash = validSha256(raw?.content_hash);
    const rawKind = String(raw?.kind || "").toLowerCase();
    const catalogKey = cleanText(raw?.catalog_key || (rawKind === "catalog" ? raw?.key : "") || raw?.tree_uuid, 120);
    const catalogTree = catalogKey ? catalogTreeByShareKey(catalogKey) : null;
    if (catalogTree || rawKind === "catalog") {
      const tree = catalogTree || catalogTreeByShareKey(cleanText(raw?.key || raw?.tree_uuid, 120));
      if (!tree) throw new Response(JSON.stringify({ error: "Unknown catalog tree" }), { status: 404, headers: { "Content-Type": "application/json" } });
      if (!(await canAccessCatalogTree(env, user, tree))) {
        throw new Response(JSON.stringify({ error: "Catalog tree not shared with this account" }), { status: 403, headers: { "Content-Type": "application/json" } });
      }
      if (!declaredHash) {
        throw new Response(JSON.stringify({ error: "Catalog tree content hash required" }), { status: 422, headers: { "Content-Type": "application/json" } });
      }
      out.push({ kind: "catalog", key: tree.key, tree_uuid: tree.uuid, content_hash: declaredHash });
      continue;
    }

    if (user.type === "anon") {
      throw new Response(JSON.stringify({ error: "Sign in required for saved-tree cache access" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    const sourceId = Number(raw?.source_id || (/^\d+$/.test(String(raw?.key || "")) ? raw?.key : 0));
    const treeUuid = cleanText(raw?.tree_uuid || (!sourceId ? raw?.key : ""), 120);
    const row = sourceId > 0
      ? await env.DB.prepare(`SELECT id, tree_uuid, content_hash FROM ged_sources WHERE id = ?`).bind(sourceId).first<{ id: number; tree_uuid: string | null; content_hash: string | null }>()
      : await env.DB.prepare(`SELECT id, tree_uuid, content_hash FROM ged_sources WHERE tree_uuid = ?`).bind(treeUuid).first<{ id: number; tree_uuid: string | null; content_hash: string | null }>();
    if (!row || !allowedIds.has(row.id)) {
      throw new Response(JSON.stringify({ error: "Tree not found or not shared with this account" }), { status: 404, headers: { "Content-Type": "application/json" } });
    }
    const actualHash = validSha256(row.content_hash) || declaredHash;
    if (!actualHash) {
      throw new Response(JSON.stringify({ error: "Saved tree content hash required" }), { status: 422, headers: { "Content-Type": "application/json" } });
    }
    if (declaredHash && declaredHash !== actualHash) {
      throw new Response(JSON.stringify({ error: "Tree content hash does not match server record" }), { status: 409, headers: { "Content-Type": "application/json" } });
    }
    out.push({ kind: "gedcom", key: String(row.id), tree_uuid: row.tree_uuid, content_hash: actualHash });
  }
  out.sort((a, b) => a.content_hash.localeCompare(b.content_hash) || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
  return out;
}

async function verifiedTreeHashKey(env: Env, user: UserContext, body: CacheBody): Promise<{ treeHashKey: string; refs: NormalizedTreeRef[] }> {
  const refs = await normalizeTreeRefs(env, user, body.tree_refs || []);
  const treeHashKey = await sha256Hex(JSON.stringify(refs.map(ref => ref.content_hash)));
  const provided = validSha256(body.tree_hash_key);
  if (provided && provided !== treeHashKey) {
    throw new Response(JSON.stringify({ error: "tree_hash_key does not match tree_refs" }), { status: 409, headers: { "Content-Type": "application/json" } });
  }
  return { treeHashKey, refs };
}

function publicEntry(row: CacheRow, includeAnswer: boolean) {
  return {
    cache_key: row.cache_key,
    question: row.question,
    preview: row.preview || "",
    answer: includeAnswer ? row.answer || "" : undefined,
    answer_length: row.answer_length || 0,
    model: row.model,
    prompt_version: row.prompt_version,
    analysis_version: row.analysis_version,
    app_commit: row.app_commit,
    is_standard: !!row.is_standard,
    created_at: row.created_at,
    updated_at: row.updated_at,
    hit_count: row.hit_count || 0,
  };
}

async function handleIndex(env: Env, user: UserContext, body: CacheBody) {
  const { treeHashKey } = await verifiedTreeHashKey(env, user, body);
  const limit = Math.max(1, Math.min(100, Number(body.limit) || 40));
  const model = cleanText(body.model, 80);
  const promptVersion = cleanText(body.prompt_version, 120);
  const analysisVersion = cleanText(body.analysis_version, 120);
  const appCommit = cleanText(body.app_commit, 80);
  const standardQuestions = new Set((body.standard_questions || []).map(q => cleanText(q, 1000)));
  const now = Math.floor(Date.now() / 1000);
  const rows = await env.DB.prepare(`
    SELECT cache_key, question,
           CASE WHEN is_standard = 1 AND answer_length <= 4000 AND updated_at >= ? THEN answer ELSE NULL END AS answer,
           preview, answer_length, model, prompt_version, analysis_version, app_commit, is_standard,
           created_at, updated_at, hit_count
    FROM ai_answer_cache
    WHERE tree_hash_key = ?
      AND (? = '' OR model = ?)
      AND (? = '' OR prompt_version = ?)
      AND (? = '' OR analysis_version = ?)
      AND (? = '' OR app_commit = ?)
    ORDER BY updated_at DESC
    LIMIT ?
  `).bind(now - 30 * 86400, treeHashKey, model, model, promptVersion, promptVersion, analysisVersion, analysisVersion, appCommit, appCommit, limit).all<CacheRow>();
  return json({
    ok: true,
    tree_hash_key: treeHashKey,
    entries: (rows.results ?? []).map(row => publicEntry(row, !!row.answer && standardQuestions.has(row.question))),
  });
}

async function handleGet(env: Env, user: UserContext, body: CacheBody) {
  const { treeHashKey } = await verifiedTreeHashKey(env, user, body);
  const cacheKey = validSha256(body.cache_key);
  if (!cacheKey) return json({ error: "cache_key required" }, { status: 422 });
  const row = await env.DB.prepare(`
    SELECT cache_key, question, answer, preview, answer_length, model, prompt_version, analysis_version, app_commit, is_standard,
           created_at, updated_at, hit_count
    FROM ai_answer_cache
    WHERE cache_key = ? AND tree_hash_key = ?
  `).bind(cacheKey, treeHashKey).first<CacheRow>();
  if (!row) return json({ found: false }, { status: 404 });
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`UPDATE ai_answer_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE cache_key = ?`)
    .bind(now, cacheKey)
    .run();
  return json({ ok: true, found: true, entry: publicEntry({ ...row, hit_count: (row.hit_count || 0) + 1 }, true) });
}

async function handlePut(env: Env, user: UserContext, body: CacheBody) {
  if (user.type === "anon") return json({ error: "Sign in required to save shared AI answers" }, { status: 401 });
  const { treeHashKey, refs } = await verifiedTreeHashKey(env, user, body);
  const cacheKey = validSha256(body.cache_key);
  const question = cleanText(body.question, 2000);
  const answer = cleanText(body.answer, 50000);
  if (!cacheKey || !question || !answer) return json({ error: "cache_key, question, and answer required" }, { status: 422 });
  const questionHash = await sha256Hex(question.toLowerCase().replace(/\s+/g, " ").trim());
  const now = Math.floor(Date.now() / 1000);
  const preview = answer.replace(/\s+/g, " ").trim().slice(0, 260);
  await env.DB.prepare(`
    INSERT INTO ai_answer_cache (
      cache_key, tree_hash_key, tree_refs_json, question_hash, question, answer, preview, answer_length,
      model, prompt_version, analysis_version, app_commit, is_standard,
      created_by_user_id, created_by_email, created_at, updated_at, hit_count
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(cache_key) DO UPDATE SET
      answer = excluded.answer,
      preview = excluded.preview,
      answer_length = excluded.answer_length,
      model = excluded.model,
      prompt_version = excluded.prompt_version,
      analysis_version = excluded.analysis_version,
      app_commit = excluded.app_commit,
      is_standard = excluded.is_standard,
      updated_at = excluded.updated_at
  `).bind(
    cacheKey,
    treeHashKey,
    JSON.stringify(refs),
    questionHash,
    question,
    answer,
    preview,
    answer.length,
    cleanText(body.model, 80),
    cleanText(body.prompt_version, 120),
    cleanText(body.analysis_version, 120),
    cleanText(body.app_commit, 80),
    body.is_standard ? 1 : 0,
    user.id,
    normalizeEmail(user.email),
    now,
    now,
  ).run();
  return json({ ok: true, cache_key: cacheKey, tree_hash_key: treeHashKey });
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  let body: CacheBody;
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }
  const user = ctx.data.user as UserContext;
  await ensureAiCacheSchema(ctx.env);
  try {
    const action = String(body.action || "index").toLowerCase();
    if (action === "index") return await handleIndex(ctx.env, user, body);
    if (action === "get") return await handleGet(ctx.env, user, body);
    if (action === "put") return await handlePut(ctx.env, user, body);
    return json({ error: "Unknown cache action" }, { status: 422 });
  } catch (e) {
    if (e instanceof Response) return e;
    return json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
};
