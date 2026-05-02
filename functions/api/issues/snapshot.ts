import type { Env } from "../../_middleware";

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const key = new URL(ctx.request.url).searchParams.get("key") || "";
  if (!key.startsWith("issue-snapshots/") || key.includes("..")) {
    return new Response("Invalid snapshot key", { status: 400 });
  }

  const obj = await ctx.env.STORAGE.get(key);
  if (!obj) return new Response("Snapshot not found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { headers });
};
