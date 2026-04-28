#!/usr/bin/env python3
"""Classify each migration in a GEDCOM against historical patterns.

Reads a .ged file, finds every cross-place move (consecutive dated events for
the same individual at different places), assigns each move a US state and
country code, and matches it against:

  1. Named historical patterns (Great Migration, Westward Expansion, Sun Belt,
     European immigration waves, Dust Bowl, Reverse Great Migration).
  2. Family-specific clusters: many family members making the same regional
     move within ~30 years.

Writes a sidecar JSON the browser auto-loads:

    {
      "patterns":  [{name, years:[a,b], color, description, match_count}, ...],
      "migrations":[{year, indi, indi_name, from_state, from_country,
                     to_state, to_country, pattern}, ...],
      "family_clusters": [{from_region, to_region, decade, count, indis}, ...],
      "by_decade": {"1900": {"total": N, "by_pattern": {...}}, ...}
    }

Usage:
    python3 migrations.py PATH_TO.ged [--out PATH.migrations.json]
"""
import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

US_STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
    "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
    "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia",
    "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana",
    "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
    "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan",
    "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri", "MT": "Montana",
    "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey",
    "NM": "New Mexico", "NY": "New York", "NC": "North Carolina",
    "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon",
    "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
    "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
    "WI": "Wisconsin", "WY": "Wyoming",
}
US_NAME_TO_ABBR = {v.lower(): k for k, v in US_STATES.items()}
US_NAME_TO_ABBR["d.c."] = "DC"
US_NAME_TO_ABBR["washington d.c."] = "DC"

US_REGIONS = {
    "South": {"AL", "AR", "FL", "GA", "KY", "LA", "MS", "NC", "OK", "SC", "TN", "TX", "VA", "WV", "DC", "MD", "DE"},
    "Northeast": {"CT", "ME", "MA", "NH", "NJ", "NY", "PA", "RI", "VT"},
    "Midwest": {"IL", "IN", "IA", "KS", "MI", "MN", "MO", "NE", "ND", "OH", "SD", "WI"},
    "West": {"AK", "AZ", "CA", "CO", "HI", "ID", "MT", "NV", "NM", "OR", "UT", "WA", "WY"},
}
STATE_TO_REGION = {st: region for region, sts in US_REGIONS.items() for st in sts}

COUNTRY_ALIASES = {
    "usa": "US", "u.s.a.": "US", "u.s.": "US", "united states": "US",
    "united states of america": "US", "us": "US", "america": "US",
    "uk": "GB", "u.k.": "GB", "england": "GB", "scotland": "GB",
    "wales": "GB", "great britain": "GB", "britain": "GB",
    "united kingdom": "GB", "northern ireland": "GB", "ireland": "IE",
    "germany": "DE", "deutschland": "DE", "prussia": "DE",
    "france": "FR", "italy": "IT", "spain": "ES", "portugal": "PT",
    "netherlands": "NL", "holland": "NL", "belgium": "BE",
    "switzerland": "CH", "austria": "AT", "poland": "PL", "russia": "RU",
    "ukraine": "UA", "sweden": "SE", "norway": "NO", "denmark": "DK",
    "finland": "FI", "australia": "AU", "new zealand": "NZ",
    "south africa": "ZA", "mexico": "MX", "brazil": "BR",
    "japan": "JP", "china": "CN", "india": "IN",
    "czechoslovakia": "CZ", "yugoslavia": "RS", "bohemia": "CZ",
    "moravia": "CZ", "hungary": "HU", "greece": "GR", "romania": "RO",
    "lithuania": "LT", "latvia": "LV", "estonia": "EE",
    "canada": "CA",
}


