// ---------- People panel component ----------
let _kfPeopleControlsContainer = null;

const KF_PEOPLE_SHOW_OPTIONS = [
  { value: "all", label: "Everyone", detail: "No relationship filter", help: "Use the selected trees without narrowing by family relationship." },
  { value: "blood", label: "Blood relatives", detail: "Direct biological kin", help: "Show only direct blood relatives of the home person." },
  { value: "ancestors", label: "Direct ancestors", detail: "Parents and grandparents", help: "Show only direct ancestors of the home person." },
];

const KF_PEOPLE_SEX_OPTIONS = [
  { value: "all", label: "All people", detail: "No sex filter", help: "Do not filter by recorded sex." },
  { value: "M", label: "Men only", detail: "Recorded male", help: "Show only people recorded as male." },
  { value: "F", label: "Women only", detail: "Recorded female", help: "Show only people recorded as female." },
];

const KF_PEOPLE_KIN_OPTIONS = [
  { value: 0, label: "Off", detail: "No relationship lines", help: "Hide relationship lines so the map stays clean." },
  { value: 3, label: "Closest 3", detail: "Strongest context", help: "Draw relationship lines to the three closest visible kinfolk." },
  { value: 5, label: "Closest 5", detail: "Balanced context", help: "Draw relationship lines to the five closest visible kinfolk." },
  { value: 10, label: "Closest 10", detail: "Broader family context", help: "Draw relationship lines to the ten closest visible kinfolk." },
  { value: 20, label: "Closest 20", detail: "Dense relationship context", help: "Draw relationship lines to the twenty closest visible kinfolk." },
];

function _kfPeopleKinChoice(value = kinLinesN) {
  const n = Number(value || 0);
  if (n >= 20) return 20;
  if (n >= 10) return 10;
  if (n >= 5) return 5;
  if (n >= 3) return 3;
  return 0;
}

function _kfPeopleOption(options, value) {
  return options.find(o => String(o.value) === String(value)) || options[0];
}

function _kfPeopleCurrentSurname() {
  return _kfSurnameFilter ? [..._kfSurnameFilter][0] || "" : "";
}

function _kfPeopleControlsModel() {
  const ux = typeof _kfReadUxState === "function" ? _kfReadUxState() : {};
  const show = curFilter || "all";
  const sex = _kfSexFilter || "all";
  const kin = _kfPeopleKinChoice();
  const surname = _kfPeopleCurrentSurname();
  const surnameOptions = (_kfSurnamesTop || []).map(row => ({
    value: row.surname,
    label: `${row.surname} (${row.count})`,
  }));
  const showOption = _kfPeopleOption(KF_PEOPLE_SHOW_OPTIONS, show);
  const sexOption = _kfPeopleOption(KF_PEOPLE_SEX_OPTIONS, sex);
  const kinOption = _kfPeopleOption(KF_PEOPLE_KIN_OPTIONS, kin);
  return {
    collapsed: !!ux.people?.controlsCollapsed,
    show,
    sex,
    kin,
    surname,
    surnameOptions,
    showHelp: showOption.help,
    sexHelp: sexOption.help,
    kinHelp: kinOption.help,
    surnameHelp: surnameOptions.length
      ? "Focus the people shown by common surname in the selected trees."
      : "Load a tree to show common surname filters.",
    summary: [
      showOption.label,
      surname ? `surname ${surname}` : "all surnames",
      sex === "M" ? "men" : sex === "F" ? "women" : "all people",
      kin ? `${kin} kin lines` : "no lines",
    ].join(" · "),
  };
}

function _kfApplyPeopleShowFilter(value) {
  const hiddenFilter = $("filt");
  if (!hiddenFilter) return;
  hiddenFilter.value = value || "all";
  hiddenFilter.dispatchEvent(new Event("change", { bubbles: true }));
  _kfRenderPeopleControls();
}

function _kfApplyPeopleSurname(value) {
  const val = String(value || "");
  _kfSurnameFilter = val ? new Set([val]) : null;
  _kfPersonsCacheYear = "";
  if (_kfDeckOverlay) updateDeckDwellLayer();
  _kfRefreshViewChrome(true);
  _kfRenderPeopleControls();
}

