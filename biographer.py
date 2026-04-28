#!/usr/bin/env python3
"""Convert each individual in a GEDCOM into source-cited biographical prose.

This is a more sophisticated companion to summarize_gedcom.py:

  1. Parses the entire GEDCOM into a fully-cross-referenced graph: individuals,
     families, sources, citations, and notes.

  2. For each individual, builds a structured context bundle: their canonical
     facts, the names of their parents / spouses / children (resolved from
     family records), every dated event, and every source citation with its
     URL when one is present in the GEDCOM.

  3. Passes that bundle to Claude Opus 4.7 with adaptive thinking and a
     biographer-grade system prompt. Output is well-crafted prose with inline
     markdown source citations.

The system prompt and the GEDCOM-wide name index are static across every call,
so prompt caching cuts steady-state input cost by ~90%.

Usage:
    python3 biographer.py PATH_TO.ged
        [--mode brief|standard|detailed|timeline]
        [--model claude-opus-4-7]
        [--effort high|medium|low|max]
        [--limit N]
        [--out path.json]
        [--md-dir path/]            # also dump a .md file per indi

Output:
    PATH_TO.ged.summaries.json      mapping indi id (e.g. "@I123@") -> markdown
    [optional] one <id>.md file per individual under --md-dir

Resume-safe: existing entries in the JSON sidecar are preserved; only missing
ones are generated. Persists incrementally and on SIGINT.
"""
import argparse
import json
import re
import signal
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import anthropic

# ---------------------------------------------------------------------------
# GEDCOM parsing
# ---------------------------------------------------------------------------

LINE_RE = re.compile(r"^(\d+)\s+(?:(@[^@]+@)\s+)?(\S+)(?:\s+(.*))?$")
DATE_YEAR_RE = re.compile(
    r"(?:(?:ABT|BEF|AFT|EST|CAL|FROM|TO|BET|AND)\s+)?"
    r"(?:\d{1,2}\s+)?"
    r"(?:(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+)?"
    r"(\d{3,4})",
    re.IGNORECASE,
)


@dataclass
class SourceRef:
    src_id: str
    page: str = ""
    text: str = ""
    url: Optional[str] = None


@dataclass
class Event:
    tag: str
    date: str = ""
    year: Optional[int] = None
    place: str = ""
    note: str = ""
    sources: list[SourceRef] = field(default_factory=list)


@dataclass
class Individual:
    id: str
    raw: str = ""
    name: str = ""
    sex: str = ""
    famc: Optional[str] = None      # family as child
    fams: list[str] = field(default_factory=list)  # families as spouse
    events: list[Event] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    sources: list[SourceRef] = field(default_factory=list)

    @property
    def birth(self) -> Optional[Event]:
        return next((e for e in self.events if e.tag == "BIRT"), None)

    @property
    def death(self) -> Optional[Event]:
        return next((e for e in self.events if e.tag == "DEAT"), None)


@dataclass
class Family:
    id: str
    husb: Optional[str] = None
    wife: Optional[str] = None
    chil: list[str] = field(default_factory=list)
    marr: Optional[Event] = None
    div: Optional[Event] = None


@dataclass
class Source:
    id: str
    title: str = ""
    auth: str = ""
    publ: str = ""
    note: str = ""


@dataclass
class Gedcom:
    individuals: dict[str, Individual] = field(default_factory=dict)
    families: dict[str, Family] = field(default_factory=dict)
    sources: dict[str, Source] = field(default_factory=dict)


def _parse_year(date_str: str) -> Optional[int]:
    if not date_str:
        return None
    m = DATE_YEAR_RE.search(date_str)
    if not m:
        return None
    y = int(m.group(1))
    return y if 1000 <= y <= 2100 else None


def _parse_name(value: str) -> str:
    return value.replace("/", "").strip()


