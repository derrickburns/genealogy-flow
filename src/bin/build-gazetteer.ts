#!/usr/bin/env -S npx tsx
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { argv, exit } from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { slug } from "../geo/slug.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const minPop = Number.parseInt(argv[2] ?? "1000", 10);

interface Country { cc: string; name: string; lat: number; lon: number; }
interface Admin1 { cc: string; code: string; name: string; lat: number; lon: number; }
interface UsCounty { st: string; name: string; lat: number; lon: number; }
type CityRow = [string, string, string, number, number, number];

function readGeonamesText(zipPath: string, innerName: string): string {
  const zip = new AdmZip(zipPath);
  const entry = zip.getEntry(innerName);
  if (!entry) throw new Error(`${innerName} not found in ${zipPath}`);
  return entry.getData().toString("utf8");
}

function round4(n: number): number { return Math.round(n * 10000) / 10000; }

function main(): number {
  const ccToName = new Map<string, string>();
  for (const line of readFileSync(join(ROOT, "countryInfo.txt"), "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 9) continue;
    const iso = parts[0]!;
    const name = parts[4]!;
    ccToName.set(iso, name);
  }

  const admin1: Admin1[] = [];
  for (const line of readFileSync(join(ROOT, "admin1.txt"), "utf8").split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const code = parts[0]!;
    const name = parts[1]!;
    const asciiName = parts[2]!;
    const dot = code.indexOf(".");
    if (dot < 0) continue;
    admin1.push({
      cc: code.slice(0, dot),
      code: code.slice(dot + 1),
      name: asciiName || name,
      lat: 0, lon: 0,
    });
  }

  const usCounties: UsCounty[] = [];
  const usText = readGeonamesText(join(ROOT, "US.zip"), "US.txt");
  for (const line of usText.split(/\r?\n/)) {
    if (!line) continue;
    const p = line.split("\t");
    if (p.length < 15 || p[6] !== "A" || p[7] !== "ADM2") continue;
    const asciiName = p[2]!;
    const lat = Number.parseFloat(p[4]!);
    const lon = Number.parseFloat(p[5]!);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const st = p[10]!;
    const key = slug(asciiName).replace(" county", "").replace(" parish", "").trim();
    usCounties.push({ st, name: key, lat: round4(lat), lon: round4(lon) });
  }

  const cities: CityRow[] = [];
  const stateAcc = new Map<string, [number, number, number]>();
  const countryAcc = new Map<string, [number, number, number]>();
  const accKey = (cc: string, st: string) => `${cc}|${st}`;

  const citiesText = readGeonamesText(join(ROOT, "cities500.zip"), "cities500.txt");
  for (const line of citiesText.split(/\r?\n/)) {
    if (!line) continue;
    const p = line.split("\t");
    if (p.length < 15 || p[6] !== "P") continue;
    const lat = Number.parseFloat(p[4]!);
    const lon = Number.parseFloat(p[5]!);
    const pop = Number.parseInt(p[14]!, 10);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(pop)) continue;
    const cc = p[8]!;
    const st = p[10]!;
    const w = Math.max(pop, 1);
    const sk = accKey(cc, st);
    const sa = stateAcc.get(sk) ?? [0, 0, 0];
    sa[0] += lat * w; sa[1] += lon * w; sa[2] += w;
    stateAcc.set(sk, sa);
    const ca = countryAcc.get(cc) ?? [0, 0, 0];
    ca[0] += lat * w; ca[1] += lon * w; ca[2] += w;
    countryAcc.set(cc, ca);
    if (pop < minPop) continue;
    const asciiName = p[2] || p[1]!;
    cities.push([slug(asciiName), cc, st, round4(lat), round4(lon), pop]);
  }

  for (const a of admin1) {
    const acc = stateAcc.get(accKey(a.cc, a.code));
    if (acc && acc[2] > 0) {
      a.lat = round4(acc[0] / acc[2]);
      a.lon = round4(acc[1] / acc[2]);
    }
  }

  const countries: Country[] = [];
  for (const [cc, name] of ccToName) {
    const acc = countryAcc.get(cc);
    if (acc && acc[2] > 0) {
      countries.push({
        cc, name,
        lat: round4(acc[0] / acc[2]),
        lon: round4(acc[1] / acc[2]),
      });
    }
  }

  const out = { countries, admin1, us_counties: usCounties, cities };
  const outPath = join(ROOT, "gazetteer.json");
  writeFileSync(outPath, JSON.stringify(out));
  const sizeMb = (statSync(outPath).size / 1024 / 1024).toFixed(1);
  console.log(`countries: ${countries.length}`);
  console.log(`admin1:    ${admin1.length}`);
  console.log(`counties:  ${usCounties.length}`);
  console.log(`cities:    ${cities.length} (pop >= ${minPop})`);
  console.log(`size:      ${sizeMb} MB`);
  return 0;
}

exit(main());
