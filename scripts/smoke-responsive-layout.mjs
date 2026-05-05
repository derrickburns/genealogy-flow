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
      throw new Error(`Could not create a Chrome CDP target at ${cdpUrl}. PUT: ${putErr.message}; GET: ${getErr.message}`);
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

async function runCase({ name, width, height, compact }) {
  const target = await createTarget();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: compact,
      screenWidth: width,
      screenHeight: height,
    });
    const url = `${appUrl}${appUrl.includes("?") ? "&" : "?"}smoke=${encodeURIComponent(name)}-${Date.now()}`;
    await client.send("Page.navigate", { url });
    await waitFor(client, "document.readyState === 'complete'", `${name} document load`);
    await waitFor(
      client,
      "window.kfDebug && window.kfDebug.treeSnapshot && window.kfDebug.treeSnapshot().trees.loaded_count >= 1",
      `${name} demo tree load`,
      30000,
    );
    await client.eval(`document.querySelector('#sideTabs [data-side-tab="trees"]')?.click()`);
    const snapshot = await waitFor(
      client,
      `(() => {
        const tree = window.kfDebug.treeSnapshot();
        const errors = window.kfDebug.clientErrors?.() || [];
        const sourcesPanel = document.getElementById("sourcesPanel");
        const treesPane = document.getElementById("treesPane");
        const visibleText = treesPane?.innerText || "";
        return {
          ok: tree.layout.compact === ${compact} &&
            tree.trees.loaded_count >= 1 &&
            tree.trees.selected_count >= 1 &&
            sourcesPanel &&
            !sourcesPanel.classList.contains("hidden") &&
            /Trees/i.test(visibleText) &&
            /Visualized/i.test(visibleText),
          compact: tree.layout.compact,
          tab: tree.layout.tab,
          sheet: tree.layout.sheet,
          loaded: tree.trees.loaded_count,
          selected: tree.trees.selected_count,
          sourcesPanelHidden: sourcesPanel?.classList.contains("hidden"),
          visibleText,
          errors
        };
      })()`,
      `${name} trees panel state`,
      20000,
      value => !!value?.ok,
    );
    assert.equal(snapshot.ok, true, `${name} trees panel should be ready`);
    assert.equal(snapshot.compact, compact, `${name} compact layout flag`);
    assert.ok(snapshot.loaded >= 1, `${name} should load at least one tree`);
    assert.ok(snapshot.selected >= 1, `${name} should select at least one tree`);
    assert.equal(snapshot.sourcesPanelHidden, false, `${name} sources panel should be visible`);
    assert.equal(snapshot.errors.length, 0, `${name} should not record client errors`);
    console.log(`${name} responsive smoke passed: ${snapshot.loaded} loaded, ${snapshot.selected} selected, sheet=${snapshot.sheet || "none"}`);
  } finally {
    try { await client.send("Page.close"); } catch (_) {}
    client.close();
  }
}

await cdpFetch("/json/version").catch(e => {
  throw new Error(`Chrome CDP is not reachable at ${cdpUrl}: ${e.message}`);
});

await runCase({ name: "desktop", width: 1180, height: 900, compact: false });
await runCase({ name: "compact", width: 500, height: 844, compact: true });
