import type { Env, UserContext } from "../../_middleware";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;

  const contentLength = Number(ctx.request.headers.get("Content-Length") ?? 0);
  if (contentLength > MAX_BYTES) {
    return new Response(JSON.stringify({ error: "File too large (max 10 MB)" }), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: ArrayBuffer;
  try {
    body = await ctx.request.arrayBuffer();
  } catch {
    return new Response(JSON.stringify({ error: "Failed to read body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (body.byteLength > MAX_BYTES) {
    return new Response(JSON.stringify({ error: "File too large (max 10 MB)" }), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    });
  }

  const key =
    user.type === "anon"
      ? `gedcom/anon/${user.id}`
      : `gedcom/user/${user.id}`;

  await ctx.env.STORAGE.put(key, body, {
    httpMetadata: { contentType: "text/plain" },
  });

  const now = Math.floor(Date.now() / 1000);
  let expiresAt: number;

  if (user.type === "anon") {
    expiresAt = now + 86400;
    await ctx.env.DB.prepare(
      `INSERT INTO sessions (session_id, created_at, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET expires_at = excluded.expires_at`
    )
      .bind(user.id, now, expiresAt)
      .run();
  } else {
    expiresAt = now + 7 * 86400;
    await ctx.env.DB.prepare(
      `UPDATE users SET gedcom_expires_at = ?, last_login = ? WHERE user_id = ?`
    )
      .bind(expiresAt, now, user.id)
      .run();
  }

  return new Response(
    JSON.stringify({ stored: true, expires_at: expiresAt }),
    { headers: { "Content-Type": "application/json" } }
  );
};
