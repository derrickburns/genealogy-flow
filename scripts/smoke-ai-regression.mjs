#!/usr/bin/env node
import assert from "node:assert/strict";

const appUrl = process.env.KF_APP_URL || process.argv[2] || "http://127.0.0.1:8791/";
const cdpUrl = (process.env.KF_CDP_URL || "http://127.0.0.1:18800").replace(/\/$/, "");

if (typeof WebSocket !== "function") {
  throw new Error("This smoke test requires a Node runtime with global WebSocket support.");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cdpFetch(path, opts = {}) {
  const resp = await fetch(`${cdpUrl}${path}`, opts);
  if (!resp.ok) throw new Error(`${path} failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function createTarget() {
  try {
    return await cdpFetch(`/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
  } catch (putErr) {
    try {
      return await cdpFetch(`/json/new?${encodeURIComponent("about:blank")}`);
    } catch (getErr) {
      throw new Error(`Could not create Chrome CDP target at ${cdpUrl}. PUT: ${putErr.message}; GET: ${getErr.message}`);
    }
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("CDP websocket failed to open")), { once: true });
    });
    this.ws.addEventListener("message", event => {
      const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
      const message = JSON.parse(raw);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result || {});
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
    });
  }

  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return result.result?.value;
  }

  close() {
    this.ws.close();
  }
}

