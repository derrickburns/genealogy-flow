import type { Env } from "../_middleware";

const PUBLIC_DEMO_KEY = "demo/demo.json";
const RAW_FALLBACK_KEY = "demo/golden-rosenberg.json";
const LIVING_MAX_AGE = 115;

function records(value: unknown): Record<string, any>[] {
  if (Array.isArray(value)) return value.filter(item => item && typeof item === "object") as Record<string, any>[];
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, any>)
      .filter(([, item]) => item && typeof item === "object")
      .map(([id, item]) => ({ id, ...(item as Record<string, any>) }));
  }
  return [];
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function idOf(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function childIds(value: unknown): string[] {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return rows.map(child => {
    if (child && typeof child === "object") {
      const row = child as Record<string, any>;
      return idOf(row.id ?? row.child_id ?? row.child ?? row.xref);
    }
    return idOf(child);
  }).filter(Boolean);
}

function nameLooksPrivate(value: unknown): boolean {
  return /\b(living|private|redacted|withheld)\b/i.test(String(value ?? ""));
}

function hasExplicitDeathEvidence(ind: Record<string, any>): boolean {
  if (numberOrNull(ind.death_year ?? ind.deathYear) != null) return true;
  return records(ind.events).some(event => {
    const type = String(event.tag ?? event.type ?? "").toUpperCase();
    return type === "DEAT" && (event.year != null || event.date != null || event.place != null);
  });
}

function isPrivateDemoPerson(ind: Record<string, any>, currentYear: number): boolean {
  if (nameLooksPrivate(ind.name)) return true;
  if (hasExplicitDeathEvidence(ind)) return false;
  const birth = numberOrNull(ind.birth_year ?? ind.birthYear);
  if (birth == null) return true;
  return currentYear - birth < LIVING_MAX_AGE;
}

function cleanEvent(event: Record<string, any>): Record<string, any> {
  return {
    tag: event.tag ?? event.type ?? "",
    date: event.date ?? null,
    year: event.year ?? null,
    year_end: event.year_end ?? event.yearEnd ?? event.year ?? null,
    place: event.place ?? null,
    lat: event.lat ?? null,
    lon: event.lon ?? null,
    sources: [],
  };
}

function cleanFamilyEvent(event: unknown): Record<string, any> | null {
  if (!event || typeof event !== "object") return null;
  const row = event as Record<string, any>;
  return {
    date: row.date ?? null,
    year: row.year ?? null,
    place: row.place ?? null,
  };
}

function sanitizePublicDemo(json: any): any {
  const currentYear = new Date().getUTCFullYear();
  const livingIds = new Set<string>();
  const livingLabels = new Map<string, string>();
  let livingCount = 0;

  const individuals = records(json?.individuals).map(ind => {
    const id = idOf(ind.id ?? ind.xref ?? ind.individual_id);
    const living = isPrivateDemoPerson(ind, currentYear);
    if (living) {
      livingCount++;
      livingLabels.set(id, `Living person ${livingCount}`);
      if (id) livingIds.add(id);
    }
    return {
      id,
      name: living ? (livingLabels.get(id) ?? "Living person") : (ind.name ?? id),
      sex: living ? "U" : (ind.sex ?? "U"),
      birth_year: living ? null : (numberOrNull(ind.birth_year ?? ind.birthYear)),
      death_year: living ? null : (numberOrNull(ind.death_year ?? ind.deathYear)),
      famc: living ? null : (ind.famc ?? ind.family_child ?? null),
      fams: living ? [] : (Array.isArray(ind.fams) ? ind.fams : []),
      events: living ? [] : records(ind.events).map(cleanEvent),
      notes: [],
      sources: [],
    };
  });

  const families = records(json?.families).map(fam => {
    const husb = idOf(fam.husb ?? fam.husb_id ?? fam.husband ?? fam.husband_id) || null;
    const wife = idOf(fam.wife ?? fam.wife_id) || null;
    const chil = childIds(fam.chil ?? fam.children ?? fam.child_ids);
    const hasLivingMember = [husb, wife, ...chil].some(id => id && livingIds.has(id));
    return {
      id: idOf(fam.id ?? fam.xref ?? fam.family_id),
      husb: husb && livingIds.has(husb) ? null : husb,
      wife: wife && livingIds.has(wife) ? null : wife,
      chil: chil.filter(id => !livingIds.has(id)),
      marr: hasLivingMember ? null : cleanFamilyEvent(fam.marr),
      div: hasLivingMember ? null : cleanFamilyEvent(fam.div),
    };
  }).filter(fam => fam.husb || fam.wife || fam.chil.length);

  return {
    individuals,
    families,
    sources: [],
    privacy: {
      tier: "public-demo",
      living_people: "anonymized",
      living_details: "removed",
    },
  };
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const obj = await ctx.env.STORAGE.get(PUBLIC_DEMO_KEY) ?? await ctx.env.STORAGE.get(RAW_FALLBACK_KEY);
  if (!obj) {
    return new Response(JSON.stringify({ error: "Demo data not seeded yet" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
  let body: string;
  try {
    body = JSON.stringify(sanitizePublicDemo(JSON.parse(await obj.text())));
  } catch (e) {
    return new Response(JSON.stringify({ error: "Demo data could not be sanitized" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      "X-Demo-Privacy": "living-anonymized",
    },
  });
};
