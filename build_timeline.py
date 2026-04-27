#!/usr/bin/env python3
"""Produce a compact timeline JSON for the animation viewer.

Inputs:
  individuals.json  - per-individual events with year + place
  places.json       - place_raw -> {lat, lon, level, cc, st}

Outputs:
  timeline.json     - {meta, dwells, flows}
"""
import json
import math
import random
import sys
from pathlib import Path

JITTER = 0.6  # degrees of jitter to avoid stacking
random.seed(7)


def jitter(lat: float, lon: float) -> tuple[float, float]:
    return (
        lat + (random.random() - 0.5) * JITTER,
        lon + (random.random() - 0.5) * JITTER,
    )


def main() -> None:
    src = Path(sys.argv[1])
    places_path = Path(sys.argv[2])
    out = Path(sys.argv[3])

    data = json.loads(src.read_text())
    places = json.loads(places_path.read_text())

    flows: list[list[float]] = []  # [from_year, to_year, from_lat, from_lon, to_lat, to_lon, sex_code]
    dwells: list[list[float]] = []  # [year, lat, lon, sex_code]
    min_year = 9999
    max_year = 0

    sex_code = {"M": 0, "F": 1, "U": 2}

    for indi in data["individuals"]:
        events = indi.get("events", [])
        coded: list[tuple[int, float, float]] = []
        for e in events:
            geo = places.get(e["place"])
            if not geo:
                continue
            lat, lon = jitter(geo["lat"], geo["lon"])
            coded.append((e["year"], lat, lon))
        if not coded:
            continue
        sx = sex_code.get(indi.get("sex", "U"), 2)
        coded.sort(key=lambda x: x[0])
        prev: tuple[int, float, float] | None = None
        for y, lat, lon in coded:
            min_year = min(min_year, y)
            max_year = max(max_year, y)
            dwells.append([y, round(lat, 3), round(lon, 3), sx])
            if prev is not None:
                py, plat, plon = prev
                if (plat, plon) != (lat, lon) and y > py:
                    flows.append([
                        py, y,
                        round(plat, 3), round(plon, 3),
                        round(lat, 3), round(lon, 3),
                        sx,
                    ])
            prev = (y, lat, lon)

    if min_year > max_year:
        min_year, max_year = 1700, 2026

    out_obj = {
        "meta": {
            "min_year": min_year,
            "max_year": max_year,
            "individuals": len(data["individuals"]),
            "dwells": len(dwells),
            "flows": len(flows),
        },
        "dwells": dwells,
        "flows": flows,
    }
    out.write_text(json.dumps(out_obj))
    print(json.dumps(out_obj["meta"], indent=2))


if __name__ == "__main__":
    main()
