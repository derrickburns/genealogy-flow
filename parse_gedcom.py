#!/usr/bin/env python3
"""Parse a GEDCOM file into per-individual dated location events."""
import json
import re
import sys
from pathlib import Path

GED_PATH = Path(sys.argv[1])
OUT_PATH = Path(sys.argv[2])

EVENT_TAGS = {"BIRT", "DEAT", "RESI", "MARR", "EMIG", "IMMI", "CENS", "BAPM", "BURI", "CHR"}

DATE_RE = re.compile(r"(?:(?:ABT|BEF|AFT|EST|CAL|FROM|TO|BET|AND)\s+)?"
                     r"(?:\d{1,2}\s+)?"
                     r"(?:(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+)?"
                     r"(\d{3,4})", re.IGNORECASE)

def parse_year(date_str: str) -> int | None:
    if not date_str:
        return None
    m = DATE_RE.search(date_str)
    if not m:
        return None
    y = int(m.group(2))
    if 1000 <= y <= 2100:
        return y
    return None

def parse_name(name_str: str) -> str:
    return name_str.replace("/", "").strip()

def main() -> None:
    individuals: dict[str, dict] = {}
    cur_indi: str | None = None
    cur_event: str | None = None
    cur_event_data: dict = {}
    cur_name: str | None = None
    cur_sex: str | None = None
    cur_birth_year: int | None = None
    cur_death_year: int | None = None

    def flush_event() -> None:
        nonlocal cur_event, cur_event_data, cur_birth_year, cur_death_year
        if cur_event and cur_indi:
            year = parse_year(cur_event_data.get("DATE", ""))
            place = cur_event_data.get("PLAC", "").strip()
            if year is not None and place:
                individuals[cur_indi]["events"].append({
                    "type": cur_event,
                    "year": year,
                    "place": place,
                })
            if cur_event == "BIRT" and year is not None and cur_birth_year is None:
                cur_birth_year = year
            if cur_event == "DEAT" and year is not None and cur_death_year is None:
                cur_death_year = year
        cur_event = None
        cur_event_data = {}

    def flush_indi() -> None:
        nonlocal cur_indi, cur_name, cur_sex, cur_birth_year, cur_death_year
        flush_event()
        if cur_indi and cur_indi in individuals:
            individuals[cur_indi]["name"] = cur_name or cur_indi
            individuals[cur_indi]["sex"] = cur_sex or "U"
            individuals[cur_indi]["birth_year"] = cur_birth_year
            individuals[cur_indi]["death_year"] = cur_death_year
            individuals[cur_indi]["events"].sort(key=lambda e: e["year"])
        cur_indi = None
        cur_name = None
        cur_sex = None
        cur_birth_year = None
        cur_death_year = None

    indi_re = re.compile(r"^0 (@[^@]+@) INDI")
    other_top_re = re.compile(r"^0 ")

    with GED_PATH.open("r", encoding="utf-8", errors="replace") as f:
        for raw in f:
            line = raw.rstrip("\n").rstrip("\r")
            if not line:
                continue
            m = indi_re.match(line)
            if m:
                flush_indi()
                cur_indi = m.group(1)
                individuals[cur_indi] = {"events": []}
                continue
            if other_top_re.match(line):
                flush_indi()
                continue
            if cur_indi is None:
                continue
            parts = line.split(" ", 2)
            if len(parts) < 2:
                continue
            level_str = parts[0]
            tag = parts[1]
            value = parts[2] if len(parts) > 2 else ""
            try:
                level = int(level_str)
            except ValueError:
                continue
            if level == 1:
                flush_event()
                if tag in EVENT_TAGS:
                    cur_event = tag
                    cur_event_data = {}
                elif tag == "NAME" and cur_name is None:
                    cur_name = parse_name(value)
                elif tag == "SEX" and cur_sex is None:
                    cur_sex = value.strip()[:1] or "U"
            elif level == 2 and cur_event is not None:
                if tag == "DATE":
                    cur_event_data["DATE"] = value
                elif tag == "PLAC":
                    cur_event_data["PLAC"] = value
        flush_indi()

    out = {
        "individuals": [
            {"id": iid, **data}
            for iid, data in individuals.items()
            if data.get("events")
        ]
    }
    OUT_PATH.write_text(json.dumps(out))
    print(f"Wrote {len(out['individuals'])} individuals with events to {OUT_PATH}")
    total_events = sum(len(p["events"]) for p in out["individuals"])
    print(f"Total events: {total_events}")
    places: set[str] = set()
    for p in out["individuals"]:
        for e in p["events"]:
            places.add(e["place"])
    print(f"Unique places: {len(places)}")

if __name__ == "__main__":
    main()
