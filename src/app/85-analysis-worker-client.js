// ---------- Optional Comlink analysis worker ----------
// Heavy AI-helper aggregations can run off the main UI thread. This is an
// optimization boundary only: every kfApi helper has an in-page fallback.

let _kfAnalysisWorkerHandlePromise = null;
let _kfAnalysisWorkerUnavailable = false;

function _kfAnalysisWorkerMayBeAvailable() {
  return !_kfAnalysisWorkerUnavailable;
}

async function _kfAnalysisWorkerHandle() {
  if (_kfAnalysisWorkerUnavailable) return null;
  if (typeof Worker === "undefined") {
    _kfAnalysisWorkerUnavailable = true;
    return null;
  }
  if (_kfAnalysisWorkerHandlePromise) return _kfAnalysisWorkerHandlePromise;
  _kfAnalysisWorkerHandlePromise = (async () => {
    const Comlink = await import("https://unpkg.com/comlink@4.4.2/dist/esm/comlink.mjs");
    const worker = new Worker(new URL("./workers/analysis-worker.js", window.location.href), {
      type: "module",
      name: "kindred-analysis",
    });
    const api = Comlink.wrap(worker);
    await api.ping();
    return { api, worker };
  })().catch(err => {
    _kfAnalysisWorkerUnavailable = true;
    console.warn("[kf] analysis worker unavailable:", err?.message || err);
    return null;
  });
  return _kfAnalysisWorkerHandlePromise;
}

async function _kfRunAnalysisInWorker(kind, payload, opts = {}) {
  const handle = await _kfAnalysisWorkerHandle();
  if (!handle) return null;
  return handle.api.run(kind, payload, opts || {});
}
