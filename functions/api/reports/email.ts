import type { Env, UserContext } from "../../_middleware";

const MAX_REPORT_HTML_CHARS = 8_000_000;
const MAX_REPORT_EMAIL_BYTES = 30 * 1024 * 1024;

interface ReportEmailBody {
  subject?: string;
  html?: string;
  text?: string;
  filename?: string;
}

interface ResendEmailResponse {
  id?: string;
  message?: string;
}

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
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

function cleanSubject(subject: string): string {
  const s = subject.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, 160) : "Kindred Flow AI report";
}

function cleanFilename(filename: string): string {
  const base = filename
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "kindred-flow-ai-report";
  return /\.html?$/i.test(base) ? base : `${base}.html`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromEmail(env: Env): string {
  const configured = typeof env.REPORT_FROM_EMAIL === "string" && env.REPORT_FROM_EMAIL.trim()
    ? env.REPORT_FROM_EMAIL.trim()
    : typeof env.INVITE_FROM_EMAIL === "string" && env.INVITE_FROM_EMAIL.trim()
      ? env.INVITE_FROM_EMAIL.trim()
      : "Kindred Flow <onboarding@resend.dev>";
  return configured;
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  if (user.type === "anon" || !user.email) {
    return json({ error: "Sign in required to email reports" }, { status: 401 });
  }
  const apiKey = typeof ctx.env.RESEND_API_KEY === "string" ? ctx.env.RESEND_API_KEY.trim() : "";
  if (!apiKey) {
    return json({ error: "Email reporting is not configured" }, { status: 501 });
  }

  let body: ReportEmailBody;
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  const html = String(body.html || "").trim();
  if (!html || !/<html[\s>]/i.test(html)) {
    return json({ error: "report HTML required" }, { status: 422 });
  }
  if (html.length > MAX_REPORT_HTML_CHARS) {
    return json({ error: "report is too large to email" }, { status: 413 });
  }

  const subject = cleanSubject(String(body.subject || ""));
  const filename = cleanFilename(String(body.filename || ""));
  const text = String(body.text || "Your Kindred Flow AI report is attached. Open the attachment in a browser, then print or save as PDF.").slice(0, 20000);
  const encoded = new TextEncoder().encode(html);
  const attachment = bytesToBase64(encoded);
  if (attachment.length > MAX_REPORT_EMAIL_BYTES) {
    return json({ error: "report attachment is too large to email" }, { status: 413 });
  }

  const emailHtml = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#142033">
      <h2 style="margin:0 0 12px">Your Kindred Flow AI report is ready</h2>
      <p>The print-ready report is attached as an HTML file.</p>
      <p>Open the attachment in a browser, then choose <strong>Print</strong> or <strong>Save as PDF</strong>.</p>
      <p style="color:#64748b;font-size:13px">This email was sent to ${escHtml(user.email)} from your signed-in Kindred Flow session.</p>
    </div>`;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromEmail(ctx.env),
      to: user.email,
      subject,
      text,
      html: emailHtml,
      attachments: [{ filename, content: attachment }],
    }),
  });

  const data = await resp.json().catch(async () => ({ message: await resp.text().catch(() => "") })) as ResendEmailResponse;
  if (!resp.ok) {
    const message = typeof data?.message === "string" && data.message ? data.message : `Resend ${resp.status}`;
    return json({ error: message }, { status: 502 });
  }
  return json({ ok: true, to: user.email, id: data?.id || null });
};
