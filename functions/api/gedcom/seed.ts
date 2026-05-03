import type { Env, UserContext } from "../../_middleware";
import { ensureGedcomMultiSourceSchema } from "./_lib";

// D1 hard limit: 100 bound parameters per prepared statement.
const ROWS_PER_STMT = 14;
const STMTS_PER_BATCH = 100;
type Row = (string | number | null)[];

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function buildInserts(db: D1Database, table: string, cols: string[], rows: Row[]): D1PreparedStatement[] {
  if (!rows.length) return [];
  return chunk(rows, ROWS_PER_STMT).map((ch) => {
    const ph = ch.map(() => `(${cols.map(() => "?").join(",")})`).join(",");
    return db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES ${ph}`).bind(...ch.flat());
  });
}

async function runBatches(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
  for (const b of chunk(stmts, STMTS_PER_BATCH)) await db.batch(b);
}

interface IndividualIn {
  id: string;
  name?: string | null;
  sex?: string | null;
  birth_year?: number | null;
  death_year?: number | null;
  famc?: string | null;
}
interface EventIn {
  individual_id: string;
  type: string;
  year?: number | null;
  place?: string | null;
  lat?: number | null;
  lon?: number | null;
}
interface FamilyIn {
  id: string;
  husb?: string | null;
  wife?: string | null;
  chil?: string[];
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  if (user.type === "anon") {
    return new Response(JSON.stringify({ error: "Sign in required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { name?: string; is_default?: boolean; individuals?: IndividualIn[]; events?: EventIn[]; families?: FamilyIn[] };
  try {
    body = await ctx.request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { name = "My Tree", is_default = false, individuals = [], events = [], families = [] } = body;
  const db = ctx.env.DB;
  await ensureGedcomMultiSourceSchema(ctx.env);
  const ownerEmail = user.email ?? user.id;

  const existing = await db.prepare(`SELECT id FROM ged_sources WHERE user_id = ? AND name = ?`)
    .bind(user.id, name)
    .first<{ id: number }>();

  if (is_default) {
    await db.prepare(`UPDATE ged_sources SET is_default = 0 WHERE user_id = ?`).bind(user.id).run();
  }

  if (existing) {
    const sid = existing.id;
    await db.batch([
      db.prepare(`DELETE FROM ged_family_children WHERE source_id = ?`).bind(sid),
      db.prepare(`DELETE FROM ged_families WHERE source_id = ?`).bind(sid),
      db.prepare(`DELETE FROM ged_events WHERE source_id = ?`).bind(sid),
      db.prepare(`DELETE FROM ged_individuals WHERE source_id = ?`).bind(sid),
      db.prepare(
        `UPDATE ged_sources SET loaded_at = ?, n_individuals = ?, n_events = ?, n_families = ?, is_default = ? WHERE id = ?`
      ).bind(new Date().toISOString(), individuals.length, events.length, families.length, is_default ? 1 : 0, sid),
    ]);

    const indiRows: Row[] = individuals.map((i) => [sid, i.id, i.name ?? null, i.sex ?? null, i.birth_year ?? null, i.death_year ?? null, i.famc ?? null]);
    await runBatches(db, buildInserts(db, "ged_individuals", ["source_id","id","name","sex","birth_year","death_year","famc"], indiRows));
    const evtRows: Row[] = events.map((e) => [sid, e.individual_id, e.type, e.year ?? null, e.place ?? null, e.lat ?? null, e.lon ?? null]);
    await runBatches(db, buildInserts(db, "ged_events", ["source_id","individual_id","type","year","place","lat","lon"], evtRows));
    const famRows: Row[] = families.map((f) => [sid, f.id, f.husb ?? null, f.wife ?? null]);
    await runBatches(db, buildInserts(db, "ged_families", ["source_id","id","husb_id","wife_id"], famRows));
    const fcRows: Row[] = families.flatMap((f) => (f.chil ?? []).map((c): Row => [sid, f.id, c]));
    await runBatches(db, buildInserts(db, "ged_family_children", ["source_id","family_id","child_id"], fcRows));
    return new Response(JSON.stringify({ ok: true, source_id: sid, updated: true }), { headers: { "Content-Type": "application/json" } });
  }

  const srcResult = await db.prepare(
    `INSERT INTO ged_sources (user_id, owner_user_id, owner_email, name, loaded_at, n_individuals, n_events, n_families, is_default)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(user.id, user.id, ownerEmail, name, new Date().toISOString(), individuals.length, events.length, families.length, is_default ? 1 : 0)
    .run();
  const sourceId = srcResult.meta.last_row_id as number;

  const indiRows: Row[] = individuals.map((i) => [sourceId, i.id, i.name ?? null, i.sex ?? null, i.birth_year ?? null, i.death_year ?? null, i.famc ?? null]);
  await runBatches(db, buildInserts(db, "ged_individuals", ["source_id","id","name","sex","birth_year","death_year","famc"], indiRows));
  const evtRows: Row[] = events.map((e) => [sourceId, e.individual_id, e.type, e.year ?? null, e.place ?? null, e.lat ?? null, e.lon ?? null]);
  await runBatches(db, buildInserts(db, "ged_events", ["source_id","individual_id","type","year","place","lat","lon"], evtRows));
  const famRows: Row[] = families.map((f) => [sourceId, f.id, f.husb ?? null, f.wife ?? null]);
  await runBatches(db, buildInserts(db, "ged_families", ["source_id","id","husb_id","wife_id"], famRows));
  const fcRows: Row[] = families.flatMap((f) => (f.chil ?? []).map((c): Row => [sourceId, f.id, c]));
  await runBatches(db, buildInserts(db, "ged_family_children", ["source_id","family_id","child_id"], fcRows));

  return new Response(JSON.stringify({ ok: true, source_id: sourceId, created: true }), {
    headers: { "Content-Type": "application/json" },
  });
};
