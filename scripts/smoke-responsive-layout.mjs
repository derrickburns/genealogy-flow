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

async function emulateRealMobile(client, { width, height, deviceScaleFactor = 3 }) {
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

async function assertRealMobileEmulation(client, label, { width, height }) {
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
  assert.equal(state.viewport.width, width, `${label} viewport width`);
  assert.equal(state.viewport.height, height, `${label} viewport height`);
  assert.ok(state.viewport.dpr >= 3, `${label} should emulate high DPR mobile`);
}

async function tapSelector(client, selector, label) {
  const encoded = JSON.stringify(selector);
  await client.eval(`document.querySelector(${encoded})?.scrollIntoView({ block: "center", inline: "center" })`);
  await sleep(80);
  const rect = await waitFor(
    client,
    `(() => {
      const el = document.querySelector(${encoded});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        width: r.width,
        height: r.height,
        visible: r.width > 0 && r.height > 0 &&
          r.left >= 0 && r.right <= (window.innerWidth || document.documentElement.clientWidth) &&
          r.top >= 0 && r.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
          style.visibility !== "hidden" && style.display !== "none",
        disabled: !!el.disabled
      };
    })()`,
    label,
    10000,
    value => value?.visible && !value?.disabled,
  );
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: rect.x, y: rect.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
  });
  await sleep(60);
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(180);
}

async function assertTouchScrollable(client, selector, label) {
  const encoded = JSON.stringify(selector);
  const setup = await waitFor(
    client,
    `(() => {
      const pane = document.querySelector(${encoded});
      if (!pane) return null;
      pane.scrollTop = 0;
      const fillerId = "kf-scroll-probe";
      document.getElementById(fillerId)?.remove();
      let addedFiller = false;
      if (pane.scrollHeight <= pane.clientHeight + 2) {
        const filler = document.createElement("div");
        filler.id = fillerId;
        filler.textContent = "scroll probe";
        filler.style.cssText = "height:900px;flex:0 0 auto;pointer-events:none;opacity:0;";
        pane.appendChild(filler);
        addedFiller = true;
      }
      const r = pane.getBoundingClientRect();
      const style = getComputedStyle(pane);
      return {
        addedFiller,
        before: pane.scrollTop,
        clientHeight: pane.clientHeight,
        scrollHeight: pane.scrollHeight,
        overflowY: style.overflowY,
        touchAction: style.touchAction,
        visible: r.width > 0 && r.height > 80 && style.display !== "none" && style.visibility !== "hidden",
        x: r.left + r.width / 2,
        yStart: Math.min(r.bottom - 36, r.top + r.height - 36),
        yEnd: Math.max(r.top + 36, r.bottom - Math.min(320, Math.max(120, r.height * 0.65))),
      };
    })()`,
    `${label} scroll setup`,
    10000,
    value => value?.visible && value.scrollHeight > value.clientHeight + 2,
  );
  assert.match(setup.overflowY, /auto|scroll/, `${label} should expose vertical scrolling`);
  assert.match(setup.touchAction, /pan-y|auto/, `${label} should allow vertical touch panning`);

  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: setup.x, y: setup.yStart, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
  });
  await sleep(60);
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: setup.x, y: setup.yEnd, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
  });
  await sleep(120);
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(250);

  const after = await client.eval(`(() => {
    const pane = document.querySelector(${encoded});
    const result = { scrollTop: pane?.scrollTop || 0 };
    document.getElementById("kf-scroll-probe")?.remove();
    return result;
  })()`);
  assert.ok(after.scrollTop > setup.before, `${label} should move when dragged`);
}

