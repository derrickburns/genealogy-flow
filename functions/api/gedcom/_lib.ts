import type { Env } from "../../_middleware";

export const INITIAL_SHARED_CATALOG_EMAILS = [
  "mayasylvia.burns@gmail.com",
  "jamil.burns@gmail.com",
  "ginagregoryburns@gmail.com",
];

export const INITIAL_ARCHER_EXTRA_SHARED_WITH = [
  "f.d.gregory@att.net",
];

export const INITIAL_SHARED_CATALOG_KEYS = ["golden-rosenberg", "gregory-henry", "archer"];

export const DEFAULT_TREE_OWNER_EMAIL = "derrickrburns@gmail.com";
export const CATALOG_ARCHER_TREE_UUID = "14d2dad8-3582-49c2-b439-99aa30d4370b";

export function normalizeEmail(email: string | undefined | null): string {
  return String(email || "").trim().toLowerCase();
}

export function cleanTreeName(name: string | undefined | null): string {
  const cleaned = String(name || "")
    .trim()
    .replace(/\.(ged|gedcom|json)(?=\s*(?:$|\(|\u00b7))/ig, "")
    .replace(/(\.(ged|gedcom|json))+$/i, "")
    .trim();
  return cleaned;
}

export type HashEventIn = {
  type?: string | null;
  tag?: string | null;
  year?: number | null;
  place?: string | null;
};

export type HashIndividualIn = {
  id?: string | null;
  name?: string | null;
  sex?: string | null;
  birth_year?: number | null;
  death_year?: number | null;
  famc?: string | null;
  events?: HashEventIn[];
};

export type HashFamilyIn = {
  id?: string | null;
  husb?: string | null;
  husb_id?: string | null;
  wife?: string | null;
  wife_id?: string | null;
  chil?: string[];
};

const TOP_PCI_MAX_DEPTH = 6;

export type TopPciResult = {
  id: string;
  name: string | null;
  score: number;
};

function canonicalTreePayload(individuals: HashIndividualIn[], families: HashFamilyIn[]): string {
  const people = (individuals || []).map(ind => ({
    id: ind.id || "",
    name: ind.name || "",
    sex: ind.sex || "",
    birth_year: ind.birth_year ?? null,
    death_year: ind.death_year ?? null,
    famc: ind.famc || "",
    events: (ind.events || []).map(e => ({
      type: e.type || e.tag || "",
      year: e.year ?? null,
      place: e.place || "",
    })).sort((a, b) =>
      String(a.type).localeCompare(String(b.type)) ||
      Number(a.year ?? -999999) - Number(b.year ?? -999999) ||
      String(a.place).localeCompare(String(b.place))
    ),
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const fams = (families || []).map(f => ({
    id: f.id || "",
    husb: f.husb || f.husb_id || "",
    wife: f.wife || f.wife_id || "",
    chil: (f.chil || []).slice().sort(),
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return JSON.stringify({ individuals: people, families: fams });
}

export async function computeGedcomContentHash(individuals: HashIndividualIn[], families: HashFamilyIn[]): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalTreePayload(individuals, families));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function ancestorScore(rootId: string, parentsOf: Map<string, string[]>, indiById: Map<string, HashIndividualIn>): { score: number; found: number } {
  const root = indiById.get(rootId);
  if (!root) return { score: 0, found: 0 };
  const queue: Array<[string, number]> = [[rootId, 0]];
  const visited = new Set([rootId]);
  let total = 0;
  let found = 0;
  while (queue.length) {
    const [id, gen] = queue.shift()!;
    if (gen > TOP_PCI_MAX_DEPTH) continue;
    const ind = indiById.get(id);
    if (!ind) continue;
    if (gen > 0) found++;
    total += (ind.events?.length ?? 0) / (1 << gen);
    const parents = parentsOf.get(id);
    if (!parents) continue;
    for (const pid of parents) {
      if (pid && !visited.has(pid)) {
        visited.add(pid);
        queue.push([pid, gen + 1]);
      }
    }
  }
  return { score: total, found };
}

export function computeTopPci(individuals: HashIndividualIn[], families: HashFamilyIn[]): TopPciResult | null {
  const indiById = new Map<string, HashIndividualIn>();
  for (const ind of individuals || []) {
    const id = String(ind.id || "");
    if (id) indiById.set(id, ind);
  }
  const parentsOf = new Map<string, string[]>();
  for (const fam of families || []) {
    const parents = [fam.husb || fam.husb_id || "", fam.wife || fam.wife_id || ""].filter(Boolean);
    if (!parents.length) continue;
    for (const childId of fam.chil || []) {
      const id = String(childId || "");
      if (!id) continue;
      const current = parentsOf.get(id) ?? [];
      parentsOf.set(id, [...current, ...parents]);
    }
  }
  let expected = 0;
  for (let d = 1; d <= TOP_PCI_MAX_DEPTH; d++) expected += 1 << d;
  let best: { ind: HashIndividualIn; score: number; pci: number } | null = null;
  for (const ind of indiById.values()) {
    const id = String(ind.id || "");
    if (!id || ind.death_year != null) continue;
    const { score, found } = ancestorScore(id, parentsOf, indiById);
    if (score <= 0 || found < 2) continue;
    const pci = expected > 0 ? found / expected : 0;
    if (
      !best ||
      score > best.score ||
      (score === best.score && Number(ind.birth_year ?? -1) > Number(best.ind.birth_year ?? -1))
    ) {
      best = { ind, score, pci };
    }
  }
  if (!best) return null;
  return {
    id: String(best.ind.id || ""),
    name: best.ind.name ?? null,
    score: best.pci,
  };
}

function uuid(): string {
  return crypto.randomUUID();
}

export async function ensureUserIdentitySchema(env: Env): Promise<void> {
  const cols = await env.DB.prepare(`PRAGMA table_info(users)`).all<{ name: string }>();
  const names = new Set((cols.results ?? []).map(c => c.name));
  if (!names.has("owner_uuid")) {
    await env.DB.prepare(`ALTER TABLE users ADD COLUMN owner_uuid TEXT`).run();
  }

  const missing = await env.DB.prepare(`
    SELECT user_id FROM users WHERE owner_uuid IS NULL OR owner_uuid = ''
  `).all<{ user_id: string }>();
  for (const row of missing.results ?? []) {
    await env.DB.prepare(`UPDATE users SET owner_uuid = ? WHERE user_id = ?`)
      .bind(uuid(), row.user_id)
      .run();
  }

  await env.DB.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_owner_uuid ON users(owner_uuid) WHERE owner_uuid IS NOT NULL
  `).run();
}

export async function getOrCreateOwnerUuid(
  env: Env,
  userId: string,
  email: string | undefined,
): Promise<string> {
  await ensureUserIdentitySchema(env);
  const now = Math.floor(Date.now() / 1000);
  const ownerUuid = uuid();
  await env.DB.prepare(`
    INSERT INTO users (user_id, email, owner_uuid, last_login, gedcom_expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      email = excluded.email,
      last_login = excluded.last_login,
      owner_uuid = COALESCE(users.owner_uuid, excluded.owner_uuid)
  `)
    .bind(userId, email || userId, ownerUuid, now, now + 7 * 86400, now)
    .run();
  const row = await env.DB.prepare(`SELECT owner_uuid FROM users WHERE user_id = ?`)
    .bind(userId)
    .first<{ owner_uuid: string | null }>();
  return row?.owner_uuid || ownerUuid;
}

export async function ensureGedcomMultiSourceSchema(env: Env): Promise<void> {
  await ensureUserIdentitySchema(env);
  await env.DB.batch([
    env.DB.prepare(`DROP INDEX IF EXISTS ged_sources_user`),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS tree_shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tree_kind TEXT NOT NULL,
        tree_key TEXT NOT NULL,
        owner_email TEXT NOT NULL,
        shared_with_email TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS tree_shares_unique ON tree_shares(tree_kind, tree_key, shared_with_email)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS tree_shares_shared_with ON tree_shares(shared_with_email)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS tree_shares_tree ON tree_shares(tree_kind, tree_key)`),
  ]);

  const cols = await env.DB.prepare(`PRAGMA table_info(ged_sources)`).all<{ name: string }>();
  const names = new Set((cols.results ?? []).map(c => c.name));
  if (!names.has("is_default")) {
    await env.DB.prepare(`ALTER TABLE ged_sources ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0`).run();
  }
  if (!names.has("owner_user_id")) {
    await env.DB.prepare(`ALTER TABLE ged_sources ADD COLUMN owner_user_id TEXT`).run();
  }
  if (!names.has("owner_email")) {
    await env.DB.prepare(`ALTER TABLE ged_sources ADD COLUMN owner_email TEXT`).run();
  }
  if (!names.has("owner_uuid")) {
    await env.DB.prepare(`ALTER TABLE ged_sources ADD COLUMN owner_uuid TEXT`).run();
  }
  if (!names.has("tree_uuid")) {
    await env.DB.prepare(`ALTER TABLE ged_sources ADD COLUMN tree_uuid TEXT`).run();
  }
  if (!names.has("content_hash")) {
    await env.DB.prepare(`ALTER TABLE ged_sources ADD COLUMN content_hash TEXT`).run();
  }
  if (!names.has("uploaded_at")) {
    await env.DB.prepare(`ALTER TABLE ged_sources ADD COLUMN uploaded_at INTEGER`).run();
  }
  if (!names.has("content_changed_at")) {
    await env.DB.prepare(`ALTER TABLE ged_sources ADD COLUMN content_changed_at INTEGER`).run();
  }
  if (!names.has("top_pci_id")) {
    await env.DB.prepare(`ALTER TABLE ged_sources ADD COLUMN top_pci_id TEXT`).run();
  }
  if (!names.has("top_pci_name")) {
    await env.DB.prepare(`ALTER TABLE ged_sources ADD COLUMN top_pci_name TEXT`).run();
  }
  if (!names.has("top_pci_score")) {
    await env.DB.prepare(`ALTER TABLE ged_sources ADD COLUMN top_pci_score REAL`).run();
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE ged_sources SET owner_user_id = user_id WHERE owner_user_id IS NULL OR owner_user_id = ''`),
    env.DB.prepare(`
      UPDATE ged_sources
      SET owner_email = COALESCE((SELECT email FROM users WHERE users.user_id = ged_sources.user_id), user_id)
      WHERE owner_email IS NULL OR owner_email = ''
    `),
    env.DB.prepare(`
      UPDATE ged_sources
      SET owner_uuid = (SELECT owner_uuid FROM users WHERE users.user_id = ged_sources.owner_user_id)
      WHERE owner_uuid IS NULL OR owner_uuid = ''
    `),
  ]);

  const missingOwners = await env.DB.prepare(`
    SELECT id FROM ged_sources WHERE owner_uuid IS NULL OR owner_uuid = ''
  `).all<{ id: number }>();
  for (const row of missingOwners.results ?? []) {
    await env.DB.prepare(`UPDATE ged_sources SET owner_uuid = ? WHERE id = ?`)
      .bind(uuid(), row.id)
      .run();
  }

  const missingTrees = await env.DB.prepare(`
    SELECT id FROM ged_sources WHERE tree_uuid IS NULL OR tree_uuid = ''
  `).all<{ id: number }>();
  for (const row of missingTrees.results ?? []) {
    await env.DB.prepare(`UPDATE ged_sources SET tree_uuid = ? WHERE id = ?`)
      .bind(uuid(), row.id)
      .run();
  }

  await env.DB.batch([
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS ged_sources_tree_uuid ON ged_sources(tree_uuid) WHERE tree_uuid IS NOT NULL`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS ged_sources_owner_uuid_name ON ged_sources(owner_uuid, name) WHERE owner_uuid IS NOT NULL`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS ged_sources_user_name ON ged_sources(user_id, name)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS ged_sources_content_hash ON ged_sources(content_hash)`),
  ]);

  await env.DB.prepare(`
    INSERT OR IGNORE INTO tree_shares (tree_kind, tree_key, owner_email, shared_with_email, created_at)
    SELECT 'gedcom', s.tree_uuid, sh.owner_email, sh.shared_with_email, sh.created_at
    FROM tree_shares sh
    JOIN ged_sources s ON sh.tree_kind = 'gedcom' AND sh.tree_key = CAST(s.id AS TEXT)
    WHERE s.tree_uuid IS NOT NULL AND s.tree_uuid <> ''
  `).run();

  await env.DB.prepare(`
    INSERT OR IGNORE INTO tree_shares (tree_kind, tree_key, owner_email, shared_with_email, created_at)
    SELECT 'gedcom', CAST(s.id AS TEXT), sh.owner_email, sh.shared_with_email, sh.created_at
    FROM tree_shares sh
    JOIN ged_sources s ON sh.tree_kind = 'gedcom' AND sh.tree_key = s.tree_uuid
    WHERE s.tree_uuid IS NOT NULL AND s.tree_uuid <> ''
  `).run();

  const now = Math.floor(Date.now() / 1000);
  const catalogShares = INITIAL_SHARED_CATALOG_KEYS.flatMap(key => {
    const emails = key === "archer"
      ? [...INITIAL_SHARED_CATALOG_EMAILS, ...INITIAL_ARCHER_EXTRA_SHARED_WITH]
      : INITIAL_SHARED_CATALOG_EMAILS;
    return emails.map(email => ({ treeKey: key, email }));
  });
  await env.DB.batch(catalogShares.map(share =>
    env.DB.prepare(`
      INSERT OR IGNORE INTO tree_shares (tree_kind, tree_key, owner_email, shared_with_email, created_at)
      VALUES ('catalog', ?, ?, ?, ?)
    `).bind(share.treeKey, DEFAULT_TREE_OWNER_EMAIL, normalizeEmail(share.email), now)
  ));
}

export async function deleteAllUserGedcomData(env: Env, userId: string): Promise<void> {
  await ensureGedcomMultiSourceSchema(env);
  const rows = await env.DB.prepare(`SELECT id, tree_uuid FROM ged_sources WHERE user_id = ?`).bind(userId).all<{ id: number; tree_uuid: string | null }>();
  const ids = (rows.results ?? []).map(r => r.id);
  if (!ids.length) return;
  const stmts = [];
  for (const row of rows.results ?? []) {
    const id = row.id;
    stmts.push(
      env.DB.prepare(`DELETE FROM ged_family_children WHERE source_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM ged_families WHERE source_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM ged_events WHERE source_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM ged_individuals WHERE source_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM tree_shares WHERE tree_kind = 'gedcom' AND tree_key = ?`).bind(String(id)),
      env.DB.prepare(`DELETE FROM tree_shares WHERE tree_kind = 'gedcom' AND tree_key = ?`).bind(row.tree_uuid || ""),
      env.DB.prepare(`DELETE FROM ged_sources WHERE id = ?`).bind(id),
    );
  }
  await env.DB.batch(stmts);
}

export async function accessibleGedSourceIds(env: Env, userId: string, email: string | undefined): Promise<number[]> {
  await ensureGedcomMultiSourceSchema(env);
  const normalized = normalizeEmail(email);
  const rows = await env.DB.prepare(`
    SELECT s.id
    FROM ged_sources s
    WHERE s.user_id = ?
       OR s.owner_user_id = ?
       OR lower(COALESCE(s.owner_email, '')) = ?
       OR EXISTS (
         SELECT 1 FROM tree_shares sh
         WHERE sh.tree_kind = 'gedcom'
           AND (sh.tree_key = s.tree_uuid OR sh.tree_key = CAST(s.id AS TEXT))
           AND lower(sh.shared_with_email) = ?
       )
    ORDER BY s.is_default DESC, s.loaded_at ASC, s.id ASC
  `).bind(userId, userId, normalized, normalized).all<{ id: number }>();
  return (rows.results ?? []).map(r => r.id);
}

export async function canAccessGedSource(env: Env, sourceId: number, userId: string, email: string | undefined): Promise<boolean> {
  const allowed = await accessibleGedSourceIds(env, userId, email);
  return allowed.includes(sourceId);
}
