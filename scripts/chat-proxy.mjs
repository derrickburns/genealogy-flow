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
import { existsSync, writeFileSync, unlinkSync, statSync, createReadStream } from "node:fs";
import { dirname, join, resolve as pathResolve, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const PORT = Number(process.env.KF_CHAT_PROXY_PORT || 8789);
const CLAUDE_BIN = process.env.KF_CLAUDE_BIN || "claude";
const DB_PATH = process.env.KF_DB_PATH || "";
// Backend selector: "cli" uses the local `claude` CLI (subscription, single-user).
// "api" uses the Anthropic Messages API (commercial sharing requires this).
const BACKEND = (process.env.KF_BACKEND || "cli").toLowerCase();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const DEFAULT_MODEL = process.env.KF_DEFAULT_MODEL || "claude-opus-4-7";
const MAX_TOKENS = Number(process.env.KF_MAX_TOKENS || 4096);

if (BACKEND !== "cli" && BACKEND !== "api") {
  console.error(`[chat-proxy] KF_BACKEND must be "cli" or "api", got "${BACKEND}"`);
  process.exit(1);
}
if (BACKEND === "api" && !ANTHROPIC_API_KEY) {
  console.error("[chat-proxy] KF_BACKEND=api requires ANTHROPIC_API_KEY to be set");
  process.exit(1);
}
const _anthropic = BACKEND === "api" ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = pathResolve(HERE, "..");
const GEDCOM_TO_SQLITE = join(HERE, "gedcom-to-sqlite.mjs");
const LINK_RECORDS = join(HERE, "link-records.mjs");
const CHECK_DATA_QUALITY = join(HERE, "check-data-quality.mjs");
const MAX_GED_BYTES = 50 * 1024 * 1024;

// Content-Type lookup for the few file kinds the page actually serves. Files
// outside this list still serve, just as octet-stream.
const STATIC_MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm":  "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map":  "application/json; charset=utf-8",
  ".txt":  "text/plain; charset=utf-8",
  ".ged":  "text/plain; charset=utf-8",
};

// Try to serve a file from STATIC_ROOT. Returns true if it sent a response,
// false if the request didn't match a real file (so the caller can fall
// through to the 404). GET/HEAD only; rejects path traversal.
function tryServeStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname); }
  catch (_) { return false; }
  if (urlPath === "/") urlPath = "/index.html";
  // normalize() collapses .. so we can detect traversal by checking the
  // resolved absolute path stays under STATIC_ROOT.
  const rel = normalize(urlPath).replace(/^\/+/, "");
  const abs = pathResolve(STATIC_ROOT, rel);
  if (!abs.startsWith(STATIC_ROOT + "/") && abs !== STATIC_ROOT) return false;
  let st;
  try { st = statSync(abs); } catch (_) { return false; }
  if (!st.isFile()) return false;
  const ext = extname(abs).toLowerCase();
  const headers = {
    ...corsHeaders,
    "Content-Type": STATIC_MIME[ext] || "application/octet-stream",
    "Content-Length": String(st.size),
    // Avoid stale gazetteer / page after edits during development.
    "Cache-Control": "no-cache",
  };
  res.writeHead(200, headers);
  if (req.method === "HEAD") { res.end(); return true; }
  createReadStream(abs).on("error", e => {
    console.warn("[chat-proxy] static read error:", abs, e.message);
    try { res.destroy(); } catch (_) {}
  }).pipe(res);
  return true;
}

let _db = null;
async function getDb() {
  if (_db) return _db;
  if (!DB_PATH) return null;
  if (!existsSync(DB_PATH)) return null;
  const Database = (await import("better-sqlite3")).default;
  _db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  return _db;
}

// Open the DB read-write, run a transaction, close, and null out _db so the
// next read reopens fresh. Used for source deletes from the proxy.
async function withWritableDb(fn) {
  if (_db) { try { _db.close(); } catch (_) {} _db = null; }
  if (!DB_PATH || !existsSync(DB_PATH)) throw new Error("no DB to mutate");
  const Database = (await import("better-sqlite3")).default;
  const w = new Database(DB_PATH, { readonly: false, fileMustExist: true });
  try { return fn(w); }
  finally { try { w.close(); } catch (_) {} }
}