def classify_place(place: str) -> tuple[str | None, str | None]:
    """Return (us_state_abbr_or_None, country_code) from a comma-separated place string."""
    parts = [p.strip() for p in place.split(",") if p.strip()]
    if not parts:
        return None, None
    last = parts[-1].lower()
    last_clean = last.rstrip(".")
    country = COUNTRY_ALIASES.get(last_clean) or COUNTRY_ALIASES.get(last)
    if len(parts) >= 2 and not country:
        last2 = (parts[-2].lower() + " " + parts[-1].lower()).strip()
        country = COUNTRY_ALIASES.get(last2)
    if country is None and any(US_NAME_TO_ABBR.get(p.lower().rstrip(".")) for p in parts):
        country = "US"
    if country is None and any(p.upper().rstrip(".") in US_STATES for p in parts):
        country = "US"
    state = None
    if country == "US":
        for p in reversed(parts):
            up = p.upper().rstrip(".")
            if up in US_STATES:
                state = up
                break
            sl = p.lower().rstrip(".")
            if sl in US_NAME_TO_ABBR:
                state = US_NAME_TO_ABBR[sl]
                break
    return state, country


PATTERNS = [
    {
        "name": "European Immigration (Old Wave)",
        "years": [1820, 1880],
        "color": "#9bc4e2",
        "description": "Migration from Western/Northern Europe (Ireland, Germany, Britain, Scandinavia) to the United States. Driven by the Irish Potato Famine, German revolutions of 1848, and economic opportunity.",
        "match": lambda fc, fs, tc, ts, year: (
            fc in {"IE", "DE", "GB", "NO", "SE", "DK", "NL", "FR"} and tc == "US" and 1820 <= year <= 1880
        ),
    },
    {
        "name": "Westward Expansion",
        "years": [1840, 1900],
        "color": "#d8a26b",
        "description": "Movement from the Northeast and South to the Plains, Midwest, and Pacific Coast. Drove the displacement of Indigenous peoples and the establishment of new states.",
        "match": lambda fc, fs, tc, ts, year: (
            tc == "US" and fc == "US"
            and STATE_TO_REGION.get(fs) in {"Northeast", "South", "Midwest"}
            and STATE_TO_REGION.get(ts) == "West"
            and 1840 <= year <= 1900
        ),
    },
    {
        "name": "European Immigration (New Wave)",
        "years": [1880, 1924],
        "color": "#c799d6",
        "description": "Mass immigration from Southern and Eastern Europe — Italy, Poland, Russia, Ukraine, Austria-Hungary, Greece, the Balkans. Often included Jewish refugees fleeing pogroms. Ended with the National Origins Act of 1924.",
        "match": lambda fc, fs, tc, ts, year: (
            fc in {"IT", "PL", "RU", "UA", "AT", "HU", "GR", "RS", "RO", "CZ", "LT", "LV", "EE"}
            and tc == "US" and 1880 <= year <= 1924
        ),
    },
    {
        "name": "Great Migration (First Wave)",
        "years": [1910, 1940],
        "color": "#e07b67",
        "description": "Black Americans leaving the rural South for industrial Northern cities (New York, Chicago, Detroit, Philadelphia). Driven by Jim Crow, lynchings, sharecropping, and demand for labor in WWI-era factories.",
        "match": lambda fc, fs, tc, ts, year: (
            fc == "US" and tc == "US"
            and STATE_TO_REGION.get(fs) == "South"
            and STATE_TO_REGION.get(ts) in {"Northeast", "Midwest"}
            and 1910 <= year <= 1940
        ),
    },
    {
        "name": "Dust Bowl Migration",
        "years": [1930, 1940],
        "color": "#a89968",
        "description": "Plains farmers (Oklahoma, Texas, Kansas, Arkansas) displaced to California during the Dust Bowl and Great Depression. The 'Okies' of Steinbeck's Grapes of Wrath.",
        "match": lambda fc, fs, tc, ts, year: (
            fc == "US" and tc == "US"
            and fs in {"OK", "TX", "KS", "AR", "NM", "CO"}
            and ts == "CA"
            and 1930 <= year <= 1940
        ),
    },
    {
        "name": "Great Migration (Second Wave)",
        "years": [1940, 1970],
        "color": "#dc6e58",
        "description": "Continuation of the Great Migration into the West Coast (especially California) plus continued movement North. Tied to wartime defense industry and postwar manufacturing.",
        "match": lambda fc, fs, tc, ts, year: (
            fc == "US" and tc == "US"
            and STATE_TO_REGION.get(fs) == "South"
            and STATE_TO_REGION.get(ts) in {"Northeast", "Midwest", "West"}
            and 1940 <= year <= 1970
        ),
    },
    {
        "name": "Sun Belt Migration",
        "years": [1970, 2010],
        "color": "#f0c75e",
        "description": "Reversal: Northeast and Midwest residents moving to the South and Southwest (Florida, Texas, Arizona, Georgia, North Carolina). Driven by air conditioning, deindustrialization in the Rust Belt, and lower cost of living.",
        "match": lambda fc, fs, tc, ts, year: (
            fc == "US" and tc == "US"
            and STATE_TO_REGION.get(fs) in {"Northeast", "Midwest"}
            and STATE_TO_REGION.get(ts) in {"South", "West"}
            and ts in {"FL", "TX", "GA", "NC", "AZ", "CA", "NV", "SC", "TN"}
            and 1970 <= year <= 2010
        ),
    },
    {
        "name": "Reverse Great Migration",
        "years": [1990, 2025],
        "color": "#7eb87e",
        "description": "Black Americans returning to the South — particularly Atlanta, Charlotte, Houston, and the Carolinas — reversing a century-long northward flow. Driven by job markets, family ties, and the decline of legalized segregation.",
        "match": lambda fc, fs, tc, ts, year: (
            fc == "US" and tc == "US"
            and STATE_TO_REGION.get(fs) in {"Northeast", "Midwest", "West"}
            and STATE_TO_REGION.get(ts) == "South"
            and 1990 <= year <= 2025
        ),
    },
]


