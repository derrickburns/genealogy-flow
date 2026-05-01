import type { Env } from "../_middleware";

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const obj = await ctx.env.STORAGE.get("geocodes/gazetteer.json");
  if (!obj) {
    return new Response(JSON.stringify({ error: "Geocodes not seeded yet" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=86400",
    },
  });
};