def parse_gedcom(path: Path) -> Gedcom:
    g = Gedcom()
    with path.open("r", encoding="utf-8", errors="replace") as f:
        lines = [ln.rstrip("\r\n") for ln in f]

    # First pass: split by 0-level records, then walk a small line-level state machine.
    n = len(lines)
    i = 0
    while i < n:
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        m = LINE_RE.match(line)
        if not m:
            i += 1
            continue
        level, xref, tag, value = m.groups()
        level = int(level)
        value = value or ""
        if level != 0:
            i += 1
            continue

        # Find end of this 0-level record (start of next 0-level line)
        j = i + 1
        while j < n:
            mj = LINE_RE.match(lines[j])
            if mj and int(mj.group(1)) == 0:
                break
            j += 1
        block = lines[i:j]

        if tag == "INDI" and xref:
            ind = Individual(id=xref, raw="\n".join(block))
            _parse_indi(block, ind)
            g.individuals[xref] = ind
        elif tag == "FAM" and xref:
            fam = Family(id=xref)
            _parse_fam(block, fam)
            g.families[xref] = fam
        elif tag == "SOUR" and xref:
            src = Source(id=xref)
            _parse_source(block, src)
            g.sources[xref] = src
        i = j
    return g


def _ungroup(block: list[str], start: int, parent_level: int) -> tuple[list[str], int]:
    """Collect lines whose level is greater than parent_level, starting at start."""
    out = []
    k = start
    while k < len(block):
        m = LINE_RE.match(block[k])
        if not m:
            k += 1
            continue
        lvl = int(m.group(1))
        if lvl <= parent_level:
            break
        out.append(block[k])
        k += 1
    return out, k


def _parse_event_block(sub: list[str]) -> Event:
    """Parse a level-1 event block (children at level >= 2)."""
    if not sub:
        return Event(tag="")
    head = LINE_RE.match(sub[0])
    if not head:
        return Event(tag="")
    tag = head.group(3)
    ev = Event(tag=tag)
    k = 1
    while k < len(sub):
        m = LINE_RE.match(sub[k])
        if not m:
            k += 1
            continue
        lvl = int(m.group(1))
        ttag = m.group(3)
        tval = m.group(4) or ""
        if lvl == 2 and ttag == "DATE":
            ev.date = tval
            ev.year = _parse_year(tval)
            k += 1
        elif lvl == 2 and ttag == "PLAC":
            ev.place = tval.strip()
            k += 1
        elif lvl == 2 and ttag == "NOTE":
            ev.note = (ev.note + " " + tval).strip()
            sub_note, k = _ungroup(sub, k + 1, 2)
            for ln in sub_note:
                mn = LINE_RE.match(ln)
                if mn and mn.group(3) in ("CONT", "CONC"):
                    sep = "\n" if mn.group(3) == "CONT" else ""
                    ev.note = (ev.note + sep + (mn.group(4) or "")).strip()
        elif lvl == 2 and ttag == "SOUR":
            sref = SourceRef(src_id=tval.strip())
            sub_sour, k = _ungroup(sub, k + 1, 2)
            for ln in sub_sour:
                ms = LINE_RE.match(ln)
                if not ms:
                    continue
                stag = ms.group(3)
                sval = ms.group(4) or ""
                if stag == "PAGE":
                    sref.page = (sref.page + " " + sval).strip()
                elif stag in ("DATA", "TEXT"):
                    if "TEXT" in stag:
                        sref.text = (sref.text + " " + sval).strip()
                # capture URL anywhere in the citation
                url_match = re.search(r"https?://\S+", sval)
                if url_match and not sref.url:
                    sref.url = url_match.group(0).rstrip(".,);")
            ev.sources.append(sref)
        else:
            k += 1
    # Pull URL from PAGE if present
    for sref in ev.sources:
        if not sref.url:
            url_match = re.search(r"https?://\S+", sref.page or "")
            if url_match:
                sref.url = url_match.group(0).rstrip(".,);")
    return ev