// Cascade-delete a source by id. Returns the deleted row, or null if missing.
async function deleteSourceById(id) {
  return withWritableDb(db => {
    const row = db.prepare("SELECT id, name, n_individuals, n_events, n_families FROM sources WHERE id = ?").get(id);
    if (!row) return null;
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM events_geo WHERE rowid IN (SELECT rowid FROM events WHERE source_id = ?)").run(id);
      db.prepare("DELETE FROM events WHERE source_id = ?").run(id);
      db.prepare("DELETE FROM individuals WHERE source_id = ?").run(id);
      db.prepare("DELETE FROM families WHERE source_id = ?").run(id);
      db.prepare("DELETE FROM family_children WHERE source_id = ?").run(id);
      db.prepare("DELETE FROM sources WHERE id = ?").run(id);
    });
    tx();
    return row;
  });
}

// Spawn a Node child against the shared DB. Closes the read-only handle
// first so the child can take an exclusive write lock; nulls out _db so the
// next SQL request reopens fresh.
function runChild(scriptPath) {
  return new Promise(resolve => {
    if (!DB_PATH || !existsSync(DB_PATH)) { resolve({ ok: false, error: "no DB" }); return; }
    if (_db) { try { _db.close(); } catch (_) {} _db = null; }
    const t0 = Date.now();
    const child = spawn(process.execPath, [scriptPath, DB_PATH], {
      cwd: HERE,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stderr.on("data", c => { log += c; });
    child.on("error", e => resolve({ ok: false, error: e.message }));
    child.on("exit", code => {
      if (code !== 0) resolve({ ok: false, error: `${scriptPath} exited ${code}`, log });
      else resolve({ ok: true, ms: Date.now() - t0, log });
    });
  });
}

// Run data-quality check first, then the linker. Both are best-effort.
async function runQualityAndLink() {
  const quality = await runChild(CHECK_DATA_QUALITY);
  const link = await runChild(LINK_RECORDS);
  return {
    ok: link.ok,
    link_ms: link.ms,
    quality_ms: quality.ms,
    log: (quality.log || "") + (link.log || ""),
  };
}

async function deleteSourceByName(name) {
  return withWritableDb(db => {
    const row = db.prepare("SELECT id FROM sources WHERE name = ?").get(name);
    if (!row) return null;
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM events_geo WHERE rowid IN (SELECT rowid FROM events WHERE source_id = ?)").run(row.id);
      db.prepare("DELETE FROM events WHERE source_id = ?").run(row.id);
      db.prepare("DELETE FROM individuals WHERE source_id = ?").run(row.id);
      db.prepare("DELETE FROM families WHERE source_id = ?").run(row.id);
      db.prepare("DELETE FROM family_children WHERE source_id = ?").run(row.id);
      db.prepare("DELETE FROM sources WHERE id = ?").run(row.id);
    });
    tx();
    return row;
  });
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, anthropic-version, anthropic-dangerous-direct-browser-access, x-api-key, kf-new-session, kf-sql, kf-filename",
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
    if (_proc !== proc) {
      // A reset already replaced _proc with a newer instance; this exit
      // event is a stale notification for the killed predecessor — ignore it.
      return;
    }
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

async function streamApi({ rawSystem, model, messages, onDelta, onDone, onError }) {
  try {
    const params = {
      model: model || DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      messages: Array.isArray(messages) ? messages : [],
    };
    if (rawSystem) params.system = rawSystem;
    const stream = _anthropic.messages.stream(params);
    stream.on("text", text => { if (text) onDelta(text); });
    const final = await stream.finalMessage();
    onDone({ usage: final.usage || null, stop_reason: final.stop_reason || "end_turn" });
  } catch (e) {
    onError(e instanceof Error ? e : new Error(String(e)));
  }
}

function resetProc() {
  if (_proc) { try { _proc.kill("SIGTERM"); } catch (_) {} _proc = null; }
  _stdoutBuf = "";
  if (_activeRequest) { _activeRequest.onError(new Error("session reset")); _activeRequest = null; }
}

const server = http.createServer((req, res) => {
  console.log(`[chat-proxy] ${req.method} ${req.url}`);
  if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders); res.end(); return; }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, backend: BACKEND, mode: BACKEND === "api" ? "anthropic-api-stream" : "claude-cli-stream", running: BACKEND === "api" ? true : !!_proc, model: BACKEND === "api" ? DEFAULT_MODEL : null, db: DB_PATH ? { path: DB_PATH, loaded: existsSync(DB_PATH) } : null }));
    return;
  }
  if (req.method === "POST" && req.url === "/reset") {
    resetProc();
    res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url.startsWith("/load-gedcom")) {
    if (!DB_PATH) {
      res.writeHead(400, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "no KF_DB_PATH configured; restart proxy with KF_DB_PATH=/some/path.db" }));
      return;
    }
    const u = new URL(req.url, "http://x");
    const mode = (u.searchParams.get("mode") || "add").toLowerCase();
    if (mode !== "add" && mode !== "replace") {
      res.writeHead(400, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: `mode must be "add" or "replace" (got "${mode}")` }));
      return;
    }
    const rawName = decodeURIComponent(req.headers["kf-filename"] || "").replace(/\.(ged|gedcom)$/i, "").trim();
    const sourceName = rawName || "untitled-" + new Date().toISOString().slice(0, 19).replace(/[:T-]/g, "");
    const chunks = [];
    let bytes = 0, tooBig = false;
    req.on("data", c => {
      bytes += c.length;
      if (bytes > MAX_GED_BYTES) { tooBig = true; return; }
      chunks.push(c);
    });
    req.on("end", async () => {
      if (tooBig) {
        res.writeHead(413, { ...corsHeaders, "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `GEDCOM exceeds ${MAX_GED_BYTES} bytes` }));
        return;
      }
      const buf = Buffer.concat(chunks);
      const tmpGed = DB_PATH + ".ged.tmp";
      try {
        writeFileSync(tmpGed, buf);
      } catch (e) {
        res.writeHead(500, { ...corsHeaders, "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "write failed: " + (e.message || e) }));
        return;
      }
      // For "replace": delete any existing rows for this source name BEFORE
      // running the script, since the script errors on duplicate-name.
      if (mode === "replace") {
        try { await deleteSourceByName(sourceName); }
        catch (e) {
          try { unlinkSync(tmpGed); } catch (_) {}
          res.writeHead(500, { ...corsHeaders, "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "replace pre-delete failed: " + (e.message || e) }));
          return;
        }
      }
      // Close the read-only handle so the build script can take exclusive write access.
      if (_db) { try { _db.close(); } catch (_) {} _db = null; }
      const t0 = Date.now();
      const child = spawn(process.execPath, [GEDCOM_TO_SQLITE, DB_PATH, tmpGed, sourceName], {
        cwd: HERE,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", c => { stderr += c; });
      child.on("error", err => {
        try { unlinkSync(tmpGed); } catch (_) {}
        res.writeHead(500, { ...corsHeaders, "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "spawn failed: " + err.message }));
      });
      child.on("exit", async code => {
        try { unlinkSync(tmpGed); } catch (_) {}
        if (code !== 0) {
          // exit code 3 = duplicate source name; everything else is a build failure.
          const status = code === 3 ? 409 : 500;
          res.writeHead(status, { ...corsHeaders, "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: `gedcom-to-sqlite exited ${code}`, stderr }));
          return;
        }
        // _db will reopen on next SQL request and see the new source.
        // Conversation history may now reference a tree that no longer exists
        // (replace) or a tree the user didn't have when they spoke (add); reset.
        resetProc();
        const buildMs = Date.now() - t0;
        // Re-run the cross-source record linker. Idempotent (auto links wiped,
        // manual confirms preserved). Failure here is non-fatal — the load
        // itself succeeded; user just won't see updated link suggestions.
        const link = await runQualityAndLink();
        res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: DB_PATH, source_name: sourceName, mode, build_ms: buildMs, link, stderr }));
      });
    });
    return;
  }
  if (req.method === "GET" && req.url === "/sources") {
    (async () => {
      try {
        const db = await getDb();
        if (!db) {
          res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, sources: [] }));
          return;
        }
        // sources table may not exist yet on a fresh DB.
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sources'").get();
        const rows = has ? db.prepare("SELECT id, name, loaded_at, n_individuals, n_events, n_families FROM sources ORDER BY id").all() : [];
        res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, sources: rows }));
      } catch (e) {
        res.writeHead(500, { ...corsHeaders, "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
      }
    })();
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/links")) {
    (async () => {
      try {
        const u = new URL(req.url, "http://x");
        const filters = ["1=1"];
        const params = [];
        const sa = u.searchParams.get("source_a");
        const sb = u.searchParams.get("source_b");
        const src = u.searchParams.get("source");
        if (sa) { filters.push("l.source_a = ?"); params.push(Number(sa)); }
        if (sb) { filters.push("l.source_b = ?"); params.push(Number(sb)); }
        if (src) { filters.push("(l.source_a = ? OR l.source_b = ?)"); params.push(Number(src), Number(src)); }
        const minScore = parseFloat(u.searchParams.get("min_score") || "0");
        const maxScore = parseFloat(u.searchParams.get("max_score") || "1");
        filters.push("l.score BETWEEN ? AND ?"); params.push(minScore, maxScore);
        const origin = u.searchParams.get("origin");
        if (origin === "auto") filters.push("l.origin LIKE 'auto:%'");
        else if (origin === "confirmed") filters.push("l.origin = 'manual:confirmed'");
        else if (origin === "rejected") filters.push("l.origin = 'manual:rejected'");
        else if (origin === "ambiguous") filters.push("l.origin = 'manual:ambiguous'");
        else if (origin === "manual") filters.push("l.origin LIKE 'manual:%'");
        else if (origin === "unlabeled") filters.push("l.origin LIKE 'auto:%'");
        else if (origin === "review") filters.push("l.origin LIKE 'auto:%' AND l.score < 0.85");
        const limit = Math.min(parseInt(u.searchParams.get("limit") || "100", 10), 500);
        const db = await getDb();
        if (!db) {
          res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, links: [] }));
          return;
        }
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='person_links'").get();
        if (!has) {
          res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, links: [] }));
          return;
        }
        const sql = `
          SELECT l.link_id, l.source_a, l.indi_a, ia.name AS name_a, ia.birth_year AS birth_a, ia.death_year AS death_a, ia.sex AS sex_a,
                 l.source_b, l.indi_b, ib.name AS name_b, ib.birth_year AS birth_b, ib.death_year AS death_b, ib.sex AS sex_b,
                 l.score, l.evidence, l.origin, l.created_at, l.label_reason, l.label_confidence,
                 sa.name AS source_a_name, sb.name AS source_b_name
          FROM person_links l
          JOIN individuals ia ON ia.source_id = l.source_a AND ia.id = l.indi_a
          JOIN individuals ib ON ib.source_id = l.source_b AND ib.id = l.indi_b
          JOIN sources sa ON sa.id = l.source_a
          JOIN sources sb ON sb.id = l.source_b
          WHERE ${filters.join(" AND ")}
          ORDER BY l.score DESC, l.link_id ASC
          LIMIT ?
        `;
        params.push(limit);
        const rows = db.prepare(sql).all(...params);
        for (const r of rows) {
          if (r.evidence) { try { r.evidence = JSON.parse(r.evidence); } catch (_) {} }
        }
        if (u.searchParams.get("include") === "family" && rows.length > 0) {
          // Hydrate parents + children + per-person anomaly flags. One pass
          // per shape, keyed by (source_id, indi_id), to keep the cost linear.
          const persons = new Map();
          for (const r of rows) {
            persons.set(`${r.source_a}|${r.indi_a}`, { src: r.source_a, id: r.indi_a, side: "a", row: r });
            persons.set(`${r.source_b}|${r.indi_b}`, { src: r.source_b, id: r.indi_b, side: "b", row: r });
          }
          const lite = (i) => i && { id: i.id, name: i.name, birth_year: i.birth_year, death_year: i.death_year };
          // parents: famc → husb_id/wife_id
          const parentsBy = new Map();
          for (const p of persons.values()) parentsBy.set(`${p.src}|${p.id}`, { father: null, mother: null });
          const parentRows = db.prepare(`
            SELECT i.source_id, i.id AS child_id,
                   fa.id AS fa_id, fa.name AS fa_name, fa.birth_year AS fa_birth, fa.death_year AS fa_death,
                   mo.id AS mo_id, mo.name AS mo_name, mo.birth_year AS mo_birth, mo.death_year AS mo_death
            FROM individuals i
            LEFT JOIN families  f  ON f.source_id  = i.source_id AND f.id  = i.famc
            LEFT JOIN individuals fa ON fa.source_id = f.source_id AND fa.id = f.husb_id
            LEFT JOIN individuals mo ON mo.source_id = f.source_id AND mo.id = f.wife_id
            WHERE i.famc IS NOT NULL
          `).all();
          for (const pr of parentRows) {
            const k = `${pr.source_id}|${pr.child_id}`;
            if (!parentsBy.has(k)) continue;
            parentsBy.set(k, {
              father: pr.fa_id ? { id: pr.fa_id, name: pr.fa_name, birth_year: pr.fa_birth, death_year: pr.fa_death } : null,
              mother: pr.mo_id ? { id: pr.mo_id, name: pr.mo_name, birth_year: pr.mo_birth, death_year: pr.mo_death } : null,
            });
          }
          // children: families where person is husb or wife → family_children → individuals
          const childrenBy = new Map();
          for (const p of persons.values()) childrenBy.set(`${p.src}|${p.id}`, []);
          const childRows = db.prepare(`
            SELECT f.source_id, f.husb_id AS h_parent, f.wife_id AS w_parent,
                   ci.id AS child_id, ci.name AS child_name, ci.birth_year AS child_birth, ci.death_year AS child_death
            FROM families f
            JOIN family_children fc ON fc.source_id = f.source_id AND fc.family_id = f.id
            JOIN individuals ci    ON ci.source_id = f.source_id AND ci.id = fc.child_id
          `).all();
          for (const cr of childRows) {
            for (const parentId of [cr.h_parent, cr.w_parent]) {
              if (!parentId) continue;
              const k = `${cr.source_id}|${parentId}`;
              const arr = childrenBy.get(k);
              if (!arr) continue;
              arr.push({ id: cr.child_id, name: cr.child_name, birth_year: cr.child_birth, death_year: cr.child_death });
            }
          }
          // anomalies for any person in the batch
          const haveAnoms = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='data_anomalies'").get();
          const anomBy = new Map();
          if (haveAnoms) {
            const anomRows = db.prepare(
              "SELECT source_id, indi_id, kind, severity, detail FROM data_anomalies"
            ).all();
            for (const a of anomRows) {
              const k = `${a.source_id}|${a.indi_id}`;
              if (!persons.has(k)) continue;
              let arr = anomBy.get(k);
              if (!arr) { arr = []; anomBy.set(k, arr); }
              let detail = null;
              try { detail = a.detail ? JSON.parse(a.detail) : null; } catch (_) {}
              arr.push({ kind: a.kind, severity: a.severity, detail });
            }
          }
          for (const r of rows) {
            const ka = `${r.source_a}|${r.indi_a}`;
            const kb = `${r.source_b}|${r.indi_b}`;
            r.parents_a  = parentsBy.get(ka)  || { father: null, mother: null };
            r.parents_b  = parentsBy.get(kb)  || { father: null, mother: null };
            r.children_a = (childrenBy.get(ka) || []).sort((x, y) => (x.birth_year ?? 9999) - (y.birth_year ?? 9999));
            r.children_b = (childrenBy.get(kb) || []).sort((x, y) => (x.birth_year ?? 9999) - (y.birth_year ?? 9999));
            r.anomalies_a = anomBy.get(ka) || [];
            r.anomalies_b = anomBy.get(kb) || [];
          }
        }
        res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, links: rows }));
      } catch (e) {
        res.writeHead(500, { ...corsHeaders, "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
      }
    })();
    return;
  }
  {
    const m = req.method === "POST" && req.url.match(/^\/links\/(\d+)\/(confirm|reject|ambiguous)$/);
    if (m) {
      const id = Number(m[1]);
      const action = m[2];
      let body = "";
      req.on("data", c => { body += c; if (body.length > 8192) body = body.slice(0, 8192); });
      req.on("end", async () => {
        try {
          let reason = null, confidence = null;
          if (body) {
            try {
              const parsed = JSON.parse(body);
              if (typeof parsed.reason === "string") reason = parsed.reason.slice(0, 500) || null;
              if (Number.isFinite(parsed.confidence)) confidence = Math.max(1, Math.min(3, Math.floor(parsed.confidence)));
            } catch (_) { /* ignore body parse errors; treat as no metadata */ }
          }
          const newOrigin =
            action === "confirm" ? "manual:confirmed" :
            action === "reject"  ? "manual:rejected"  :
                                   "manual:ambiguous";
          const updated = await withWritableDb(db => {
            const row = db.prepare("SELECT link_id FROM person_links WHERE link_id = ?").get(id);
            if (!row) return null;
            db.prepare(
              "UPDATE person_links SET origin = ?, label_reason = ?, label_confidence = ? WHERE link_id = ?"
            ).run(newOrigin, reason, confidence, id);
            return { id, origin: newOrigin, reason, confidence };
          });
          if (!updated) {
            res.writeHead(404, { ...corsHeaders, "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "link not found" }));
            return;
          }
          res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ...updated }));
        } catch (e) {
          res.writeHead(500, { ...corsHeaders, "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
        }
      });
      return;
    }
  }
  {
    const m = req.method === "DELETE" && req.url.match(/^\/sources\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      (async () => {
        try {
          const removed = await deleteSourceById(id);
          if (!removed) {
            res.writeHead(404, { ...corsHeaders, "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: `source id ${id} not found` }));
            return;
          }
          // Old conversation may reference removed data.
          resetProc();
          // Re-link: prior auto links involving this source are now stale.
          const link = await runQualityAndLink();
          res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, deleted: removed, link }));
        } catch (e) {
          res.writeHead(500, { ...corsHeaders, "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
        }
      })();
      return;
    }
  }
  if (req.method === "POST" && req.url === "/sql") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", async () => {
      try {
        const { query, limit } = JSON.parse(body);
        if (!query || typeof query !== "string") throw new Error("query required");
        // Read-only safety: block obvious mutation keywords. The DB is also
        // opened with readonly:true so any UPDATE/INSERT/DELETE/DROP would
        // fail at SQLite anyway.
        if (/\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum)\b/i.test(query)) {
          throw new Error("only SELECT queries are allowed");
        }
        const db = await getDb();
        if (!db) throw new Error("no database loaded; set KF_DB_PATH and restart the proxy");
        const stmt = db.prepare(query);
        const rows = stmt.all();
        const max = Math.min(Number(limit) || 200, 1000);
        const truncated = rows.length > max;
        res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, rows: rows.slice(0, max), truncated, totalRows: rows.length }));
      } catch (e) {
        res.writeHead(400, { ...corsHeaders, "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
      }
    });
    return;
  }
  if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
    // Fall through to static file serving (index.html, gazetteer.json, etc.)
    // so the user can open http://localhost:PORT/index.html and skip running
    // a separate static server. Returns true once it has written a response.
    if (tryServeStatic(req, res)) return;
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
    if (BACKEND === "cli" && req.headers["kf-new-session"] === "1") resetProc();
    const { system: rawSystem, messages, model } = parsed;
    res.writeHead(200, {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    function send(obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
    const onDelta = text => send({ delta: text });
    const onDone = ({ usage, stop_reason }) => { send({ done: true, usage, stop_reason }); res.end(); };
    const onError = err => { send({ error: err.message || String(err) }); res.end(); };
    if (BACKEND === "api") {
      streamApi({ rawSystem, model, messages, onDelta, onDone, onError });
    } else {
      // CLI mode: maintains its own session, so flatten system to a string and
      // forward only the latest user turn (the CLI keeps prior history itself).
      const system = Array.isArray(rawSystem)
        ? rawSystem.filter(b => b.type === "text").map(b => b.text).join("\n")
        : rawSystem;
      const lastUser = (messages || []).filter(m => m.role === "user").slice(-1)[0];
      const content = lastUser
        ? (typeof lastUser.content === "string" ? lastUser.content
            : Array.isArray(lastUser.content) ? lastUser.content.filter(b => b.type === "text").map(b => b.text).join("")
            : String(lastUser.content || ""))
        : "";
      streamClaude({ system, model, content, onDelta, onDone, onError });
    }
    req.on("close", () => { /* client disconnected; let upstream finish silently */ });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  if (BACKEND === "api") {
    console.log(`[chat-proxy] listening on http://localhost:${PORT}  mode=anthropic-api-stream  default-model=${DEFAULT_MODEL}`);
    console.log(`[chat-proxy] turns are billed against ANTHROPIC_API_KEY; replies stream back via SSE.`);
  } else {
    console.log(`[chat-proxy] listening on http://localhost:${PORT}  mode=claude-cli-stream  bin=${CLAUDE_BIN}`);
    console.log(`[chat-proxy] one persistent claude process serves all turns; replies stream back via SSE.`);
  }
  console.log(`[chat-proxy] static root: ${STATIC_ROOT}  ->  open http://localhost:${PORT}/index.html`);
  console.log(`[chat-proxy] health: curl http://localhost:${PORT}/health`);
});
