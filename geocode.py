#!/usr/bin/env python3
"""Offline geocoder using GeoNames dumps.

Reads individuals.json, geocodes the unique place strings, writes places.json
mapping place_raw -> {lat, lon, level} where level is one of:
  city | county | admin1 | country
"""
import csv
import json
import re
import sys
import unicodedata
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent

US_STATE_ABBR = {
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
US_STATE_NAME = {v.lower(): k for k, v in US_STATE_ABBR.items()}
US_STATE_NAME["d.c."] = "DC"
US_STATE_NAME["washington d.c."] = "DC"
US_STATE_NAME["washington, d.c."] = "DC"

CA_PROVINCES = {
    "AB": "Alberta", "BC": "British Columbia", "MB": "Manitoba",
    "NB": "New Brunswick", "NL": "Newfoundland and Labrador", "NS": "Nova Scotia",
    "NT": "Northwest Territories", "NU": "Nunavut", "ON": "Ontario",
    "PE": "Prince Edward Island", "QC": "Quebec", "SK": "Saskatchewan", "YT": "Yukon",
}
CA_PROV_NAME = {v.lower(): k for k, v in CA_PROVINCES.items()}

COUNTRY_ALIASES = {
    "usa": "US", "u.s.a.": "US", "u.s.": "US", "united states": "US",
    "united states of america": "US", "us": "US", "america": "US",
    "uk": "GB", "u.k.": "GB", "england": "GB", "scotland": "GB",
    "wales": "GB", "great britain": "GB", "britain": "GB",
    "united kingdom": "GB", "northern ireland": "GB",
    "canada": "CA",
    "ireland": "IE",
    "germany": "DE", "deutschland": "DE", "prussia": "DE",
    "france": "FR", "italy": "IT", "spain": "ES", "portugal": "PT",
    "netherlands": "NL", "holland": "NL", "belgium": "BE",
    "switzerland": "CH", "austria": "AT", "poland": "PL", "russia": "RU",
    "ukraine": "UA", "sweden": "SE", "norway": "NO", "denmark": "DK",
    "finland": "FI", "australia": "AU", "new zealand": "NZ",
    "south africa": "ZA", "mexico": "MX", "brazil": "BR",
    "japan": "JP", "china": "CN", "india": "IN",
    "czechoslovakia": "CZ", "yugoslavia": "RS", "bohemia": "CZ",
    "moravia": "CZ", "prussia, germany": "DE",
}

PLACE_NORMALIZE = [
    (re.compile(r"\bCo\.?\b", re.IGNORECASE), "County"),
    (re.compile(r"\s+"), " "),
]

def slug(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def load_geonames():
    cities_path = ROOT / "cities500.zip"
    countries: dict[str, tuple[float, float, str]] = {}
    states: dict[tuple[str, str], tuple[float, float]] = {}
    state_names: dict[str, dict[str, tuple[float, float, str]]] = defaultdict(dict)
    cities_by_state: dict[tuple[str, str], dict[str, list[tuple[float, float, int]]]] = defaultdict(lambda: defaultdict(list))
    cities_by_country: dict[str, dict[str, list[tuple[float, float, int]]]] = defaultdict(lambda: defaultdict(list))
    counties_us: dict[tuple[str, str], tuple[float, float]] = {}

    with (ROOT / "countryInfo.txt").open() as f:
        for line in f:
            if line.startswith("#") or not line.strip():
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 9:
                continue
            iso, _, _, _, name, capital = parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]
            countries[iso] = (0.0, 0.0, name)
            COUNTRY_ALIASES.setdefault(name.lower(), iso)

    with (ROOT / "admin1.txt").open() as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 4:
                continue
            code, name, ascii_name, _gid = parts
            cc, st = code.split(".", 1)
            states[(cc, st)] = (0.0, 0.0)
            state_names[cc][slug(name)] = (0.0, 0.0, st)
            state_names[cc][slug(ascii_name)] = (0.0, 0.0, st)

    with zipfile.ZipFile(cities_path) as z:
        with z.open("cities500.txt") as f:
            for raw in f:
                p = raw.decode("utf-8", "replace").rstrip("\n").split("\t")
                if len(p) < 15:
                    continue
                name = p[1]
                ascii_name = p[2]
                alt = p[3]
                try:
                    lat = float(p[4]); lon = float(p[5])
                except ValueError:
                    continue
                fclass = p[6]
                cc = p[8]
                st = p[10]
                try:
                    pop = int(p[14])
                except ValueError:
                    pop = 0
                if fclass != "P":
                    continue
                key = slug(ascii_name or name)
                cities_by_state[(cc, st)][key].append((lat, lon, pop))
                cities_by_country[cc][key].append((lat, lon, pop))
                if alt:
                    for a in alt.split(","):
                        ak = slug(a)
                        if ak and ak != key:
                            cities_by_state[(cc, st)].setdefault(ak, []).append((lat, lon, pop // 2))

    with zipfile.ZipFile(ROOT / "US.zip") as z:
        with z.open("US.txt") as f:
            for raw in f:
                p = raw.decode("utf-8", "replace").rstrip("\n").split("\t")
                if len(p) < 15:
                    continue
                if p[6] != "A" or p[7] != "ADM2":
                    continue
                ascii_name = p[2]
                try:
                    lat = float(p[4]); lon = float(p[5])
                except ValueError:
                    continue
                st = p[10]
                key = slug(ascii_name).replace(" county", "").replace(" parish", "").strip()
                counties_us[(st, key)] = (lat, lon)
                key2 = slug(ascii_name).strip()
                counties_us[(st, key2)] = (lat, lon)

    state_centroids: dict[tuple[str, str], tuple[float, float]] = {}
    for (cc, st), city_map in cities_by_state.items():
        lats: list[float] = []
        lons: list[float] = []
        weights: list[int] = []
        for entries in city_map.values():
            for lat, lon, pop in entries:
                w = max(pop, 1)
                lats.append(lat * w)
                lons.append(lon * w)
                weights.append(w)
        if weights:
            tw = sum(weights)
            state_centroids[(cc, st)] = (sum(lats) / tw, sum(lons) / tw)

    country_centroids: dict[str, tuple[float, float, str]] = {}
    for cc, city_map in cities_by_country.items():
        lats: list[float] = []
        lons: list[float] = []
        weights: list[int] = []
        for entries in city_map.values():
            for lat, lon, pop in entries:
                w = max(pop, 1)
                lats.append(lat * w)
                lons.append(lon * w)
                weights.append(w)
        if weights:
            tw = sum(weights)
            name = countries.get(cc, (0, 0, cc))[2]
            country_centroids[cc] = (sum(lats) / tw, sum(lons) / tw, name)

    return {
        "cities_by_state": cities_by_state,
        "cities_by_country": cities_by_country,
        "counties_us": counties_us,
        "state_centroids": state_centroids,
        "country_centroids": country_centroids,
        "state_names": state_names,
    }


COUNTY_SUFFIX = re.compile(r"\b(County|Parish|Co\.?|Borough|Census Area)\b", re.IGNORECASE)


def detect_country(parts: list[str]) -> str | None:
    if not parts:
        return None
    last = slug(parts[-1])
    if last in COUNTRY_ALIASES:
        return COUNTRY_ALIASES[last]
    if len(parts) >= 2:
        last2 = slug(parts[-1] + " " + parts[-2])
        if last2 in COUNTRY_ALIASES:
            return COUNTRY_ALIASES[last2]
    return None


def detect_state(parts: list[str], cc: str, state_names: dict) -> tuple[str | None, int | None]:
    """Return (state_code, index_consumed) where index_consumed is the index of the
    state component in parts (counting from the end is implicit in caller).
    """
    if not parts:
        return None, None
    if cc == "US":
        for idx in range(len(parts) - 1, -1, -1):
            tok = parts[idx].strip()
            tok_up = tok.upper().rstrip(".")
            if tok_up in US_STATE_ABBR:
                return US_STATE_ABBR[tok_up].upper()[:2] if False else tok_up_to_geonames(tok_up), idx
            slugged = slug(tok)
            if slugged in US_STATE_NAME:
                return us_geonames_code(US_STATE_NAME[slugged]), idx
            if slugged in state_names.get("US", {}):
                return state_names["US"][slugged][2], idx
        return None, None
    if cc == "CA":
        for idx in range(len(parts) - 1, -1, -1):
            tok = parts[idx].strip()
            tok_up = tok.upper().rstrip(".")
            if tok_up in CA_PROVINCES:
                return tok_up, idx
            slugged = slug(tok)
            if slugged in CA_PROV_NAME:
                return CA_PROV_NAME[slugged], idx
        return None, None
    if cc and cc in state_names:
        for idx in range(len(parts) - 1, -1, -1):
            slugged = slug(parts[idx])
            if slugged in state_names[cc]:
                return state_names[cc][slugged][2], idx
    return None, None


def tok_up_to_geonames(abbr: str) -> str:
    return abbr


def us_geonames_code(abbr: str) -> str:
    return abbr


def best_city(candidates: list[tuple[float, float, int]]) -> tuple[float, float]:
    if not candidates:
        return None  # type: ignore
    best = max(candidates, key=lambda x: x[2])
    return best[0], best[1]


def find_county(parts: list[str], st: str, counties_us: dict) -> tuple[float, float] | None:
    for tok in parts:
        s = slug(tok)
        s_clean = s.replace(" county", "").replace(" parish", "").strip()
        for k in (s, s_clean):
            if (st, k) in counties_us:
                return counties_us[(st, k)]
    return None


def geocode_one(place: str, gz: dict) -> dict | None:
    parts = [p.strip() for p in place.split(",") if p.strip()]
    if not parts:
        return None
    cc = detect_country(parts) or "US"
    state_names = gz["state_names"]
    st, st_idx = detect_state(parts, cc, state_names)

    has_county_token = any(COUNTY_SUFFIX.search(p) for p in parts)
    if cc == "US" and st and has_county_token:
        cty = find_county(parts, st, gz["counties_us"])
        if cty:
            for tok in parts[:st_idx]:
                if not COUNTY_SUFFIX.search(tok):
                    s = slug(tok)
                    cands = gz["cities_by_state"].get((cc, st), {}).get(s)
                    if cands:
                        lat, lon = best_city(cands)
                        return {"lat": lat, "lon": lon, "level": "city", "cc": cc, "st": st}
            return {"lat": cty[0], "lon": cty[1], "level": "county", "cc": cc, "st": st}

    if st:
        upper = st_idx if st_idx is not None else len(parts)
        candidates_lookup = gz["cities_by_state"].get((cc, st), {})
        for tok in parts[:upper]:
            if COUNTY_SUFFIX.search(tok):
                continue
            s = slug(tok)
            cands = candidates_lookup.get(s)
            if cands:
                lat, lon = best_city(cands)
                return {"lat": lat, "lon": lon, "level": "city", "cc": cc, "st": st}
        if cc == "US":
            cty = find_county(parts, st, gz["counties_us"])
            if cty:
                return {"lat": cty[0], "lon": cty[1], "level": "county", "cc": cc, "st": st}
        sc = gz["state_centroids"].get((cc, st))
        if sc:
            return {"lat": sc[0], "lon": sc[1], "level": "admin1", "cc": cc, "st": st}

    if cc:
        cand_lookup = gz["cities_by_country"].get(cc, {})
        for tok in parts:
            s = slug(tok)
            cands = cand_lookup.get(s)
            if cands:
                lat, lon = best_city(cands)
                return {"lat": lat, "lon": lon, "level": "city", "cc": cc, "st": None}
        cc_centroid = gz["country_centroids"].get(cc)
        if cc_centroid:
            return {"lat": cc_centroid[0], "lon": cc_centroid[1], "level": "country", "cc": cc, "st": None}

    return None


def main() -> None:
    src = Path(sys.argv[1])
    out = Path(sys.argv[2])
    print("Loading GeoNames...")
    gz = load_geonames()
    print(f"  {sum(len(v) for v in gz['cities_by_state'].values())} city entries")
    print(f"  {len(gz['counties_us'])} US county entries")
    print(f"  {len(gz['state_centroids'])} state centroids")

    data = json.loads(src.read_text())
    places: set[str] = set()
    for p in data["individuals"]:
        for e in p["events"]:
            places.add(e["place"])
    print(f"Geocoding {len(places)} unique places...")

    results: dict[str, dict] = {}
    misses: list[str] = []
    counts = {"city": 0, "county": 0, "admin1": 0, "country": 0, "miss": 0}
    for place in places:
        r = geocode_one(place, gz)
        if r is None:
            counts["miss"] += 1
            misses.append(place)
        else:
            counts[r["level"]] += 1
            results[place] = r

    out.write_text(json.dumps(results))
    print(f"Wrote {len(results)} place mappings to {out}")
    print(f"Resolution counts: {counts}")
    print(f"Miss rate: {counts['miss']}/{len(places)} = {counts['miss']/len(places):.1%}")
    (ROOT / "misses.txt").write_text("\n".join(sorted(misses)[:500]))


if __name__ == "__main__":
    main()
