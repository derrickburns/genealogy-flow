import { readFileSync } from "node:fs";

const text = readFileSync(process.argv[2], "utf-8");
const lines = text.split(/\r?\n/);
const individuals = new Map();   // id -> {name, sex, birth, death, famc, fams[]}
const families = new Map();      // id -> {husb, wife, chil[]}
let mode = null, cur = null;
function flush() {
  if (cur && mode === "INDI") individuals.set(cur.id, cur);
  else if (cur && mode === "FAM") families.set(cur.id, cur);
  cur = null; mode = null;
}
for (const raw of lines) {
  if (!raw) continue;
  const sp = raw.indexOf(" "); if (sp < 0) continue;
  const lvl = parseInt(raw.slice(0, sp), 10); if (Number.isNaN(lvl)) continue;
  const rest = raw.slice(sp + 1);
  if (lvl === 0) {
    flush();
    const mi = rest.match(/^(@[^@]+@)\s+INDI/);
    const mf = rest.match(/^(@[^@]+@)\s+FAM/);
    if (mi) { cur = { id: mi[1], fams: [] }; mode = "INDI"; }
    else if (mf) { cur = { id: mf[1], husb: null, wife: null, chil: [] }; mode = "FAM"; }
    continue;
  }
  if (!cur) continue;
  const sp2 = rest.indexOf(" ");
  const tag = sp2 >= 0 ? rest.slice(0, sp2) : rest;
  const value = sp2 >= 0 ? rest.slice(sp2 + 1).trim() : "";
  if (lvl === 1) {
    if (mode === "INDI") {
      if (tag === "NAME" && !cur.name) cur.name = value.replace(/\//g, "").trim();
      else if (tag === "SEX" && !cur.sex) cur.sex = value[0] || "";
      else if (tag === "FAMC" && !cur.famc) cur.famc = value;
      else if (tag === "FAMS") cur.fams.push(value);
    } else if (mode === "FAM") {
      if (tag === "HUSB") cur.husb = value;
      else if (tag === "WIFE") cur.wife = value;
      else if (tag === "CHIL") cur.chil.push(value);
    }
  } else if (lvl === 2 && mode === "INDI") {
    if (tag === "DATE") {
      const m = value.match(/(\d{3,4})/);
      if (m) {
        const y = +m[1];
        // assign to most recent BIRT/DEAT — track via state
      }
    }
  }
}
flush();

// Determine: no parents recorded
function hasParents(ind) {
  if (!ind.famc) return false;
  const f = families.get(ind.famc);
  if (!f) return false;
  return !!(f.husb || f.wife);
}
// Determine: has descendants (is in some FAM with CHIL list non-empty)
function hasDescendants(ind) {
  for (const fid of ind.fams || []) {
    const f = families.get(fid);
    if (f && f.chil && f.chil.length) return true;
  }
  return false;
}

const isolates = [];
for (const ind of individuals.values()) {
  if (!hasParents(ind) && !hasDescendants(ind)) isolates.push(ind);
}
console.log(`Total individuals: ${individuals.size}`);
console.log(`Isolates (no recorded parents AND no descendants): ${isolates.length}`);
console.log();
isolates.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
for (const ind of isolates) {
  console.log(`  ${ind.id.padEnd(28)} ${ind.name || "(no name)"}`);
}
