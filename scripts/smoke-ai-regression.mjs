#!/usr/bin/env node
import assert from "node:assert/strict";

const appUrl = process.env.KF_APP_URL || process.argv[2] || "http://127.0.0.1:8791/";
const cdpUrl = (process.env.KF_CDP_URL || "http://127.0.0.1:18800").replace(/\/$/, "");
const REAL_MOBILE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

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
    this.ws.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("CDP websocket closed"));
      this.pending.clear();
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

async function emulateRealMobile(client, { width = 390, height = 844, deviceScaleFactor = 3 } = {}) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor,
    mobile: true,
    screenWidth: width,
    screenHeight: height,
    scale: 1,
    screenOrientation: { type: "portraitPrimary", angle: 0 },
  });
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await client.send("Emulation.setUserAgentOverride", {
    userAgent: REAL_MOBILE_USER_AGENT,
    platform: "iPhone",
  });
}

async function assertRealMobileEmulation(client, label) {
  const state = await client.eval(`(() => ({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    coarsePointer: matchMedia("(pointer: coarse)").matches,
    noHover: matchMedia("(hover: none)").matches,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }
  }))()`);
  assert.match(state.userAgent, /iPhone/, `${label} should use an iPhone user agent`);
  assert.equal(state.platform, "iPhone", `${label} should expose iPhone platform`);
  assert.ok(state.maxTouchPoints >= 5, `${label} should expose real multi-touch`);
  assert.equal(state.coarsePointer, true, `${label} should use coarse pointer media`);
  assert.equal(state.noHover, true, `${label} should use no-hover media`);
  assert.equal(state.viewport.width, 390, `${label} viewport width`);
  assert.equal(state.viewport.height, 844, `${label} viewport height`);
  assert.ok(state.viewport.dpr >= 3, `${label} should emulate high DPR mobile`);
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

async function tapPoint(client, x, y) {
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
  });
  await sleep(40);
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function assertMobileImmigrationQuestionTap() {
  const target = await createTarget();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await emulateRealMobile(client);
    await client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `localStorage.setItem("kf-anthropic-key", "smoke-test-key");`,
    });
    const url = `${appUrl}${appUrl.includes("?") ? "&" : "?"}ai-regression=${Date.now()}&mobile-question=1`;
    await client.send("Page.navigate", { url });
    await waitFor(client, "document.readyState === 'complete'", "mobile question document load");
    await assertRealMobileEmulation(client, "mobile question");
    await dismissStartupDialogs(client);
    await waitFor(
      client,
      `window.kfApi && window.kfDebug && window.kfDebug.treeSnapshot && window.kfDebug.treeSnapshot().trees.loaded_count >= 1`,
      "mobile loaded tree and kfApi",
      40000,
    );
    await showExploreTab(client);
    await client.eval(`window._kfAiRegressionSuggestedQuestions = []`);
    const targetButton = await waitFor(
      client,
      `(() => {
        const btn = [...document.querySelectorAll("[data-chat-scope-question]")]
          .find(el => /immigration waves/i.test(el.textContent || ""));
        if (!btn) return null;
        btn.scrollIntoView({ block: "center", inline: "nearest" });
        const r = btn.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          text: btn.getAttribute("data-chat-scope-question") || "",
          x,
          y,
          visible: r.width > 20 && r.height > 20 && r.bottom > 0 && r.top < window.innerHeight &&
            hit && (hit === btn || hit.closest("[data-chat-scope-question]") === btn),
        };
      })()`,
      "mobile Immigration waves suggested question",
      15000,
      value => value?.visible && /waves of immigration/i.test(value.text),
    );
    await tapPoint(client, targetButton.x, targetButton.y);
    await tapPoint(client, targetButton.x, targetButton.y);
    await waitFor(
      client,
      `window._kfAiRegressionSuggestedQuestions?.length === 1`,
      "mobile Immigration waves dispatches once",
      10000,
    );
    const captured = await client.eval(`window._kfAiRegressionSuggestedQuestions || []`);
    assert.equal(captured.length, 1, "double-tapping Immigration waves should dispatch one question");
    assert.match(captured[0], /waves of immigration/i, "mobile tap should dispatch Immigration waves");
  } finally {
    try { await client.send("Page.close"); } catch (_) {}
    client.close();
  }
}

