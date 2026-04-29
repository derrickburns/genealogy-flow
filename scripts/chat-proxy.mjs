#!/usr/bin/env node
// Local proxy for the Kindred Flow side-panel chat.
//
// The static page (GitHub Pages) calls Anthropic from the browser. For users
// who don't want to paste a raw API key into localStorage, this proxy holds
// the credential server-side and forwards POST /v1/messages to Anthropic.
//
// Auth modes (set one before starting):
//   ANTHROPIC_API_KEY=sk-ant-...        -> sent as x-api-key header
//   ANTHROPIC_AUTH_TOKEN=<oauth-token>  -> sent as Authorization: Bearer ...
//
// Run:
//   node scripts/chat-proxy.mjs
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/chat-proxy.mjs
//
// Then open the page; the chat panel auto-detects the proxy at
// http://localhost:8787 and routes requests through it. Browsers treat
// http://localhost as a secure origin, so this works even when the page
// itself is served from https://*.github.io.

import http from "node:http";

const PORT = Number(process.env.KF_CHAT_PROXY_PORT || 8788);
const apiKey = process.env.ANTHROPIC_API_KEY || "";
const authToken = process.env.ANTHROPIC_AUTH_TOKEN || "";
const upstream = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";

if (!apiKey && !authToken) {
  console.warn("[chat-proxy] No ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN set; the upstream will reject requests until one is configured.");
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, anthropic-version, anthropic-dangerous-direct-browser-access, x-api-key",
  "Access-Control-Max-Age": "600",
};

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, hasAuth: !!(apiKey || authToken) }));
    return;
  }
  if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
    res.writeHead(404, { ...corsHeaders, "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", async () => {
    const headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
    else if (apiKey) headers["x-api-key"] = apiKey;
    try {
      const r = await fetch(`${upstream}/v1/messages`, { method: "POST", headers, body });
      const text = await r.text();
      res.writeHead(r.status, {
        ...corsHeaders,
        "Content-Type": r.headers.get("content-type") || "application/json",
      });
      res.end(text);
    } catch (e) {
      res.writeHead(502, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "proxy_upstream_error", message: String(e) } }));
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  const mode = authToken ? "Bearer (ANTHROPIC_AUTH_TOKEN)" : apiKey ? "x-api-key (ANTHROPIC_API_KEY)" : "no auth — set one";
  console.log(`[chat-proxy] listening on http://localhost:${PORT}  upstream=${upstream}  auth=${mode}`);
  console.log(`[chat-proxy] health: curl http://localhost:${PORT}/health`);
});
