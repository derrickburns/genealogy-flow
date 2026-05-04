import { createClerkClient } from "@clerk/backend";
import { ensureUserIdentitySchema } from "./api/gedcom/_lib";

export interface UserContext {
  type: "anon" | "regular" | "vip";
  id: string;
  email?: string;
}

export interface AuthDiagnostics {
  headerPresent: boolean;
  status: "not-attempted" | "signed-in" | "signed-out" | "handshake" | "error";
  reason?: string | null;
  message?: string | null;
  userId?: string | null;
  email?: string | null;
  emailSource?: "clerk-user" | "session-claims" | "none";
  userLookupError?: string;
}

export interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  CLERK_SECRET_KEY: string;
  CLERK_PUBLISHABLE_KEY?: string;
  ANTHROPIC_API_KEY: string;
  KEY_ENCRYPTION_SECRET: string;
  VIP_EMAILS?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  RESEND_API_KEY?: string;
  INVITE_FROM_EMAIL?: string;
  REPORT_FROM_EMAIL?: string;
  NEW_LOGIN_NOTIFY_EMAIL?: string;
  APP_ORIGIN?: string;
}

const DEFAULT_VIP_EMAILS = [
  "ginagregoryburns@gmail.com",
  "mayasylvia.burns@gmail.com",
  "jamil.burns@gmail.com",
  "derrickrburns@gmail.com",
  "derrickburns@gmail.com",
  "derrick.burns@gmail.com",
  "derrick@kindredsearch.com",
  "derrickburns@kindredsearch.com",
  "paigeunterberg@gmail.com",
  "james.raby@gmail.com",
];

// Public Clerk browser key used by index.html. Keeping this as a fallback avoids
// turning authenticated API requests into anonymous requests if the Pages var is
// absent in a deployment environment.
const DEFAULT_CLERK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsua2luZHJlZHNlYXJjaC5jb20k";

function getClerkPublishableKey(env: Env): string {
  const configured = typeof env.CLERK_PUBLISHABLE_KEY === "string" ? env.CLERK_PUBLISHABLE_KEY.trim() : "";
  return configured || DEFAULT_CLERK_PUBLISHABLE_KEY;
}

function getClerkSecretKey(env: Env): string {
  return typeof env.CLERK_SECRET_KEY === "string" ? env.CLERK_SECRET_KEY.trim() : "";
}

function getVipEmails(env: Env): Set<string> {
  const raw = [
    typeof env.VIP_EMAILS === "string" ? env.VIP_EMAILS : "",
    DEFAULT_VIP_EMAILS.join(","),
  ].join(",");
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
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

async function upsertAuthenticatedUser(
  userId: string,
  email: string,
  env: Env,
  userType: UserContext["type"] = "regular"
): Promise<void> {
  await ensureUserIdentitySchema(env);
  const now = Math.floor(Date.now() / 1000);
  const ownerUuid = crypto.randomUUID();
  const inserted = await env.DB.prepare(
    `INSERT INTO users (user_id, email, owner_uuid, last_login, gedcom_expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO NOTHING`
  )
    .bind(userId, email, ownerUuid, now, now + 7 * 86400, now)
    .run();
  const created = Number(inserted.meta?.changes ?? 0) > 0;
  if (!created) {
    await env.DB.prepare(
      `UPDATE users
       SET email = ?, last_login = ?, gedcom_expires_at = ?, owner_uuid = COALESCE(owner_uuid, ?)
       WHERE user_id = ?`
    )
      .bind(email, now, now + 7 * 86400, ownerUuid, userId)
      .run();
    return;
  }
  await sendNewLoginNotification(env, { userId, email, userType, createdAt: now });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch] ?? ch));
}

function configuredEmailSender(env: Env): string {
  if (typeof env.INVITE_FROM_EMAIL === "string" && env.INVITE_FROM_EMAIL.trim()) {
    return env.INVITE_FROM_EMAIL.trim();
  }
  if (typeof env.REPORT_FROM_EMAIL === "string" && env.REPORT_FROM_EMAIL.trim()) {
    return env.REPORT_FROM_EMAIL.trim();
  }
  return "";
}

function newLoginNotifyEmail(env: Env): string {
  return typeof env.NEW_LOGIN_NOTIFY_EMAIL === "string" && env.NEW_LOGIN_NOTIFY_EMAIL.trim()
    ? env.NEW_LOGIN_NOTIFY_EMAIL.trim()
    : "derrick.burns@parthenian.com";
}

function appOrigin(env: Env): string {
  const origin = typeof env.APP_ORIGIN === "string" && env.APP_ORIGIN.trim()
    ? env.APP_ORIGIN.trim()
    : "https://flow.kindredsearch.com";
  return origin.replace(/\/+$/, "");
}

