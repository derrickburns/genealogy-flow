// ---------- AI Report Export ----------
// Produces a printable local report from the current AI session. Browsers do
// not let us silently write a PDF, so the report opens a print-ready window
// with an explicit "Save as PDF" action.

function _kfReportEsc(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function _kfReportAttr(s) {
  return _kfReportEsc(s).replace(/\n/g, "&#10;");
}

function _kfReportVisibleMessageText(m) {
  if (m?.role === "user") return String(m.content || "");
  return _kfPlainEnglishEventText(_kfHideToolMarkersInChatText(String(m?.content || "")));
}

function _kfReportHasSignal(m) {
  const raw = _kfReportVisibleMessageText(m).trim();
  if (!raw) return false;
  if (m?.role !== "bot") return raw !== "_thinking..._";
  const normalized = raw
    .replace(/[`*_]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  return !new Set([
    "thinking...",
    "thinking",
    "using the data...",
    "using the data",
  ]).has(normalized);
}

function _kfReportTranscriptMessages() {
  return chatHistory
    .filter(m => m && (m.role === "user" || m.role === "bot"))
    .filter(m => m.kind !== "tool" && m.kind !== "action")
    .filter(_kfReportHasSignal);
}

function _kfReportTreeNames() {
  if (typeof _kfSelectedVizSourceList !== "function") return [];
  return _kfSelectedVizSourceList().map(src => String(src.name || "").replace(/\.ged$/i, "")).filter(Boolean);
}

function _kfReportMapSnapshot() {
  try {
    const shot = window.kfApi?.capturePng?.();
    if (shot?.ok && shot.dataUrl) return shot;
  } catch (e) {
    console.warn("[kf] report map snapshot:", e?.message || e);
  }
  return null;
}

function _kfReportTranscriptHtml(messages) {
  if (!messages.length) {
    return `<section class="card"><h2>AI Conversation</h2><p class="muted">No AI questions or answers are in this session yet.</p></section>`;
  }
  return `<section class="card"><h2>AI Conversation</h2>` + messages.map(m => {
    const raw = _kfReportVisibleMessageText(m);
    const body = m.role === "user" ? `<p>${_kfReportEsc(raw)}</p>` : renderMd(raw);
    const who = m.role === "user" ? "Question" : (m.cached ? "Answer (cached)" : "Answer");
    return `<article class="turn ${m.role}"><h3>${who}</h3><div>${body}</div></article>`;
  }).join("") + `</section>`;
}

function _kfReportPlainText(messages) {
  const lines = ["Kindred Flow AI Report", ""];
  for (const m of messages) {
    const label = m.role === "user" ? "Question" : "Answer";
    const raw = _kfReportVisibleMessageText(m);
    lines.push(`${label}:`, raw.replace(/\s+/g, " ").trim(), "");
  }
  lines.push("Open the attached report in a browser, then print or save as PDF.");
  return lines.join("\n");
}

function _kfReportMapHtml(snapshot) {
  const title = `Map at ${Math.floor(curYear)}`;
  if (!snapshot?.dataUrl) {
    return `<section class="card"><h2>${_kfReportEsc(title)}</h2><p class="muted">The map snapshot was not available.</p></section>`;
  }
  return `<section class="card"><h2>${_kfReportEsc(title)}</h2><img class="map-shot" src="${_kfReportAttr(snapshot.dataUrl)}" alt="Current map snapshot"></section>`;
}

function _kfReportVizHtml() {
  if (!_kfVizList.length) return "";
  return `<section class="card"><h2>Visualizations</h2>` + _kfVizList.map(v => {
    let srcdoc = "";
    try { srcdoc = _kfVizSrcDoc(v.type, v.spec); }
    catch (e) {
      srcdoc = `<!doctype html><html><body><pre>${_kfReportEsc(e?.message || e)}</pre></body></html>`;
    }
    return `<article class="viz-report"><h3>${_kfReportEsc(v.title || v.type)}</h3>` +
      `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${_kfReportAttr(srcdoc)}" title="${_kfReportAttr(v.title || v.type)}"></iframe>` +
      `</article>`;
  }).join("") + `</section>`;
}

function _kfReportFilename() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `kindred-flow-ai-report-${y}-${m}-${day}.html`;
}

