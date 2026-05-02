import { createClerkClient, verifyToken } from "@clerk/backend";

export interface UserContext {
  type: "anon" | "regular" | "vip";
  id: string;
  email?: string;
}

export interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  CLERK_SECRET_KEY: string;
  CLERK_PUBLISHABLE_KEY: string;
  ANTHROPIC_API_KEY: string;
  KEY_ENCRYPTION_SECRET: string;
  VIP_EMAILS: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
}

function getVipEmails(env: Env): Set<string> {
  return new Set(env.VIP_EMAILS.split(",").map((e) => e.trim().toLowerCase()));
}

function sessionCookieName() {
  return "gf_session";
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map((c) => {
      const [k, ...v] = c.trim().split("=");
      return [k?.trim() ?? "", v.join("=")];
    })
  );
}

async function ensureSession(
  sessionId: string,
  env: Env
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const expires = now + 86400; // 1 day
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, created_at, expires_at)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET expires_at = excluded.expires_at`
  )
    .bind(sessionId, now, expires)
    .run();
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env, next } = ctx;
  const authHeader = request.headers.get("Authorization");

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      const clerk = createClerkClient({
        secretKey: env.CLERK_SECRET_KEY,
        publishableKey: env.CLERK_PUBLISHABLE_KEY,
      });
      const payload = await verifyToken(token, {
        secretKey: env.CLERK_SECRET_KEY,
      });
      const userId = payload.sub;

      // Fetch email from Clerk
      const user = await clerk.users.getUser(userId);
      const email =
        user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
          ?.emailAddress ?? "";

      const vips = getVipEmails(env);
      const type = vips.has(email.toLowerCase()) ? "vip" : "regular";

      // Upsert user record
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        `INSERT INTO users (user_id, email, last_login, gedcom_expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           email = excluded.email,
           last_login = excluded.last_login,
           gedcom_expires_at = excluded.gedcom_expires_at`
      )
        .bind(userId, email, now, now + 7 * 86400, now)
        .run();

      ctx.data.user = { type, id: userId, email };
      return next();
    } catch (e) {
      console.error("[auth] token verification failed:", e instanceof Error ? e.message : String(e));
      // Fall through to anon
    }
  }

  // Anonymous: assign/read session cookie
  const cookies = parseCookies(request.headers.get("Cookie"));
  let sessionId = cookies[sessionCookieName()];

  if (!sessionId || !/^[0-9a-f-]{36}$/.test(sessionId)) {
    sessionId = crypto.randomUUID();
  }

  await ensureSession(sessionId, env);
  ctx.data.user = { type: "anon", id: sessionId };

  const response = await next();
  const mutable = new Response(response.body, response);
  mutable.headers.append(
    "Set-Cookie",
    `${sessionCookieName()}=${sessionId}; HttpOnly; SameSite=Strict; Max-Age=86400; Path=/`
  );
  return mutable;
};