function suggestedButtonLookupScript(question) {
  const text = JSON.stringify(String(question?.text || ""));
  const label = JSON.stringify(String(question?.label || "").toLowerCase());
  return `(() => {
    const expectedText = ${text};
    const label = ${label};
    const buttons = [...document.querySelectorAll("[data-chat-scope-question]")];
    const questionText = el => el.getAttribute("data-chat-scope-question") || "";
    const exact = buttons.find(el => questionText(el) === expectedText);
    if (exact) return exact;
    const original = expectedText.toLowerCase();
    const wants = needle => label.includes(needle) || original.includes(needle);
    if (wants("home person") || wants("selected person")) {
      const person = buttons.find(el => /^(why is .+ shown here|what should i notice about .+ family)\\b/i.test(questionText(el)));
      if (person) return person;
    }
    if (wants("this year") || /explain this year/i.test(original)) {
      const currentYear = buttons.find(el => /^Explain this year in plain language\\.?$/i.test(questionText(el)));
      if (currentYear) return currentYear;
    }
    if (wants("migration story") || /migration story for the visible people/i.test(original)) {
      const migration = buttons.find(el => /^Summarize the migration story for the visible people in \\d{3,4}\\./i.test(questionText(el)));
      if (migration) return migration;
    }
    if (wants("visible people") || /these people visible/i.test(original)) {
      const visible = buttons.find(el => /^Why are these people visible in \\d{3,4}\\?$/i.test(questionText(el)));
      if (visible) return visible;
    }
    if (wants("cluster pattern") || /biggest place or cluster pattern/i.test(original)) {
      const cluster = buttons.find(el => /^Explain the biggest place or cluster pattern in \\d{3,4}\\.?$/i.test(questionText(el)));
      if (cluster) return cluster;
    }
    if (wants("weak evidence") || /weakest location evidence/i.test(original)) {
      const weak = buttons.find(el => /^Find the weakest location evidence in the checked trees at \\d{3,4}\\.?$/i.test(questionText(el)));
      if (weak) return weak;
    }
    if (wants("simplify view") || /simplest way to understand/i.test(original)) {
      const simple = buttons.find(el => /^Give me the simplest way to understand these \\d+ visible people\\.?$/i.test(questionText(el)));
      if (simple) return simple;
    }
    return null;
  })()`;
}

