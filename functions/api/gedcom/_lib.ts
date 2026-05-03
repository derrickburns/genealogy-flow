import type { Env } from "../../_middleware";

const INITIAL_ARCHER_SHARED_WITH = [
  "derrickrburns@gmail.com",
  "ginagregoryburns@gmail.com",
  "f.d.gregory@att.net",
];

export const DEFAULT_TREE_OWNER_EMAIL = "derrickrburns@gmail.com";

export function normalizeEmail(email: string | undefined | null): string {
  return String(email || "").trim().toLowerCase();
}

export async function ensureGedcomMultiSourceSchema(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DROP INDEX IF EXISTS ged_sources_user`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS ged_sources_user_name ON ged_sources(user_id, name)`),
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
  await env.DB.batch([
    env.DB.prepare(`UPDATE ged_sources SET owner_user_id = user_id WHERE owner_user_id IS NULL OR owner_user_id = ''`),
    env.DB.prepare(`
      UPDATE ged_sources
      SET owner_email = COALESCE((SELECT email FROM users WHERE users.user_id = ged_sources.user_id), user_id)
      WHERE owner_email IS NULL OR owner_email = ''
    `),
  ]);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch(INITIAL_ARCHER_SHARED_WITH.map(email =>
    env.DB.prepare(`
      INSERT OR IGNORE INTO tree_shares (tree_kind, tree_key, owner_email, shared_with_email, created_at)
      VALUES ('catalog', 'archer', ?, ?, ?)
    `).bind(DEFAULT_TREE_OWNER_EMAIL, normalizeEmail(email), now)
  ));
}

export async function deleteAllUserGedcomData(env: Env, userId: string): Promise<void> {
  await ensureGedcomMultiSourceSchema(env);
  const rows = await env.DB.prepare(`SELECT id FROM ged_sources WHERE user_id = ?`).bind(userId).all<{ id: number }>();
  const ids = (rows.results ?? []).map(r => r.id);
  if (!ids.length) return;
  const stmts = [];
  for (const id of ids) {
    stmts.push(
      env.DB.prepare(`DELETE FROM ged_family_children WHERE source_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM ged_families WHERE source_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM ged_events WHERE source_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM ged_individuals WHERE source_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM tree_shares WHERE tree_kind = 'gedcom' AND tree_key = ?`).bind(String(id)),
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
           AND sh.tree_key = CAST(s.id AS TEXT)
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