def _parse_indi(block: list[str], ind: Individual):
    k = 1
    while k < len(block):
        m = LINE_RE.match(block[k])
        if not m:
            k += 1
            continue
        lvl = int(m.group(1))
        tag = m.group(3)
        val = m.group(4) or ""
        if lvl == 1:
            if tag == "NAME" and not ind.name:
                ind.name = _parse_name(val)
                k += 1
            elif tag == "SEX" and not ind.sex:
                ind.sex = val.strip()[:1].upper()
                k += 1
            elif tag == "FAMC":
                ind.famc = val.strip()
                k += 1
            elif tag == "FAMS":
                ind.fams.append(val.strip())
                k += 1
            elif tag == "NOTE":
                buf = val.strip()
                sub_note, k = _ungroup(block, k + 1, 1)
                for ln in sub_note:
                    mn = LINE_RE.match(ln)
                    if mn and mn.group(3) in ("CONT", "CONC"):
                        sep = "\n" if mn.group(3) == "CONT" else ""
                        buf += sep + (mn.group(4) or "")
                ind.notes.append(buf.strip())
            elif tag == "SOUR":
                sref = SourceRef(src_id=val.strip())
                sub_sour, k = _ungroup(block, k + 1, 1)
                for ln in sub_sour:
                    ms = LINE_RE.match(ln)
                    if not ms:
                        continue
                    stag = ms.group(3)
                    sval = ms.group(4) or ""
                    if stag == "PAGE":
                        sref.page = (sref.page + " " + sval).strip()
                    url_match = re.search(r"https?://\S+", sval)
                    if url_match and not sref.url:
                        sref.url = url_match.group(0).rstrip(".,);")
                if not sref.url:
                    url_match = re.search(r"https?://\S+", sref.page or "")
                    if url_match:
                        sref.url = url_match.group(0).rstrip(".,);")
                ind.sources.append(sref)
            elif tag in EVENT_TAGS:
                # Find the extent of this event block
                sub_ev, k = _ungroup(block, k + 1, 1)
                ev = _parse_event_block([block[k - 1 - len(sub_ev)]] + sub_ev)
                if ev.tag:
                    ind.events.append(ev)
            else:
                k += 1
        else:
            k += 1


def _parse_fam(block: list[str], fam: Family):
    k = 1
    while k < len(block):
        m = LINE_RE.match(block[k])
        if not m:
            k += 1
            continue
        lvl = int(m.group(1))
        tag = m.group(3)
        val = m.group(4) or ""
        if lvl == 1:
            if tag == "HUSB":
                fam.husb = val.strip()
                k += 1
            elif tag == "WIFE":
                fam.wife = val.strip()
                k += 1
            elif tag == "CHIL":
                fam.chil.append(val.strip())
                k += 1
            elif tag == "MARR":
                sub_ev, k = _ungroup(block, k + 1, 1)
                fam.marr = _parse_event_block([block[k - 1 - len(sub_ev)]] + sub_ev)
            elif tag == "DIV":
                sub_ev, k = _ungroup(block, k + 1, 1)
                fam.div = _parse_event_block([block[k - 1 - len(sub_ev)]] + sub_ev)
            else:
                k += 1
        else:
            k += 1


def _parse_source(block: list[str], src: Source):
    k = 1
    while k < len(block):
        m = LINE_RE.match(block[k])
        if not m:
            k += 1
            continue
        lvl = int(m.group(1))
        tag = m.group(3)
        val = m.group(4) or ""
        if lvl == 1:
            if tag == "TITL":
                src.title = val
                # consume CONT/CONC lines
                sub, k = _ungroup(block, k + 1, 1)
                for ln in sub:
                    mn = LINE_RE.match(ln)
                    if mn and mn.group(3) in ("CONT", "CONC"):
                        sep = "\n" if mn.group(3) == "CONT" else ""
                        src.title += sep + (mn.group(4) or "")
                src.title = src.title.strip()
            elif tag == "AUTH":
                src.auth = val.strip()
                k += 1
            elif tag == "PUBL":
                src.publ = val.strip()
                k += 1
            else:
                k += 1
        else:
            k += 1


EVENT_TAGS = {"BIRT", "DEAT", "RESI", "MARR", "EMIG", "IMMI", "CENS", "BAPM",
              "BURI", "CHR", "OCCU", "EDUC", "RELI", "NATU", "WILL"}


# ---------------------------------------------------------------------------
# Context bundle
# ---------------------------------------------------------------------------

EVENT_VERB = {
    "BIRT": "Born",
    "DEAT": "Died",
    "RESI": "Lived",
    "MARR": "Married",
    "EMIG": "Emigrated from",
    "IMMI": "Immigrated to",
    "CENS": "Recorded in census",
    "BAPM": "Baptized",
    "BURI": "Buried",
    "CHR": "Christened",
    "OCCU": "Worked as",
    "EDUC": "Educated",
    "RELI": "Religion",
    "NATU": "Naturalized",
    "WILL": "Will probated",
}


