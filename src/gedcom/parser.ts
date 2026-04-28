import { readFileSync } from "node:fs";
import {
  EVENT_TAGS,
  type Event,
  type Family,
  type Gedcom,
  type Individual,
  type Source,
  type SourceRef,
} from "./types.js";

const LINE_RE = /^(\d+)\s+(?:(@[^@]+@)\s+)?(\S+)(?:\s+(.*))?$/;
const DATE_YEAR_RE = /(?:(?:ABT|BEF|AFT|EST|CAL|FROM|TO|BET|AND)\s+)?(?:\d{1,2}\s+)?(?:(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+)?(\d{3,4})/i;
const URL_RE = /https?:\/\/\S+/;

interface ParsedLine {
  level: number;
  xref: string | null;
  tag: string;
  value: string;
}

function parseLine(line: string): ParsedLine | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  return {
    level: Number.parseInt(m[1]!, 10),
    xref: m[2] ?? null,
    tag: m[3]!,
    value: m[4] ?? "",
  };
}

export function parseYear(s: string): number | null {
  if (!s) return null;
  const m = DATE_YEAR_RE.exec(s);
  if (!m) return null;
  const y = Number.parseInt(m[1]!, 10);
  return y >= 1000 && y <= 2100 ? y : null;
}

export function parseName(value: string): string {
  return value.replace(/\//g, "").trim();
}

function trimUrl(u: string): string {
  return u.replace(/[.,);]+$/, "");
}

function emptyEvent(tag: string): Event {
  return { tag, date: "", year: null, place: "", note: "", sources: [] };
}

function ungroup(block: string[], start: number, parentLevel: number): { sub: string[]; next: number } {
  const out: string[] = [];
  let k = start;
  while (k < block.length) {
    const p = parseLine(block[k]!);
    if (!p) { k += 1; continue; }
    if (p.level <= parentLevel) break;
    out.push(block[k]!);
    k += 1;
  }
  return { sub: out, next: k };
}

function parseEventBlock(sub: string[]): Event {
  if (sub.length === 0) return emptyEvent("");
  const head = parseLine(sub[0]!);
  if (!head) return emptyEvent("");
  const ev = emptyEvent(head.tag);
  let k = 1;
  while (k < sub.length) {
    const p = parseLine(sub[k]!);
    if (!p) { k += 1; continue; }
    if (p.level === 2 && p.tag === "DATE") {
      ev.date = p.value;
      ev.year = parseYear(p.value);
      k += 1;
    } else if (p.level === 2 && p.tag === "PLAC") {
      ev.place = p.value.trim();
      k += 1;
    } else if (p.level === 2 && p.tag === "NOTE") {
      ev.note = (ev.note + " " + p.value).trim();
      const r = ungroup(sub, k + 1, 2);
      k = r.next;
      for (const ln of r.sub) {
        const mn = parseLine(ln);
        if (mn && (mn.tag === "CONT" || mn.tag === "CONC")) {
          const sep = mn.tag === "CONT" ? "\n" : "";
          ev.note = (ev.note + sep + mn.value).trim();
        }
      }
    } else if (p.level === 2 && p.tag === "SOUR") {
      const sref: SourceRef = { src_id: p.value.trim(), page: "", text: "", url: null };
      const r = ungroup(sub, k + 1, 2);
      k = r.next;
      for (const ln of r.sub) {
        const ms = parseLine(ln);
        if (!ms) continue;
        if (ms.tag === "PAGE") {
          sref.page = (sref.page + " " + ms.value).trim();
        } else if (ms.tag === "TEXT" || ms.tag === "DATA") {
          if (ms.tag === "TEXT") sref.text = (sref.text + " " + ms.value).trim();
        }
        const um = URL_RE.exec(ms.value);
        if (um && !sref.url) sref.url = trimUrl(um[0]);
      }
      ev.sources.push(sref);
    } else {
      k += 1;
    }
  }
  for (const sref of ev.sources) {
    if (!sref.url) {
      const um = URL_RE.exec(sref.page);
      if (um) sref.url = trimUrl(um[0]);
    }
  }
  return ev;
}

