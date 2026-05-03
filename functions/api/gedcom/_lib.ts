import type { Env } from "../../_middleware";

const INITIAL_ARCHER_SHARED_WITH = [
  "derrickrburns@gmail.com",
  "ginagregoryburns@gmail.com",
  "f.d.gregory@att.net",
];

export const DEFAULT_TREE_OWNER_EMAIL = "derrickrburns@gmail.com";
export const CATALOG_ARCHER_TREE_UUID = "14d2dad8-3582-49c2-b439-99aa30d4370b";

export function normalizeEmail(email: string | undefined | null): string {
  return String(email || "").trim().toLowerCase();
}

function uuid(): string {
  return crypto.randomUUID();
}

export async function ensureUserIdentitySchema(env: Env): Promise<void> {
  const cols = await env.DB.prepare(`PRAGMA table_info(users)`).all<{ name: string }>();
  const names = new Set((cols.results ?? []).map(c => c.name));
  if (!names.has("owner_uuid")) {
    await env.DB.prepare(`ALTER TABLE users ADD COLUMN owner_uuid TEXT`).run();
  }

  const missing = await env.DB.prepare(`
    SELECT user_id FROM users WHERE owner_uuid IS NULL OR owner_uuid = ''
  `).all<{ user_id: string }>();
  for (const row of missing.results ?? []) {
    await env.DB.prepare(`UPDATE users SET owner_uuid = ? WHERE user_id = ?`)
      .bind(uuid(), row.user_id)
      .run();
  }

  await env.DB.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_owner_uuid ON users(owner_uuid) WHERE owner_uuid IS NOT NULL
  `).run();
}

export async function getOrCreateOwnerUuid(
  env: Env,
  userId: string,
  email: string | undefined,
): Promise<string> {
  await ensureUserIdentitySchema(env);
  const now = Math.floor(Date.now() / 1000);
  const ownerUuid = uuid();
  await env.DB.prepare(`
    INSERT INTO users (user_id, email, owner_uuid, last_login, gedcom_expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      email = excluded.email,
      last_login = excluded.last_login,
      owner_uuid = COALESCE(users.owner_uuid, excluded.owner_uuid)
  `)
    .bind(userId, email || userId, ownerUuid, now, now + 7 * 86400, now)
    .run();
  const row = await env.DB.prepare(`SELECT owner_uuid FROM users WHERE user_id = ?`)
    .bind(userId)
    .first<{ owner_uuid: string | null }>();
  return row?.owner_uuid || ownerUuid;
}

export async function ensureGedcomMultiSourceSchema(env: Env): Promise<void> {
  await ensureUserIdentitySchema(env);
  await env.DB.batch([
    env.DB.prepare(`DROP INDEX IF EXISTS ged_sources_user`),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS tree_shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tree_kind TEXT NOT NULL,
        tree_key TEXT NOT NULL,
        owner_email TEXT NOT NULL,
        shared_with_email TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS tree_shares_unique ON tree_shares(tree_kind, tree_key, shared_with_email)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS tree_shares_shared_with ON tree_shares(shared_with_email)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS tree_shares_tree ON tree_shares(tree_kind, tree_key)`),
  ]);

  const cols = await env.DB.prepare(`PRAGMA table_info(ged_sources)`).all<{ name: string }>();
  const names = new Set((cols.results ?? []).map(c => c.name));
  if (!names.has("is_default")) {
    await env.DB.prepare(`ALTER TABLE ged_sources ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0`).run();
  }
  if (!names.has("owner_user_id")) {
    await env.DB.prepare(`ALTER TABLE ged_sources ADD COLUMN owner_user_id TEXT`).run();
  }
  if (!names.has("owner_email")) {
    await env.DB.prepare(`ALTER TABLE ged_sources ADD COLUMN owner_email TEXT`).run();
  }
  if (!names.has("owner_uuid")) {
    await env.DB.prepare(`ALTER TABLE ged_sources ADD COLUMN owner_uuid TEXT`).run();
  }
  if (!names.has("tree_uuid")) {
    await env.DB.prepare(`ALTER TABLE ged_sources ADD COLUMN tree_uuid TEXT`).run();
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE ged_sources SET owner_user_id = user_id WHERE owner_user_id IS NULL OR owner_user_id = ''`),
    env.DB.prepare(`
      UPDATE ged_sources
      SET owner_email = COALESCE((SELECT email FROM users WHERE users.user_id = ged_sources.user_id), user_id)
      WHERE owner_email IS NULL OR owner_email = ''
    `),
    env.DB.prepare(`
      UPDATE ged_sources
      SET owner_uuid = (SELECT owner_uuid FROM users WHERE users.user_id = ged_sources.owner_user_id)
      WHERE owner_uuid IS NULL OR owner_uuid = ''
    `),
  ]);

  const missingOwners = await env.DB.prepare(`
    SELECT id FROM ged_sources WHERE owner_uuid IS NULL OR owner_uuid = ''
  `).all<{ id: number }>();
  for (const row of missingOwners.results ?? []) {
    await env.DB.prepare(`UPDATE ged_sources SET owner_uuid = ? WHERE id = ?`)
      .bind(uuid(), row.id)
      .run();
  }

  const missingTrees = await env.DB.prepare(`
    SELECT id FROM ged_sources WHERE tree_uuid IS NULL OR tree_uuid = ''
  `).all<{ id: number }>();
  for (const row of missingTrees.results ?? []) {
    await env.DB.prepare(`UPDATE ged_sources SET tree_uuid = ? WHERE id = ?`)
      .bind(uuid(), row.id)
      .run();
  }

  await env.DB.batch([
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS ged_sources_tree_uuid ON ged_sources(tree_uuid) WHERE tree_uuid IS NOT NULL`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS ged_sources_owner_uuid_name ON ged_sources(owner_uuid, name) WHERE owner_uuid IS NOT NULL`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS ged_sources_user_name ON ged_sources(user_id, name)`),
  ]);

  await env.DB.prepare(`
    INSERT OR IGNORE INTO tree_shares (tree_kind, tree_key, owner_email, shared_with_email, created_at)
    SELECT 'gedcom', s.tree_uuid, sh.owner_email, sh.shared_with_email, sh.created_at
    FROM tree_shares sh
    JOIN ged_sources s ON sh.tree_kind = 'gedcom' AND sh.tree_key = CAST(s.id AS TEXT)
    WHERE s.tree_uuid IS NOT NULL AND s.tree_uuid <> ''
  `).run();

  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch(INITIAL_ARCHER_SHARED_WITH.map(email =>
    env.DB.prepare(`
      INSERT OR IGNORE INTO tree_shares (tree_kind, tree_key, owner_email, shared_with_email, created_at)
      VALUES ('catalog', 'archer', ?, ?, ?)
    `).bind(DEFAULT_TREE_OWNER_EMAIL, normalizeEmail(email), now)
  ));
  await env.DB.batch(INITIAL_ARCHER_SHARED_WITH.map(email =>
    env.DB.prepare(`
      INSERT OR IGNORE INTO tree_shares (tree_kind, tree_key, owner_email, shared_with_email, created_at)
      VALUES ('catalog', ?, ?, ?, ?)
    `).bind(CATALOG_ARCHER_TREE_UUID, DEFAULT_TREE_OWNER_EMAIL, normalizeEmail(email), now)
  ));
}

