function _kfPendingTimelineCaption() {
  const startup = typeof _kfReadUxState === "function" ? _kfReadUxState().startup : null;
  const message = String(startup?.message || "").trim();
  if (message && message !== "starting...") return message;
  const selectedRefs = typeof _kfReadSelectedTreeRefs === "function" ? _kfReadSelectedTreeRefs() : [];
  if (selectedRefs.length) return "restoring selected trees...";
  return "loading DEMO tree...";
}

function _kfRefreshTimelineChrome() {
  const ui = $("ui");
  const current = $("timelineCurrentYear");
  const caption = $("timelineCaption");
  const start = $("startYearLabel");
  const end = $("endYearLabel");
  const loaded = !!timelineLoaded && Number.isFinite(Number(curYear));
  if (ui) {
    ui.classList.toggle("timelineLoaded", loaded);
    ui.classList.toggle("timelinePlaying", !!playing);
  }
  if (current) current.textContent = loaded ? String(Math.floor(curYear)) : "-";
  if (caption) {
    caption.textContent = loaded
      ? "Recorded years"
      : _kfPendingTimelineCaption();
  }
  if (start) start.textContent = loaded && Number.isFinite(Number(minYear)) ? String(Math.floor(minYear)) : "-";
  if (end) end.textContent = loaded && Number.isFinite(Number(maxYear)) ? String(Math.floor(maxYear)) : "-";
}

_kfRefreshTimelineChrome();
