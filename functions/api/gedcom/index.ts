import type { Env, UserContext } from "../../_middleware";
import { accessibleGedSourceIds, deleteAllUserGedcomData, ensureGedcomMultiSourceSchema } from "./_lib";

type SourceRow = {
  id: number;
  tree_uuid: string | null;
  name: string;
  is_default: number;
  loaded_at: string;
  n_individuals: number;
  n_events: number;
  n_families: number;
  owner_email: string | null;
  owner_uuid: string | null;
  content_hash: string | null;
  uploaded_at: number | null;
  content_changed_at: number | null;
  top_pci_id: string | null;
  top_pci_name: string | null;
  top_pci_score: number | null;
  relation: string;
};

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;
  if (user.type === "anon") {
    return new Response(null, { status: 404 });
  }

  await ensureGedcomMultiSourceSchema(ctx.env);
  const allowedIds = await accessibleGedSourceIds(ctx.env, user.id, user.email);
  if (!allowedIds.length) {
    return new Response(JSON.stringify({ trees: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  const url = new URL(ctx.request.url);
  const requestedTreeUuid = url.searchParams.get("tree_uuid") || "";
  const requestedId = Number(url.searchParams.get("source_id") || "");
  let selectedIds = allowedIds;
  if (requestedTreeUuid) {
    const row = await ctx.env.DB.prepare(`SELECT id FROM ged_sources WHERE tree_uuid = ?`)
      .bind(requestedTreeUuid)
      .first<{ id: number }>();
    selectedIds = row ? allowedIds.filter(id => id === row.id) : [];
  } else if (Number.isFinite(requestedId) && requestedId > 0) {
    selectedIds = allowedIds.filter(id => id === requestedId);
  }
  if ((requestedTreeUuid || requestedId) && !selectedIds.length) {
    return new Response(JSON.stringify({ error: "Tree not found or not shared with this account" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const placeholders = selectedIds.map(() => "?").join(",");
  const rows = await ctx.env.DB.prepare(
    `SELECT id, tree_uuid, name, is_default, loaded_at, n_individuals, n_events, n_families,
            owner_email, owner_uuid, content_hash, uploaded_at, content_changed_at, top_pci_id, top_pci_name, top_pci_score,
            CASE WHEN user_id = ? OR owner_user_id = ? OR lower(COALESCE(owner_email, '')) = ? THEN 'owned' ELSE 'shared' END AS relation
     FROM ged_sources WHERE id IN (${placeholders})
     ORDER BY is_default DESC, loaded_at ASC, id ASC`,
  ).bind(user.id, user.id, String(user.email || "").toLowerCase(), ...selectedIds).all<SourceRow>();
  const sources = rows.results ?? [];
  if (!sources.length) {
    return new Response(JSON.stringify({ trees: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const trees = [];
  for (const src of sources) {
    const individualsRows = await ctx.env.DB.prepare(
      `SELECT id, name, sex, birth_year, death_year, famc FROM ged_individuals WHERE source_id = ? ORDER BY id`
    ).bind(src.id).all<{
      id: string; name: string | null; sex: string | null; birth_year: number | null; death_year: number | null; famc: string | null;
    }>();
    const eventRows = await ctx.env.DB.prepare(
      `SELECT individual_id, type, year, place FROM ged_events WHERE source_id = ? ORDER BY individual_id, year, id`
    ).bind(src.id).all<{ individual_id: string; type: string; year: number | null; place: string | null }>();
    const familyRows = await ctx.env.DB.prepare(
      `SELECT id, husb_id, wife_id FROM ged_families WHERE source_id = ? ORDER BY id`
    ).bind(src.id).all<{ id: string; husb_id: string | null; wife_id: string | null }>();
    const childRows = await ctx.env.DB.prepare(
      `SELECT family_id, child_id FROM ged_family_children WHERE source_id = ? ORDER BY family_id, child_id`
    ).bind(src.id).all<{ family_id: string; child_id: string }>();

    const eventsByIndi = new Map<string, { tag: string; year: number | null; place: string | null }[]>();
    for (const e of eventRows.results ?? []) {
      let arr = eventsByIndi.get(e.individual_id);
      if (!arr) { arr = []; eventsByIndi.set(e.individual_id, arr); }
      arr.push({ tag: e.type, year: e.year, place: e.place });
    }
    const childrenByFam = new Map<string, string[]>();
    for (const c of childRows.results ?? []) {
      let arr = childrenByFam.get(c.family_id);
      if (!arr) { arr = []; childrenByFam.set(c.family_id, arr); }
      arr.push(c.child_id);
    }

    trees.push({
      source_id: src.id,
      tree_uuid: src.tree_uuid,
      content_hash: src.content_hash,
      name: src.name,
      is_default: !!src.is_default,
      loaded_at: src.loaded_at,
      n_individuals: src.n_individuals,
      n_events: src.n_events,
      n_families: src.n_families,
      owner_email: src.owner_email,
      owner_uuid: src.owner_uuid,
      uploaded_at: src.uploaded_at,
      content_changed_at: src.content_changed_at,
      top_pci_id: src.top_pci_id,
      top_pci_name: src.top_pci_name,
      top_pci_score: src.top_pci_score,
      relation: src.relation,
      data: {
        individuals: (individualsRows.results ?? []).map((i) => ({
          id: i.id,
          name: i.name,
          sex: i.sex,
          birth_year: i.birth_year,
          death_year: i.death_year,
          famc: i.famc,
          events: eventsByIndi.get(i.id) ?? [],
        })),
        families: (familyRows.results ?? []).map((f) => ({
          id: f.id,
          husb: f.husb_id,
          wife: f.wife_id,
          chil: childrenByFam.get(f.id) ?? [],
        })),
      },
    });
  }

  return new Response(JSON.stringify({ trees }), {
    headers: { "Content-Type": "application/json" },
  });
};

export const onRequestDelete: PagesFunction<Env> = async (ctx) => {
  const user = ctx.data.user as UserContext;

  if (user.type === "anon") {
    await ctx.env.STORAGE.delete(`gedcom/anon/${user.id}`);
    await ctx.env.DB.prepare(`DELETE FROM sessions WHERE session_id = ?`).bind(user.id).run();
    return new Response(null, { status: 204 });
  }

  await deleteAllUserGedcomData(ctx.env, user.id);
  await ctx.env.DB.prepare(`UPDATE users SET gedcom_expires_at = NULL WHERE user_id = ?`).bind(user.id).run();
  return new Response(null, { status: 204 });
};