async function assertCompactMapVisible(client, label) {
  const budget = await waitFor(
    client,
    `(() => {
      const map = document.getElementById("mapWrap");
      if (!map) return null;
      const mapRect = map.getBoundingClientRect();
      const centerX = mapRect.left + mapRect.width / 2;
      const blockers = ["authBar", "responsiveContextStrip", "mapStoryRibbon", "ui", "panel"]
        .map(id => document.getElementById(id))
        .filter(el => {
          if (!el) return false;
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
        })
        .map(el => {
          const r = el.getBoundingClientRect();
          return { id: el.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height };
        });
      let run = 0;
      let maxRun = 0;
      for (let y = Math.max(0, Math.ceil(mapRect.top)); y <= Math.min(window.innerHeight, Math.floor(mapRect.bottom)); y += 4) {
        const blocked = blockers.some(r => centerX >= r.left && centerX <= r.right && y >= r.top && y <= r.bottom);
        if (blocked) {
          maxRun = Math.max(maxRun, run);
          run = 0;
        } else {
          run += 4;
        }
      }
      maxRun = Math.max(maxRun, run);
      const story = document.getElementById("mapStoryRibbon")?.getBoundingClientRect();
      const ui = document.getElementById("ui")?.getBoundingClientRect();
      const storyStyle = document.getElementById("mapStoryRibbon")
        ? getComputedStyle(document.getElementById("mapStoryRibbon"))
        : null;
      const storyVisible = !!story && storyStyle?.display !== "none" && story.width > 0 && story.height > 0;
      const storyTimelineGap = storyVisible && ui ? ui.top - story.bottom : null;
      return {
        ok: maxRun >= 320 && (!storyVisible || storyTimelineGap >= 8),
        maxClearRun: maxRun,
        storyTimelineGap,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        map: { top: mapRect.top, bottom: mapRect.bottom, height: mapRect.height },
        blockers
      };
    })()`,
    `${label} visible map budget`,
    10000,
    value => !!value?.ok,
  );
  assert.ok(budget.maxClearRun >= 320, `${label} should leave a map-dominant visible band`);
  if (budget.storyTimelineGap != null) {
    assert.ok(budget.storyTimelineGap >= 8, `${label} should not overlap the story card and timeline: ${JSON.stringify(budget)}`);
  }
}

async function assertDetailDrawerLeavesMapContext(client, label) {
  const budget = await waitFor(
    client,
    `(() => {
      const map = document.getElementById("mapWrap");
      const panel = document.getElementById("panel");
      if (!map || !panel) return null;
      const mapRect = map.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const authRect = document.getElementById("authBar")?.getBoundingClientRect();
      const mapStart = Math.max(mapRect.top, authRect?.bottom || mapRect.top);
      const visibleMapHeight = Math.max(0, Math.min(panelRect.top, mapRect.bottom) - mapStart);
      const minimum = Math.min(220, Math.max(150, window.innerHeight * 0.24));
      return {
        ok: visibleMapHeight >= minimum,
        visibleMapHeight,
        minimum,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        panel: { top: panelRect.top, height: panelRect.height },
        map: { top: mapRect.top, bottom: mapRect.bottom, height: mapRect.height }
      };
    })()`,
    `${label} drawer map context`,
    10000,
    value => !!value?.ok,
  );
  assert.ok(budget.ok, `${label} detail drawer should preserve map context: ${JSON.stringify(budget)}`);
}