def _short(ev: Event) -> str:
    parts = []
    when = ev.date or (str(ev.year) if ev.year else "")
    where = ev.place or ""
    verb = EVENT_VERB.get(ev.tag, ev.tag)
    line = verb
    if when:
        line += f" in {when}" if ev.tag in ("RESI", "CENS", "OCCU") else f" {when}"
    if where:
        line += f" at {where}" if ev.tag in ("BIRT", "DEAT", "MARR", "BURI", "BAPM", "CHR") else f", {where}"
    if ev.note:
        line += f" (note: {ev.note[:200]})"
    if ev.sources:
        cites = []
        for s in ev.sources[:3]:
            chunk = s.page or s.text or s.src_id
            chunk = chunk[:120].strip()
            if s.url:
                cites.append(f"[{chunk}]({s.url})")
            else:
                cites.append(chunk)
        if cites:
            line += " — sources: " + "; ".join(cites)
    return line


def build_context(g: Gedcom, indi: Individual) -> str:
    """Return a markdown-ish bundle for a single individual, fully cross-referenced."""
    name = indi.name or indi.id
    sex = {"M": "male", "F": "female"}.get(indi.sex, "unknown sex")
    by = indi.birth.year if indi.birth else None
    dy = indi.death.year if indi.death else None
    lifespan = ""
    if by and dy:
        lifespan = f", {by}–{dy}"
    elif by:
        lifespan = f", b. {by}"
    elif dy:
        lifespan = f", d. {dy}"

    out: list[str] = []
    out.append(f"# {name} ({indi.id}{lifespan}, {sex})")
    out.append("")

    # Parents
    if indi.famc and indi.famc in g.families:
        f = g.families[indi.famc]
        father = g.individuals.get(f.husb).name if f.husb and f.husb in g.individuals else None
        mother = g.individuals.get(f.wife).name if f.wife and f.wife in g.individuals else None
        if father or mother:
            out.append("## Parents")
            if father:
                out.append(f"- Father: {father}")
            if mother:
                out.append(f"- Mother: {mother}")
            out.append("")

    # Spouses + children, per family
    if indi.fams:
        out.append("## Marriages and children")
        for fid in indi.fams:
            f = g.families.get(fid)
            if not f:
                continue
            spouse_id = f.wife if indi.id == f.husb else f.husb
            spouse = g.individuals.get(spouse_id).name if spouse_id and spouse_id in g.individuals else "(unrecorded spouse)"
            line = f"- Married {spouse}"
            if f.marr:
                if f.marr.year:
                    line += f" in {f.marr.year}"
                if f.marr.place:
                    line += f" at {f.marr.place}"
            out.append(line)
            if f.div and f.div.year:
                out.append(f"  - Divorced in {f.div.year}")
            if f.chil:
                for cid in f.chil:
                    c = g.individuals.get(cid)
                    if not c:
                        continue
                    cname = c.name or cid
                    cby = c.birth.year if c.birth else None
                    cdy = c.death.year if c.death else None
                    suffix = ""
                    if cby and cdy: suffix = f" ({cby}–{cdy})"
                    elif cby: suffix = f" (b. {cby})"
                    out.append(f"  - Child: {cname}{suffix}")
        out.append("")

    # All events, sorted by year
    events = sorted(indi.events, key=lambda e: (e.year if e.year else 9999))
    if events:
        out.append("## Events")
        for ev in events:
            out.append(f"- {_short(ev)}")
        out.append("")

    # Top-level notes
    if indi.notes:
        out.append("## Notes")
        for nt in indi.notes[:5]:
            out.append(f"- {nt[:600]}")
        out.append("")

    # Top-level (non-event) source citations with URLs
    top_cites = [s for s in indi.sources if s.url]
    if top_cites:
        out.append("## Source URLs (top-level)")
        for s in top_cites[:8]:
            label = (s.page or s.text or s.src_id)[:100].strip()
            out.append(f"- [{label}]({s.url})")
        out.append("")

    return "\n".join(out).strip()


# ---------------------------------------------------------------------------
# Prose generation
# ---------------------------------------------------------------------------