export async function deleteAllUserGedcomData(env: Env, userId: string): Promise<void> {
  await ensureGedcomMultiSourceSchema(env);
  const rows = await env.DB.prepare(`SELECT id, tree_uuid FROM ged_sources WHERE user_id = ?`).bind(userId).all<{ id: number; tree_uuid: string | null }>();
  const ids = (rows.results ?? []).map(r => r.id);
  if (!ids.length) return;
  const stmts = [];
  for (const row of rows.results ?? []) {
    const id = row.id;
    stmts.push(
      env.DB.prepare(`DELETE FROM ged_family_children WHERE source_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM ged_families WHERE source_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM ged_events WHERE source_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM ged_individuals WHERE source_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM tree_shares WHERE tree_kind = 'gedcom' AND tree_key = ?`).bind(String(id)),
      env.DB.prepare(`DELETE FROM tree_shares WHERE tree_kind = 'gedcom' AND tree_key = ?`).bind(row.tree_uuid || ""),
      env.DB.prepare(`DELETE FROM ged_sources WHERE id = ?`).bind(id),
    );
  }
  await env.DB.batch(stmts);
}

export async function accessibleGedSourceIds(env: Env, userId: string, email: string | undefined): Promise<number[]> {
  await ensureGedcomMultiSourceSchema(env);
  const normalized = normalizeEmail(email);
  const rows = await env.DB.prepare(`
    SELECT s.id
    FROM ged_sources s
    WHERE s.user_id = ?
       OR s.owner_user_id = ?
       OR lower(COALESCE(s.owner_email, '')) = ?
       OR EXISTS (
         SELECT 1 FROM tree_shares sh
         WHERE sh.tree_kind = 'gedcom'
           AND (sh.tree_key = s.tree_uuid OR sh.tree_key = CAST(s.id AS TEXT))
           AND sh.shared_with_email = ?
       )
    ORDER BY s.is_default DESC, s.loaded_at ASC, s.id ASC
  `).bind(userId, userId, normalized, normalized).all<{ id: number }>();
  return (rows.results ?? []).map(r => r.id);
}

export async function canAccessGedSource(env: Env, sourceId: number, userId: string, email: string | undefined): Promise<boolean> {
  const allowed = await accessibleGedSourceIds(env, userId, email);
  return allowed.includes(sourceId);
}
