import type { Env, UserContext } from "../../_middleware";

const DEFAULT_REPO = "derrickburns/genealogy-flow";
const FROM_APP_LABEL = "from-app";
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_CONTEXT_CHARS = 30000;

interface ReportBody {
  description?: string;
  commit?: string;
  snapshotDataUrl?: string;
  snapshotKind?: string;
  context?: unknown;
}

interface GitHubIssueResponse {
  number?: number;
  html_url?: string;
  message?: string;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n...[truncated]" : s;
}

function safeJson(value: unknown, max = MAX_CONTEXT_CHARS): string {
  try {
    return truncate(JSON.stringify(value, null, 2), max);
  } catch {
    return "[unserializable context]";
  }
}

function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; contentType: string; ext: string } | null {
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl || "");
  if (!match) return null;
  const contentType = (match[1] || "").toLowerCase();
  const payload = match[2] || "";
  if (!contentType || !payload) return null;
  const binary = atob(payload);
  if (binary.length > MAX_SNAPSHOT_BYTES) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, contentType, ext: contentType === "image/jpeg" ? "jpg" : "png" };
}

async function githubRequest(env: Env, path: string, init: RequestInit = {}) {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not configured");
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");
  headers.set("User-Agent", "kindred-flow-app");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers,
  });
}

async function ensureFromAppLabel(env: Env, repo: string): Promise<void> {
  const resp = await githubRequest(env, `/repos/${repo}/labels`, {
    method: "POST",
    body: JSON.stringify({
      name: FROM_APP_LABEL,
      color: "1f6feb",
      description: "Issue reported from the Kindred Flow application",
    }),
  });
  if (resp.ok || resp.status === 422) return;
  const text = await resp.text().catch(() => "");
  throw new Error(`GitHub label error ${resp.status}: ${text.slice(0, 300)}`);
}

function issueTitle(description: string): string {
  const first = description.split(/\r?\n/).map(s => s.trim()).find(Boolean) || "Issue reported from app";
  return `App issue: ${truncate(first, 90).replace(/\s+/g, " ")}`;
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext | undefined;
  const repo = (ctx.env.GITHUB_REPO || DEFAULT_REPO).trim();
  if (!ctx.env.GITHUB_TOKEN) {
    return new Response(JSON.stringify({ error: "GitHub issue reporting is not configured" }), {
      status: 501,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: ReportBody;
  try {
    body = await ctx.request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const description = String(body.description || "").trim();
  if (!description) {
    return new Response(JSON.stringify({ error: "description required" }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    });
  }

  const now = new Date().toISOString();
  const origin = new URL(ctx.request.url).origin;
  let snapshotUrl = "";
  const decoded = body.snapshotDataUrl ? decodeDataUrl(body.snapshotDataUrl) : null;
  if (decoded) {
    const key = `issue-snapshots/${crypto.randomUUID()}.${decoded.ext}`;
    await ctx.env.STORAGE.put(key, decoded.bytes, {
      httpMetadata: { contentType: decoded.contentType },
      customMetadata: {
        reporter_type: user?.type || "unknown",
        reporter_id: user?.id || "",
        commit: String(body.commit || ""),
        created_at: now,
      },
    });
    snapshotUrl = `${origin}/api/issues/snapshot?key=${encodeURIComponent(key)}`;
  }

  const reporter = {
    type: user?.type || "unknown",
    id: user?.id || "unknown",
    email: user?.email || null,
  };
  const issueBody = [
    "## Report",
    description,
    "",
    "## Reporter",
    `- Type: ${reporter.type}`,
    `- User ID: ${reporter.id}`,
    `- Email: ${reporter.email || "(none)"}`,
    "",
    "## Runtime",
    `- Reported at: ${now}`,
    `- Commit: ${body.commit || "(unknown)"}`,
    snapshotUrl ? `- Snapshot (${body.snapshotKind || "screen"}): ${snapshotUrl}` : "- Snapshot: not captured",
    "",
    "## App Context",
    "```json",
    safeJson(body.context),
    "```",
  ].join("\n");

  try {
    await ensureFromAppLabel(ctx.env, repo);
    const gh = await githubRequest(ctx.env, `/repos/${repo}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: issueTitle(description),
        body: issueBody,
        labels: [FROM_APP_LABEL],
      }),
    });
    const json = await gh.json().catch(() => null) as GitHubIssueResponse | null;
    if (!gh.ok) {
      return new Response(JSON.stringify({ error: json?.message || `GitHub error ${gh.status}` }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      ok: true,
      number: json?.number,
      url: json?.html_url,
      snapshot_url: snapshotUrl || null,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
};