SYSTEM_BIOGRAPHER = """You are a professional genealogist and biographer writing source-cited prose for a family-history project. Your output is read by descendants, students, and researchers.

You will receive a structured record for one individual: their name, lifespan, parents, marriages and children (with names and birth years), every dated event, and source citations (some with URLs). Produce well-crafted biographical prose.

Style and format:
- Open with the person's full name in **bold** at first mention.
- Write in flowing past tense. Convey dates, places, and life events as a coherent narrative — not a chronological checklist or a dump of facts.
- Refer to spouses, parents, children, and siblings by the names provided in the record. Do not invent any name not in the record.
- Cite sources inline with markdown links: weave them naturally — "the 1900 census recorded the family in Hertford County ([Ancestry source](url))" — or attach them parenthetically — "(see [headstone photograph](url))". Use only URLs that appear in the source data; do not invent URLs.
- When a date is approximate (ABT/EST/CAL), write "by 1865", "around 1865", "in the early 1860s" — do not pretend it is exact.
- When a place is given only at state or country level, do not invent a city or county.
- Hedge gracefully where evidence is thin: "appears in", "is recorded as", "according to the source".
- Do not editorialize ("a fascinating life", "a remarkable man", "tragically"). Do not write conclusions the data doesn't support. Do not assign emotions or motivations.
- Do not invent facts: occupations, religious affiliations, military service, immigration motives, causes of death, family relationships not in the record.
- Do not summarize the record by repeating headings or bullet labels. Translate the data into prose.

Output modes:
- "brief": one paragraph, 3–5 sentences. Focus on lifespan, parents, principal marriage, and place of life.
- "standard" (default): one or two paragraphs, ~120–250 words. Cover lifespan, parents (briefly), each marriage with spouse and major children, principal residences, and any distinctive life event from the record. Cite the most authoritative one or two sources.
- "detailed": two to four paragraphs, ~250–500 words. Build a coherent biographical sketch. Use the events list to show a life trajectory (where they were at each census, when and where children were born, when they moved, when each spouse and each parent died if recorded). Cite sources liberally with inline markdown links — but only where a URL is provided.
- "timeline": a markdown-ordered list of dated entries, each one a single fluent sentence: "**1850** — Born in Norfolk, Virginia, to John and Mary Smith ([Census](url))." Order strictly by year. Inline citations as before.

Output ONLY the prose (or the timeline list for "timeline" mode). No preamble. No headings except when "timeline" mode requires the year prefix in bold. No closing remarks."""


def _build_user_message(context_md: str, mode: str) -> str:
    return (
        f"Mode: {mode}\n\n"
        f"Structured record:\n\n"
        f"{context_md}\n\n"
        f"Write the {mode} biography now."
    )