function parseIndi(block: string[], ind: Individual): void {
  let k = 1;
  while (k < block.length) {
    const p = parseLine(block[k]!);
    if (!p) { k += 1; continue; }
    if (p.level !== 1) { k += 1; continue; }
    const tag = p.tag;
    const val = p.value;
    if (tag === "NAME" && !ind.name) {
      ind.name = parseName(val);
      k += 1;
    } else if (tag === "SEX" && !ind.sex) {
      ind.sex = (val.trim()[0] ?? "").toUpperCase();
      k += 1;
    } else if (tag === "FAMC") {
      ind.famc = val.trim();
      k += 1;
    } else if (tag === "FAMS") {
      ind.fams.push(val.trim());
      k += 1;
    } else if (tag === "NOTE") {
      let buf = val.trim();
      const r = ungroup(block, k + 1, 1);
      k = r.next;
      for (const ln of r.sub) {
        const mn = parseLine(ln);
        if (mn && (mn.tag === "CONT" || mn.tag === "CONC")) {
          const sep = mn.tag === "CONT" ? "\n" : "";
          buf += sep + mn.value;
        }
      }
      ind.notes.push(buf.trim());
    } else if (tag === "SOUR") {
      const sref: SourceRef = { src_id: val.trim(), page: "", text: "", url: null };
      const r = ungroup(block, k + 1, 1);
      k = r.next;
      for (const ln of r.sub) {
        const ms = parseLine(ln);
        if (!ms) continue;
        if (ms.tag === "PAGE") {
          sref.page = (sref.page + " " + ms.value).trim();
        }
        const um = URL_RE.exec(ms.value);
        if (um && !sref.url) sref.url = trimUrl(um[0]);
      }
      if (!sref.url) {
        const um = URL_RE.exec(sref.page);
        if (um) sref.url = trimUrl(um[0]);
      }
      ind.sources.push(sref);
    } else if (EVENT_TAGS.has(tag)) {
      const r = ungroup(block, k + 1, 1);
      const headLine = block[k]!;
      const ev = parseEventBlock([headLine, ...r.sub]);
      k = r.next;
      if (ev.tag) ind.events.push(ev);
    } else {
      k += 1;
    }
  }
}

function parseFam(block: string[], fam: Family): void {
  let k = 1;
  while (k < block.length) {
    const p = parseLine(block[k]!);
    if (!p) { k += 1; continue; }
    if (p.level !== 1) { k += 1; continue; }
    if (p.tag === "HUSB") {
      fam.husb = p.value.trim();
      k += 1;
    } else if (p.tag === "WIFE") {
      fam.wife = p.value.trim();
      k += 1;
    } else if (p.tag === "CHIL") {
      fam.chil.push(p.value.trim());
      k += 1;
    } else if (p.tag === "MARR") {
      const r = ungroup(block, k + 1, 1);
      fam.marr = parseEventBlock([block[k]!, ...r.sub]);
      k = r.next;
    } else if (p.tag === "DIV") {
      const r = ungroup(block, k + 1, 1);
      fam.div = parseEventBlock([block[k]!, ...r.sub]);
      k = r.next;
    } else {
      k += 1;
    }
  }
}

function parseSourceRecord(block: string[], src: Source): void {
  let k = 1;
  while (k < block.length) {
    const p = parseLine(block[k]!);
    if (!p) { k += 1; continue; }
    if (p.level !== 1) { k += 1; continue; }
    if (p.tag === "TITL") {
      src.title = p.value;
      const r = ungroup(block, k + 1, 1);
      k = r.next;
      for (const ln of r.sub) {
        const mn = parseLine(ln);
        if (mn && (mn.tag === "CONT" || mn.tag === "CONC")) {
          const sep = mn.tag === "CONT" ? "\n" : "";
          src.title += sep + mn.value;
        }
      }
      src.title = src.title.trim();
    } else if (p.tag === "AUTH") {
      src.auth = p.value.trim();
      k += 1;
    } else if (p.tag === "PUBL") {
      src.publ = p.value.trim();
      k += 1;
    } else {
      k += 1;
    }
  }
}

export function parseGedcom(path: string): Gedcom {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  const g: Gedcom = {
    individuals: new Map(),
    families: new Map(),
    sources: new Map(),
  };
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (!line.trim()) { i += 1; continue; }
    const p = parseLine(line);
    if (!p || p.level !== 0) { i += 1; continue; }
    let j = i + 1;
    while (j < n) {
      const pj = parseLine(lines[j]!);
      if (pj && pj.level === 0) break;
      j += 1;
    }
    const block = lines.slice(i, j);
    if (p.tag === "INDI" && p.xref) {
      const ind: Individual = {
        id: p.xref, raw: block.join("\n"), name: "", sex: "",
        famc: null, fams: [], events: [], notes: [], sources: [],
      };
      parseIndi(block, ind);
      g.individuals.set(p.xref, ind);
    } else if (p.tag === "FAM" && p.xref) {
      const fam: Family = {
        id: p.xref, husb: null, wife: null, chil: [], marr: null, div: null,
      };
      parseFam(block, fam);
      g.families.set(p.xref, fam);
    } else if (p.tag === "SOUR" && p.xref) {
      const src: Source = { id: p.xref, title: "", auth: "", publ: "", note: "" };
      parseSourceRecord(block, src);
      g.sources.set(p.xref, src);
    }
    i = j;
  }
  return g;
}
