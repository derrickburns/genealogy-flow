// ---------- Cluster panel component ----------
let _kfClusterControlsContainer = null;

const KF_CLUSTER_MODE_OPTIONS = [
  { value: "none", label: "Off", detail: "Individual people", help: "Show each visible person as an individual marker." },
  { value: "state", label: "Places", detail: "State/country regions", help: "Group people by state or country so migration regions are easier to scan." },
  { value: "tree", label: "Trees", detail: "Compare selected data sets", help: "Color and group people by loaded family tree." },
  { value: "group", label: "Exploration groups", detail: "From live answers", help: "Show groups created while exploring this session." },
  { value: "pie", label: "Lineage", detail: "Paternal/maternal branches", help: "Summarize paternal, maternal, and other branches inside each cluster." },
  { value: "gender", label: "Gender", detail: "Recorded sex mix", help: "Summarize recorded male, female, and unknown sex inside each cluster." },
  { value: "parents", label: "Parent knowledge", detail: "Missing parents", help: "Summarize how complete parent records are for clustered people." },
  { value: "dispersion", label: "Declutter", detail: "Group nearby markers", help: "Combine nearby points at the current zoom so dense places stay readable." },
];

function _kfClusterModeOption(value = clusterMode) {
  return KF_CLUSTER_MODE_OPTIONS.find(o => o.value === value) || KF_CLUSTER_MODE_OPTIONS[0];
}

function _kfClusterControlsModel() {
  const modeOption = _kfClusterModeOption(clusterMode);
  return {
    mode: clusterMode || "none",
    modeHelp: modeOption.help,
    radius: Number(clusterRadius || 30),
    summary: `${modeOption.label} · radius ${Number(clusterRadius || 30)}`,
  };
}

function _kfApplyClusterMode(value) {
  if (window.kfApi?.setClusterMode) window.kfApi.setClusterMode(value || "none");
  else {
    const hiddenMode = $("clusterMode");
    if (hiddenMode) {
      hiddenMode.value = value || "none";
      hiddenMode.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  _kfRenderClusterControls();
}

function _kfApplyClusterRadius(value) {
  if (typeof _kfSetClusterRadius === "function") _kfSetClusterRadius(value);
  _kfRenderClusterControls();
}

function KfClusterControls({ model }) {
  return h("div", { class: "clusterControlsShell optionSelectorGrid" },
    h("section", { class: "optionCard clusterOptionCard" },
      h("label", { for: "clusterModeChoice" }, "How to group people"),
      h("select", {
        id: "clusterModeChoice",
        value: model.mode,
        onChange: e => _kfApplyClusterMode(e.currentTarget.value),
      }, KF_CLUSTER_MODE_OPTIONS.map(opt => h("option", {
        key: opt.value,
        value: opt.value,
      }, `${opt.label} - ${opt.detail}`))),
      h("p", { id: "clusterModeHelp", class: "optionHelp" }, model.modeHelp),
    ),
    h("section", { class: "optionCard clusterOptionCard" },
      h("label", { for: "clusterRadiusMain" }, "Cluster size"),
      h("div", { class: "clusterRadiusControl" },
        h("input", {
          type: "range",
          id: "clusterRadiusMain",
          min: "10",
          max: "80",
          step: "2",
          value: String(model.radius),
          onInput: e => _kfApplyClusterRadius(e.currentTarget.value),
        }),
        h("b", { id: "clusterRadiusMainLabel" }, String(model.radius)),
      ),
      h("p", { class: "optionHelp" }, "Larger values combine nearby people into fewer clusters."),
    ),
  );
}

function _kfRenderClusterControls(container) {
  _kfClusterControlsContainer = container || _kfClusterControlsContainer || $("clusterControlsMount");
  if (!_kfClusterControlsContainer) return;
  preactRender(h(KfClusterControls, { model: _kfClusterControlsModel() }), _kfClusterControlsContainer);
}

_kfRenderClusterControls();
