import type { Env, UserContext } from "../../_middleware";
import { DEFAULT_TREE_OWNER_EMAIL, ensureGedcomMultiSourceSchema, normalizeEmail } from "../gedcom/_lib";

export interface CatalogTree {
  key: string;
  name: string;
  storageKey: string;
  ownerEmail: string;
  access: "public" | "vip" | "shared";
  publicDemo?: boolean;
}

export const CATALOG_TREES: CatalogTree[] = [
  {
    key: "demo",
    name: "DEMO",
    storageKey: "demo/demo.json",
    ownerEmail: DEFAULT_TREE_OWNER_EMAIL,
    access: "public",
    publicDemo: true,
  },
  {
    key: "golden-rosenberg",
    name: "Golden-Rosenberg.ged",
    storageKey: "demo/golden-rosenberg.json",
    ownerEmail: DEFAULT_TREE_OWNER_EMAIL,
    access: "vip",
  },
  {
    key: "gregory-henry",
    name: "Gregory-Henry.ged",
    storageKey: "demo/gregory-henry.json",
    ownerEmail: DEFAULT_TREE_OWNER_EMAIL,
    access: "vip",
  },
  {
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
  return shared.has(tree.key);
}

export async function visibleCatalogTrees(env: Env, user: UserContext): Promise<Array<CatalogTree & { relation: string }>> {
  const shared = await sharedCatalogKeys(env, user.email);
  return CATALOG_TREES
    .filter(tree => {
      if (tree.access === "public") return true;
      if (isCatalogOwner(tree, user.email)) return true;
      if (tree.access === "vip" && user.type === "vip") return true;
      return shared.has(tree.key);
    })
    .map(tree => ({
      ...tree,
      relation: tree.access === "public"
        ? "public"
        : isCatalogOwner(tree, user.email)
          ? "owned"
          : shared.has(tree.key)
            ? "shared"
            : "vip",
    }));
}
