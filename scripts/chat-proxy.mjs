#!/usr/bin/env node
// Local proxy for the Kindred Flow side-panel chat that wraps the `claude`
// CLI so requests bill against the user's Claude Max subscription instead of
// console.anthropic.com API credits.
//
// The browser sends a standard Anthropic Messages-API request to
// http://localhost:8788/v1/messages. This proxy reformats the conversation
// as a single text prompt, spawns `claude --print --output-format json`,
// captures the JSON output, and returns it shaped like a Messages-API
// response so the browser side doesn't need to know about the CLI.
//
// Run:
//   node scripts/chat-proxy.mjs
//
// Requires: `claude` CLI installed and `claude login` already run with a
// Max-subscription account.

import http from "node:http";
import { spawn } from "node:child_process";

const PORT = Number(process.env.KF_CHAT_PROXY_PORT || 8788);
const CLAUDE_BIN = process.env.KF_CLAUDE_BIN || "claude";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, anthropic-version, anthropic-dangerous-direct-browser-access, x-api-key, kf-new-session",
  "Access-Control-Max-Age": "600",
};

function buildPrompt(messages) {
  // Conversation history -> single string. Claude understands the pattern
  // and continues from the latest USER turn.
  const lines = [];
  for (const m of messages) {
    const role = m.role === "user" ? "USER" : "ASSISTANT";
    const content = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter(b => b.type === "text").map(b => b.text).join("")
        : String(m.content || "");
    lines.push(`${role}: ${content}`);
  }
  return lines.join("\n\n");
}

// Single global session id. First request starts a fresh session; subsequent
// requests pass --resume <id> so Claude keeps its own context across turns.
// The browser can force a reset by sending the kf-new-session: 1 header.
let _currentSession = null;

function callClaudeCLI({ system, messages, model, resetSession }) {
  return new Promise((resolve, reject) => {
    if (resetSession) _currentSession = null;
    const args = ["--print", "--output-format", "json"];
    if (model) args.push("--model", model);
    if (system) args.push("--system-prompt", system);
    if (_currentSession) args.push("--resume", _currentSession);
    // With --resume, send only the latest user turn; Claude already has the
    // earlier history in its session. Without --resume, send the full history.
    const useResume = !!_currentSession;
    const lastUser = messages.filter(m => m.role === "user").slice(-1)[0];
    const prompt = useResume && lastUser
      ? (typeof lastUser.content === "string" ? lastUser.content
          : Array.isArray(lastUser.content) ? lastUser.content.filter(b => b.type === "text").map(b => b.text).join("")
          : String(lastUser.content || ""))
      : buildPrompt(messages);
    const child = spawn(CLAUDE_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 800)}`));
      }
      try {
        const j = JSON.parse(stdout);
        if (j.is_error) return reject(new Error(j.result || stderr || "claude reported an error"));
        if (j.session_id) _currentSession = j.session_id;
        resolve(j);
      } catch (e) {
        reject(new Error(`could not parse claude json: ${e.message}\n${stdout.slice(0, 400)}`));
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, mode: "claude-cli", session: _currentSession }));
    return;
  }
  if (req.method === "POST" && req.url === "/reset") {
    _currentSession = null;
    res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
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
    let parsed;
    try { parsed = JSON.parse(body); }
    catch (e) {
      res.writeHead(400, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request", message: "body is not JSON" } }));
      return;
    }
    try {
      const { system, messages, model } = parsed;
      const resetSession = req.headers["kf-new-session"] === "1";
      const cliResult = await callClaudeCLI({ system, messages: messages || [], model, resetSession });
      const text = cliResult.result || "";
      // Reshape to Anthropic Messages-API response so browser doesn't change.
      const apiResp = {
        id: "kf_" + Date.now(),
        type: "message",
        role: "assistant",
        model: model || "claude-opus-4-7",
        content: [{ type: "text", text }],
        stop_reason: cliResult.stop_reason || "end_turn",
        usage: cliResult.usage ? {
          input_tokens: cliResult.usage.input_tokens || 0,
          output_tokens: cliResult.usage.output_tokens || 0,
          cache_read_input_tokens: cliResult.usage.cache_read_input_tokens || 0,
          cache_creation_input_tokens: cliResult.usage.cache_creation_input_tokens || 0,
        } : { input_tokens: 0, output_tokens: 0 },
      };
      res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify(apiResp));
    } catch (e) {
      console.error("[chat-proxy] error:", e.message);
      res.writeHead(502, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "claude_cli_error", message: e.message } }));
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[chat-proxy] listening on http://localhost:${PORT}  mode=claude-cli  bin=${CLAUDE_BIN}`);
  console.log(`[chat-proxy] each /v1/messages spawns the claude CLI; bills against the Max subscription you logged into with claude login.`);
  console.log(`[chat-proxy] health: curl http://localhost:${PORT}/health`);
});