function _kfApplyPeopleSexFilter(value) {
  _kfSexFilter = value === "all" ? null : value;
  _kfPersonsCacheYear = "";
  if (_kfDeckOverlay) updateDeckDwellLayer();
  _kfRefreshViewChrome(true);
  _kfRefreshQuickChips();
  _kfRenderPeopleControls();
}

function _kfApplyPeopleKinLines(value) {
  if (typeof _kfSetKinLines === "function") _kfSetKinLines(parseInt(value, 10) || 0);
  _kfRefreshViewChrome(true);
  _kfRefreshQuickChips();
  _kfRenderPeopleControls();
}

function _kfTogglePeopleControls() {
  const next = !_kfPeopleControlsModel().collapsed;
  if (typeof _kfSetPeopleUxState === "function") _kfSetPeopleUxState({ controlsCollapsed: next });
  _kfRenderPeopleControls();
}

function KfPeopleSelect({ id, helpId, label, value, options, help, onChange, disabled }) {
  return h("section", { class: "optionCard peopleOptionCard" },
    h("label", { for: id }, label),
    h("select", {
      id,
      value: String(value ?? ""),
      disabled: !!disabled,
      onChange: e => onChange(e.currentTarget.value),
    }, options.map(opt => h("option", {
      key: String(opt.value),
      value: String(opt.value),
    }, opt.detail ? `${opt.label} - ${opt.detail}` : opt.label))),
    h("p", { id: helpId, class: "optionHelp" }, help),
  );
}

function KfPeopleControls({ model }) {
  return h("div", { class: "peopleControlsShell" },
    h("button", {
      id: "peopleControlsToggle",
      class: "paneDisclosureToggle",
      type: "button",
      "aria-expanded": model.collapsed ? "false" : "true",
      "aria-controls": "peopleControlsBody",
      onClick: _kfTogglePeopleControls,
    },
      h("span", null, "Display options"),
      h("small", { id: "peopleControlsSummary" }, model.summary),
    ),
    h("div", {
      id: "peopleControlsBody",
      class: "paneDisclosureBody optionSelectorGrid peopleSelectorGrid",
      hidden: model.collapsed,
    },
      h(KfPeopleSelect, {
        id: "showFilterChoice",
        helpId: "showFilterHelp",
        label: "People shown",
        value: model.show,
        options: KF_PEOPLE_SHOW_OPTIONS,
        help: model.showHelp,
        onChange: _kfApplyPeopleShowFilter,
      }),
      h("section", { class: "optionCard peopleOptionCard" },
        h("label", { for: "surnameSelect" }, "Surname"),
        h("span", {
          id: "peopleSurnameGroup",
          class: "chipGroup surnameControl",
          "data-grp": "surname",
        },
          h("select", {
            id: "surnameSelect",
            value: model.surname,
            disabled: !model.surnameOptions.length,
            onChange: e => _kfApplyPeopleSurname(e.currentTarget.value),
          },
            h("option", { value: "" }, model.surnameOptions.length ? "All surnames" : "No surname filters yet"),
            model.surnameOptions.map(opt => h("option", { key: opt.value, value: opt.value }, opt.label)),
          ),
        ),
        h("p", { class: "optionHelp" }, model.surnameHelp),
      ),
      h(KfPeopleSelect, {
        id: "sexFilterChoice",
        helpId: "sexFilterHelp",
        label: "Sex filter",
        value: model.sex,
        options: KF_PEOPLE_SEX_OPTIONS,
        help: model.sexHelp,
        onChange: _kfApplyPeopleSexFilter,
      }),
      h(KfPeopleSelect, {
        id: "kinLinesChoice",
        helpId: "kinLinesHelp",
        label: "Relationship context",
        value: model.kin,
        options: KF_PEOPLE_KIN_OPTIONS,
        help: model.kinHelp,
        onChange: _kfApplyPeopleKinLines,
      }),
      h("input", { type: "range", id: "kinNMain", min: "0", max: "20", step: "1", value: String(model.kin), hidden: true, readOnly: true }),
      h("b", { id: "kinNMainLabel", hidden: true }, String(model.kin)),
    ),
  );
}

function _kfRenderPeopleControls(container) {
  _kfPeopleControlsContainer = container || _kfPeopleControlsContainer || $("peopleControlsMount");
  if (!_kfPeopleControlsContainer) return;
  preactRender(h(KfPeopleControls, { model: _kfPeopleControlsModel() }), _kfPeopleControlsContainer);
}

_kfRenderPeopleControls();
