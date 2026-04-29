#!/usr/bin/env node
// Local proxy for the Kindred Flow side-panel chat. One long-running
// `claude` process handles all turns via stream-json, and assistant text
// is streamed back to the browser as Server-Sent Events so the UI can
// render tokens as they arrive.
//
// Run:
//   node scripts/chat-proxy.mjs
// Requires: `claude` CLI installed and `claude login` already done.

import http from "node:http";
import { spawn } from "node:child_process";

const PORT = Number(process.env.KF_CHAT_PROXY_PORT || 8788);
const CLAUDE_BIN = process.env.KF_CLAUDE_BIN || "claude";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, anthropic-version, anthropic-dangerous-direct-browser-access, x-api-key, kf-new-session",
  "Access-Control-Expose-Headers": "*",
  "Access-Control-Max-Age": "600",
};

let _proc = null;
let _procSystemPrompt = null;
let _procModel = null;
let _stdoutBuf = "";
let _activeRequest = null;
const _queue = [];

function startProc(system, model) {
  const args = ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  if (model) args.push("--model", model);
  if (system) args.push("--system-prompt", system);
  const proc = spawn(CLAUDE_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
  proc.stderr.on("data", c => process.stderr.write(`[claude.stderr] ${c}`));
  proc.stdout.on("data", c => {
    _stdoutBuf += c;
    let nl;
    while ((nl = _stdoutBuf.indexOf("\n")) >= 0) {
      const line = _stdoutBuf.slice(0, nl).trim();
      _stdoutBuf = _stdoutBuf.slice(nl + 1);
      if (!line) continue;
      try { handleStreamLine(JSON.parse(line)); }
      catch (_) { /* non-JSON */ }
    }
  });
  proc.on("exit", (code, signal) => {
    console.warn(`[chat-proxy] claude exited code=${code} signal=${signal}`);
    _proc = null;
    if (_activeRequest) { _activeRequest.onError(new Error(`claude exited ${code}/${signal}`)); _activeRequest = null; }
    drainQueue();
  });
  _proc = proc;
  _procSystemPrompt = system || null;
  _procModel = model || null;
}

function ensureProc(system, model) {
  if (_proc && _procSystemPrompt === (system || null) && _procModel === (model || null)) return;
  if (_proc) { try { _proc.kill("SIGTERM"); } catch (_) {} _proc = null; }
  startProc(system, model);
}

function handleStreamLine(msg) {
  if (!_activeRequest) return;
  if (msg.type === "assistant" && msg.message && Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        _activeRequest.onDelta(block.text);
      }
    }
  } else if (msg.type === "result") {
    if (msg.is_error) {
      _activeRequest.onError(new Error(msg.result || "claude reported an error"));
    } else {
      _activeRequest.onDone({ usage: msg.usage || null, stop_reason: msg.stop_reason || "end_turn" });
    }
    _activeRequest = null;
    drainQueue();
  }
}

function drainQueue() {
  if (_activeRequest) return;
  const next = _queue.shift();
  if (!next) return;
  ensureProc(next.system, next.model);
  _activeRequest = { onDelta: next.onDelta, onDone: next.onDone, onError: next.onError };
  const line = JSON.stringify({ type: "user", message: { role: "user", content: next.content } }) + "\n";
  try { _proc.stdin.write(line); }
  catch (e) { _activeRequest.onError(e); _activeRequest = null; drainQueue(); }
}

function streamClaude({ system, model, content, onDelta, onDone, onError }) {
  _queue.push({ system, model, content, onDelta, onDone, onError });
  drainQueue();
}

function resetProc() {
  if (_proc) { try { _proc.kill("SIGTERM"); } catch (_) {} _proc = null; }
  _stdoutBuf = "";
  if (_activeRequest) { _activeRequest.onError(new Error("session reset")); _activeRequest = null; }
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders); res.end(); return; }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, mode: "claude-cli-stream", running: !!_proc }));
    return;
  }
  if (req.method === "POST" && req.url === "/reset") {
    resetProc();
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
  req.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(body); }
    catch (_) {
      res.writeHead(400, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request", message: "body is not JSON" } }));
      return;
    }
    if (req.headers["kf-new-session"] === "1") resetProc();
    const { system, messages, model } = parsed;
    const lastUser = (messages || []).filter(m => m.role === "user").slice(-1)[0];
    const content = lastUser
      ? (typeof lastUser.content === "string" ? lastUser.content
          : Array.isArray(lastUser.content) ? lastUser.content.filter(b => b.type === "text").map(b => b.text).join("")
          : String(lastUser.content || ""))
      : "";
    res.writeHead(200, {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    function send(obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
    streamClaude({
      system, model, content,
      onDelta: text => send({ delta: text }),
      onDone: ({ usage, stop_reason }) => { send({ done: true, usage, stop_reason }); res.end(); },
      onError: err => { send({ error: err.message || String(err) }); res.end(); },
    });
    req.on("close", () => { /* client disconnected; let claude finish silently */ });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[chat-proxy] listening on http://localhost:${PORT}  mode=claude-cli-stream  bin=${CLAUDE_BIN}`);
  console.log(`[chat-proxy] one persistent claude process serves all turns; replies stream back via SSE.`);
  console.log(`[chat-proxy] health: curl http://localhost:${PORT}/health`);
});