# ---------------------------------------------------------------------------
# Lightweight GEDCOM parser (just enough for migration extraction)
# ---------------------------------------------------------------------------

LINE_RE = re.compile(r"^(\d+)\s+(?:(@[^@]+@)\s+)?(\S+)(?:\s+(.*))?$")
DATE_YEAR_RE = re.compile(
    r"(?:(?:ABT|BEF|AFT|EST|CAL|FROM|TO|BET|AND)\s+)?"
    r"(?:\d{1,2}\s+)?"
    r"(?:(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+)?"
    r"(\d{3,4})", re.IGNORECASE,
)


def parse_year(s: str):
    if not s: return None
    m = DATE_YEAR_RE.search(s)
    if not m: return None
    y = int(m.group(1))
    return y if 1000 <= y <= 2100 else None


def parse_individuals(path: Path):
    """Yield {id, name, events:[{year, place}]} for each indi with dated events."""
    cur = None
    cur_event = None
    name = None
    in_indi = False
    events: list[dict] = []
    with path.open(encoding="utf-8", errors="replace") as f:
        for raw in f:
            line = raw.rstrip("\n").rstrip("\r")
            if not line.strip(): continue
            m = LINE_RE.match(line)
            if not m: continue
            lvl = int(m.group(1))
            xref = m.group(2)
            tag = m.group(3)
            val = m.group(4) or ""
            if lvl == 0:
                if cur and events:
                    yield {"id": cur, "name": name or cur, "events": events}
                cur = xref if tag == "INDI" else None
                in_indi = (tag == "INDI" and xref is not None)
                cur_event = None
                name = None
                events = []
                continue
            if not in_indi: continue
            if lvl == 1:
                if tag == "NAME" and not name:
                    name = val.replace("/", "").strip()
                elif tag in {"BIRT", "DEAT", "RESI", "MARR", "EMIG", "IMMI", "CENS", "BAPM", "BURI", "CHR"}:
                    cur_event = {"tag": tag}
                else:
                    cur_event = None
            elif lvl == 2 and cur_event is not None:
                if tag == "DATE":
                    cur_event["year"] = parse_year(val)
                elif tag == "PLAC":
                    cur_event["place"] = val.strip()
                if cur_event.get("year") is not None and cur_event.get("place"):
                    events.append({"year": cur_event["year"], "place": cur_event["place"]})
                    cur_event = None
        if cur and events:
            yield {"id": cur, "name": name or cur, "events": events}


# ---------------------------------------------------------------------------
# Migration extraction
# ---------------------------------------------------------------------------

