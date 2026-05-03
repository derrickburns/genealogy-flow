import type { Env, UserContext } from "../../_middleware";
import { cleanTreeName, computeGedcomContentHash, ensureGedcomMultiSourceSchema, getOrCreateOwnerUuid } from "./_lib";

const MAX_TREES = 24;

type EventIn = { tag: string; year?: number | null; place?: string | null };
type IndividualIn = {
  id: string;
  name?: string | null;
  sex?: string | null;
  birth_year?: number | null;
  death_year?: number | null;
  famc?: string | null;
  events?: EventIn[];
};
type FamilyIn = { id: string; husb?: string | null; wife?: string | null; chil?: string[] };
type TreeIn = {
  name: string;
  tree_uuid?: string;
  content_hash?: string;
  top_pci_id?: string | null;
  top_pci_name?: string | null;
  top_pci_score?: number | null;
  is_default?: boolean;
  individuals?: IndividualIn[];
  families?: FamilyIn[];
};

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

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  if (user.type === "anon") {
    return new Response(JSON.stringify({ error: "Sign in required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { trees?: TreeIn[] };
  try {
    body = await ctx.request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const trees = (body.trees ?? []).filter(t => t && typeof t.name === "string" && t.name.trim());
  if (trees.length > MAX_TREES) {
    return new Response(JSON.stringify({ error: `Too many trees (max ${MAX_TREES})` }), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    });
  }

  await ensureGedcomMultiSourceSchema(ctx.env);

  const db = ctx.env.DB;
  let defaultName = cleanTreeName(trees.find(t => t.is_default)?.name ?? trees[0]?.name ?? null);
  const loadedAt = new Date().toISOString();
  const uploadedAt = Math.floor(Date.now() / 1000);
  const ownerEmail = user.email ?? user.id;
  const ownerUuid = await getOrCreateOwnerUuid(ctx.env, user.id, user.email);
  const saved: Array<{ source_id: number; name: string; content_hash: string | null; updated: boolean }> = [];

  for (const tree of trees) {
    const treeName = cleanTreeName(tree.name);
    if (!treeName) {
      return new Response(JSON.stringify({ error: "Every uploaded tree must have a name" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });
    }
    const individuals = tree.individuals ?? [];
    const families = tree.families ?? [];
    const events = individuals.flatMap(ind => (ind.events ?? []).map((e) => ({
      individual_id: ind.id,
      type: e.tag,
      year: e.year ?? null,
      place: e.place ?? null,
    })));
    const contentHash = await computeGedcomContentHash(individuals, families);
    const topPciScore = Number.isFinite(Number(tree.top_pci_score)) ? Number(tree.top_pci_score) : null;
    const existing = await db.prepare(`
      SELECT id FROM ged_sources
      WHERE (owner_uuid = ? AND name = ?) OR (user_id = ? AND name = ?)
      ORDER BY id ASC
      LIMIT 1
    `).bind(ownerUuid, treeName, user.id, treeName).first<{ id: number }>();

    let sourceId: number;
    let updated = false;
    if (existing) {
      sourceId = existing.id;
      updated = true;
      await db.batch([
        db.prepare(`DELETE FROM ged_family_children WHERE source_id = ?`).bind(sourceId),
        db.prepare(`DELETE FROM ged_families WHERE source_id = ?`).bind(sourceId),
        db.prepare(`DELETE FROM ged_events WHERE source_id = ?`).bind(sourceId),
        db.prepare(`DELETE FROM ged_individuals WHERE source_id = ?`).bind(sourceId),
        db.prepare(`
          UPDATE ged_sources
          SET user_id = ?, owner_user_id = ?, owner_uuid = ?, owner_email = ?, name = ?,
              content_hash = ?, uploaded_at = ?, top_pci_id = ?, top_pci_name = ?, top_pci_score = ?,
              loaded_at = ?, n_individuals = ?, n_events = ?, n_families = ?, is_default = ?
          WHERE id = ?
        `).bind(
          user.id, user.id, ownerUuid, ownerEmail, treeName,
          contentHash, uploadedAt, tree.top_pci_id ?? null, tree.top_pci_name ?? null, topPciScore,
          loadedAt, individuals.length, events.length, families.length, treeName === defaultName ? 1 : 0,
          sourceId,
        ),
      ]);
    } else {
      const srcResult = await db.prepare(
        `INSERT INTO ged_sources (tree_uuid, user_id, owner_user_id, owner_uuid, owner_email, name, content_hash, uploaded_at, top_pci_id, top_pci_name, top_pci_score, loaded_at, n_individuals, n_events, n_families, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          tree.tree_uuid || crypto.randomUUID(), user.id, user.id, ownerUuid, ownerEmail, treeName,
          contentHash, uploadedAt, tree.top_pci_id ?? null, tree.top_pci_name ?? null, topPciScore,
          loadedAt, individuals.length, events.length, families.length, treeName === defaultName ? 1 : 0,
        )
        .run();
      sourceId = srcResult.meta.last_row_id as number;
    }

    const indiRows: Row[] = individuals.map((i) => [
      sourceId, i.id, i.name ?? null, i.sex ?? null, i.birth_year ?? null, i.death_year ?? null, i.famc ?? null,
    ]);
    await runBatches(db, buildInserts(db, "ged_individuals", ["source_id","id","name","sex","birth_year","death_year","famc"], indiRows));

    const evtRows: Row[] = events.map((e) => [
      sourceId, e.individual_id, e.type, e.year ?? null, e.place ?? null, null, null,
    ]);
    await runBatches(db, buildInserts(db, "ged_events", ["source_id","individual_id","type","year","place","lat","lon"], evtRows));

    const famRows: Row[] = families.map((f) => [sourceId, f.id, f.husb ?? null, f.wife ?? null]);
    await runBatches(db, buildInserts(db, "ged_families", ["source_id","id","husb_id","wife_id"], famRows));

    const fcRows: Row[] = families.flatMap((f) => (f.chil ?? []).map((c): Row => [sourceId, f.id, c]));
    await runBatches(db, buildInserts(db, "ged_family_children", ["source_id","family_id","child_id"], fcRows));
    saved.push({ source_id: sourceId, name: treeName, content_hash: contentHash, updated });
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 7 * 86400;
  await db.prepare(`UPDATE users SET gedcom_expires_at = ?, last_login = ? WHERE user_id = ?`)
    .bind(expiresAt, now, user.id)
    .run();

  return new Response(JSON.stringify({ ok: true, trees: trees.length, saved, expires_at: expiresAt }), {
    headers: { "Content-Type": "application/json" },
  });
};
