import { createClerkClient } from "@clerk/backend";

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
  CLERK_PUBLISHABLE_KEY: string;
  ANTHROPIC_API_KEY: string;
  KEY_ENCRYPTION_SECRET: string;
  VIP_EMAILS?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
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
  env: Env
): Promise<void> {
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
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
      const clerk = createClerkClient({
        secretKey: env.CLERK_SECRET_KEY,
        publishableKey: env.CLERK_PUBLISHABLE_KEY,
      });
      const requestState = await clerk.authenticateRequest(request, {
        secretKey: env.CLERK_SECRET_KEY,
        publishableKey: env.CLERK_PUBLISHABLE_KEY,
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
            upsertAuthenticatedUser(userId, email, env).catch((e) => {
              console.error("[auth] user upsert failed:", errorMessage(e));
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
