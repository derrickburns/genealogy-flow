// Pure-function name normalization helpers used by the record linker.
// Self-contained: no external deps. Implementations follow the standard
// algorithm definitions; not mirrors of any specific kindred-search file.

export function stripDiacritics(s) {
  return (s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

export function canonicalGiven(name) {
  // GEDCOM names sometimes carry slash-wrapped surnames or double spaces.
  // We just take the first whitespace-separated token of the given block,
  // strip diacritics, lowercase, alpha-only.
  if (!name) return "";
  const cleaned = stripDiacritics(name).replace(/\/[^/]*\//, "").trim();
  const first = cleaned.split(/\s+/)[0] || "";
  return first.toLowerCase().replace(/[^a-z]/g, "");
}

export function canonicalSurname(name) {
  if (!name) return "";
  const slashed = stripDiacritics(name).match(/\/([^/]+)\//);
  let surname;
  if (slashed) surname = slashed[1];
  else {
    // Fallback: take last whitespace-separated token.
    const tokens = stripDiacritics(name).trim().split(/\s+/);
    surname = tokens[tokens.length - 1] || "";
  }
  return surname.toLowerCase().replace(/[^a-z]/g, "");
}

export function soundex(s) {
  if (!s) return "";
  const up = String(s).toUpperCase().replace(/[^A-Z]/g, "");
  if (!up) return "";
  function code(c) {
    if ("BFPV".includes(c)) return "1";
    if ("CGJKQSXZ".includes(c)) return "2";
    if ("DT".includes(c)) return "3";
    if (c === "L") return "4";
    if ("MN".includes(c)) return "5";
    if (c === "R") return "6";
    return ""; // vowels (and Y) → ""
  }
  let out = up[0];
  let prev = code(up[0]);
  for (let i = 1; i < up.length && out.length < 4; i++) {
    const c = up[i];
    if (c === "H" || c === "W") continue; // do not reset prev
    const k = code(c);
    if (k && k !== prev) out += k;
    prev = k; // vowels return "" → reset
  }
  while (out.length < 4) out += "0";
  return out.slice(0, 4);
}

// Modern NYSIIS (Taft 1970, with the 6-char truncation).
export function nysiis(s) {
  if (!s) return "";
  let str = String(s).toUpperCase().replace(/[^A-Z]/g, "");
  if (!str) return "";
  // Initial-letter substitutions
  if (str.startsWith("MAC")) str = "MCC" + str.slice(3);
  else if (str.startsWith("KN")) str = "NN" + str.slice(2);
  else if (str.startsWith("K")) str = "C" + str.slice(1);
  else if (str.startsWith("PH") || str.startsWith("PF")) str = "FF" + str.slice(2);
  else if (str.startsWith("SCH")) str = "SSS" + str.slice(3);
  // Trailing substitutions
  if (str.endsWith("EE") || str.endsWith("IE")) str = str.slice(0, -2) + "Y";
  else if (str.endsWith("DT") || str.endsWith("RT") || str.endsWith("RD") || str.endsWith("NT") || str.endsWith("ND")) str = str.slice(0, -2) + "D";
  // Body translation, preserving the first letter
  let out = str[0];
  let i = 1;
  while (i < str.length) {
    const c = str[i];
    const next = str[i + 1] || "";
    const next2 = str[i + 2] || "";
    const prev = out[out.length - 1];
    let token = c;
    let advance = 1;
    if (c === "E" && next === "V") { token = "AF"; advance = 2; }
    else if ("AEIOU".includes(c)) token = "A";
    else if (c === "Q") token = "G";
    else if (c === "Z") token = "S";
    else if (c === "M") token = "N";
    else if (c === "K" && next === "N") { token = "NN"; advance = 2; }
    else if (c === "K") token = "C";
    else if (c === "S" && next === "C" && next2 === "H") { token = "SSS"; advance = 3; }
    else if (c === "P" && next === "H") { token = "FF"; advance = 2; }
    else if (c === "H" && (!"AEIOU".includes(prev) || (next && !"AEIOU".includes(next)))) token = prev || "H";
    else if (c === "W" && "AEIOU".includes(prev)) token = prev || "W";
    if (token !== prev) out += token;
    i += advance;
  }
  // Trailing tidy
  if (out.length > 1 && out.endsWith("S")) out = out.slice(0, -1);
  if (out.endsWith("AY")) out = out.slice(0, -2) + "Y";
  if (out.length > 1 && out.endsWith("A")) out = out.slice(0, -1);
  return out.slice(0, 6);
}

function jaro(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const matchDist = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatch = new Array(a.length).fill(false);
  const bMatch = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - matchDist);
    const hi = Math.min(b.length - 1, i + matchDist);
    for (let j = lo; j <= hi; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = true; bMatch[j] = true; matches++; break;
    }
  }
  if (matches === 0) return 0;
  let trans = 0, k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) trans++;
    k++;
  }
  trans /= 2;
  return (matches / a.length + matches / b.length + (matches - trans) / matches) / 3;
}

export function jaroWinkler(a, b, p = 0.1) {
  const aa = String(a || "").toLowerCase();
  const bb = String(b || "").toLowerCase();
  const j = jaro(aa, bb);
  if (j === 0) return 0;
  let l = 0;
  while (l < 4 && l < aa.length && l < bb.length && aa[l] === bb[l]) l++;
  return j + l * p * (1 - j);
}

export function birthDecade(year) {
  if (!year || !Number.isFinite(year)) return null;
  return Math.floor(year / 10) * 10;
}