async function assertMobileVizTimelineRail(client, label) {
  await client.eval(`window.kfApi?.showViz?.({
    type: "svg",
    title: "Mobile timeline rail smoke",
    spec: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 360'><rect width='640' height='360' fill='#eff6ff'/><path d='M48 292 C160 150 254 248 344 126 S510 184 592 72' fill='none' stroke='#2563eb' stroke-width='18' stroke-linecap='round'/><circle cx='48' cy='292' r='18' fill='#16a34a'/><circle cx='592' cy='72' r='18' fill='#dc2626'/></svg>"
  })`);
  const state = await waitFor(
    client,
    `(() => {
      const pane = document.getElementById("vizPane");
      const frame = document.getElementById("vizFrame");
      const ui = document.getElementById("ui");
      const play = document.getElementById("play");
      const auth = document.getElementById("authBar");
      const tabs = document.getElementById("vizTabBar");
      const caption = document.getElementById("timelineCaption");
      const hist = document.getElementById("yearHist");
      const options = document.querySelector("#ui .timelineOptions");
      if (!pane || !frame || !ui || !play) return null;
      const visible = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
      };
      const uiRect = ui.getBoundingClientRect();
      const frameRect = frame.getBoundingClientRect();
      const playRect = play.getBoundingClientRect();
      const clearVizHeight = Math.max(0, Math.min(frameRect.bottom, uiRect.top) - frameRect.top);
      const minimumClear = Math.min(420, Math.max(260, window.innerHeight * 0.46));
      return {
        ok: pane.classList.contains("on") &&
          uiRect.height <= 50 &&
          playRect.height <= 32 &&
          !visible(caption) &&
          !visible(hist) &&
          !visible(options) &&
          visible(tabs) &&
          !visible(auth) &&
          clearVizHeight >= minimumClear,
        ui: { top: uiRect.top, bottom: uiRect.bottom, height: uiRect.height },
        play: { width: playRect.width, height: playRect.height },
        frame: { top: frameRect.top, bottom: frameRect.bottom, height: frameRect.height },
        clearVizHeight,
        minimumClear,
        captionVisible: visible(caption),
        histVisible: visible(hist),
        optionsVisible: visible(options),
        authVisible: visible(auth),
        tabsVisible: visible(tabs),
        viewport: { width: window.innerWidth, height: window.innerHeight }
      };
    })()`,
    `${label} visualization timeline rail`,
    10000,
    value => !!value?.ok,
  );
  assert.ok(state.ok, `${label} visualization should keep the mobile timeline as a short rail: ${JSON.stringify(state)}`);
  await client.eval(`document.querySelector("#vizTabBar .tabClose")?.click()`);
  await client.eval(`if (typeof _kfClearChatArtifacts === "function") _kfClearChatArtifacts()`);
  await waitFor(
    client,
    `(() => {
      const pane = document.getElementById("vizPane");
      const bar = document.getElementById("vizTabBar");
      return !pane?.classList.contains("on") && !!bar?.hidden;
    })()`,
    `${label} visualization cleanup`,
    10000,
  );
}