async function clickSuggestedQuestionForAnswer(client, question, { mobile = false } = {}) {
  if (mobile) {
    await client.eval(`document.querySelector("#vizTabBar [data-tab='map']")?.click()`);
    await sleep(120);
  }
  await showExploreTab(client);
  await waitFor(
    client,
    `!document.querySelector("[data-chat-scope-question][aria-busy='true']") && !document.getElementById("chatSend")?.disabled`,
    "chat suggestion controls idle",
    10000,
  );
  await sleep(180);
  await client.eval(`(() => {
    const more = document.querySelector("[data-chat-more]");
    if (more && more.getAttribute("aria-expanded") !== "true") more.click();
  })()`);
  const targetButton = await waitFor(
    client,
    `(() => {
      const btn = ${suggestedButtonLookupScript(question)};
      if (!btn) return null;
      btn.scrollIntoView({ block: "center", inline: "nearest" });
      const r = btn.getBoundingClientRect();
      return {
        text: btn.getAttribute("data-chat-scope-question") || "",
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        visible: r.width > 20 && r.height > 20 && r.bottom > 0 && r.top < window.innerHeight,
      };
    })()`,
    `suggested question visible: ${question.label}`,
    10000,
    value => value?.visible,
  );
  if (mobile) {
    await tapPoint(client, targetButton.x, targetButton.y);
    await sleep(1300);
    const activeAfterTap = await client.eval(
      `document.querySelector("#chatAnswer .chatActiveQuestion p")?.textContent?.trim() === ${JSON.stringify(targetButton.text)}`,
    );
    if (!activeAfterTap) {
      await client.eval(`(() => {
        const btn = ${suggestedButtonLookupScript(question)};
        const text = btn?.getAttribute("data-chat-scope-question") || "";
        if (btn) delete btn.dataset.kfTapHandled;
        if (text && typeof _kfAskQuestion === "function") {
          Promise.resolve(_kfAskQuestion(
            typeof _kfAugmentAiSuggestionQuestion === "function" ? _kfAugmentAiSuggestionQuestion(text) : text,
            { displayText: text, queueIfBusy: true }
          )).catch(e => appendError(e?.message || String(e)));
        }
        else if (text && typeof _kfDispatchChatScopeQuestion === "function") _kfDispatchChatScopeQuestion(text, btn);
        else btn?.click();
      })()`);
    }
  } else await client.eval(`(() => {
    const btn = ${suggestedButtonLookupScript(question)};
    btn?.click();
  })()`);
  await waitFor(
    client,
    `(() => {
      const activeQuestion = document.querySelector("#chatAnswer .chatActiveQuestion p")?.textContent?.trim() || "";
      const btn = ${suggestedButtonLookupScript(question)};
      return {
        ok: activeQuestion === ${JSON.stringify(targetButton.text)},
        activeQuestion,
        expected: ${JSON.stringify(targetButton.text)},
        foundButton: btn?.getAttribute("data-chat-scope-question") || "",
        buttonDisabled: !!btn?.disabled,
        dispatching: typeof _kfChatScopeDispatching !== "undefined" ? _kfChatScopeDispatching : null,
        lastDispatched: typeof _kfChatScopeLastDispatchedSignature !== "undefined" ? _kfChatScopeLastDispatchedSignature : null,
        lastHandledAt: typeof _kfChatScopeLastHandledAt !== "undefined" ? _kfChatScopeLastHandledAt : null,
        activeSignature: typeof _kfActiveChatQuestionSignature !== "undefined" ? _kfActiveChatQuestionSignature : null,
        answerPreview: document.getElementById("chatAnswer")?.innerText?.slice(0, 400) || "",
        errors: window.kfDebug?.clientErrors?.() || []
      };
    })()`,
    `active answer question: ${question.label}`,
    10000,
    value => !!value?.ok,
  );
  return targetButton.text;
}

async function assertMobileExploreAnswerAndVisualizationLayout(client, label) {
  const state = await waitFor(
    client,
    `(() => {
      const visible = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
      };
      const overlap = (a, b) => {
        if (!visible(a) || !visible(b)) return false;
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.left < br.right && ar.right > br.left && ar.top < br.bottom && ar.bottom > br.top;
      };
      const panel = document.getElementById("panel");
      const pane = document.getElementById("vizPane");
      const frame = document.getElementById("vizFrame");
      const tabs = document.getElementById("vizTabBar");
      const auth = document.getElementById("authBar");
      const scope = document.getElementById("chatScope");
      const artifacts = document.getElementById("chatArtifacts");
      const answer = document.querySelector("#chatAnswer .chatActiveAnswer");
      const answerRect = answer?.getBoundingClientRect();
      const frameRect = frame?.getBoundingClientRect();
      const panelRect = panel?.getBoundingClientRect();
      const answerVisibleHeight = answerRect
        ? Math.max(0, Math.min(answerRect.bottom, innerHeight) - Math.max(answerRect.top, 0))
        : 0;
      const clearVizHeight = frameRect && panelRect
        ? Math.max(0, Math.min(frameRect.bottom, panelRect.top) - frameRect.top)
        : 0;
      const minimumVizHeight = Math.min(280, Math.max(180, innerHeight * 0.24));
      return {
        ok: panel?.dataset.activeTab === "chat" &&
          pane?.classList.contains("on") &&
          visible(tabs) &&
          visible(answer) &&
          answerVisibleHeight >= 90 &&
          clearVizHeight >= minimumVizHeight &&
          !visible(scope) &&
          !visible(artifacts) &&
          !overlap(auth, tabs),
        activeTab: panel?.dataset.activeTab || "",
        sheet: panel?.dataset.sheet || "",
        vizOn: pane?.classList.contains("on") || false,
        tabsVisible: visible(tabs),
        answerVisible: visible(answer),
        answerVisibleHeight,
        clearVizHeight,
        minimumVizHeight,
        scopeVisible: visible(scope),
        artifactsVisible: visible(artifacts),
        authVisible: visible(auth),
        authTabsOverlap: overlap(auth, tabs),
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }
      };
    })()`,
    `${label} mobile answer plus visualization layout`,
    10000,
    value => !!value?.ok,
  );
  assert.ok(state.ok, `${label} mobile answer and visualization should both be usable: ${JSON.stringify(state)}`);
}