async function sendNewLoginNotification(
  env: Env,
  params: { userId: string; email: string; userType: UserContext["type"]; createdAt: number }
): Promise<void> {
  const apiKey = typeof env.RESEND_API_KEY === "string" ? env.RESEND_API_KEY.trim() : "";
  if (!apiKey) {
    console.warn("[auth] new-login email skipped: RESEND_API_KEY is not configured");
    return;
  }
  const from = configuredEmailSender(env);
  if (!from) {
    console.warn("[auth] new-login email skipped: INVITE_FROM_EMAIL or REPORT_FROM_EMAIL is not configured");
    return;
  }
  const to = newLoginNotifyEmail(env);
  const createdIso = new Date(params.createdAt * 1000).toISOString();
  const subject = `New Kindred Flow login: ${params.email}`;
  const text = [
    "A new Kindred Flow login was created.",
    "",
    `Email: ${params.email}`,
    `Clerk user ID: ${params.userId}`,
    `Tier: ${params.userType}`,
    `Created: ${createdIso}`,
    `App: ${appOrigin(env)}`,
  ].join("\n");
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#142033">
      <h2 style="margin:0 0 12px">New Kindred Flow login</h2>
      <p>A new signed-in user record was created.</p>
      <table style="border-collapse:collapse">
        <tr><td style="padding:4px 10px 4px 0;color:#64748b">Email</td><td style="padding:4px 0"><strong>${escHtml(params.email)}</strong></td></tr>
        <tr><td style="padding:4px 10px 4px 0;color:#64748b">Clerk user ID</td><td style="padding:4px 0"><code>${escHtml(params.userId)}</code></td></tr>
        <tr><td style="padding:4px 10px 4px 0;color:#64748b">Tier</td><td style="padding:4px 0">${escHtml(params.userType)}</td></tr>
        <tr><td style="padding:4px 10px 4px 0;color:#64748b">Created</td><td style="padding:4px 0">${escHtml(createdIso)}</td></tr>
      </table>
      <p><a href="${escHtml(appOrigin(env))}" style="color:#183b7a">Open Kindred Flow</a></p>
    </div>`;
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, text, html }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Resend ${resp.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
}

function extractEmailFromSessionClaims(claims: unknown): string {
  if (!claims || typeof claims !== "object") return "";
  const record = claims as Record<string, unknown>;
  for (const key of ["email", "email_address", "primary_email_address"]) {
    const value = record[key];
    if (typeof value === "string" && value.includes("@")) return value;
  }
  const emailAddresses = record.email_addresses;
  if (Array.isArray(emailAddresses)) {
    for (const item of emailAddresses) {
      if (typeof item === "string" && item.includes("@")) return item;
      if (item && typeof item === "object") {
        const value = (item as Record<string, unknown>).email_address ?? (item as Record<string, unknown>).emailAddress;
        if (typeof value === "string" && value.includes("@")) return value;
      }
    }
  }
  return "";
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env, next } = ctx;
  const authHeader = request.headers.get("Authorization");
  ctx.data.auth = {
    headerPresent: !!authHeader,
    status: "not-attempted",
  } satisfies AuthDiagnostics;

  if (authHeader?.startsWith("Bearer ")) {
    try {
      const secretKey = getClerkSecretKey(env);
      if (!secretKey) throw new Error("Clerk secret key is missing in Pages Functions environment");
      const publishableKey = getClerkPublishableKey(env);
      const clerk = createClerkClient({
        secretKey,
        publishableKey,
      });
      const requestState = await clerk.authenticateRequest(request, {
        secretKey,
        publishableKey,
      });
      ctx.data.auth = {
        headerPresent: true,
        status: requestState.status,
        reason: requestState.reason,
        message: requestState.message,
      } satisfies AuthDiagnostics;
      if (requestState.status !== "signed-in") {
        console.warn("[auth] request not signed in:", requestState.reason || requestState.message || requestState.status);
      } else {
        const auth = requestState.toAuth({ treatPendingAsSignedOut: false });
        const userId = auth.userId;
        if (!userId) throw new Error("Clerk signed-in request did not include a user id");

        let email = extractEmailFromSessionClaims(auth.sessionClaims);
        let emailSource: AuthDiagnostics["emailSource"] = email ? "session-claims" : "none";
        let userLookupError: string | undefined;
        try {
          const user = await clerk.users.getUser(userId);
          const primaryEmail =
            user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
              ?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? "";
          if (primaryEmail) {
            email = primaryEmail;
            emailSource = "clerk-user";
          }
        } catch (e) {
          userLookupError = errorMessage(e);
          console.error("[auth] Clerk user lookup failed:", userLookupError);
          if (!email) throw e;
        }

        const vips = getVipEmails(env);
        const type = vips.has(email.toLowerCase()) ? "vip" : "regular";

        ctx.data.auth = {
          ...(ctx.data.auth as AuthDiagnostics),
          userId,
          email: email || null,
          emailSource,
          userLookupError,
        } satisfies AuthDiagnostics;
        ctx.data.user = { type, id: userId, email };
        if (email) {
          ctx.waitUntil(
            upsertAuthenticatedUser(userId, email, env, type).catch((e) => {
              console.error("[auth] user upsert/new-login notification failed:", errorMessage(e));
            })
          );
        }
        return next();
      }
    } catch (e) {
      const message = errorMessage(e);
      ctx.data.auth = {
        headerPresent: true,
        status: "error",
        message,
      } satisfies AuthDiagnostics;
      console.error("[auth] token verification failed:", message);
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
