#!/usr/bin/env python3
"""Diagnose parent-count detection on the actual GEDCOM."""
import re
import sys
from collections import Counter

GED = sys.argv[1]

individuals = {}
families = {}
mode = None
cur_id = None
cur_indi_famcs = []
cur_fam = None

with open(GED, encoding="utf-8", errors="replace") as f:
    for raw in f:
        line = raw.rstrip("\n").rstrip("\r")
        if not line:
            continue
        sp = line.find(" ")
        if sp < 0:
            continue
        try:
            lvl = int(line[:sp])
        except ValueError:
            continue
        rest = line[sp+1:]
        if lvl == 0:
            if mode == "INDI" and cur_id:
                individuals[cur_id] = {"famcs": cur_indi_famcs}
            elif mode == "FAM" and cur_fam:
                families[cur_id] = cur_fam
            cur_id = None; mode = None
            cur_indi_famcs = []
            cur_fam = None
            mi = re.match(r"^(@[^@]+@)\s+INDI", rest)
            mf = re.match(r"^(@[^@]+@)\s+FAM", rest)
            if mi:
                cur_id = mi.group(1)
                mode = "INDI"
            elif mf:
                cur_id = mf.group(1)
                mode = "FAM"
                cur_fam = {"husb": None, "wife": None, "chil": []}
            continue
        if cur_id is None:
            continue
        sp2 = rest.find(" ")
        tag = rest[:sp2] if sp2 >= 0 else rest
        value = rest[sp2+1:] if sp2 >= 0 else ""
        if lvl == 1:
            if mode == "INDI":
                if tag == "FAMC":
                    cur_indi_famcs.append(value.strip())
            elif mode == "FAM":
                if tag == "HUSB":
                    cur_fam["husb"] = value.strip()
                elif tag == "WIFE":
                    cur_fam["wife"] = value.strip()
                elif tag == "CHIL":
                    cur_fam["chil"].append(value.strip())

if mode == "INDI" and cur_id:
    individuals[cur_id] = {"famcs": cur_indi_famcs}
elif mode == "FAM" and cur_fam:
    families[cur_id] = cur_fam

# Compute parent status using FIRST FAMC only (matches JS logic)
status_first_only = Counter()
status_any_famc = Counter()
for iid, ind in individuals.items():
    famcs = ind["famcs"]
    # First-FAMC-only logic (matches current JS)
    if not famcs:
        status_first_only["no famc"] += 1
    else:
        f0 = families.get(famcs[0])
        if not f0:
            status_first_only["famc bad ref"] += 1
        else:
            n = (1 if f0["husb"] else 0) + (1 if f0["wife"] else 0)
            status_first_only[f"first-famc has {n} parent"] += 1

    # Any-FAMC logic
    if not famcs:
        status_any_famc["no famc"] += 1
    else:
        max_n = 0
        for fid in famcs:
            f = families.get(fid)
            if not f:
                continue
            n = (1 if f["husb"] else 0) + (1 if f["wife"] else 0)
            if n > max_n:
                max_n = n
        status_any_famc[f"any-famc has {max_n} parent"] += 1

print(f"Total individuals: {len(individuals)}")
print(f"Total families:    {len(families)}")
print()
print("First-FAMC-only logic (current JS):")
for k, v in sorted(status_first_only.items()):
    print(f"  {k:35s} {v}")
print()
print("Any-FAMC logic (alternative):")
for k, v in sorted(status_any_famc.items()):
    print(f"  {k:35s} {v}")

# Multi-FAMC counts
multi = sum(1 for ind in individuals.values() if len(ind["famcs"]) > 1)
print(f"\nIndividuals with >1 FAMC: {multi}")

# Check: kids referenced via CHIL in FAM records, who have no FAMC of their own
chil_to_family = {}
for fid, f in families.items():
    for c in f["chil"]:
        chil_to_family.setdefault(c, []).append(fid)

orphans_with_chil_link = 0
implicit_parent_recorded = Counter()
for iid, ind in individuals.items():
    if ind["famcs"]:
        continue  # has explicit FAMC
    fams_listing_them = chil_to_family.get(iid, [])
    if not fams_listing_them:
        continue
    orphans_with_chil_link += 1
    # find max parent count across these families
    max_n = 0
    for fid in fams_listing_them:
        f = families.get(fid)
        if not f:
            continue
        n = (1 if f["husb"] else 0) + (1 if f["wife"] else 0)
        if n > max_n:
            max_n = n
    implicit_parent_recorded[f"implicit-{max_n}-parent"] += 1
print(f"\nIndividuals with no FAMC but referenced as CHIL elsewhere: {orphans_with_chil_link}")
for k, v in sorted(implicit_parent_recorded.items()):
    print(f"  {k}: {v}")

# Now scan the file again to grab names and a sample of individuals with no FAMC
# but appearing as parents (HUSB/WIFE) -- those are the "spouse-only" sources.
parents_set = set()
for f in families.values():
    if f["husb"]: parents_set.add(f["husb"])
    if f["wife"]: parents_set.add(f["wife"])

# Re-parse to extract names
import re as _re
names = {}
mode_n = None; cur_id_n = None
with open(GED, encoding="utf-8", errors="replace") as fh:
    for raw in fh:
        line = raw.rstrip()
        if not line: continue
        if line.startswith("0 "):
            mi = _re.match(r"^0 (@[^@]+@)\s+INDI", line)
            if mi:
                cur_id_n = mi.group(1); mode_n = "INDI"
            else:
                cur_id_n = None; mode_n = None
        elif mode_n == "INDI" and line.startswith("1 NAME ") and cur_id_n not in names:
            names[cur_id_n] = line[7:].replace("/", "").strip()

# Categorize the no-FAMC people:
no_famc = [iid for iid, ind in individuals.items() if not ind["famcs"]]
no_famc_parents = [iid for iid in no_famc if iid in parents_set]
no_famc_orphans = [iid for iid in no_famc if iid not in parents_set]

print(f"\nNo-FAMC breakdown:")
print(f"  total no-FAMC: {len(no_famc)}")
print(f"  also appear as parent (spouses-in / earliest ancestors): {len(no_famc_parents)}")
print(f"  appear nowhere as parent (true terminal leaves): {len(no_famc_orphans)}")
print(f"\nFirst 10 no-FAMC names that ARE recorded as parents:")
for iid in no_famc_parents[:10]:
    print(f"  {iid:30s} {names.get(iid, '?')}")
print(f"\nFirst 10 no-FAMC names that are NOT parents (true orphans):")
for iid in no_famc_orphans[:10]:
    print(f"  {iid:30s} {names.get(iid, '?')}")

# Bad-reference families
bad = 0
for ind in individuals.values():
    for fid in ind["famcs"]:
        if fid not in families:
            bad += 1
print(f"FAMC references that don't resolve: {bad}")