def extract_migrations(individuals: list[dict]) -> list[dict]:
    out = []
    for ind in individuals:
        evs = sorted({(e["year"], e["place"]) for e in ind["events"]}, key=lambda x: x[0])
        prev = None
        for year, place in evs:
            fs, fc = classify_place(place)
            if prev is not None:
                py, pp, ps, pc = prev
                if pp != place:
                    out.append({
                        "year": year,
                        "from_year": py,
                        "indi": ind["id"], "indi_name": ind["name"],
                        "from_place": pp, "to_place": place,
                        "from_state": ps, "from_country": pc,
                        "to_state": fs, "to_country": fc,
                    })
            prev = (year, place, fs, fc)
    return out


def classify(mig: dict) -> str | None:
    fs, fc, ts, tc, year = mig["from_state"], mig["from_country"], mig["to_state"], mig["to_country"], mig["year"]
    for p in PATTERNS:
        try:
            if p["match"](fc, fs, tc, ts, year):
                return p["name"]
        except Exception:
            pass
    return None


def find_family_clusters(migrations: list[dict], min_count: int = 3) -> list[dict]:
    """Group migrations by (from_region, to_region, decade); flag groups of >= min_count distinct individuals."""
    buckets: dict[tuple, list[dict]] = defaultdict(list)
    for m in migrations:
        fs, fc, ts, tc = m["from_state"], m["from_country"], m["to_state"], m["to_country"]
        if not fc or not tc: continue
        from_label = STATE_TO_REGION.get(fs) if fc == "US" else fc
        to_label = STATE_TO_REGION.get(ts) if tc == "US" else tc
        if not from_label or not to_label or from_label == to_label and fs == ts:
            # same place inside same region (city-to-city) — skip clustering
            continue
        decade = (m["year"] // 10) * 10
        buckets[(from_label, to_label, decade)].append(m)
    clusters = []
    for (from_label, to_label, decade), group in buckets.items():
        indis = sorted({m["indi"] for m in group})
        if len(indis) < min_count: continue
        clusters.append({
            "from_region": from_label,
            "to_region": to_label,
            "decade": decade,
            "count": len(indis),
            "indis": indis[:50],
            "sample_names": sorted({m["indi_name"] for m in group})[:6],
        })
    clusters.sort(key=lambda c: (-c["count"], c["decade"]))
    return clusters


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ged", type=Path)
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--min-cluster", type=int, default=3, help="Minimum individuals to declare a family cluster (default 3)")
    args = ap.parse_args()

    out_path = args.out or args.ged.with_suffix(args.ged.suffix + ".migrations.json")

    print(f"Parsing {args.ged}")
    individuals = list(parse_individuals(args.ged))
    print(f"  {len(individuals):,} individuals with dated events")

    migs = extract_migrations(individuals)
    print(f"  {len(migs):,} cross-place migrations")

    pattern_counts: Counter = Counter()
    by_decade: dict[int, dict] = {}
    for m in migs:
        pat = classify(m)
        m["pattern"] = pat
        if pat:
            pattern_counts[pat] += 1
        decade = (m["year"] // 10) * 10
        rec = by_decade.setdefault(decade, {"total": 0, "by_pattern": {}})
        rec["total"] += 1
        if pat:
            rec["by_pattern"][pat] = rec["by_pattern"].get(pat, 0) + 1

    pattern_list = []
    for p in PATTERNS:
        pattern_list.append({
            "name": p["name"],
            "years": p["years"],
            "color": p["color"],
            "description": p["description"],
            "match_count": pattern_counts.get(p["name"], 0),
        })

    clusters = find_family_clusters(migs, min_count=args.min_cluster)

    out = {
        "patterns": pattern_list,
        "migrations": [{k: v for k, v in m.items() if k != "match"} for m in migs],
        "family_clusters": clusters,
        "by_decade": {str(k): v for k, v in sorted(by_decade.items())},
    }
    out_path.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(f"\nWrote {out_path}")
    print("\nMatched patterns (count of migrations):")
    for p in pattern_list:
        if p["match_count"]:
            print(f"  {p['match_count']:>5}  {p['name']}  {p['years'][0]}-{p['years'][1]}")
    if clusters:
        print(f"\nFamily-specific clusters (>={args.min_cluster} individuals making the same regional move within a decade):")
        for c in clusters[:20]:
            sample = ", ".join(c["sample_names"][:3])
            print(f"  {c['count']:>3}  {c['from_region']:>10} -> {c['to_region']:<10} {c['decade']}s  e.g. {sample}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
