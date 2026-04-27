#!/usr/bin/env python3
"""Build a compact JSON gazetteer for in-browser geocoding.

Layout (gazetteer.json):
{
  "countries": [{"cc": "US", "name": "United States", "lat":..., "lon":...}, ...],
  "admin1":    [{"cc": "US", "code": "VA", "name": "Virginia", "lat":..., "lon":...}, ...],
  "us_counties": [{"st":"VA","name":"henrico","lat":...,"lon":...}, ...],
  "cities":   compact array: alternating arrays per row,
              [name_slug, cc, admin1_code, lat, lon, pop]
}
"""
import json
import re
import sys
import unicodedata
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent
MIN_POP = int(sys.argv[1]) if len(sys.argv) > 1 else 1000


def slug(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def main() -> None:
    countries = []
    cc_to_name = {}
    with (ROOT / "countryInfo.txt").open() as f:
        for line in f:
            if line.startswith("#") or not line.strip():
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 9:
                continue
            iso, _iso3, _isoNum, _fips, name = parts[0], parts[1], parts[2], parts[3], parts[4]
            cc_to_name[iso] = name

    admin1 = []
    admin1_keys = []
    with (ROOT / "admin1.txt").open() as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 4:
                continue
            code, name, ascii_name, _gid = parts
            cc, st = code.split(".", 1)
            admin1.append({"cc": cc, "code": st, "name": ascii_name or name})
            admin1_keys.append((cc, st))

    us_counties = []
    with zipfile.ZipFile(ROOT / "US.zip") as z:
        with z.open("US.txt") as f:
            for raw in f:
                p = raw.decode("utf-8", "replace").rstrip("\n").split("\t")
                if len(p) < 15 or p[6] != "A" or p[7] != "ADM2":
                    continue
                ascii_name = p[2]
                try:
                    lat = float(p[4]); lon = float(p[5])
                except ValueError:
                    continue
                st = p[10]
                key = slug(ascii_name).replace(" county", "").replace(" parish", "").strip()
                us_counties.append({
                    "st": st,
                    "name": key,
                    "lat": round(lat, 4),
                    "lon": round(lon, 4),
                })

    cities = []
    state_lat_acc: dict[tuple[str, str], list[float]] = defaultdict(lambda: [0.0, 0.0, 0])
    country_lat_acc: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0, 0])
    with zipfile.ZipFile(ROOT / "cities500.zip") as z:
        with z.open("cities500.txt") as f:
            for raw in f:
                p = raw.decode("utf-8", "replace").rstrip("\n").split("\t")
                if len(p) < 15:
                    continue
                if p[6] != "P":
                    continue
                try:
                    lat = float(p[4]); lon = float(p[5])
                    pop = int(p[14])
                except ValueError:
                    continue
                cc = p[8]
                st = p[10]
                w = max(pop, 1)
                state_lat_acc[(cc, st)][0] += lat * w
                state_lat_acc[(cc, st)][1] += lon * w
                state_lat_acc[(cc, st)][2] += w
                country_lat_acc[cc][0] += lat * w
                country_lat_acc[cc][1] += lon * w
                country_lat_acc[cc][2] += w
                if pop < MIN_POP:
                    continue
                ascii_name = p[2] or p[1]
                alt = p[3]
                cities.append([
                    slug(ascii_name), cc, st,
                    round(lat, 4), round(lon, 4), pop,
                ])

    for a in admin1:
        key = (a["cc"], a["code"])
        if state_lat_acc[key][2] > 0:
            tw = state_lat_acc[key][2]
            a["lat"] = round(state_lat_acc[key][0] / tw, 4)
            a["lon"] = round(state_lat_acc[key][1] / tw, 4)
        else:
            a["lat"] = 0.0
            a["lon"] = 0.0

    for cc, name in cc_to_name.items():
        if country_lat_acc[cc][2] > 0:
            tw = country_lat_acc[cc][2]
            countries.append({
                "cc": cc, "name": name,
                "lat": round(country_lat_acc[cc][0] / tw, 4),
                "lon": round(country_lat_acc[cc][1] / tw, 4),
            })

    out = {
        "countries": countries,
        "admin1": admin1,
        "us_counties": us_counties,
        "cities": cities,
    }
    out_path = ROOT / "gazetteer.json"
    out_path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"countries: {len(countries)}")
    print(f"admin1:    {len(admin1)}")
    print(f"counties:  {len(us_counties)}")
    print(f"cities:    {len(cities)} (pop >= {MIN_POP})")
    print(f"size:      {out_path.stat().st_size / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()
