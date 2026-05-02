import type { Env } from "../../_middleware";

export async function ensureGedcomMultiSourceSchema(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DROP INDEX IF EXISTS ged_sources_user`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS ged_sources_user_name ON ged_sources(user_id, name)`),
  ]);

  const cols = await env.DB.prepare(`PRAGMA table_info(ged_sources)`).all<{ name: string }>();
  const names = new Set((cols.results ?? []).map(c => c.name));
  if (!names.has("is_default")) {
    await env.DB.prepare(`ALTER TABLE ged_sources ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0`).run();
  }
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
      env.DB.prepare(`DELETE FROM ged_sources WHERE id = ?`).bind(id),
    );
  }
  await env.DB.batch(stmts);
}