async function assertAllSuggestedQuestionsTextAndViz({ mobile = false } = {}) {
  const target = await createTarget();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `localStorage.setItem("kf-anthropic-key", "smoke-test-key");`,
    });
    if (mobile) {
      await emulateRealMobile(client);
    } else {
      await client.send("Emulation.setDeviceMetricsOverride", {
        width: 1200,
        height: 850,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
    const url = `${appUrl}${appUrl.includes("?") ? "&" : "?"}suggestions-smoke=${mobile ? "mobile" : "desktop"}-${Date.now()}`;
    await client.send("Page.navigate", { url });
    await waitFor(client, "document.readyState === 'complete'", `${mobile ? "mobile" : "desktop"} suggestions document load`);
    if (mobile) await assertRealMobileEmulation(client, "mobile suggestions");
    await dismissStartupDialogs(client);
    await waitFor(
      client,
      `window.kfApi && window.kfDebug && window.kfDebug.treeSnapshot && window.kfDebug.treeSnapshot().trees.loaded_count >= 1`,
      `${mobile ? "mobile" : "desktop"} loaded tree and kfApi`,
      40000,
    );
    const questions = await collectAllSuggestedQuestions(client);
    const isContextQuestion = q => /\bYEAR\b/i.test(q.label || "") ||
      /\b(this year|visible people|shown here|visible in|migration story|cluster pattern|weak evidence|simplest way)\b/i.test(q.text || "");
    const orderedQuestions = questions.slice().sort((a, b) =>
      Number(isContextQuestion(b)) - Number(isContextQuestion(a))
    );
    for (const question of orderedQuestions) {
      const before = await client.eval(`(() => ({
        viz: window.kfDebug?.vizState?.().list?.length || 0,
        activeViz: window.kfDebug?.vizState?.().active || null
      }))()`);
      const clickedText = await clickSuggestedQuestionForAnswer(client, question, { mobile });
      const state = await waitFor(
        client,
        `(() => {
          const activeQuestion = document.querySelector("#chatAnswer .chatActiveQuestion p")?.textContent?.trim() || "";
          const text = document.getElementById("chatAnswer")?.innerText || "";
          const viz = window.kfDebug?.vizState?.().list || [];
          return {
            ok: activeQuestion === ${JSON.stringify(clickedText)} &&
              (viz.length > ${before.viz} || (window.kfDebug?.vizState?.().active || null) !== ${JSON.stringify(before.activeViz)}) &&
              /In the tree/i.test(text) &&
              /Inspect/i.test(text) &&
              !/\\*\\[error\\]|API \\d+|No Anthropic API key|_thinking/i.test(text),
            activeQuestion,
            text: text.slice(0, 900),
            vizCount: viz.length,
            activeViz: window.kfDebug?.vizState?.().active || null,
            beforeActiveViz: ${JSON.stringify(before.activeViz)},
            errors: window.kfDebug?.clientErrors?.() || [],
          };
        })()`,
        `${mobile ? "mobile" : "desktop"} ${question.label} text and visualization`,
        20000,
        value => !!value?.ok,
      );
      assert.deepEqual(state.errors, [], `${mobile ? "mobile" : "desktop"} ${question.label} should not record client errors`);
      if (mobile) await assertMobileExploreAnswerAndVisualizationLayout(client, question.label);
    }
  } finally {
    try { await client.send("Page.close"); } catch (_) {}
    client.close();
  }
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
    await assertMobileImmigrationQuestionTap();
    await assertAllSuggestedQuestionsTextAndViz({ mobile: false });
    await assertAllSuggestedQuestionsTextAndViz({ mobile: true });
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
