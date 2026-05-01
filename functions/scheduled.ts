import type { Env } from "./_middleware";

export const onScheduled: ExportedHandlerScheduledHandler<Env> = async (
  _event,
  env
) => {
  const now = Math.floor(Date.now() / 1000);

  // Expire anonymous sessions
  const expiredSessions = await env.DB.prepare(
    `SELECT session_id FROM sessions WHERE expires_at < ?`
  )
    .bind(now)
    .all<{ session_id: string }>();

  for (const { session_id } of expiredSessions.results) {
    await env.STORAGE.delete(`gedcom/anon/${session_id}`);
  }
  if (expiredSessions.results.length > 0) {
    await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(now).run();
  }

  // Expire authenticated user GEDCOMs
  const expiredUsers = await env.DB.prepare(
    `SELECT user_id FROM users WHERE gedcom_expires_at IS NOT NULL AND gedcom_expires_at < ?`
  )
    .bind(now)
    .all<{ user_id: string }>();

  for (const { user_id } of expiredUsers.results) {
    await env.STORAGE.delete(`gedcom/user/${user_id}`);
  }
  if (expiredUsers.results.length > 0) {
    await env.DB.prepare(
      `UPDATE users SET gedcom_expires_at = NULL WHERE gedcom_expires_at IS NOT NULL AND gedcom_expires_at < ?`
    )
      .bind(now)
      .run();
  }
};