async function waitFor(client, expression, label, timeoutMs = 20000, predicate = Boolean) {
  const start = Date.now();
  let lastValue;
  while (Date.now() - start < timeoutMs) {
    try {
      lastValue = await client.eval(expression);
      if (predicate(lastValue)) return lastValue;
    } catch (e) {
      lastValue = e.message;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
}

async function callApi(client, method, args = null, opts = {}) {
  const expr = `(async () => {
    const method = ${JSON.stringify(method)};
    const args = ${JSON.stringify(args)};
    const fn = window.kfApi && window.kfApi[method];
    if (typeof fn !== "function") return { error: "missing kfApi method: " + method };
    try {
      return ${opts.spread ? "await fn.apply(window.kfApi, args)" : "await fn.call(window.kfApi, args)"};
    } catch (e) {
      return { error: e && e.message || String(e) };
    }
  })()`;
  return client.eval(expr);
}

function assertOk(result, label) {
  assert.ok(result && !result.error, `${label} failed: ${JSON.stringify(result)}`);
  assert.equal(result.ok, true, `${label} should return ok: ${JSON.stringify(result)}`);
}

async function dismissStartupDialogs(client) {
  await client.eval(`(() => {
    const terms = document.getElementById("termsModal");
    if (terms && !terms.hidden) {
      const check = document.getElementById("termsAcceptCheck");
      const button = document.getElementById("termsAcceptBtn");
      if (check && button) {
        check.checked = true;
        check.dispatchEvent(new Event("change", { bubbles: true }));
        button.click();
      }
    }
    const splash = document.getElementById("splash");
    if (splash && !splash.hidden) document.getElementById("splashDismiss")?.click();
  })()`);
}

async function showExploreTab(client) {
  await client.eval(`document.querySelector('#sideTabs [data-side-tab="chat"]')?.click()`);
  await waitFor(
    client,
    `document.getElementById("panel")?.dataset.activeTab === "chat" || document.querySelector("#chatPanel .sidePane.on")?.id === "chatPane"`,
    "Explore tab active",
    10000,
  );
}

async function collectAllSuggestedQuestions(client) {
  await showExploreTab(client);
  await waitFor(
    client,
    `window.kfDebug?.suggestedQuestionTexts?.().length >= 3`,
    "primary suggested questions",
    15000,
  );
  const beforeMore = await client.eval(`(() => {
    const btn = document.querySelector("[data-chat-more]");
    return { hasMore: !!btn, text: btn?.textContent || "" };
  })()`);
  assert.equal(beforeMore.hasMore, true, "Explore should expose a More ideas control when secondary questions exist");
  await client.eval(`document.querySelector("[data-chat-more]")?.click()`);
  const questions = await waitFor(
    client,
    `(() => {
      const rows = window.kfDebug?.suggestedQuestionTexts?.() || [];
      const seen = new Set();
      return rows.filter(q => q.text && !seen.has(q.text) && seen.add(q.text));
    })()`,
    "all suggested questions",
    10000,
    value => Array.isArray(value) && value.length >= 8,
  );
  assert.ok(questions.length >= 8, `expected primary plus More ideas questions, got ${questions.length}`);
  return questions;
}

async function clickEverySuggestedQuestion(client, questions) {
  await client.eval(`window._kfAiRegressionSuggestedQuestions = []`);
  const clickedTexts = [];
  for (let i = 0; i < 20; i++) {
    await client.eval(`(() => {
      const more = document.querySelector("[data-chat-more]");
      if (more && more.getAttribute("aria-expanded") !== "true") more.click();
    })()`);
    await sleep(120);
    const clicked = await client.eval(`(() => {
      const already = new Set(${JSON.stringify(clickedTexts)});
      const btn = [...document.querySelectorAll("[data-chat-scope-question]")]
        .find(el => {
          const text = el.getAttribute("data-chat-scope-question") || "";
          return text && !already.has(text);
        });
      if (!btn) return null;
      const text = btn.getAttribute("data-chat-scope-question") || "";
      btn.click();
      return text;
    })()`);
    if (!clicked) break;
    clickedTexts.push(clicked);
    await waitFor(
      client,
      `window._kfAiRegressionSuggestedQuestions?.length === ${clickedTexts.length}`,
      `suggested question dispatch ${clickedTexts.length}`,
      10000,
    );
    await sleep(560);
  }
  const captured = await client.eval(`window._kfAiRegressionSuggestedQuestions || []`);
  assert.deepEqual(captured, clickedTexts, "suggested questions should dispatch exactly once and in order");
  assert.ok(
    captured.length >= Math.min(questions.length, 8),
    `expected to dispatch the primary and More ideas pool; initial=${questions.length}, captured=${captured.length}`,
  );
}

async function personNames(client) {
  const result = await callApi(client, "findPeople", { limit: 30, mustHavePlace: true });
  assertOk(result, "findPeople");
  const names = (result.rows || []).map(row => row.name).filter(Boolean);
  assert.ok(names.length >= 2, "rendering tests need at least two named people");
  return names;
}

async function traceablePair(client, names) {
  for (const name of names.slice(0, 12)) {
    const ancestors = await callApi(client, "getAncestors", [name, 5], { spread: true });
    if (ancestors?.ok && ancestors.ancestors?.length) {
      return [name, ancestors.ancestors[0].name];
    }
  }
  return null;
}

async function assertKfCallParser(client) {
  const chain = await client.eval(`window.kfDebug.runKfCallText(${JSON.stringify(
    '<<KFCALL:chain([{"method":"setActiveTree","args":"Golden-Rosenberg"},{"method":"setShowFilter","args":"all"},{"method":"setYear","args":1910}])>>'
  )})`);
  assert.equal(chain.results?.length, 1, "chain KFCALL should produce one tool result");
  assert.ok(!chain.results[0].result?.error, `chain([...]) parser should not fail: ${JSON.stringify(chain)}`);

  const positional = await client.eval(`window.kfDebug.runKfCallText(${JSON.stringify(
    "<<KFCALL:playRange(1910,1911,2)>>"
  )})`);
  assert.equal(positional.results?.length, 1, "positional KFCALL should produce one tool result");
  assert.ok(!positional.results[0].result?.error, `playRange(1910,1911,2) should be accepted: ${JSON.stringify(positional)}`);
  await callApi(client, "pause");
}

async function assertShowVizTypes(client) {
  const cases = [
    ["vega", {
      "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
      width: 240,
      height: 160,
      data: { values: [{ label: "A", n: 2 }, { label: "B", n: 5 }] },
      mark: "bar",
      encoding: {
        x: { field: "label", type: "nominal" },
        y: { field: "n", type: "quantitative" },
      },
    }, "vegaEmbed"],
    ["mermaid", "graph TD\\nA[Ancestor]-->B[Descendant]", "mermaid.initialize"],
    ["dot", "digraph G { A -> B; }", "viz-standalone"],
    ["svg", "<svg xmlns='http://www.w3.org/2000/svg' width='260' height='120'><rect width='260' height='120' fill='#f8fafc'/><circle cx='70' cy='60' r='30' fill='#2563eb'/><text x='120' y='66' font-size='20'>SVG OK</text></svg>", "SVG OK"],
    ["html", "<section><h1>Regression HTML</h1><p>HTML renderer works.</p></section>", "Regression HTML"],
    ["markdown", "# Regression Markdown\\n\\nMarkdown renderer works.", "marked.parse"],
  ];
  for (const [type, spec, expected] of cases) {
    const result = await callApi(client, "showViz", { type, title: `Regression ${type}`, spec });
    assertOk(result, `showViz ${type}`);
    const state = await waitFor(
      client,
      `(() => {
        const state = window.kfDebug.vizState();
        const frame = document.getElementById("vizFrame");
        const tab = document.querySelector('.vizTab[data-id="${result.id}"]');
        return {
          ok: state.active === ${result.id} && !!tab && frame?.srcdoc?.includes(${JSON.stringify(expected)}),
          state,
          hasTab: !!tab,
          srcdocPreview: frame?.srcdoc?.slice(0, 400) || ""
        };
      })()`,
      `showViz ${type} visible`,
      10000,
      value => !!value?.ok,
    );
    assert.ok(state.ok, `showViz ${type} should render a tab and srcdoc`);
  }
}

async function assertLensShapes(client) {
  const lenses = [
    ["state", "SELECT 'MI' AS state, 3 AS n"],
    ["country", "SELECT 'US' AS country, 5 AS n"],
    ["latlon", "SELECT 42.3314 AS lat, -83.0458 AS lon, 7 AS n"],
    ["line", "SELECT 55.7558 AS from_lat, 37.6173 AS from_lon, 42.3314 AS to_lat, -83.0458 AS to_lon"],
    ["arc", "SELECT 55.7558 AS from_lat, 37.6173 AS from_lon, 38.6270 AS to_lat, -90.1994 AS to_lon"],
  ];
  for (const [shape, sql] of lenses) {
    const name = `regression-${shape}-${Date.now()}`;
    const saved = await callApi(client, "saveLens", { name, sql, shape, label: `Regression ${shape}` });
    assertOk(saved, `saveLens ${shape}`);
    const active = await callApi(client, "activateLens", name);
    assertOk(active, `activateLens ${shape}`);
    const caption = await callApi(client, "setLensCaption", `Regression ${shape} lens`);
    assertOk(caption, `setLensCaption ${shape}`);
    const state = await waitFor(
      client,
      `(() => {
        const s = window.kfDebug.lensState();
        return { ok: s.active === ${JSON.stringify(name)} && s.rows > 0, state: s };
      })()`,
      `lens ${shape} rows`,
      10000,
      value => !!value?.ok,
    );
    assert.ok(state.ok, `lens ${shape} should activate and render rows`);
  }
  assertOk(await callApi(client, "activateLens", null), "clear active lens");
}

async function assertMapRenderingActions(client, names) {
  assertOk(await callApi(client, "setYear", 1925), "setYear");
  assertOk(await callApi(client, "setWindow", 8), "setWindow");
  assertOk(await callApi(client, "setShowFilter", "all"), "setShowFilter all");
  assertOk(await callApi(client, "setKinLines", 3), "setKinLines");
  assertOk(await callApi(client, "setClusterMode", "none"), "setClusterMode none");
  for (const mode of ["pie", "parents", "gender", "tree", "state", "dispersion"]) {
    assertOk(await callApi(client, "setClusterMode", mode), `setClusterMode ${mode}`);
  }
  assertOk(await callApi(client, "addPin", { lat: 42.3314, lon: -83.0458, label: "Detroit regression pin" }), "addPin");
  assertOk(await callApi(client, "addRoute", {
    points: [
      { lat: 55.7558, lon: 37.6173, label: "Russia" },
      { lat: 42.3314, lon: -83.0458, label: "Detroit" },
      { lat: 38.6270, lon: -90.1994, label: "St. Louis" },
    ],
    label: "Russia to Midwest regression route",
  }), "addRoute");
  assertOk(await callApi(client, "selectPerson", names[0]), "selectPerson");
  assertOk(await callApi(client, "centerOn", names[0]), "centerOn person");
  assertOk(await callApi(client, "centerOn", "Detroit, Michigan, USA"), "centerOn place");
  const pair = await traceablePair(client, names);
  if (pair) assertOk(await callApi(client, "traceLineage", pair, { spread: true }), "traceLineage");
  assertOk(await callApi(client, "clearLineage"), "clearLineage");
  assertOk(await callApi(client, "setHighlight", [names.slice(0, 2), { color: [255, 64, 64] }], { spread: true }), "setHighlight");
  assertOk(await callApi(client, "clearHighlight"), "clearHighlight");
  const group = await callApi(client, "createGroupSet", {
    name: "Regression groups",
    question: "Regression group rendering",
    activate: true,
    showTimeline: true,
    groups: [
      { label: "First person", people: [names[0]] },
      { label: "Second person", people: [names[1]] },
    ],
  });
  assertOk(group, "createGroupSet");
  assertOk(await callApi(client, "setClusterMode", "group"), "setClusterMode group");
  assertOk(await callApi(client, "showYearTour"), "showYearTour");
  assertOk(await callApi(client, "showOutliers", 3), "showOutliers");
  assertOk(await callApi(client, "playRange", [1910, 1912, 2], { spread: true }), "playRange");
  await sleep(400);
  assertOk(await callApi(client, "pause"), "pause");
  assertOk(await callApi(client, "setLoopRange", [1910, 1935], { spread: true }), "setLoopRange");
  assertOk(await callApi(client, "clearLoopRange"), "clearLoopRange");
  const png = await callApi(client, "capturePng");
  assertOk(png, "capturePng");
  assert.ok(/^data:image\/png;base64,/.test(png.dataUrl || ""), "capturePng should return a PNG data URL");
}

async function assertChipDispatch(client) {
  const chip = await client.eval(`window.kfDebug.dispatchChip({
    label: "Regression chip route",
    method: "addRoute",
    args: {
      points: [{ lat: 55.7558, lon: 37.6173, label: "Russia" }, { lat: 42.3314, lon: -83.0458, label: "Detroit" }],
      label: "Regression chip route"
    }
  })`);
  assert.equal(chip, true, `chat chip dispatch should report success: ${JSON.stringify(chip)}`);
}

async function assertExportReport(client) {
  await client.eval(`(() => {
    window.__kfReportOpenCalls = [];
    window.__kfOriginalOpenForAiRegression = window.open;
    window.open = (url, target, features) => {
      const doc = {
        html: "",
        open() {},
        write(value) { this.html += String(value || ""); },
        close() {},
        getElementById() { return null; }
      };
      const win = { document: doc, focus() {}, __kfEmailReport: null, url, target, features };
      window.__kfReportOpenCalls.push(win);
      return win;
    };
  })()`);
  const report = await callApi(client, "exportAiReport");
  assertOk(report, "exportAiReport");
  const opened = await client.eval(`(() => {
    const call = window.__kfReportOpenCalls?.[0];
    if (window.__kfOriginalOpenForAiRegression) window.open = window.__kfOriginalOpenForAiRegression;
    return { count: window.__kfReportOpenCalls?.length || 0, html: call?.document?.html?.slice(0, 500) || "" };
  })()`);
  assert.equal(opened.count, 1, "exportAiReport should open one printable report window");
  assert.match(opened.html, /Kindred Flow/i, "exported report should contain Kindred Flow HTML");
}

async function main() {
  await cdpFetch("/json/version").catch(e => {
    throw new Error(`Chrome CDP is not reachable at ${cdpUrl}: ${e.message}`);
  });
  const target = await createTarget();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    const url = `${appUrl}${appUrl.includes("?") ? "&" : "?"}ai-regression=${Date.now()}`;
    await client.send("Page.navigate", { url });
    await waitFor(client, "document.readyState === 'complete'", "document load");
    await dismissStartupDialogs(client);
    await waitFor(
      client,
      `window.kfApi && window.kfDebug && window.kfDebug.treeSnapshot && window.kfDebug.treeSnapshot().trees.loaded_count >= 1`,
      "loaded tree and kfApi",
      40000,
    );

    const questions = await collectAllSuggestedQuestions(client);
    await clickEverySuggestedQuestion(client, questions);
    await assertKfCallParser(client);
    const names = await personNames(client);
    await assertMapRenderingActions(client, names);
    await assertShowVizTypes(client);
    await assertLensShapes(client);
    await assertChipDispatch(client);
    await assertExportReport(client);
    const errors = await client.eval(`window.kfDebug.clientErrors()`);
    assert.deepEqual(errors, [], `AI regression smoke should not record client errors: ${JSON.stringify(errors)}`);
    console.log(`AI regression smoke passed: ${questions.length} suggested questions, 6 viz types, 5 lens shapes, map/chip/report actions`);
  } finally {
    try { await client.send("Page.close"); } catch (_) {}
    client.close();
  }
}

await main();