def write_bio(client: anthropic.Anthropic, model: str, effort: str, mode: str,
              context_md: str, max_tokens: int) -> tuple[str, anthropic.types.Usage]:
    kwargs: dict = {
        "model": model,
        "max_tokens": max_tokens,
        "system": [{
            "type": "text",
            "text": SYSTEM_BIOGRAPHER,
            "cache_control": {"type": "ephemeral"},
        }],
        "messages": [{"role": "user", "content": _build_user_message(context_md, mode)}],
    }
    # Adaptive thinking + effort on Opus 4.7 / 4.6
    if model.startswith("claude-opus-4-7") or model.startswith("claude-opus-4-6") or model.startswith("claude-sonnet-4-6"):
        kwargs["thinking"] = {"type": "adaptive"}
        kwargs["output_config"] = {"effort": effort}

    # Stream so we get the final message without HTTP timeout risk
    with client.messages.stream(**kwargs) as stream:
        final = stream.get_final_message()
    text = next((b.text for b in final.content if getattr(b, "type", None) == "text"), "").strip()
    return text, final.usage


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ged", type=Path)
    ap.add_argument("--mode", choices=["brief", "standard", "detailed", "timeline"], default="standard")
    ap.add_argument("--model", default="claude-opus-4-7",
                    help="Default claude-opus-4-7. Use claude-haiku-4-5 to cut cost on large trees.")
    ap.add_argument("--effort", choices=["low", "medium", "high", "max"], default="high",
                    help="Thinking effort on Opus 4.6/4.7 / Sonnet 4.6. Ignored on Haiku.")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--out", type=Path, default=None,
                    help="Output JSON path (default: <ged>.summaries.json so the browser auto-loads it).")
    ap.add_argument("--md-dir", type=Path, default=None,
                    help="Optional: also write each individual's prose to <md-dir>/<id>.md")
    ap.add_argument("--max-tokens", type=int, default=2000)
    ap.add_argument("--min-events", type=int, default=1,
                    help="Skip individuals with fewer dated events than this (default 1).")
    ap.add_argument("--ids", type=str, default=None,
                    help="Comma-separated list of indi IDs to process (e.g. '@I123@,@I456@'). Overrides default scan.")
    args = ap.parse_args()

    out_path = args.out or args.ged.with_suffix(args.ged.suffix + ".summaries.json")
    if args.md_dir:
        args.md_dir.mkdir(parents=True, exist_ok=True)

    existing: dict[str, str] = {}
    if out_path.exists():
        try:
            existing = json.loads(out_path.read_text())
        except json.JSONDecodeError:
            print(f"Warning: existing {out_path} is malformed; starting fresh", file=sys.stderr)

    print(f"Parsing {args.ged}")
    g = parse_gedcom(args.ged)
    print(f"  {len(g.individuals):,} individuals, {len(g.families):,} families, {len(g.sources):,} sources")

    if args.ids:
        wanted = [s.strip() for s in args.ids.split(",") if s.strip()]
    else:
        wanted = [
            iid for iid, ind in g.individuals.items()
            if sum(1 for e in ind.events if e.year) >= args.min_events
        ]
    pending = [iid for iid in wanted if iid not in existing]
    print(f"  candidates: {len(wanted):,}, already done: {len(existing):,}, pending: {len(pending):,}")
    if args.limit is not None:
        pending = pending[: args.limit]
        print(f"  limiting this run to {len(pending):,}")

    if not pending:
        print("Nothing to do.")
        return 0

    client = anthropic.Anthropic()

    interrupted = {"flag": False}

    def _handle_sigint(signum, frame):
        interrupted["flag"] = True
        print("\nInterrupt received; finishing current request and saving...", file=sys.stderr)

    signal.signal(signal.SIGINT, _handle_sigint)

    save_every = 10
    written = 0
    cache_reads = cache_writes = input_tokens = output_tokens = 0
    start = time.time()

    def persist():
        out_path.write_text(json.dumps(existing, indent=2, ensure_ascii=False))

    for i, iid in enumerate(pending):
        if interrupted["flag"]:
            break
        ind = g.individuals[iid]
        ctx = build_context(g, ind)
        try:
            text, usage = write_bio(
                client, args.model, args.effort, args.mode, ctx, args.max_tokens,
            )
        except anthropic.APIStatusError as e:
            print(f"[{iid}] API error {e.status_code}: {e.message} - skipping", file=sys.stderr)
            continue
        except Exception as e:
            print(f"[{iid}] Unexpected error: {e!r} - skipping", file=sys.stderr)
            continue
        if not text:
            continue
        existing[iid] = text
        written += 1
        if args.md_dir:
            safe_id = re.sub(r"[^A-Za-z0-9_.-]+", "_", iid.strip("@"))
            (args.md_dir / f"{safe_id}.md").write_text(text)

        cache_reads += getattr(usage, "cache_read_input_tokens", 0) or 0
        cache_writes += getattr(usage, "cache_creation_input_tokens", 0) or 0
        input_tokens += usage.input_tokens or 0
        output_tokens += usage.output_tokens or 0

        if (i + 1) % 5 == 0:
            elapsed = time.time() - start
            rate = (i + 1) / elapsed if elapsed > 0 else 0
            print(
                f"[{i + 1}/{len(pending)}] {iid:30s} | "
                f"cache_r {cache_reads:,} cache_w {cache_writes:,} in {input_tokens:,} out {output_tokens:,} | {rate:.2f}/s"
            )

        if written % save_every == 0:
            persist()

    persist()
    print(
        f"\nWrote {len(existing)} biographies to {out_path}\n"
        f"Cache reads:  {cache_reads:,}\n"
        f"Cache writes: {cache_writes:,}\n"
        f"Input tokens: {input_tokens:,}\n"
        f"Output tokens:{output_tokens:,}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