function _kfReportHtml({ messages, snapshot, email = "" }) {
  const trees = _kfReportTreeNames();
  const generated = new Date().toLocaleString();
  const dateRange = (Number.isFinite(minYear) && Number.isFinite(maxYear)) ? `${minYear}-${maxYear}` : "";
  const emailTools = email
    ? `<button id="emailReportBtn" onclick="window.__kfEmailReport && window.__kfEmailReport()">Email to me</button><span id="emailStatus">Sends a print-ready attachment to ${_kfReportEsc(email)}.</span>`
    : `<span id="emailStatus">Sign in to email this report to yourself.</span>`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Kindred Flow AI Report</title>
  <style>
    :root { color-scheme: light; --ink:#151c2c; --muted:#5f6d86; --line:#dce5f0; --panel:#fff; --soft:#f4f7fb; }
    * { box-sizing:border-box; }
    body { margin:0; padding:32px; background:var(--soft); color:var(--ink); font:14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .toolbar { position:sticky; top:0; z-index:2; display:flex; align-items:center; gap:12px; margin:-32px -32px 24px; padding:14px 32px; background:rgba(244,247,251,0.96); border-bottom:1px solid var(--line); backdrop-filter:blur(8px); }
    .toolbar button { border:0; border-radius:10px; background:#294c8f; color:#fff; font-weight:800; padding:10px 14px; cursor:pointer; }
    .toolbar button:disabled { opacity:0.5; cursor:not-allowed; }
    .toolbar span { color:var(--muted); font-size:13px; }
    header { margin-bottom:22px; }
    h1 { margin:0 0 6px; font-size:28px; letter-spacing:-0.03em; }
    h2 { margin:0 0 14px; font-size:18px; }
    h3 { margin:0 0 8px; font-size:12px; letter-spacing:0.08em; text-transform:uppercase; color:#32405d; }
    .meta { color:var(--muted); display:flex; flex-wrap:wrap; gap:8px 16px; }
    .card { page-break-inside:avoid; margin:0 0 18px; padding:18px; background:var(--panel); border:1px solid var(--line); border-radius:16px; box-shadow:0 10px 28px rgba(28,42,70,0.06); }
    .turn { page-break-inside:avoid; border-top:1px solid var(--line); padding-top:14px; margin-top:14px; }
    .turn:first-of-type { border-top:0; padding-top:0; margin-top:0; }
    .turn.user { background:#f7f9fc; border-radius:12px; padding:12px; border:1px solid #e9eef6; }
    .turn.bot p { margin:0 0 8px; }
    .turn.bot ul, .turn.bot ol { padding-left:22px; }
    .muted { color:var(--muted); }
    .map-shot { display:block; width:100%; max-height:72vh; object-fit:contain; border:1px solid var(--line); border-radius:12px; background:#d7e7f0; }
    .viz-report { page-break-inside:avoid; margin-top:16px; padding-top:16px; border-top:1px solid var(--line); }
    .viz-report:first-of-type { margin-top:0; padding-top:0; border-top:0; }
    .viz-report iframe { width:100%; height:520px; border:1px solid var(--line); border-radius:12px; background:#fff; }
    code { background:#eef3fa; border-radius:4px; padding:1px 4px; }
    table { border-collapse:collapse; width:100%; }
    th, td { border:1px solid var(--line); padding:6px 8px; text-align:left; }
    th { background:#f4f7fb; }
    @page { margin:0.55in; }
    @media print {
      body { padding:0; background:#fff; }
      .toolbar { display:none; }
      .card { box-shadow:none; border-color:#cfd8e5; }
      .viz-report iframe { height:620px; }
    }
  </style>
</head>
<body>
  <div class="toolbar"><button onclick="window.print()">Save as PDF</button>${emailTools}</div>
  <header>
    <h1>Kindred Flow AI Report</h1>
    <div class="meta">
      <span>Generated ${_kfReportEsc(generated)}</span>
      <span>Year ${_kfReportEsc(String(Math.floor(curYear)))}</span>
      ${dateRange ? `<span>Data range ${_kfReportEsc(dateRange)}</span>` : ""}
      ${trees.length ? `<span>Trees: ${_kfReportEsc(trees.join(", "))}</span>` : ""}
    </div>
  </header>
  ${_kfReportTranscriptHtml(messages)}
  ${_kfReportMapHtml(snapshot)}
  ${_kfReportVizHtml()}
</body>
</html>`;
}

function _kfExportAiReport() {
  const messages = _kfReportTranscriptMessages();
  const snapshot = _kfReportMapSnapshot();
  const email = typeof _kfCurrentAuthEmail === "function" ? _kfCurrentAuthEmail() : "";
  const html = _kfReportHtml({ messages, snapshot, email });
  const emailHtml = _kfReportHtml({ messages, snapshot, email: "" });
  const subject = `Kindred Flow AI report - ${new Date().toLocaleDateString()}`;
  const filename = _kfReportFilename();
  const text = _kfReportPlainText(messages);
  const win = window.open("", "_blank", "width=1100,height=900");
  if (!win) return { error: "popup blocked; allow popups to create the printable report" };
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.__kfEmailReport = async () => {
    const btn = win.document.getElementById("emailReportBtn");
    const status = win.document.getElementById("emailStatus");
    if (!email) {
      if (status) status.textContent = "Sign in to email this report to yourself.";
      return;
    }
    if (btn) btn.disabled = true;
    if (status) status.textContent = `Sending to ${email}...`;
    try {
      const headers = { "Content-Type": "application/json", ...(typeof _kfAuthHeaders === "function" ? _kfAuthHeaders() : {}) };
      const resp = await fetch("/api/reports/email", {
        method: "POST",
        headers,
        body: JSON.stringify({ subject, html: emailHtml, text, filename }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) throw new Error(data.error || `email failed (${resp.status})`);
      if (status) status.textContent = `Sent to ${data.to || email}. Open the attachment to print.`;
    } catch (e) {
      if (status) status.textContent = `Could not email report: ${e.message || e}`;
      if (btn) btn.disabled = false;
    }
  };
  win.focus();
  return { ok: true, questions: messages.filter(m => m.role === "user").length, answers: messages.filter(m => m.role === "bot").length, visualizations: _kfVizList.length, map: !!snapshot };
}

$("chatPdf")?.addEventListener("click", () => _kfExportAiReport());
