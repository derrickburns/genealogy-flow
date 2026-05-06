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
      : "Load a tree to begin";
  }
  if (start) start.textContent = loaded && Number.isFinite(Number(minYear)) ? String(Math.floor(minYear)) : "-";
  if (end) end.textContent = loaded && Number.isFinite(Number(maxYear)) ? String(Math.floor(maxYear)) : "-";
}

_kfRefreshTimelineChrome();