async function assertFollowPathFocusesPerson(client, label) {
  const before = await client.eval(`window.kfApi?.getState?.()`);
  await tapSelector(client, "#mapStoryAction", `${label} follow their path`);
  const state = await waitFor(
    client,
    `(() => {
      const state = window.kfApi?.getState?.();
      if (!state) return null;
      return {
        ok: state.showFilter === "person" &&
          !!state.focusedPerson &&
          state.visiblePeople <= 1 &&
          state.visiblePeople < ${Number(before?.visiblePeople || 2)},
        showFilter: state.showFilter,
        focusedPerson: state.focusedPerson,
        visiblePeople: state.visiblePeople,
        beforeVisiblePeople: ${Number(before?.visiblePeople || 0)}
      };
    })()`,
    `${label} follow path focused-person filter`,
    10000,
    value => !!value?.ok,
  );
  assert.ok(state.ok, `${label} follow their path should narrow map markers to one person: ${JSON.stringify(state)}`);
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
    if (splash && !splash.hidden) {
      document.getElementById("splashDismiss")?.click();
    }
  })()`);
}

function paneAssertion(tab, textPattern) {
  return `(() => {
    const tree = window.kfDebug.treeSnapshot();
    const panel = document.getElementById("panel");
    const activePane = ${JSON.stringify(tab)} === "map"
      ? document.getElementById("mapWrap")
      : document.querySelector("#chatPanel .sidePane.on");
    const visibleText = ${JSON.stringify(tab)} === "map"
      ? document.body.innerText
      : activePane?.innerText || "";
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const controls = [...(activePane || document).querySelectorAll("button,input,select,textarea,[role='button']")]
        .filter(el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
        })
        .map(el => {
          const r = el.getBoundingClientRect();
          let insideHorizontalScroller = false;
          for (let p = el.parentElement; p && p !== activePane && p !== document.body; p = p.parentElement) {
            const ps = getComputedStyle(p);
            if (p.scrollWidth > p.clientWidth + 2 && /auto|scroll/.test(ps.overflowX)) {
              insideHorizontalScroller = true;
              break;
            }
          }
          return {
            label: el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.id || el.tagName,
            left: r.left,
            right: r.right,
            width: r.width,
            height: r.height,
            insideHorizontalScroller
          };
        });
    const offscreen = controls.filter(c => !c.insideHorizontalScroller && (c.left < -1 || c.right > viewportWidth + 1 || c.width < 8 || c.height < 8));
    const horizontalOverflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > viewportWidth + 2;
    return {
      ok: tree.layout.tab === ${JSON.stringify(tab)} &&
        panel?.dataset.activeTab === ${JSON.stringify(tab)} &&
        (${JSON.stringify(tab)} === "map" ? tree.layout.sheet === "peek" : tree.layout.sheet !== "peek") &&
        ${textPattern}.test(visibleText) &&
        !horizontalOverflow &&
        offscreen.length === 0,
      tab: tree.layout.tab,
      sheet: tree.layout.sheet,
      activeTab: panel?.dataset.activeTab,
      horizontalOverflow,
      offscreen,
      visibleText: visibleText.slice(0, 900),
      errors: window.kfDebug.clientErrors?.() || []
    };
  })()`;
}

async function auditCompactInteractions(client, name) {
  const tabs = [
    ["map", /Recorded years|Patterns|Story|Tree scope/i],
    ["person", /Person connection|visible now/i],
    ["trees", /Trees|Visualized/i],
    ["chat", /Live exploration|Evidence first/i],
  ];
  for (const [tab, pattern] of tabs) {
    await tapSelector(client, `#sideTabs [data-side-tab="${tab}"]`, `${name} ${tab} tab`);
    const state = await waitFor(client, paneAssertion(tab, pattern), `${name} ${tab} visual utility`, 15000, value => !!value?.ok);
    assert.equal(state.errors.length, 0, `${name} ${tab} should not record client errors`);
    if (tab === "trees") {
      await assertTouchScrollable(client, "#treesPane", `${name} trees panel`);
    }
  }

  await tapSelector(client, `#sideTabs [data-side-tab="map"]`, `${name} map tab before patterns action`);
  await tapSelector(client, "#mapStoryPatterns", `${name} patterns story action`);
  let state = await waitFor(client, paneAssertion("cluster", /Patterns|How to group people|Find the family pattern/i), `${name} patterns visual utility`, 15000, value => !!value?.ok);
  assert.equal(state.errors.length, 0, `${name} patterns should not record client errors`);
  await assertDetailDrawerLeavesMapContext(client, `${name} patterns`);
  await tapSelector(client, `#sideTabs [data-side-tab="map"]`, `${name} map tab before story action`);
  await tapSelector(client, "#mapStoryStory", `${name} story action`);
  state = await waitFor(client, paneAssertion("tour", /Story|Place feeling|Current evidence notes/i), `${name} story visual utility`, 15000, value => !!value?.ok);
  assert.equal(state.errors.length, 0, `${name} story should not record client errors`);
  await assertDetailDrawerLeavesMapContext(client, `${name} story`);

  await tapSelector(client, `#sideTabs [data-side-tab="person"]`, `${name} people tab`);
  await tapSelector(client, "#v4PeopleBlood", `${name} blood relatives button`);
  assert.equal(await client.eval(`document.getElementById("filt")?.value`), "blood", `${name} blood filter should activate`);
  await tapSelector(client, "#v4PeopleAncestors", `${name} ancestors button`);
  assert.equal(await client.eval(`document.getElementById("filt")?.value`), "ancestors", `${name} ancestors filter should activate`);
  await tapSelector(client, "#v4PeopleAll", `${name} everyone button`);
  assert.equal(await client.eval(`document.getElementById("filt")?.value`), "all", `${name} everyone filter should reset`);
  await tapSelector(client, "#v4PeopleKin", `${name} kin lines button`);
  assert.ok((await client.eval(`window.kfApi.getState().kinLines`)) > 0, `${name} kin lines should turn on`);
  assert.equal(
    await client.eval(`(() => {
      const el = document.getElementById("peopleControlsToggle");
      if (!el) return true;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width === 0 || r.height === 0 || s.display === "none" || s.visibility === "hidden";
    })()`),
    true,
    `${name} display options should stay out of the map-first phone overlay`,
  );

  await tapSelector(client, `#sideTabs [data-side-tab="map"]`, `${name} map tab before patterns controls`);
  await tapSelector(client, "#mapStoryPatterns", `${name} patterns action for cluster controls`);
  await client.eval(`(() => {
    const select = document.getElementById("clusterModeChoice");
    select.value = "dispersion";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitFor(client, `window.kfApi.getState().clusterMode === "dispersion"`, `${name} declutter mode`);
  await client.eval(`(() => {
    const range = document.getElementById("clusterRadiusMain");
    range.value = "44";
    range.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  assert.equal(await client.eval(`document.getElementById("clusterRadiusMainLabel")?.textContent`), "44", `${name} cluster radius label should update`);

  await tapSelector(client, `#sideTabs [data-side-tab="chat"]`, `${name} explore tab`);
  const chatToolsVisible = await client.eval(`(() => {
    const el = document.getElementById("chatTools");
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
  })()`);
  if (chatToolsVisible) {
    await tapSelector(client, "#chatTools", `${name} chat tools toggle`);
    assert.match(await client.eval(`document.getElementById("chatTools")?.textContent || ""`), /tools/i, `${name} tools toggle remains visible`);
  } else {
    assert.match(await client.eval(`document.getElementById("chatLock")?.innerText || ""`), /Live exploration|API key|Sign in/i, `${name} locked Explore state should explain access`);
  }
}

async function runCase({ name, width, height, compact, mapOnly = false, realMobile = false }) {
  const target = await createTarget();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    if (realMobile) {
      await emulateRealMobile(client, { width, height });
    } else {
      await client.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: compact,
        screenWidth: width,
        screenHeight: height,
      });
      if (compact) {
        await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      }
    }
    const url = `${appUrl}${appUrl.includes("?") ? "&" : "?"}smoke=${encodeURIComponent(name)}-${Date.now()}`;
    await client.send("Page.navigate", { url });
    await waitFor(client, "document.readyState === 'complete'", `${name} document load`);
    if (realMobile) await assertRealMobileEmulation(client, name, { width, height });
    await dismissStartupDialogs(client);
    await waitFor(
      client,
      "window.kfDebug && window.kfDebug.treeSnapshot && window.kfDebug.treeSnapshot().trees.loaded_count >= 1",
      `${name} demo tree load`,
      30000,
    );
    const initialSnapshot = await client.eval(`window.kfDebug.treeSnapshot()`);
    if (compact) {
      assert.equal(initialSnapshot.layout.tab, "map", `${name} should start map-first after tree load`);
      assert.equal(initialSnapshot.layout.sheet, "peek", `${name} should keep the sheet collapsed after tree load`);
      await assertCompactMapVisible(client, name);
      await assertMobileVizTimelineRail(client, name);
      if (mapOnly) {
        console.log(`${name} map visibility smoke passed`);
        return;
      }
    } else {
      await assertFollowPathFocusesPerson(client, name);
    }
    if (compact) {
      await auditCompactInteractions(client, name);
      await tapSelector(client, `#sideTabs [data-side-tab="trees"]`, `${name} trees tab`);
    } else {
      await client.eval(`document.querySelector('#sideTabs [data-side-tab="trees"]')?.click()`);
    }
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
await runCase({ name: "iphone-real", width: 390, height: 844, compact: true, realMobile: true, mapOnly: true });
await runCase({ name: "compact-short", width: 521, height: 694, compact: true, mapOnly: true });
