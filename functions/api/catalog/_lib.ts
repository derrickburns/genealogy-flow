import type { Env, UserContext } from "../../_middleware";
import { DEFAULT_TREE_OWNER_EMAIL, ensureGedcomMultiSourceSchema, normalizeEmail } from "../gedcom/_lib";

export interface CatalogTree {
  uuid: string;
  key: string;
  name: string;
  storageKey: string;
  ownerEmail: string;
  access: "public" | "vip" | "shared";
  publicDemo?: boolean;
}

export const CATALOG_TREES: CatalogTree[] = [
  {
    uuid: "8b7a6f25-2712-42a3-a487-af4844686886",
    key: "demo",
    name: "DEMO",
    storageKey: "demo/demo.json",
    ownerEmail: DEFAULT_TREE_OWNER_EMAIL,
    access: "public",
    publicDemo: true,
  },
  {
    uuid: "643ee1b5-301e-45a8-9c05-73a46bce7042",
    key: "golden-rosenberg",
    name: "Golden-Rosenberg.ged",
    storageKey: "demo/golden-rosenberg.json",
    ownerEmail: DEFAULT_TREE_OWNER_EMAIL,
    access: "vip",
  },
  {
    uuid: "91122fa3-fdb7-488c-a5e8-8dee4d9e3f06",
    key: "gregory-henry",
    name: "Gregory-Henry.ged",
    storageKey: "demo/gregory-henry.json",
    ownerEmail: DEFAULT_TREE_OWNER_EMAIL,
    access: "vip",
  },
  {
    uuid: "14d2dad8-3582-49c2-b439-99aa30d4370b",
    key: "archer",
    name: "Archer.ged",
    storageKey: "demo/archer.json",
    ownerEmail: DEFAULT_TREE_OWNER_EMAIL,
    access: "shared",
  },
];

export function catalogTreeByKey(key: string): CatalogTree | null {
  return CATALOG_TREES.find(tree => tree.key === key) ?? null;
}

export function catalogTreeByShareKey(key: string): CatalogTree | null {
  return CATALOG_TREES.find(tree => tree.uuid === key || tree.key === key) ?? null;
}

export function isCatalogOwner(tree: CatalogTree, email: string | undefined): boolean {
  return normalizeEmail(email) === normalizeEmail(tree.ownerEmail);
}

export async function sharedCatalogKeys(env: Env, email: string | undefined): Promise<Set<string>> {
  const normalized = normalizeEmail(email);
  if (!normalized) return new Set();
  await ensureGedcomMultiSourceSchema(env);
  const rows = await env.DB.prepare(`
    SELECT tree_key FROM tree_shares
    WHERE tree_kind = 'catalog' AND shared_with_email = ?
  `).bind(normalized).all<{ tree_key: string }>();
  return new Set((rows.results ?? []).map(row => row.tree_key));
}

export async function canAccessCatalogTree(env: Env, user: UserContext, tree: CatalogTree): Promise<boolean> {
  if (tree.access === "public") return true;
  if (isCatalogOwner(tree, user.email)) return true;
  if (tree.access === "vip" && user.type === "vip") return true;
  const shared = await sharedCatalogKeys(env, user.email);
  return shared.has(tree.uuid) || shared.has(tree.key);
}

export async function visibleCatalogTrees(env: Env, user: UserContext): Promise<Array<CatalogTree & { relation: string }>> {
  const shared = await sharedCatalogKeys(env, user.email);
  return CATALOG_TREES
    .filter(tree => {
      if (tree.access === "public") return true;
      if (isCatalogOwner(tree, user.email)) return true;
      if (tree.access === "vip" && user.type === "vip") return true;
      return shared.has(tree.uuid) || shared.has(tree.key);
    })
    .map(tree => ({
      ...tree,
      relation: tree.access === "public"
        ? "public"
        : isCatalogOwner(tree, user.email)
          ? "owned"
          : (shared.has(tree.uuid) || shared.has(tree.key))
            ? "shared"
            : "vip",
    }));
}
